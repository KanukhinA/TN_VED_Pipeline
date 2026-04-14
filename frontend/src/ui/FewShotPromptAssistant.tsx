import React, { useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { runFewShotAssist } from "../api/client";

export type FewShotPromptAssistantProps = {
  /** Теги моделей из конфигурации */
  selectedModels: string[];
  prompt: string;
  rulesPreview: string;
  disabled?: boolean;
};

type ParsedTable = {
  columns: string[];
  rows: string[][];
};

const PREVIEW_ROWS = 8;

function normalizeCell(v: unknown): string {
  if (v == null) return "";
  return String(v).trim();
}

function parseCsvText(raw: string): ParsedTable {
  const text = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = text.split("\n").filter((line) => line.length > 0);
  if (lines.length === 0) return { columns: [], rows: [] };

  const sample = lines.slice(0, 5).join("\n");
  const counts = [
    { delim: ";", n: (sample.match(/;/g) || []).length },
    { delim: ",", n: (sample.match(/,/g) || []).length },
    { delim: "\t", n: (sample.match(/\t/g) || []).length },
  ];
  counts.sort((a, b) => b.n - a.n);
  const delimiter = counts[0].n > 0 ? counts[0].delim : ",";

  function parseLine(line: string): string[] {
    const out: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '"') {
        const next = line[i + 1];
        if (inQuotes && next === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = !inQuotes;
        }
        continue;
      }
      if (!inQuotes && ch === delimiter) {
        out.push(cur);
        cur = "";
        continue;
      }
      cur += ch;
    }
    out.push(cur);
    return out.map((v) => v.trim());
  }

  const matrix = lines.map(parseLine);
  const headerRaw = matrix[0] ?? [];
  const hasHeader = headerRaw.some((h) => /[a-zA-Zа-яА-Я]/.test(h));
  const width = Math.max(...matrix.map((r) => r.length), 1);
  const columns = (hasHeader ? headerRaw : Array.from({ length: width }, (_, i) => `Колонка ${i + 1}`)).map((h, i) =>
    normalizeCell(h) || `Колонка ${i + 1}`,
  );
  const body = hasHeader ? matrix.slice(1) : matrix;
  const rows = body.map((r) => Array.from({ length: columns.length }, (_, i) => normalizeCell(r[i])));
  return { columns, rows };
}

function parseTxtText(raw: string): ParsedTable {
  const rows = raw
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => [line]);
  return { columns: ["Текст"], rows };
}

async function parseUploadedFile(file: File): Promise<ParsedTable> {
  const name = (file.name || "").toLowerCase();
  if (name.endsWith(".txt")) {
    return parseTxtText(await file.text());
  }
  if (name.endsWith(".csv")) {
    return parseCsvText(await file.text());
  }
  if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const first = wb.SheetNames[0];
    if (!first) return { columns: [], rows: [] };
    const ws = wb.Sheets[first];
    const matrix = XLSX.utils.sheet_to_json<(string | number | boolean | null)[]>(ws, { header: 1, raw: false });
    if (!Array.isArray(matrix) || matrix.length === 0) return { columns: [], rows: [] };
    const width = Math.max(...matrix.map((r) => (Array.isArray(r) ? r.length : 0)), 1);
    const headerRaw = Array.isArray(matrix[0]) ? matrix[0] : [];
    const hasHeader = headerRaw.some((h) => /[a-zA-Zа-яА-Я]/.test(normalizeCell(h)));
    const columns = (hasHeader ? headerRaw : Array.from({ length: width }, (_, i) => `Колонка ${i + 1}`)).map((h, i) =>
      normalizeCell(h) || `Колонка ${i + 1}`,
    );
    const body = hasHeader ? matrix.slice(1) : matrix;
    const rows = body.map((r) => {
      const row = Array.isArray(r) ? r : [];
      return Array.from({ length: columns.length }, (_, i) => normalizeCell(row[i]));
    });
    return { columns, rows };
  }
  throw new Error("Поддерживаются только .txt, .csv, .xls, .xlsx");
}

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

export default function FewShotPromptAssistant({
  selectedModels,
  prompt,
  rulesPreview,
  disabled,
}: FewShotPromptAssistantProps) {
  const [model, setModel] = useState(() => selectedModels[0] ?? "");
  const [expanded, setExpanded] = useState(false);
  const [table, setTable] = useState<ParsedTable>({ columns: [], rows: [] });
  const [selectedColumn, setSelectedColumn] = useState("");
  const [analyzeCount, setAnalyzeCount] = useState(100);
  const [targetCount, setTargetCount] = useState(8);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<any>(null);

  React.useEffect(() => {
    if (selectedModels.length && !selectedModels.includes(model)) {
      setModel(selectedModels[0]);
    }
  }, [selectedModels, model]);

  React.useEffect(() => {
    if (table.rows.length === 0) return;
    setAnalyzeCount((prev) => {
      const next = Number.isFinite(prev) ? prev : 1;
      return Math.max(1, Math.min(next, table.rows.length));
    });
  }, [table.rows.length]);

  const selectedColumnIndex = useMemo(() => table.columns.findIndex((c) => c === selectedColumn), [table.columns, selectedColumn]);

  const sourceTexts = useMemo(() => {
    if (selectedColumnIndex < 0) return [];
    return table.rows
      .map((row) => normalizeCell(row[selectedColumnIndex]))
      .filter(Boolean);
  }, [table.rows, selectedColumnIndex]);

  const canRun =
    !disabled &&
    !busy &&
    selectedModels.length > 0 &&
    String(prompt ?? "").trim().length > 0 &&
    sourceTexts.length > 0;

  async function onRun() {
    if (!canRun) return;
    const analyze = Math.max(1, Math.min(Number.isFinite(analyzeCount) ? analyzeCount : 1, sourceTexts.length));
    const target = Math.max(1, Number.isFinite(targetCount) ? targetCount : 1);
    setBusy(true);
    setError(null);
    setData(null);
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
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
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
      <h3 style={{ marginTop: 0, marginBottom: 8, fontSize: "1.05rem", color: "#1e3a8a" }}>
        Помощник few-shot (неопределённость модели)
      </h3>
      <p style={{ margin: "0 0 12px 0", fontSize: 13, color: "#475569", lineHeight: 1.5 }}>
        Загрузите файл с описаниями ДТ, выберите колонку и запустите поиск примеров. Кластеризация выполняется через
        <strong> multilingual-e5-base</strong>; лишние параметры скрыты.
      </p>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <button type="button" className="btn-secondary" disabled={disabled || busy} onClick={() => setExpanded((v) => !v)}>
          {expanded ? "Скрыть блок генерации few-shot" : "Сгенерировать few-shot примеры"}
        </button>
      </div>

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
                    const parsed = await parseUploadedFile(file);
                    setTable(parsed);
                    setSelectedColumn(parsed.columns[0] ?? "");
                    setAnalyzeCount(Math.max(1, Math.min(100, parsed.rows.length || 1)));
                  } catch (err: any) {
                    setTable({ columns: [], rows: [] });
                    setSelectedColumn("");
                    setError(err?.message ?? "Не удалось прочитать файл");
                  }
                })();
              }}
            />
          </div>

          {table.columns.length > 0 ? (
            <label style={{ display: "grid", gap: 6, maxWidth: 420 }}>
              <span style={{ fontWeight: 600, fontSize: 14 }}>Колонка с текстами ДТ</span>
              <select
                value={selectedColumn}
                onChange={(e) => setSelectedColumn(e.target.value)}
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
          ) : null}

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 10 }}>
            <label style={{ display: "grid", gap: 6 }}>
              <span style={{ fontWeight: 600, fontSize: 14 }}>Сколько примеров анализировать</span>
              <input
                type="number"
                min={1}
                max={10000}
                value={analyzeCount}
                onChange={(e) =>
                  setAnalyzeCount(
                    Math.max(1, Math.min(Number(e.target.value) || 1, Math.max(1, sourceTexts.length || table.rows.length))),
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
            <div style={{ display: "grid", gap: 6 }}>
              <span style={{ fontWeight: 600, fontSize: 14 }}>Предпросмотр таблицы</span>
              <div style={{ overflowX: "auto", border: "1px solid #e2e8f0", borderRadius: 8 }}>
                <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 560, fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: "#f8fafc" }}>
                      {table.columns.map((c) => (
                        <th key={c} style={{ textAlign: "left", padding: "8px 10px", borderBottom: "1px solid #e2e8f0" }}>
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {table.rows.slice(0, PREVIEW_ROWS).map((row, idx) => (
                      <tr key={idx}>
                        {table.columns.map((c, ci) => (
                          <td key={`${idx}-${c}`} style={{ padding: "7px 10px", borderBottom: "1px solid #f1f5f9" }}>
                            {row[ci]}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <span style={{ fontSize: 12, color: "#64748b" }}>
                Загружено строк: {table.rows.length}. Для анализа будет отобрано до {Math.min(analyzeCount, sourceTexts.length || 0)}.
              </span>
            </div>
          ) : null}

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
                  Оценка…
                </>
              ) : (
                "Найти few-shot примеры"
              )}
            </button>
            {sourceTexts.length > 0 ? (
              <span style={{ fontSize: 12, color: "#64748b" }}>
                Источник: {sourceTexts.length} текстов, кластеризация до {Math.min(analyzeCount, sourceTexts.length)}.
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      {error ? (
        <p style={{ color: "#b91c1c", fontWeight: 600, marginTop: 12, marginBottom: 0 }}>{error}</p>
      ) : null}

      {data?.hint ? (
        <p style={{ fontSize: 13, color: "#334155", marginTop: 12, marginBottom: 0, lineHeight: 1.5 }}>{data.hint}</p>
      ) : null}

      {Array.isArray(data?.results) && data.results.length > 0 ? (
        <div style={{ marginTop: 14, display: "grid", gap: 10 }}>
          <div style={{ fontWeight: 650, fontSize: 14 }}>Результаты (по убыванию 𝒰)</div>
          {data.results.map((row: any, idx: number) => (
            <div
              key={idx}
              style={{
                border: "1px solid #e2e8f0",
                borderRadius: 10,
                padding: "10px 12px",
                background: "#fff",
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
                  onClick={() => {
                    void navigator.clipboard.writeText(formatFewShotBlock(row.text, row.best_json_fragment));
                  }}
                >
                  Копировать блок для промпта
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
