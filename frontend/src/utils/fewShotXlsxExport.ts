import * as XLSX from "xlsx";

function cellStr(v: unknown): string {
  if (v == null) return "";
  const t = typeof v;
  if (t === "string" || t === "number" || t === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function sanitizeSheetName(name: string): string {
  const bad = /[:\\/?*[\]]/g;
  const trimmed = name.replace(bad, " ").trim().slice(0, 31);
  return trimmed || "Sheet";
}

/** Скачивает полный объект результата few-shot assist в .xlsx (сводка + таблица по строкам). */
export function downloadFewShotResultsXlsx(data: Record<string, unknown> | null | undefined, filenameBase = "few-shot"): void {
  if (!data || typeof data !== "object") return;

  const results = Array.isArray(data.results) ? (data.results as Record<string, unknown>[]) : [];
  const kHint = Number(data.k_variants);
  const kCols = Math.max(
    Number.isFinite(kHint) && kHint > 0 ? kHint : 0,
    ...results.map((r) => {
      const prev = r.responses_preview;
      return Array.isArray(prev) ? prev.length : 0;
    }),
  );

  const wb = XLSX.utils.book_new();

  const metaRows: (string | number)[][] = [
    ["Поле", "Значение"],
    ["status", cellStr(data.status)],
    ["algorithm", cellStr(data.algorithm)],
    ["k_variants", cellStr(data.k_variants)],
    ["candidate_strategy", cellStr(data.candidate_strategy)],
    ["clustering_embedding_model", cellStr(data.clustering_embedding_model)],
    ["candidates_evaluated", cellStr(data.candidates_evaluated)],
    ["hint", cellStr(data.hint)],
    ["weights", cellStr(data.weights)],
    ["outlier_detection", cellStr(data.outlier_detection)],
    ["reference", cellStr(data.reference)],
  ];
  const wsMeta = XLSX.utils.aoa_to_sheet(metaRows);
  XLSX.utils.book_append_sheet(wb, wsMeta, sanitizeSheetName("Сводка"));

  const header: string[] = [
    "rank",
    "text",
    "cluster",
    "total_uncertainty",
    "generation_disagreement",
    "format_uncertainty",
    "R_fail",
    "structural_disagreement",
    "content_uncertainty",
    "best_json_fragment",
    "is_outlier",
    "outlier_score",
  ];
  for (let i = 1; i <= kCols; i += 1) {
    header.push(`response_variant_${i}`);
  }

  const body: string[][] = results.map((row, idx) => {
    const prev = Array.isArray(row.responses_preview) ? (row.responses_preview as unknown[]) : [];
    const cells: string[] = [
      String(idx + 1),
      cellStr(row.text),
      cellStr(row.cluster),
      cellStr(row.total_uncertainty),
      cellStr(row.generation_disagreement),
      cellStr(row.format_uncertainty),
      cellStr(row.R_fail),
      cellStr(row.structural_disagreement),
      cellStr(row.content_uncertainty),
      cellStr(row.best_json_fragment),
      cellStr(row.is_outlier),
      cellStr(row.outlier_score),
    ];
    for (let i = 0; i < kCols; i += 1) {
      cells.push(cellStr(prev[i]));
    }
    return cells;
  });

  const wsRes = XLSX.utils.aoa_to_sheet([header, ...body]);
  XLSX.utils.book_append_sheet(wb, wsRes, sanitizeSheetName("Результаты"));

  const stamp = new Date().toISOString().replace(/[:]/g, "-").slice(0, 19);
  const safeBase = filenameBase.replace(/[/\\?%*:|"<>]/g, "_").slice(0, 80);
  XLSX.writeFile(wb, `${safeBase}-${stamp}.xlsx`);
}
