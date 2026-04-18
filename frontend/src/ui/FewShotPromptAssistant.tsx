import React, { useCallback, useMemo, useState } from "react";
import { deleteFewShotAssistRun, listFewShotAssistRuns, runFewShotAssist, saveFewShotAssistRun } from "../api/client";
import { formatElapsedSec, useElapsedSeconds } from "../hooks/useElapsedSeconds";
import { normalizeCell, type ParsedTable, parseUploadedTableFile } from "../utils/tableFileParse";
import { TableColumnPreviewModal } from "./TableColumnPreviewModal";

export type FewShotPromptAssistantProps = {
  /** Теги моделей из конфигурации */
  selectedModels: string[];
  prompt: string;
  rulesPreview: string;
  /** UUID справочника — при наличии прогоны сохраняются в БД и показывается история. */
  ruleId?: string;
  disabled?: boolean;
  /** Раскрытие блока few-shot снаружи (кнопка в родителе). */
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  /** Скрыть внутреннюю кнопку «Сгенерировать few-shot…» — кнопка в родителе. */
  hideToolbarButton?: boolean;
};

function formatFewShotBlock(text: string, jsonFragment: string): string {
  const j = (jsonFragment || "").trim();
  return [
    "—— Пример для few-shot (вставьте в промпт при необходимости) ——",
    "Текст:",
    text.trim(),
    "",
    "Ожидаемый JSON:",
    j ? "```json\n" + j + "\n```" : "(нет устойчивого JSON — проверьте ответы в превью)",
    "",
  ].join("\n");
}

function formatFewShotBlocksFromResults(results: any[]): string {
  const parts = results.map((row: any) =>
    formatFewShotBlock(String(row?.text ?? ""), String(row?.best_json_fragment ?? "")),
  );
  return parts.join("\n\n");
}

type SavedFewShotRun = {
  id: string;
  rule_id?: string;
  created_at?: string | null;
  result: any;
};

export default function FewShotPromptAssistant({
  selectedModels,
  prompt,
  rulesPreview,
  ruleId,
  disabled,
  expanded: expandedProp,
  onExpandedChange,
  hideToolbarButton,
}: FewShotPromptAssistantProps) {
  const [model, setModel] = useState(() => selectedModels[0] ?? "");
  const [expandedInternal, setExpandedInternal] = useState(false);
  const expanded = hideToolbarButton ? Boolean(expandedProp) : expandedInternal;
  const setExpanded = (next: boolean) => {
    if (hideToolbarButton) onExpandedChange?.(next);
    else setExpandedInternal(next);
  };
  const [table, setTable] = useState<ParsedTable>({ columns: [], rows: [] });
  /** Индекс колонки с описаниями (применённое значение после «Готово» в модалке). */
  const [pickedColumnIndex, setPickedColumnIndex] = useState(0);
  /** Черновик названия колонки в модалке (как в пакетном тесте). */
  const [fewShotColumnDraft, setFewShotColumnDraft] = useState("");
  /** Диапазон строк данных (1-based, включительно), как в пакетном тесте. */
  const [fewShotRowStart, setFewShotRowStart] = useState(1);
  const [fewShotRowEnd, setFewShotRowEnd] = useState(1);
  const [analyzeCount, setAnalyzeCount] = useState(100);
  const [targetCount, setTargetCount] = useState(8);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<any>(null);
  /** Откуда взяты текущие `data`: null — свежий прогон; иначе id сохранённой записи. */
  const [dataSourceRunId, setDataSourceRunId] = useState<string | null>(null);
  const [savedRuns, setSavedRuns] = useState<SavedFewShotRun[]>([]);
  const [runsBusy, setRunsBusy] = useState(false);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [selectedResultIndices, setSelectedResultIndices] = useState<Set<number>>(() => new Set());
  const [selectionAnchorIndex, setSelectionAnchorIndex] = useState<number | null>(null);
  const [tablePreviewOpen, setTablePreviewOpen] = useState(false);
  const elapsedFewShot = useElapsedSeconds(busy);

  const refreshSavedRuns = useCallback(async () => {
    const rid = String(ruleId ?? "").trim();
    if (!rid) {
      setSavedRuns([]);
      return;
    }
    setRunsBusy(true);
    setRunsError(null);
    try {
      const res = await listFewShotAssistRuns(rid);
      setSavedRuns(Array.isArray(res?.runs) ? res.runs : []);
    } catch (e: any) {
      setRunsError(e?.message ?? String(e));
      setSavedRuns([]);
    } finally {
      setRunsBusy(false);
    }
  }, [ruleId]);

  React.useEffect(() => {
    void refreshSavedRuns();
  }, [refreshSavedRuns]);

  React.useEffect(() => {
    setSelectedResultIndices(new Set());
    setSelectionAnchorIndex(null);
  }, [data]);

  React.useEffect(() => {
    if (selectedModels.length && !selectedModels.includes(model)) {
      setModel(selectedModels[0]);
    }
  }, [selectedModels, model]);

  React.useEffect(() => {
    if (!tablePreviewOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTablePreviewOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tablePreviewOpen]);

  React.useEffect(() => {
    if (!hideToolbarButton || !expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hideToolbarButton, expanded]);

  const activeColumnIndex = useMemo(() => {
    if (table.columns.length === 0) return -1;
    const i = Math.floor(Number(pickedColumnIndex));
    if (i < 0 || i >= table.columns.length) return 0;
    return i;
  }, [table.columns, pickedColumnIndex]);

  const fewShotColumnDraftIndex = useMemo(() => {
    const i = table.columns.findIndex((c) => c === fewShotColumnDraft);
    return i >= 0 ? i : 0;
  }, [table.columns, fewShotColumnDraft]);

  const buildRowRange = useCallback(
    (ci: number) => {
      const n = table.rows.length;
      if (ci < 0 || n === 0) {
        return { items: [] as { rowNumber: number; text: string }[], start: 1, end: 0, rowCount: 0 };
      }
      const rawS = Number(fewShotRowStart);
      const rawE = Number(fewShotRowEnd);
      const s0 = Number.isFinite(rawS) ? rawS : 1;
      const e0 = Number.isFinite(rawE) ? rawE : n;
      let lo = Math.min(Math.max(1, Math.floor(s0)), n);
      let hi = Math.min(Math.max(1, Math.floor(e0)), n);
      if (lo > hi) [lo, hi] = [hi, lo];
      const items: { rowNumber: number; text: string }[] = [];
      for (let i = lo - 1; i <= hi - 1; i += 1) {
        items.push({
          rowNumber: i + 1,
          text: normalizeCell(table.rows[i][ci]),
        });
      }
      return { items, start: lo, end: hi, rowCount: n };
    },
    [table.rows, fewShotRowStart, fewShotRowEnd],
  );

  const fewShotRowRange = useMemo(() => buildRowRange(activeColumnIndex), [buildRowRange, activeColumnIndex]);

  /** Диапазон по текущему черновику колонки в модалке (для сводки до «Применить»). */
  const fewShotRowRangeDraft = useMemo(
    () => buildRowRange(fewShotColumnDraftIndex),
    [buildRowRange, fewShotColumnDraftIndex],
  );

  const selectedColumnLabel = activeColumnIndex >= 0 ? table.columns[activeColumnIndex] ?? "" : "";

  const sourceTexts = useMemo(() => fewShotRowRange.items.map((x) => x.text).filter(Boolean), [fewShotRowRange]);

  React.useEffect(() => {
    if (sourceTexts.length === 0) return;
    setAnalyzeCount((prev: number) => {
      const next = Number.isFinite(prev) ? prev : 1;
      return Math.max(1, Math.min(next, sourceTexts.length));
    });
  }, [sourceTexts.length]);

  const canRun =
    !disabled &&
    !busy &&
    selectedModels.length > 0 &&
    String(prompt ?? "").trim().length > 0 &&
    sourceTexts.length > 0;

  const resultsArr = Array.isArray(data?.results) ? data.results : [];

  const handleResultCardClick = (idx: number, e: React.MouseEvent) => {
    const maxIdx = Math.max(0, resultsArr.length - 1);
    const clamped = Math.max(0, Math.min(idx, maxIdx));
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      setSelectedResultIndices((prev: Set<number>) => {
        const next = new Set(prev);
        if (next.has(clamped)) next.delete(clamped);
        else next.add(clamped);
        return next;
      });
      setSelectionAnchorIndex(clamped);
      return;
    }
    if (e.shiftKey && selectionAnchorIndex !== null && resultsArr.length > 0) {
      e.preventDefault();
      const start = Math.min(selectionAnchorIndex, clamped);
      const end = Math.max(selectionAnchorIndex, clamped);
      const next = new Set<number>();
      for (let i = start; i <= end; i++) next.add(i);
      setSelectedResultIndices(next);
      return;
    }
    setSelectedResultIndices(new Set([clamped]));
    setSelectionAnchorIndex(clamped);
  };

  async function onDeleteSavedRun(run: SavedFewShotRun) {
    try {
      await deleteFewShotAssistRun(run.id);
      setRunsError(null);
      if (dataSourceRunId === run.id) {
        setData(null);
        setDataSourceRunId(null);
      }
      await refreshSavedRuns();
    } catch (e: any) {
      setRunsError(e?.message ?? String(e));
    }
  }

  async function onRun() {
    if (!canRun) return;
    const analyze = Math.max(1, Math.min(Number.isFinite(analyzeCount) ? analyzeCount : 1, sourceTexts.length));
    const target = Math.max(1, Number.isFinite(targetCount) ? targetCount : 1);
    setBusy(true);
    setError(null);
    setData(null);
    setDataSourceRunId(null);
    try {
      const res = await runFewShotAssist({
        model,
        prompt: String(prompt ?? ""),
        rules_preview: rulesPreview || undefined,
        unlabeled_texts: sourceTexts,
        k: 2,
        temperature: 0.7,
        top_p: 0.95,
        alpha: 0.33,
        beta: 0.33,
        gamma: 0.34,
        max_candidates: analyze,
        top_n: target,
        candidate_strategy: "few_shot_extractor",
        n_clusters: analyze,
        outlier_percentile: null,
      });
      setData(res);
      const rid = String(ruleId ?? "").trim();
      if (rid) {
        try {
          const saved = await saveFewShotAssistRun(rid, res as Record<string, unknown>);
          if (saved?.id) setDataSourceRunId(String(saved.id));
          setRunsError(null);
          await refreshSavedRuns();
        } catch (persistErr: any) {
          setRunsError(persistErr?.message ?? String(persistErr));
        }
      }
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  const content = (
    <>
      <h3 style={{ marginTop: 0, marginBottom: 8, fontSize: "1.05rem", color: "#1e3a8a" }}>Выбор few-shot примеров для разметки</h3>
      <p style={{ margin: "0 0 12px 0", fontSize: 13, color: "#475569", lineHeight: 1.5 }}>
        Загрузите файл с описаниями ДТ, выберите колонку и запустите поиск примеров. 
      </p>

      {!hideToolbarButton ? (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <button type="button" className="btn-secondary" disabled={disabled || busy} onClick={() => setExpanded(!expanded)}>
            {expanded ? "Скрыть блок генерации few-shot" : "Сгенерировать few-shot примеры"}
          </button>
        </div>
      ) : null}

      {expanded ? (
        <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
          {selectedModels.length === 0 ? (
            <p style={{ color: "#b45309", fontSize: 14, margin: 0 }}>Отметьте модели в конфигурации, чтобы запустить оценку.</p>
          ) : (
            <label style={{ display: "grid", gap: 6, maxWidth: 420 }}>
              <span style={{ fontWeight: 600, fontSize: 14 }}>Модель для оценки</span>
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                disabled={disabled || busy}
                style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #cbd5e1" }}
              >
                {selectedModels.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
          )}

          <div style={{ display: "grid", gap: 6 }}>
            <span style={{ fontWeight: 600, fontSize: 14 }}>Файл с описаниями деклараций</span>
            <input
              type="file"
              accept=".txt,.csv,.xls,.xlsx"
              disabled={disabled || busy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                void (async () => {
                  try {
                    setError(null);
                    const parsed = await parseUploadedTableFile(file);
                    setTable(parsed);
                    setPickedColumnIndex(0);
                    const n = Math.max(1, parsed.rows.length || 1);
                    setFewShotRowStart(1);
                    setFewShotRowEnd(n);
                    setFewShotColumnDraft(parsed.columns[0] ?? "");
                    setAnalyzeCount(Math.max(1, Math.min(100, n)));
                    setTablePreviewOpen(true);
                  } catch (err: any) {
                    setTable({ columns: [], rows: [] });
                    setPickedColumnIndex(0);
                    setTablePreviewOpen(false);
                    setError(err?.message ?? "Не удалось прочитать файл");
                  }
                })();
              }}
            />
          </div>

          {table.columns.length > 0 ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
              <button
                type="button"
                className="btn-secondary"
                disabled={disabled || busy}
                onClick={() => {
                  setFewShotColumnDraft(table.columns[activeColumnIndex] ?? table.columns[0] ?? "");
                  setTablePreviewOpen(true);
                }}
              >
                Предпросмотр таблицы и выбор колонки
              </button>
              <span style={{ fontSize: 13, color: "#475569" }}>
                Колонка: <strong style={{ color: "#0f172a" }}>{selectedColumnLabel || "—"}</strong>
                {" · "}
                строки {fewShotRowRange.rowCount ? `${fewShotRowRange.start}–${fewShotRowRange.end}` : "—"} (
                {sourceTexts.length} непустых текстов)
              </span>
            </div>
          ) : null}

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 10 }}>
            <label style={{ display: "grid", gap: 6 }}>
              <span style={{ fontWeight: 600, fontSize: 14 }}>Сколько примеров анализировать</span>
              <input
                type="number"
                min={1}
                max={Math.max(1, sourceTexts.length || 1)}
                value={analyzeCount}
                onChange={(e) =>
                  setAnalyzeCount(
                    Math.max(1, Math.min(Number(e.target.value) || 1, Math.max(1, sourceTexts.length))),
                  )
                }
                disabled={disabled || busy}
              />
            </label>
            <label style={{ display: "grid", gap: 6 }}>
              <span style={{ fontWeight: 600, fontSize: 14 }}>Сколько few-shot примеров найти</span>
              <input
                type="number"
                min={1}
                max={1000}
                value={targetCount}
                onChange={(e) => setTargetCount(Number(e.target.value))}
                disabled={disabled || busy}
              />
            </label>
          </div>

          {table.rows.length > 0 ? (
            <span style={{ fontSize: 12, color: "#64748b" }}>
              В файле строк данных: {table.rows.length}. В выбранном диапазоне непустых текстов: {sourceTexts.length}. Для
              кластеризации будет отобрано до {Math.min(analyzeCount, sourceTexts.length || 0)}.
            </span>
          ) : null}

          <TableColumnPreviewModal
            open={tablePreviewOpen && table.columns.length > 0}
            onClose={() => setTablePreviewOpen(false)}
            title="Выбор колонки и предпросмотр данных"
            subtitle="Кликните по заголовку или ячейке колонки с описаниями (как в пакетном тесте). Колонка № слева — номер строки в файле. При многих столбцах прокрутите таблицу горизонтально."
            ariaTitleId="fewshot-table-preview-title"
            table={table}
            previewRowLimit={12}
            selectedColumnIndex={fewShotColumnDraftIndex}
            onSelectColumn={(ci) => {
              setFewShotColumnDraft(table.columns[ci] ?? "");
              setError(null);
            }}
            controls={
              <>
                <label style={{ display: "grid", gap: 6, maxWidth: 420 }}>
                  <span style={{ fontWeight: 600, fontSize: 13 }}>Колонка с описанием</span>
                  <select
                    value={fewShotColumnDraft}
                    onChange={(e) => setFewShotColumnDraft(e.target.value)}
                    disabled={disabled || busy}
                    style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #cbd5e1" }}
                  >
                    {table.columns.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </label>
                <div style={{ display: "grid", gap: 6 }}>
                  <span style={{ fontWeight: 600, fontSize: 13 }}>Диапазон строк данных (включительно)</span>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                    <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <span style={{ fontSize: 13, color: "#64748b" }}>С</span>
                      <input
                        type="number"
                        min={1}
                        max={Math.max(1, table.rows.length)}
                        value={fewShotRowStart}
                        onChange={(e) => setFewShotRowStart(Number(e.target.value) || 1)}
                        disabled={disabled || busy || table.rows.length === 0}
                        style={{ width: 96, padding: "6px 8px", borderRadius: 8, border: "1px solid #cbd5e1" }}
                      />
                    </label>
                    <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <span style={{ fontSize: 13, color: "#64748b" }}>По</span>
                      <input
                        type="number"
                        min={1}
                        max={Math.max(1, table.rows.length)}
                        value={fewShotRowEnd}
                        onChange={(e) => setFewShotRowEnd(Number(e.target.value) || 1)}
                        disabled={disabled || busy || table.rows.length === 0}
                        style={{ width: 96, padding: "6px 8px", borderRadius: 8, border: "1px solid #cbd5e1" }}
                      />
                    </label>
                  </div>
                </div>
              </>
            }
            footer={
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 10,
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <span style={{ fontSize: 13, color: "#475569" }}>
                  Будет применена колонка: <strong style={{ color: "#0f172a" }}>{fewShotColumnDraft || "—"}</strong> · строки{" "}
                  {fewShotRowRangeDraft.rowCount ? `${fewShotRowRangeDraft.start}–${fewShotRowRangeDraft.end}` : "—"} (
                  {fewShotRowRangeDraft.items.filter((x) => x.text.trim()).length} непустых)
                </span>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button type="button" className="btn-secondary" onClick={() => setTablePreviewOpen(false)}>
                    Отмена
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      setPickedColumnIndex(fewShotColumnDraftIndex);
                      setTablePreviewOpen(false);
                    }}
                  >
                    Применить
                  </button>
                </div>
              </div>
            }
          />

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <button
              type="button"
              className="btn"
              style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
              disabled={!canRun}
              onClick={() => void onRun()}
            >
              {busy ? (
                <>
                  <span className="fe-model-admin-spinner fe-model-admin-spinner--sm" />
                  Оценка…{" "}
                  <span style={{ fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                    · {formatElapsedSec(elapsedFewShot)}
                  </span>
                </>
              ) : (
                "Найти few-shot примеры"
              )}
            </button>
            {sourceTexts.length > 0 ? (
              <span style={{ fontSize: 12, color: "#64748b" }}>
                Диапазон строк {fewShotRowRange.start}–{fewShotRowRange.end}: {sourceTexts.length} непустых текстов, в кластеризацию до{" "}
                {Math.min(analyzeCount, sourceTexts.length)}.
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      {error ? (
        <p style={{ color: "#b91c1c", fontWeight: 600, marginTop: 12, marginBottom: 0 }}>{error}</p>
      ) : null}

      {String(ruleId ?? "").trim() ? (
        <div style={{ marginTop: 14, padding: "10px 12px", borderRadius: 10, border: "1px solid #e2e8f0", background: "#f8fafc" }}>
          <div style={{ fontWeight: 650, fontSize: 14, marginBottom: 8 }}>Сохранённые прогоны</div>
          {runsError ? (
            <p style={{ color: "#b45309", fontSize: 13, margin: "0 0 8px 0" }}>{runsError}</p>
          ) : null}
          {runsBusy ? (
            <p style={{ fontSize: 13, color: "#64748b", margin: 0 }}>Загрузка истории…</p>
          ) : savedRuns.length === 0 ? (
            <p style={{ fontSize: 13, color: "#64748b", margin: 0 }}>
              Пока нет сохранённых прогонов для этого справочника. После успешного поиска примеров результат будет записан в БД.
            </p>
          ) : (
            <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 8 }}>
              {savedRuns.map((run) => {
                const n = Array.isArray(run.result?.results) ? run.result.results.length : 0;
                const label = run.created_at
                  ? new Date(run.created_at).toLocaleString()
                  : run.id.slice(0, 8);
                const isActive = dataSourceRunId === run.id;
                return (
                  <li key={run.id} style={{ fontSize: 13, color: "#334155" }}>
                    <span style={{ fontWeight: isActive ? 700 : 400 }}>
                      {label}
                      {n ? ` · примеров: ${n}` : ""}
                      {isActive ? " · на экране" : ""}
                    </span>
                    <span style={{ marginLeft: 8, display: "inline-flex", flexWrap: "wrap", gap: 6 }}>
                      <button
                        type="button"
                        className="btn-secondary"
                        style={{ fontSize: 12, padding: "4px 8px" }}
                        disabled={disabled || busy}
                        onClick={() => {
                          setData(run.result);
                          setDataSourceRunId(run.id);
                        }}
                      >
                        Открыть
                      </button>
                      <button
                        type="button"
                        className="btn-secondary"
                        style={{ fontSize: 12, padding: "4px 8px", color: "#991b1b" }}
                        disabled={disabled || busy}
                        onClick={() => void onDeleteSavedRun(run)}
                      >
                        Удалить
                      </button>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}

      {data?.hint ? (
        <p style={{ fontSize: 13, color: "#334155", marginTop: 12, marginBottom: 0, lineHeight: 1.5 }}>{data.hint}</p>
      ) : null}

      {resultsArr.length > 0 ? (
        <div style={{ marginTop: 14, display: "grid", gap: 10 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ fontWeight: 650, fontSize: 14 }}>Результаты (по убыванию 𝒰)</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
              <button
                type="button"
                className="btn"
                style={{ fontSize: 12, padding: "6px 10px" }}
                disabled={selectedResultIndices.size === 0}
                onClick={() => {
                  const ordered = [...selectedResultIndices].sort((a, b) => a - b);
                  const slice = ordered.map((i) => resultsArr[i]).filter(Boolean);
                  void navigator.clipboard.writeText(formatFewShotBlocksFromResults(slice));
                }}
              >
                Копировать выбранные в буфер ({selectedResultIndices.size})
              </button>
            </div>
          </div>
          <p style={{ fontSize: 12, color: "#64748b", margin: 0 }}>
            Клик по карточке — выбор; Ctrl — добавить/снять; Shift — диапазон от последней опорной карточки. Затем нажмите «Копировать выбранные».
          </p>
          {resultsArr.map((row: any, idx: number) => {
            const selected = selectedResultIndices.has(idx);
            return (
              <div
                key={idx}
                role="button"
                tabIndex={0}
                onClick={(e) => handleResultCardClick(idx, e)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSelectedResultIndices(new Set([idx]));
                    setSelectionAnchorIndex(idx);
                  }
                }}
                style={{
                  border: selected ? "2px solid #2563eb" : "1px solid #e2e8f0",
                  borderRadius: 10,
                  padding: "10px 12px",
                  background: selected ? "#eff6ff" : "#fff",
                  cursor: "pointer",
                }}
              >
                <div style={{ fontSize: 12, color: "#64748b", marginBottom: 6 }}>
                  #{idx + 1} · total={Number(row.total_uncertainty).toFixed(4)} · gen={Number(row.generation_disagreement).toFixed(4)}{" "}
                  · format={Number(row.format_uncertainty).toFixed(4)} · content={Number(row.content_uncertainty).toFixed(4)}
                  {typeof row.cluster === "number" ? ` · cluster=${row.cluster}` : ""}
                  {row.is_outlier ? ` · outlier (score=${Number(row.outlier_score).toFixed(4)})` : ""}
                </div>
                <div style={{ fontSize: 13, color: "#0f172a", marginBottom: 8, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                  {String(row.text ?? "").slice(0, 1200)}
                  {String(row.text ?? "").length > 1200 ? "…" : ""}
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  <button
                    type="button"
                    className="btn-secondary"
                    style={{ fontSize: 12, padding: "6px 10px" }}
                    onClick={(e) => {
                      e.stopPropagation();
                      void navigator.clipboard.writeText(formatFewShotBlock(row.text, row.best_json_fragment));
                    }}
                  >
                    Копировать блок для промпта
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </>
  );

  if (hideToolbarButton) {
    if (!expanded) return null;
    return (
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="fewshot-main-dialog-title"
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(15, 23, 42, 0.45)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 999,
          padding: 16,
        }}
        onClick={() => setExpanded(false)}
      >
        <div
          style={{
            width: "min(1320px, 96vw)",
            maxHeight: "92vh",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            borderRadius: 12,
            border: "1px solid #c7d2fe",
            background: "linear-gradient(180deg, #f8fafc 0%, #ffffff 100%)",
            boxShadow: "0 12px 40px rgba(15, 23, 42, 0.12)",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            style={{
              flexShrink: 0,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 10,
              padding: "12px 14px",
              borderBottom: "1px solid #e2e8f0",
            }}
          >
            <div id="fewshot-main-dialog-title" style={{ fontWeight: 700, color: "#1e3a8a" }}>
              Генератор few-shot примеров
            </div>
            <button type="button" className="btn-secondary" onClick={() => setExpanded(false)}>
              Закрыть
            </button>
          </div>
          <div
            style={{
              flex: 1,
              minHeight: 0,
              maxHeight: "calc(92vh - 56px)",
              overflow: "auto",
              WebkitOverflowScrolling: "touch",
              padding: 14,
            }}
          >
            {content}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="card"
      style={{
        marginTop: 20,
        marginBottom: 8,
        border: "1px solid #c7d2fe",
        background: "linear-gradient(180deg, #f8fafc 0%, #ffffff 100%)",
      }}
    >
      {content}
    </div>
  );
}
