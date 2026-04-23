/**
 * Устойчивое извлечение и парсинг JSON из ячеек датасета / ответов LLM.
 * Согласовано с shared/json_recovery.py (extract_json_from_response + parse_json_safe).
 * JSON5 — гибкий разбор (одинарные кавычки, ключи), аналог fallback ast.literal_eval в Python.
 */
import JSON5 from "json5";

function extractJsonLike(s: string): string {
  if (typeof s !== "string") return "";
  const m = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (m) return m[1].trim();

  const sStripped = s.replace(/^[\s*\-#>]+/, "").trimStart();
  const iObj = sStripped.indexOf("{");
  if (iObj !== -1) return sStripped.slice(iObj).trim();
  const iArr = sStripped.indexOf("[");
  if (iArr !== -1) return sStripped.slice(iArr).trim();
  return "";
}

function autofixCommas(s: string): string {
  let out = s.replace(/}\s*{/g, "}, {");
  out = out.replace(/}\s*\n\s*{/g, "},\n{");
  out = out.replace(/]\s*{/g, "], {");
  out = out.replace(/,\s*}/g, "}");
  out = out.replace(/,\s*]/g, "]");
  return out;
}

function balanceAndClose(s: string): string {
  let depthObj = 0;
  let depthArr = 0;
  let inString = false;
  let escape = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && !escape) {
      escape = true;
      continue;
    }
    if (escape) {
      if (ch === '"') escape = false;
      else escape = false;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (ch === "{") depthObj += 1;
      else if (ch === "}") {
        if (depthObj > 0) depthObj -= 1;
      } else if (ch === "[") depthArr += 1;
      else if (ch === "]") {
        if (depthArr > 0) depthArr -= 1;
      }
    }
  }

  let result = s;
  if (inString) {
    result += '"';
    if (/[,{]\s*"[^"]*"$/.test(result.trimEnd())) {
      result = result.trimEnd() + ": null";
    }
  }
  const sStripped = result.trimEnd();
  if (sStripped) {
    const last = sStripped[sStripped.length - 1];
    if (last === ":") result = result.trimEnd() + " null";
    else if (last === ",") result = sStripped.slice(0, -1).trimEnd();
  }

  let closing = "";
  if (depthArr > 0) closing += "]".repeat(depthArr);
  if (depthObj > 0) closing += "}".repeat(depthObj);
  if (closing) result += closing;
  return result;
}

export function extractJsonFromResponse(responseText: string): string {
  if (!responseText) return "";

  const responseLower = responseText.toLowerCase();
  const answerMarkers = ["ответ:", "answer:"] as const;
  for (const marker of answerMarkers) {
    let lastIdx = -1;
    let searchPos = 0;
    for (;;) {
      const idx = responseLower.indexOf(marker, searchPos);
      if (idx === -1) break;
      lastIdx = idx;
      searchPos = idx + 1;
    }
    if (lastIdx !== -1) {
      let jsonPart = responseText.slice(lastIdx + marker.length).trim();
      jsonPart = jsonPart.replace(/^[\n\r\t ]+/, "");
      const jsonBlocks = [...jsonPart.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)];
      if (jsonBlocks.length) {
        const extracted = jsonBlocks[jsonBlocks.length - 1][1].trim();
        if (extracted) return extracted;
      }
      const firstBrace = jsonPart.indexOf("{");
      const firstBracket = jsonPart.indexOf("[");
      let start = -1;
      if (firstBrace !== -1 && firstBracket !== -1) start = Math.min(firstBrace, firstBracket);
      else if (firstBrace !== -1) start = firstBrace;
      else if (firstBracket !== -1) start = firstBracket;
      if (start !== -1) {
        const extracted = jsonPart.slice(start).trim();
        if (extracted) return extracted;
      }
      if (jsonPart.trim()) return jsonPart;
    }
  }

  const blocks = [...responseText.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)];
  if (blocks.length) {
    const extracted = blocks[blocks.length - 1][1].trim();
    if (extracted) return extracted;
  }

  const firstBrace = responseText.indexOf("{");
  const firstBracket = responseText.indexOf("[");
  let start = -1;
  if (firstBrace !== -1 && firstBracket !== -1) start = Math.min(firstBrace, firstBracket);
  else if (firstBrace !== -1) start = firstBrace;
  else if (firstBracket !== -1) start = firstBracket;
  if (start !== -1) {
    const extracted = responseText.slice(start).trim();
    if (extracted) return extracted;
  }
  return responseText.trim();
}

/**
 * Как parse_json_safe в Python: сначала extract_json_from_response, затем _extract_json_like, затем нормализация.
 */
export function prepareCleanedJsonString(raw: string): {
  afterResponse: string;
  innerFragment: string;
  sClean: string;
} {
  const afterResponse = extractJsonFromResponse(raw) || raw;
  let innerFragment = extractJsonLike(afterResponse);
  if (!innerFragment) innerFragment = afterResponse.trim();

  let sClean = innerFragment;
  try {
    sClean = sClean.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\r/g, "\r");
  } catch {
    /* ignore */
  }
  sClean = sClean.replace(/\r/g, "").trim();

  sClean = sClean
    .replace(/\u201c/g, '"')
    .replace(/\u201d/g, '"')
    .replace(/\u201a/g, "'")
    .replace(/\u2018/g, "'");
  sClean = sClean.replace(/\bNone\b/g, "null");
  sClean = autofixCommas(sClean);
  sClean = balanceAndClose(sClean);
  sClean = sClean.replace(/,\s*,+/g, ",");
  sClean = sClean.replace(/,\s*}/g, "}");
  sClean = sClean.replace(/,\s*]/g, "]");

  return { afterResponse, innerFragment, sClean };
}

function tryParseNormalized(sClean: string): { ok: true; value: unknown } | { ok: false; jsonError: string; json5Error: string } {
  let jsonError = "";
  try {
    return { ok: true, value: JSON.parse(sClean) };
  } catch (e: unknown) {
    jsonError = e instanceof Error ? e.message : String(e);
  }
  const forJson5 = sClean
    .replace(/\bTrue\b/g, "true")
    .replace(/\bFalse\b/g, "false")
    .replace(/\bNone\b/g, "null");
  try {
    return { ok: true, value: JSON5.parse(forJson5) };
  } catch (e: unknown) {
    const json5Error = e instanceof Error ? e.message : String(e);
    return { ok: false, jsonError, json5Error };
  }
}

/**
 * Устойчивый парсинг: как parse_json_safe в Python; при полной неудаче — null (не путать с пустым объектом).
 */
export function parseJsonSafe(s: string): unknown | null {
  if (typeof s !== "string" || !s.trim()) return null;
  const { sClean } = prepareCleanedJsonString(s);
  const r = tryParseNormalized(sClean);
  if (r.ok) return r.value;
  return null;
}

/** Как parse_json_from_model_response в Python: extract + parse_json_safe (внутри prepareCleanedJsonString). */
export function parseJsonFromModelResponse(responseText: string): unknown | null {
  return parseJsonSafe(responseText);
}

export type DatasetParseFailure = {
  ok: false;
  error: string;
  /** Сообщения JSON.parse и JSON5 после нормализации (извлечение фрагмента, кавычки, скобки). */
  parseReason: string;
  /** Ошибка строгого JSON.parse по исходной ячейке (без восстановления). */
  strictCellError: string | null;
  /** Текст после extractJsonFromResponse (как в пайплайне LLM). */
  afterExtractPreview: string;
  /** После extractJsonLike: markdown / первая «{» или «[». */
  innerFragmentPreview: string;
  /** Строка, переданная в JSON.parse / JSON5 после нормализации (усечённо). */
  normalizedAttemptPreview: string;
};

export type DatasetParseResult = { ok: true; value: unknown } | DatasetParseFailure;

const PREVIEW_LEN = 1800;

function strictJsonError(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  try {
    JSON.parse(t);
    return null;
  } catch (e: unknown) {
    return e instanceof Error ? e.message : String(e);
  }
}

/**
 * Парсинг ячейки JSON датасета с диагностикой при ошибке (как в пайплайне LLM + пояснения для пользователя).
 */
export function parseDatasetFeaturesCell(raw: string): DatasetParseResult {
  const t = raw.trim();
  if (!t) {
    return {
      ok: false,
      error: "пустая ячейка",
      parseReason: "Ячейка пустая или содержит только пробелы.",
      strictCellError: null,
      afterExtractPreview: "",
      innerFragmentPreview: "",
      normalizedAttemptPreview: "",
    };
  }

  const strictCellError = strictJsonError(t);
  const { afterResponse, innerFragment, sClean } = prepareCleanedJsonString(t);
  const attempt = tryParseNormalized(sClean);

  if (attempt.ok) {
    return { ok: true, value: attempt.value };
  }

  const { jsonError, json5Error } = attempt;
  const parseReason = [
    `JSON.parse (после извлечения фрагмента и нормализации): ${jsonError}`,
    `JSON5 (расширенный синтаксис): ${json5Error}`,
  ].join("\n");

  const clip = (s: string) => (s.length > PREVIEW_LEN ? `${s.slice(0, PREVIEW_LEN)}…` : s);

  return {
    ok: false,
    error: "невалидный JSON",
    parseReason,
    strictCellError,
    afterExtractPreview: clip(afterResponse),
    innerFragmentPreview: clip(innerFragment),
    normalizedAttemptPreview: clip(sClean),
  };
}
