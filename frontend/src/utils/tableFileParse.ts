import * as XLSX from "xlsx";

/** Макс. индекс колонки + 1 по всем ячейкам листа (!ref иногда ужат в старых .xls / после правок). */
function columnCountFromWorksheetCells(ws: XLSX.WorkSheet): number {
  let max = -1;
  for (const k of Object.keys(ws)) {
    if (k.length === 0 || k[0] === "!") continue;
    try {
      const addr = XLSX.utils.decode_cell(k);
      max = Math.max(max, addr.c);
    } catch {
      /* skip */
    }
  }
  return max >= 0 ? max + 1 : 0;
}

export type ParsedTable = {
  columns: string[];
  rows: string[][];
};

export function normalizeCell(v: unknown): string {
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
  /** Первая строка может быть короче следующих — растягиваем до общей ширины. */
  const headerCells = hasHeader
    ? Array.from({ length: width }, (_, i) => headerRaw[i])
    : Array.from({ length: width }, (_, i) => `Колонка ${i + 1}`);
  const columns = headerCells.map((h, i) => normalizeCell(h) || `Колонка ${i + 1}`);
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

/** Чтение .txt / .csv / .xls / .xlsx в таблицу строк (как в few-shot и пакетном тесте). */
export async function parseUploadedTableFile(file: File): Promise<ParsedTable> {
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
    const matrix = XLSX.utils.sheet_to_json<(string | number | boolean | null)[]>(ws, {
      header: 1,
      raw: false,
      defval: "",
    });
    if (!Array.isArray(matrix) || matrix.length === 0) return { columns: [], rows: [] };

    let gridCols = 0;
    const ref = ws["!ref"];
    if (typeof ref === "string" && ref) {
      try {
        const range = XLSX.utils.decode_range(ref);
        gridCols = Math.max(0, range.e.c - range.s.c + 1);
      } catch {
        gridCols = 0;
      }
    }
    const fromCellAddresses = columnCountFromWorksheetCells(ws);
    const maxRowLen = Math.max(...matrix.map((r) => (Array.isArray(r) ? r.length : 0)), 1);
    const width = Math.max(gridCols, fromCellAddresses, maxRowLen, 1);

    const rawHeader = Array.isArray(matrix[0]) ? matrix[0] : [];
    const hasHeader = rawHeader.some((h) => /[a-zA-Zа-яА-Я]/.test(normalizeCell(h)));
    const headerCells = hasHeader
      ? Array.from({ length: width }, (_, i) => rawHeader[i])
      : Array.from({ length: width }, (_, i) => `Колонка ${i + 1}`);
    const columns = headerCells.map((h, i) => normalizeCell(h) || `Колонка ${i + 1}`);

    const body = hasHeader ? matrix.slice(1) : matrix;
    const rows = body.map((r) => {
      const row = Array.isArray(r) ? r : [];
      return Array.from({ length: columns.length }, (_, i) => normalizeCell(row[i]));
    });
    return { columns, rows };
  }
  throw new Error("Поддерживаются только .txt, .csv, .xls, .xlsx");
}
