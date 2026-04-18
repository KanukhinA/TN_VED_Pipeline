import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  bulkSaveReferenceExamples,
  deleteReferenceExample,
  listReferenceExamples,
  validateRule,
} from "../api/client";
import { normalizeCell, parseUploadedTableFile, type ParsedTable } from "../utils/tableFileParse";
import { TableColumnPreviewModal } from "./TableColumnPreviewModal";

export type DatasetImportPanelProps = {
  ruleId: string;
  disabled?: boolean;
};

type ClassifyRowResult = {
  rowNumber: number;
  descriptionText: string;
  parseError: string | null;
  data: unknown | null;
  ok: boolean;
  assignedClass: string | null;
  errors: unknown;
};

function parseFeaturesJsonCell(raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const t = raw.trim();
  if (!t) return { ok: false, error: "пустая ячейка" };
  try {
    return { ok: true, value: JSON.parse(t) };
  } catch {
    return { ok: false, error: "невалидный JSON" };
  }
}

async function mapPool<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await fn(items[i], i);
    }
  }
  const n = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

export default function DatasetImportPanel({ ruleId, disabled }: DatasetImportPanelProps) {
  const [table, setTable] = useState<ParsedTable>({ columns: [], rows: [] });
  const [pickerOpen, setPickerOpen] = useState(false);
  const [descColDraft, setDescColDraft] = useState("");
  const [jsonColDraft, setJsonColDraft] = useState("");
  const [rowStart, setRowStart] = useState(1);
  const [rowEnd, setRowEnd] = useState(1);
  const [busy, setBusy] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [results, setResults] = useState<ClassifyRowResult[] | null>(null);
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
    if (n === 0) return { start: 1, end: 0, rowCount: 0 };
    const rawS = Number(rowStart);
    const rawE = Number(rowEnd);
    const s0 = Number.isFinite(rawS) ? rawS : 1;
    const e0 = Number.isFinite(rawE) ? rawE : n;
    let lo = Math.min(Math.max(1, Math.floor(s0)), n);
    let hi = Math.min(Math.max(1, Math.floor(e0)), n);
    if (lo > hi) [lo, hi] = [hi, lo];
    return { start: lo, end: hi, rowCount: n };
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

  const canRun =
    !disabled &&
    !busy &&
    table.rows.length > 0 &&
    descIdx !== jsonIdx &&
    rowRange.start <= rowRange.end;

  const passedCount = useMemo(
    () => (results ? results.filter((r) => r.ok && r.assignedClass).length : 0),
    [results],
  );

  async function onRunClassify() {
    if (!canRun || !ruleId) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    setResults(null);
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
      const out = await mapPool(slice, 6, async (item) => {
        const parsed = parseFeaturesJsonCell(item.jsonRaw);
        if (!parsed.ok) {
          const r: ClassifyRowResult = {
            rowNumber: item.rowNumber,
            descriptionText: item.descriptionText,
            parseError: parsed.error,
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
            data: parsed.value,
            ok: false,
            assignedClass: null,
            errors: e?.message ?? String(e),
          };
          return r;
        }
      });
      setResults(out);
      setStatus(`Обработано строк: ${out.length}. Класс определён (детерминированно): ${out.filter((x) => x.ok && x.assignedClass).length}.`);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onSavePassed() {
    if (!results || !String(ruleId ?? "").trim()) return;
    const items = results
      .filter((r) => r.ok && r.assignedClass && r.data != null && !r.parseError)
      .map((r) => ({
        description_text: r.descriptionText,
        data: r.data,
      }));
    if (items.length === 0) {
      setStatus("Нет строк с успешной классификацией для сохранения.");
      return;
    }
    setSaveBusy(true);
    setError(null);
    try {
      const res = await bulkSaveReferenceExamples(ruleId, items);
      setStatus(
        `Сохранено в БД: ${res.inserted}. Пропущено при валидации на сервере: ${(res.skipped ?? []).length}.`,
      );
      await refreshStored();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setSaveBusy(false);
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
    <div style={{ display: "grid", gap: 14 }}>
      <div className="card" style={{ padding: 14 }}>
        <h2 style={{ marginTop: 0, marginBottom: 8, fontSize: "1.05rem", color: "#1e3a8a" }}>3. Подгрузить датасет</h2>
        <p style={{ margin: "0 0 12px 0", fontSize: 13, color: "#475569", lineHeight: 1.5 }}>
          Загрузите файл с колонкой <strong>текста описания</strong> таможенной декларации и колонкой с <strong>JSON признаков</strong> (как
          после извлечения). Для каждой строки выполняется детерминированная классификация по текущему справочнику. Успешные примеры можно
          одним действием записать в базу — эталоны для последующего сравнения (например, с порогом семантической схожести).
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
          {busy ? "Классификация…" : "Запустить детерминированную классификацию"}
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
                <th style={{ textAlign: "left", padding: 6, borderBottom: "1px solid #e2e8f0" }}>Описание (фрагмент)</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <tr key={r.rowNumber}>
                  <td style={{ padding: 6, borderBottom: "1px solid #f1f5f9", verticalAlign: "top" }}>{r.rowNumber}</td>
                  <td style={{ padding: 6, borderBottom: "1px solid #f1f5f9", verticalAlign: "top" }}>
                    {r.assignedClass ? (
                      <span style={{ color: "#166534", fontWeight: 600 }}>{r.assignedClass}</span>
                    ) : (
                      <span style={{ color: "#64748b" }}>—</span>
                    )}
                  </td>
                  <td style={{ padding: 6, borderBottom: "1px solid #f1f5f9", verticalAlign: "top", maxWidth: 280 }}>
                    {r.parseError ? (
                      <span style={{ color: "#b45309" }}>JSON: {r.parseError}</span>
                    ) : !r.ok ? (
                      <span style={{ color: "#b91c1c" }}>{typeof r.errors === "string" ? r.errors : JSON.stringify(r.errors)}</span>
                    ) : (
                      <span style={{ color: "#64748b" }}>ok</span>
                    )}
                  </td>
                  <td style={{ padding: 6, borderBottom: "1px solid #f1f5f9", verticalAlign: "top" }}>
                    {r.descriptionText.slice(0, 200)}
                    {r.descriptionText.length > 200 ? "…" : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="card" style={{ padding: 14 }}>
        <div style={{ fontWeight: 650, marginBottom: 8 }}>Эталоны в базе для этого справочника</div>
        {storedLoading ? (
          <p style={{ margin: 0, color: "#64748b" }}>Загрузка…</p>
        ) : stored.length === 0 ? (
          <p style={{ margin: 0, color: "#64748b" }}>Пока нет сохранённых примеров.</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 8 }}>
            {stored.map((ex) => (
              <li key={ex.id} style={{ fontSize: 13, color: "#334155" }}>
                <span style={{ fontWeight: 600, color: "#0f172a" }}>{ex.assigned_class_id}</span>
                {" · "}
                <span style={{ color: "#64748b" }}>{ex.created_at ? new Date(ex.created_at).toLocaleString() : ""}</span>
                {" · "}
                <span>{String(ex.description_text ?? "").slice(0, 120)}</span>
                <button
                  type="button"
                  className="btn-secondary"
                  style={{ marginLeft: 8, fontSize: 12, padding: "2px 8px", color: "#991b1b" }}
                  disabled={disabled}
                  onClick={() => void onDeleteExample(String(ex.id))}
                >
                  Удалить
                </button>
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
                    value={rowStart}
                    onChange={(e) => setRowStart(Number(e.target.value) || 1)}
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
                    value={rowEnd}
                    onChange={(e) => setRowEnd(Number(e.target.value) || 1)}
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
    </div>
  );
}
