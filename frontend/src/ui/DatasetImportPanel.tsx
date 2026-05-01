import { useCallback, useEffect, useMemo, useState } from "react";
import {
  bulkSaveReferenceExamples,
  deleteReferenceExample,
  getRule,
  listReferenceExamples,
  validateRule,
} from "../api/client";
import { parseDatasetFeaturesCell } from "../utils/jsonRecovery";
import { finalizeRowInput, rowRangeBounds, type RowInputValue } from "../utils/rowRangeNumericInput";
import { formatClassColumnDisplay } from "../utils/formatClassColumn";
import { normalizeCell, parseUploadedTableFile, type ParsedTable } from "../utils/tableFileParse";
import { useElapsedSeconds } from "../hooks/useElapsedSeconds";
import { LongOperationStatusBar } from "./LongOperationStatusBar";
import { TableColumnPreviewModal } from "./TableColumnPreviewModal";

export type DatasetImportPanelProps = {
  ruleId: string;
  disabled?: boolean;
};

type ParseDiagnostics = {
  parseReason: string;
  strictCellError: string | null;
  afterExtractPreview: string;
  innerFragmentPreview: string;
  normalizedAttemptPreview: string;
};

type ClassifyRowResult = {
  rowNumber: number;
  descriptionText: string;
  parseError: string | null;
  /** Подробности при «невалидный JSON»: сообщения парсеров и фрагменты текста. */
  parseDiagnostics: ParseDiagnostics | null;
  data: unknown | null;
  ok: boolean;
  assignedClass: string | null;
  errors: unknown;
};

type ClassOption = { id: string; label: string };

function extractClassOptionsFromDsl(dsl: unknown): ClassOption[] {
  if (!dsl || typeof dsl !== "object") return [];
  const rules = (dsl as { classification?: { rules?: unknown } }).classification?.rules;
  if (!Array.isArray(rules)) return [];
  const seen = new Set<string>();
  const out: ClassOption[] = [];
  for (const raw of rules) {
    if (!raw || typeof raw !== "object") continue;
    const id = String((raw as { class_id?: unknown }).class_id ?? "")
      .trim()
      .toLowerCase();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const title = String((raw as { title?: unknown }).title ?? "").trim();
    out.push({ id, label: title ? `${id} — ${title}` : id });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

function effectiveAssignedClassId(r: ClassifyRowResult, overrides: Record<number, string>): string | null {
  const o = overrides[r.rowNumber];
  if (o !== undefined && o !== "") return o;
  const a = r.assignedClass;
  if (a == null) return null;
  const s = String(a).trim();
  return s || null;
}

function rowAllowsClassPicker(r: ClassifyRowResult): boolean {
  return !r.parseError && r.data != null && r.ok;
}

function splitAssignedClassIds(raw: string | null): string[] {
  return String(raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function classifyRuleOutcomeText(r: ClassifyRowResult): string | null {
  if (!r.ok) return null;
  const ids = splitAssignedClassIds(r.assignedClass);
  if (ids.length === 0) return "По правилам не подошел ни один класс.";
  if (ids.length > 1) return `По правилам подошло несколько классов: ${ids.join(", ")}.`;
  return `По правилам выбран класс: ${ids[0]}.`;
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  onProgress?: (completed: number, total: number) => void,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const total = items.length;
  let completed = 0;
  async function workerTracked() {
    for (;;) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await fn(items[i], i);
      completed += 1;
      onProgress?.(completed, total);
    }
  }
  const n = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: n }, () => workerTracked()));
  return results;
}

export default function DatasetImportPanel({ ruleId, disabled }: DatasetImportPanelProps) {
  const [table, setTable] = useState<ParsedTable>({ columns: [], rows: [] });
  const [pickerOpen, setPickerOpen] = useState(false);
  const [descColDraft, setDescColDraft] = useState("");
  const [jsonColDraft, setJsonColDraft] = useState("");
  const [rowStart, setRowStart] = useState<RowInputValue>(1);
  const [rowEnd, setRowEnd] = useState<RowInputValue>(1);
  const [busy, setBusy] = useState(false);
  const [classifyProgress, setClassifyProgress] = useState<{ done: number; total: number } | null>(null);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveProgress, setSaveProgress] = useState<{ done: number; total: number } | null>(null);
  const [saveDetailText, setSaveDetailText] = useState<string | null>(null);
  const elapsedClassify = useElapsedSeconds(busy);
  const elapsedSave = useElapsedSeconds(saveBusy);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [results, setResults] = useState<ClassifyRowResult[] | null>(null);
  const [classOptions, setClassOptions] = useState<ClassOption[]>([]);
  const [classOptionsLoaded, setClassOptionsLoaded] = useState(false);
  /** Непустое значение — явный выбор эксперта (перекрывает классификацию по правилам). */
  const [classOverrides, setClassOverrides] = useState<Record<number, string>>({});
  const [stored, setStored] = useState<any[]>([]);
  const [storedLoading, setStoredLoading] = useState(false);

  const descIdx = useMemo(() => {
    const i = table.columns.findIndex((c) => c === descColDraft);
    return i >= 0 ? i : 0;
  }, [table.columns, descColDraft]);

  const jsonIdx = useMemo(() => {
    const i = table.columns.findIndex((c) => c === jsonColDraft);
    return i >= 0 ? i : 0;
  }, [table.columns, jsonColDraft]);

  const rowRange = useMemo(() => {
    const n = table.rows.length;
    if (n === 0) return { start: 1, end: 0, rowCount: 0, incomplete: false };
    const { s0, e0, incomplete } = rowRangeBounds(rowStart, rowEnd, n);
    let lo = Math.min(Math.max(1, Math.floor(s0)), n);
    let hi = Math.min(Math.max(1, Math.floor(e0)), n);
    if (lo > hi) [lo, hi] = [hi, lo];
    return { start: lo, end: hi, rowCount: n, incomplete };
  }, [table.rows.length, rowStart, rowEnd]);

  const refreshStored = useCallback(async () => {
    if (!ruleId) return;
    setStoredLoading(true);
    try {
      const res = await listReferenceExamples(ruleId);
      setStored(Array.isArray(res?.examples) ? res.examples : []);
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setStored([]);
    } finally {
      setStoredLoading(false);
    }
  }, [ruleId]);

  useEffect(() => {
    void refreshStored();
  }, [refreshStored]);

  useEffect(() => {
    if (!ruleId) {
      setClassOptions([]);
      setClassOptionsLoaded(false);
      return;
    }
    let cancelled = false;
    setClassOptionsLoaded(false);
    void (async () => {
      try {
        const rule = await getRule(ruleId);
        if (cancelled) return;
        setClassOptions(extractClassOptionsFromDsl(rule?.dsl));
      } catch {
        if (!cancelled) setClassOptions([]);
      } finally {
        if (!cancelled) setClassOptionsLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ruleId]);

  const canRun =
    !disabled &&
    !busy &&
    table.rows.length > 0 &&
    descIdx !== jsonIdx &&
    !rowRange.incomplete &&
    rowRange.start <= rowRange.end;

  const passedCount = useMemo(
    () =>
      results
        ? results.filter((r) => {
            if (r.parseError || r.data == null || !r.ok) return false;
            return effectiveAssignedClassId(r, classOverrides) != null;
          }).length
        : 0,
    [results, classOverrides],
  );

  async function onRunClassify() {
    if (!canRun || !ruleId) return;
    setBusy(true);
    setClassifyProgress(null);
    setError(null);
    setStatus(null);
    setResults(null);
    setClassOverrides({});
    try {
      const slice: { rowNumber: number; descriptionText: string; jsonRaw: string }[] = [];
      for (let i = rowRange.start - 1; i <= rowRange.end - 1; i++) {
        const row = table.rows[i];
        slice.push({
          rowNumber: i + 1,
          descriptionText: normalizeCell(row[descIdx]),
          jsonRaw: normalizeCell(row[jsonIdx]),
        });
      }
      if (slice.length === 0) {
        setStatus("В диапазоне нет строк.");
        return;
      }
      setClassifyProgress({ done: 0, total: slice.length });
      const out = await mapPool(slice, 6, async (item) => {
        const parsed = parseDatasetFeaturesCell(item.jsonRaw);
        if (!parsed.ok) {
          const r: ClassifyRowResult = {
            rowNumber: item.rowNumber,
            descriptionText: item.descriptionText,
            parseError: parsed.error,
            parseDiagnostics: {
              parseReason: parsed.parseReason,
              strictCellError: parsed.strictCellError,
              afterExtractPreview: parsed.afterExtractPreview,
              innerFragmentPreview: parsed.innerFragmentPreview,
              normalizedAttemptPreview: parsed.normalizedAttemptPreview,
            },
            data: null,
            ok: false,
            assignedClass: null,
            errors: null,
          };
          return r;
        }
        try {
          const res = await validateRule(ruleId, parsed.value);
          const r: ClassifyRowResult = {
            rowNumber: item.rowNumber,
            descriptionText: item.descriptionText,
            parseError: null,
            parseDiagnostics: null,
            data: parsed.value,
            ok: Boolean(res?.ok),
            assignedClass: res?.assigned_class != null ? String(res.assigned_class) : null,
            errors: res?.errors ?? null,
          };
          return r;
        } catch (e: any) {
          const r: ClassifyRowResult = {
            rowNumber: item.rowNumber,
            descriptionText: item.descriptionText,
            parseError: null,
            parseDiagnostics: null,
            data: parsed.value,
            ok: false,
            assignedClass: null,
            errors: e?.message ?? String(e),
          };
          return r;
        }
      }, (done, total) => setClassifyProgress({ done, total }));
      setResults(out);
      setStatus(`Обработано строк: ${out.length}. Класс определён по правилам: ${out.filter((x) => x.ok && x.assignedClass).length}.`);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
      setClassifyProgress(null);
    }
  }

  async function onSavePassed() {
    if (!results || !String(ruleId ?? "").trim()) return;
    const items = results
      .filter((r) => !r.parseError && r.data != null && r.ok && effectiveAssignedClassId(r, classOverrides) != null)
      .map((r) => {
        const manual = classOverrides[r.rowNumber];
        const body: { description_text: string; data: unknown; assigned_class_id?: string } = {
          description_text: r.descriptionText,
          data: r.data,
        };
        if (manual !== undefined && manual !== "") body.assigned_class_id = manual;
        return body;
      });
    if (items.length === 0) {
      setStatus("Нет строк с успешной классификацией для сохранения.");
      return;
    }
    setSaveBusy(true);
    setSaveProgress({ done: 0, total: 1 });
    setSaveDetailText(`${items.length} ${items.length === 1 ? "запись" : items.length < 5 ? "записи" : "записей"} — один запрос к серверу`);
    setError(null);
    try {
      const res = await bulkSaveReferenceExamples(ruleId, items);
      setStatus(
        `Сохранено в БД: ${res.inserted}. Пропущено сервером: ${(res.skipped ?? []).length} (включая невалидные и дубликаты описаний).`,
      );
      await refreshStored();
      setSaveProgress({ done: 1, total: 1 });
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setSaveBusy(false);
      setSaveProgress(null);
      setSaveDetailText(null);
    }
  }

  async function onDeleteExample(id: string) {
    if (!ruleId) return;
    try {
      await deleteReferenceExample(ruleId, id);
      await refreshStored();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }

  return (
    <div style={{ display: "grid", gap: 14, paddingBottom: busy || saveBusy ? 76 : undefined }}>
      <div className="card" style={{ padding: 14 }}>
        <h2 style={{ marginTop: 0, marginBottom: 8, fontSize: "1.05rem", color: "#1e3a8a" }}>3. Подгрузить датасет</h2>
        <p style={{ margin: "0 0 12px 0", fontSize: 13, color: "#475569", lineHeight: 1.5 }}>
          Загрузите файл с колонкой <strong>текста описания</strong> таможенной декларации и колонкой с <strong>JSON признаков</strong> (как
          после извлечения). Ячейки JSON разбираются тем же устойчивым конвейером, что и ответы модели: блоки в markdown, лишний текст вокруг
          объекта, <code>None</code> вместо <code>null</code>, правка запятых и незакрытых скобок, при необходимости — расширенный синтаксис
          (одинарные кавычки и т.п.). Для каждой строки выполняется классификация по правилам текущего справочника. Успешные примеры
          можно одним действием записать в базу — эталоны для последующего сравнения (например, с порогом семантической схожести).
          После прогона в таблице результатов можно вручную выбрать класс из списка (классы из правил классификации справочника); он будет
          сохранён вместо автоматически назначенного.
        </p>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
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
                  setDescColDraft(parsed.columns[0] ?? "");
                  setJsonColDraft(parsed.columns[Math.min(1, Math.max(0, parsed.columns.length - 1))] ?? "");
                  const n = Math.max(1, parsed.rows.length || 1);
                  setRowStart(1);
                  setRowEnd(n);
                  setResults(null);
                  setClassOverrides({});
                  setPickerOpen(true);
                } catch (err: any) {
                  setTable({ columns: [], rows: [] });
                  setError(err?.message ?? "Не удалось прочитать файл");
                }
              })();
            }}
          />
          {table.columns.length > 0 ? (
            <button type="button" className="btn-secondary" disabled={disabled || busy} onClick={() => setPickerOpen(true)}>
              Предпросмотр и выбор колонок
            </button>
          ) : null}
        </div>

        {table.columns.length > 0 ? (
          <p style={{ fontSize: 13, color: "#475569", margin: "10px 0 0 0" }}>
            Описание: <strong>{descColDraft || "—"}</strong> · JSON: <strong>{jsonColDraft || "—"}</strong> · строки{" "}
            {rowRange.rowCount ? `${rowRange.start}–${rowRange.end}` : "—"}
          </p>
        ) : null}

        {error ? (
          <p style={{ color: "#b91c1c", fontWeight: 600, margin: "10px 0 0 0" }}>{error}</p>
        ) : null}
        {status ? (
          <p style={{ color: "#166534", fontWeight: 600, margin: "8px 0 0 0" }}>{status}</p>
        ) : null}
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
        <button type="button" className="btn" disabled={!canRun || busy} onClick={() => void onRunClassify()}>
          {busy ? "Классификация…" : "Запустить классификацию по правилам"}
        </button>
        <button
          type="button"
          className="btn"
          disabled={!results || passedCount === 0 || saveBusy || disabled}
          onClick={() => void onSavePassed()}
        >
          {saveBusy ? "Сохранение…" : `Записать в БД прошедшие классификацию (${passedCount})`}
        </button>
      </div>

      {results && results.length > 0 ? (
        <div className="card" style={{ padding: 12, overflow: "auto" }}>
          <div style={{ fontWeight: 650, marginBottom: 8 }}>Результаты по строкам</div>
          <table style={{ borderCollapse: "collapse", fontSize: 12, width: "100%" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", padding: 6, borderBottom: "1px solid #e2e8f0" }}>№</th>
                <th style={{ textAlign: "left", padding: 6, borderBottom: "1px solid #e2e8f0" }}>Класс</th>
                <th style={{ textAlign: "left", padding: 6, borderBottom: "1px solid #e2e8f0" }}>Ошибка / примечание</th>
                <th style={{ textAlign: "left", padding: 6, borderBottom: "1px solid #e2e8f0" }}>JSON (диагностика)</th>
                <th style={{ textAlign: "left", padding: 6, borderBottom: "1px solid #e2e8f0" }}>Описание декларации</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => {
                const autoDisplay = formatClassColumnDisplay(r.assignedClass, []);
                const picked = classOverrides[r.rowNumber];
                const displayLabel = picked || autoDisplay;
                const pickerEnabled = rowAllowsClassPicker(r);
                const outcomeText = classifyRuleOutcomeText(r);
                return (
                <tr key={r.rowNumber}>
                  <td style={{ padding: 6, borderBottom: "1px solid #f1f5f9", verticalAlign: "top" }}>{r.rowNumber}</td>
                  <td style={{ padding: 6, borderBottom: "1px solid #f1f5f9", verticalAlign: "top" }}>
                    <div style={{ display: "grid", gap: 6, minWidth: 120, maxWidth: 320 }}>
                      <div>
                        {displayLabel ? (
                          <span style={{ color: "#166534", fontWeight: 600 }}>{displayLabel}</span>
                        ) : (
                          <span style={{ color: "#64748b" }}>—</span>
                        )}
                      </div>
                      {classOptions.length > 0 ? (
                        <div style={{ display: "grid", gap: 6 }}>
                          <select
                            aria-label={`Класс для строки ${r.rowNumber}`}
                            disabled={disabled || busy || saveBusy || !pickerEnabled}
                            value={picked ?? ""}
                            onChange={(e) => {
                              const v = e.target.value.trim().toLowerCase();
                              setClassOverrides((prev) => {
                                const next = { ...prev };
                                if (!v) delete next[r.rowNumber];
                                else next[r.rowNumber] = v;
                                return next;
                              });
                            }}
                            style={{
                              fontSize: 12,
                              width: "100%",
                              maxWidth: 300,
                              padding: "4px 6px",
                              borderRadius: 6,
                              border: "1px solid #cbd5e1",
                              background: pickerEnabled ? "#fff" : "#f1f5f9",
                            }}
                          >
                            <option value="">
                              По правилам{autoDisplay ? `: ${autoDisplay}` : " (класс не назначен)"}
                            </option>
                            {classOptions.map((opt) => (
                              <option key={opt.id} value={opt.id}>
                                {opt.label}
                              </option>
                            ))}
                          </select>
                          {outcomeText ? (
                            <span style={{ fontSize: 11, color: "#64748b", lineHeight: 1.35 }}>{outcomeText}</span>
                          ) : null}
                        </div>
                      ) : classOptionsLoaded ? (
                        <span style={{ fontSize: 11, color: "#94a3b8" }}>В справочнике нет правил классификации</span>
                      ) : (
                        <span style={{ fontSize: 11, color: "#94a3b8" }}>Загрузка классов…</span>
                      )}
                    </div>
                  </td>
                  <td style={{ padding: 6, borderBottom: "1px solid #f1f5f9", verticalAlign: "top", maxWidth: 320 }}>
                    {r.parseError ? (
                      <span style={{ color: "#b45309" }}>JSON: {r.parseError}</span>
                    ) : !r.ok ? (
                      <span style={{ color: "#b91c1c" }}>{typeof r.errors === "string" ? r.errors : JSON.stringify(r.errors)}</span>
                    ) : (
                      <span style={{ color: "#64748b" }}>ok</span>
                    )}
                  </td>
                  <td style={{ padding: 6, borderBottom: "1px solid #f1f5f9", verticalAlign: "top", maxWidth: 480, fontSize: 11 }}>
                    {r.parseDiagnostics ? (
                      <details style={{ maxWidth: "100%" }}>
                        <summary style={{ cursor: "pointer", color: "#0f172a", fontWeight: 600 }}>
                          Почему не разобралось и что передавалось в парсер
                        </summary>
                        <div style={{ marginTop: 8, display: "grid", gap: 10, color: "#334155" }}>
                          <div>
                            <div style={{ fontWeight: 600, marginBottom: 4 }}>Сообщения парсеров</div>
                            <pre
                              style={{
                                margin: 0,
                                whiteSpace: "pre-wrap",
                                wordBreak: "break-word",
                                background: "#f8fafc",
                                padding: 8,
                                borderRadius: 6,
                                border: "1px solid #e2e8f0",
                              }}
                            >
                              {r.parseDiagnostics.parseReason}
                            </pre>
                          </div>
                          {r.parseDiagnostics.strictCellError ? (
                            <div>
                              <div style={{ fontWeight: 600, marginBottom: 4 }}>Строгий JSON.parse по ячейке как есть</div>
                              <pre
                                style={{
                                  margin: 0,
                                  whiteSpace: "pre-wrap",
                                  wordBreak: "break-word",
                                  background: "#fffbeb",
                                  padding: 8,
                                  borderRadius: 6,
                                  border: "1px solid #fcd34d",
                                }}
                              >
                                {r.parseDiagnostics.strictCellError}
                              </pre>
                            </div>
                          ) : null}
                          <div>
                            <div style={{ fontWeight: 600, marginBottom: 4 }}>Текст после извлечения JSON (как у ответа модели)</div>
                            <pre
                              style={{
                                margin: 0,
                                whiteSpace: "pre-wrap",
                                wordBreak: "break-word",
                                background: "#f8fafc",
                                padding: 8,
                                borderRadius: 6,
                                border: "1px solid #e2e8f0",
                                maxHeight: 220,
                                overflow: "auto",
                              }}
                            >
                              {r.parseDiagnostics.afterExtractPreview || "—"}
                            </pre>
                          </div>
                          {r.parseDiagnostics.innerFragmentPreview !== r.parseDiagnostics.afterExtractPreview ? (
                            <div>
                              <div style={{ fontWeight: 600, marginBottom: 4 }}>После извлечения markdown / первой «&#123;» или «[»</div>
                              <pre
                                style={{
                                  margin: 0,
                                  whiteSpace: "pre-wrap",
                                  wordBreak: "break-word",
                                  background: "#f8fafc",
                                  padding: 8,
                                  borderRadius: 6,
                                  border: "1px solid #e2e8f0",
                                  maxHeight: 220,
                                  overflow: "auto",
                                }}
                              >
                                {r.parseDiagnostics.innerFragmentPreview}
                              </pre>
                            </div>
                          ) : null}
                          <div>
                            <div style={{ fontWeight: 600, marginBottom: 4 }}>Строка после нормализации (то, что шло в JSON.parse / JSON5)</div>
                            <pre
                              style={{
                                margin: 0,
                                whiteSpace: "pre-wrap",
                                wordBreak: "break-word",
                                background: "#eff6ff",
                                padding: 8,
                                borderRadius: 6,
                                border: "1px solid #93c5fd",
                                maxHeight: 280,
                                overflow: "auto",
                              }}
                            >
                              {r.parseDiagnostics.normalizedAttemptPreview}
                            </pre>
                          </div>
                        </div>
                      </details>
                    ) : r.data != null ? (
                      <pre
                        style={{
                          margin: 0,
                          fontSize: 11,
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-word",
                          background: r.ok ? "#f0fdf4" : "#fffbeb",
                          padding: 8,
                          borderRadius: 6,
                          border: r.ok ? "1px solid #bbf7d0" : "1px solid #fcd34d",
                          maxHeight: 200,
                          overflow: "auto",
                        }}
                      >
                        {(() => {
                          try {
                            return JSON.stringify(r.data, null, 2);
                          } catch {
                            return String(r.data);
                          }
                        })()}
                      </pre>
                    ) : (
                      <span style={{ color: "#94a3b8" }}>—</span>
                    )}
                  </td>
                  <td
                    style={{
                      padding: 6,
                      borderBottom: "1px solid #f1f5f9",
                      verticalAlign: "top",
                      maxWidth: 560,
                    }}
                  >
                    <div
                      style={{
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        maxHeight: "min(70vh, 520px)",
                        overflow: "auto",
                        fontSize: 12,
                        lineHeight: 1.45,
                        color: "#0f172a",
                      }}
                    >
                      {r.descriptionText}
                    </div>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="card" style={{ padding: 14 }}>
        <div style={{ fontWeight: 650, marginBottom: 8, display: "flex", alignItems: "center", gap: 8 }}>
          <span>Эталоны в базе для этого справочника</span>
          <span style={{ fontSize: 12, color: "#475569", fontWeight: 600 }}>
            ({storedLoading ? "загрузка..." : `записей: ${stored.length}`})
          </span>
        </div>
        {storedLoading ? (
          <p style={{ margin: 0, color: "#64748b" }}>Загрузка…</p>
        ) : stored.length === 0 ? (
          <p style={{ margin: 0, color: "#64748b" }}>Пока нет сохранённых примеров.</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 8 }}>
            {stored.map((ex) => (
              <li key={ex.id} style={{ fontSize: 13, color: "#334155", display: "grid", gap: 6 }}>
                <div>
                  <span style={{ fontWeight: 600, color: "#0f172a" }}>{ex.assigned_class_id}</span>
                  {" · "}
                  <span style={{ color: "#64748b" }}>{ex.created_at ? new Date(ex.created_at).toLocaleString() : ""}</span>
                </div>
                <div
                  style={{
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    color: "#334155",
                    lineHeight: 1.45,
                  }}
                >
                  {String(ex.description_text ?? "")}
                </div>
                <div>
                  <button
                    type="button"
                    className="btn-secondary"
                    style={{ fontSize: 12, padding: "2px 8px", color: "#991b1b" }}
                    disabled={disabled}
                    onClick={() => void onDeleteExample(String(ex.id))}
                  >
                    Удалить
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <TableColumnPreviewModal
        open={pickerOpen && table.columns.length > 0}
        onClose={() => setPickerOpen(false)}
        title="Выбор колонок датасета"
        subtitle="Синяя подсветка — колонка с текстом описания декларации; зелёная — колонка с JSON признаков. При необходимости задайте диапазон строк."
        ariaTitleId="dataset-table-preview-title"
        table={table}
        selectedColumnIndex={descIdx}
        secondarySelectedColumnIndex={jsonIdx}
        onSelectColumn={(ci) => {
          setDescColDraft(table.columns[ci] ?? "");
        }}
        controls={
          <>
            <label style={{ display: "grid", gap: 6, maxWidth: 420 }}>
              <span style={{ fontWeight: 600, fontSize: 13 }}>Колонка с описанием декларации</span>
              <select
                value={descColDraft}
                onChange={(e) => setDescColDraft(e.target.value)}
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
            <label style={{ display: "grid", gap: 6, maxWidth: 420 }}>
              <span style={{ fontWeight: 600, fontSize: 13 }}>Колонка с JSON признаков</span>
              <select
                value={jsonColDraft}
                onChange={(e) => setJsonColDraft(e.target.value)}
                disabled={disabled || busy}
                style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #cbd5e1" }}
              >
                {table.columns.map((c) => (
                  <option key={`j-${c}`} value={c}>
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
                    value={rowStart === "" ? "" : rowStart}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === "") {
                        setRowStart("");
                        return;
                      }
                      const n = Number(v);
                      if (!Number.isNaN(n)) setRowStart(n);
                    }}
                    onBlur={() => setRowStart((prev) => finalizeRowInput(prev, table.rows.length))}
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
                    value={rowEnd === "" ? "" : rowEnd}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === "") {
                        setRowEnd("");
                        return;
                      }
                      const n = Number(v);
                      if (!Number.isNaN(n)) setRowEnd(n);
                    }}
                    onBlur={() => setRowEnd((prev) => finalizeRowInput(prev, table.rows.length))}
                    disabled={disabled || busy || table.rows.length === 0}
                    style={{ width: 96, padding: "6px 8px", borderRadius: 8, border: "1px solid #cbd5e1" }}
                  />
                </label>
              </div>
            </div>
          </>
        }
        footer={
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
            <button type="button" className="btn-secondary" onClick={() => setPickerOpen(false)}>
              Отмена
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                if (descColDraft === jsonColDraft) {
                  setError("Выберите две разные колонки: описание и JSON.");
                  return;
                }
                setPickerOpen(false);
              }}
            >
              Применить
            </button>
          </div>
        }
      />
      <LongOperationStatusBar
        visible={busy}
        title="Классификация строк датасета"
        detail="Каждая строка — разбор JSON и проверка по правилам (до 6 параллельно)."
        elapsedSec={elapsedClassify}
        progress={classifyProgress}
      />
      <LongOperationStatusBar
        visible={saveBusy}
        title="Сохранение эталонов в базу"
        detail={saveDetailText ?? undefined}
        elapsedSec={elapsedSave}
        progress={saveProgress}
      />
    </div>
  );
}
