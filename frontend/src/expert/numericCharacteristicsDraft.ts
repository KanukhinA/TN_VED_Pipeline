/**
 * Черновик структуры «несколько числовых характеристик на корне JSON»:
 * каждая характеристика: массив объектов { [текстовый ключ]: компонент, [имя характеристики]: число }.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { suggestModelId } from "./expertDraft";

export const NUMERIC_CHARACTERISTICS_DRAFT_VERSION = 2;

/** Ключ массива «прочие характеристики» на корне JSON. */
export const PROCHEE_ROOT_KEY = "прочее";

/** Типовой набор строк для блока «прочее» (редактируемый в форме). */
export const DEFAULT_PROCHEE_TEMPLATE: ReadonlyArray<Record<string, unknown>> = [
  { параметр: "масса нетто единицы", масса: 50, единица: "кг" },
  { параметр: "масса брутто", масса: 1020, единица: "кг" },
  { параметр: "количество поддонов", количество: 20, единица: "шт" },
  { параметр: "количество мешков", количество: 1000, единица: "шт" },
  { параметр: "объем нетто единицы", объем: 10, единица: "л" },
  { параметр: "стандарт", значение: "ТУ 2184-037-32496445-02" },
  { параметр: "марка", значение: "N7-P20-K30-S3" },
];

export interface NumericCharacteristicLine {
  /**
   * Имя поля на корне JSON и одновременно имя числового поля в каждом элементе массива
   * (как «числовая характеристика 1» в примере).
   */
  characteristicKey: string;
  /**
   * Ключ текстового поля в строке массива: наименование компонента, вида массы, вещества и т.д.
   */
  componentColumnKey: string;
  /**
   * Допустимые значения поля значения (ключ componentColumnKey в строке массива).
   * Хранятся и сравниваются в нижнем регистре; пустой перечень: без ограничения enum.
   */
  allowedComponentValues?: string[];
}

/** Фиксированное текстовое поле-массив: ключ на корне совпадает с ключом внутри каждого элемента. */
export interface TextArrayFieldLine {
  /** Один и тот же ключ для массива на корне и для свойства в объекте строки. */
  fieldKey: string;
  /** Примеры допустимых значений (в схеме — enum для строки). */
  exampleValues?: string[];
}

/** Делит строку по запятым; запятые внутри "..." или '...' не разделяют. */
function splitLineByCommaRespectingQuotes(line: string): string[] {
  const parts: string[] = [];
  let buf = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      buf += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      buf += c;
      continue;
    }
    if (c === ",") {
      parts.push(buf);
      buf = "";
      continue;
    }
    buf += c;
  }
  parts.push(buf);
  return parts;
}

function trimAllowedValueSegment(seg: string): string {
  let t = seg.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    t = t.slice(1, -1).trim();
  }
  return t.replace(/^["']+|["']+$/g, "").trim();
}

/**
 * Разбор поля перечня: значения с новой строки и/или через запятую.
 * Значение с запятой внутри: в двойных или одинарных кавычках.
 * Регистр приводится к нижнему при сохранении.
 */
export function parseAllowedComponentValuesFromText(raw: string): string[] | undefined {
  const lines = raw.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    for (const seg of splitLineByCommaRespectingQuotes(line)) {
      const t = trimAllowedValueSegment(seg);
      if (t) out.push(t.toLowerCase());
    }
  }
  const uniq = [...new Set(out)];
  return uniq.length ? uniq : undefined;
}

/** Нормализация перечня: trim, lower case, без дубликатов. */
export function normalizeAllowedComponentValuesList(values: string[] | undefined): string[] | undefined {
  if (!values?.length) return undefined;
  const out = [...new Set(values.map((s) => String(s).trim().toLowerCase()).filter(Boolean))];
  return out.length ? out : undefined;
}

/**
 * Приводит ключи полей и перечень значений к нижнему регистру (единый канон для БД и валидации).
 * Название/описание справочника не трогаем: это человекочитаемые поля.
 */
function normalizeTextArrayFields(lines: TextArrayFieldLine[] | undefined): TextArrayFieldLine[] {
  const seen = new Set<string>();
  const out: TextArrayFieldLine[] = [];
  for (const raw of lines ?? []) {
    const fieldKey = String(raw?.fieldKey ?? "").trim().toLowerCase();
    if (!fieldKey || seen.has(fieldKey)) continue;
    seen.add(fieldKey);
    out.push({
      fieldKey,
      exampleValues: normalizeAllowedComponentValuesList(raw?.exampleValues),
    });
  }
  return out;
}

function cloneProcheeRows(rows: Array<Record<string, unknown>> | undefined): Array<Record<string, unknown>> {
  const src = rows?.length ? rows : [...DEFAULT_PROCHEE_TEMPLATE];
  return src.map((o) => ({ ...o }));
}

export function normalizeNumericCharacteristicsDraft(d: NumericCharacteristicsDraft): NumericCharacteristicsDraft {
  return {
    ...d,
    modelId: d.modelId.trim().toLowerCase(),
    characteristics: d.characteristics.map((c) => ({
      ...c,
      characteristicKey: c.characteristicKey.trim().toLowerCase(),
      componentColumnKey: c.componentColumnKey.trim().toLowerCase(),
      allowedComponentValues: normalizeAllowedComponentValuesList(c.allowedComponentValues),
    })),
    procheeEnabled: !!d.procheeEnabled,
    procheeRows: d.procheeRows?.length ? cloneProcheeRows(d.procheeRows) : undefined,
    textArrayFields: normalizeTextArrayFields(d.textArrayFields),
  };
}

/** Описание поля из шага «Структура»: ключи и при наличии перечень значений полей. */
export type StructureRowFieldDescriptor = {
  listKey: string;
  componentColumnKey: string;
  /** Путь в синтаксисе движка: массив, все элементы, поле значения */
  wildcardComponentPath: string;
  /** Пусто: перечень на шаге структуры не задан, в условиях остаётся только ручной ввод */
  allowedValues: string[];
};

/** Все поля из черновика (для шаблонов условий); allowedValues заполнен, если задан перечень значений. */
export function buildStructureRowDescriptors(draft: NumericCharacteristicsDraft): StructureRowFieldDescriptor[] {
  const d = normalizeNumericCharacteristicsDraft(draft);
  const numeric = d.characteristics
    .filter((c) => c.characteristicKey.trim() && c.componentColumnKey.trim())
    .map((c) => {
      const listKey = c.characteristicKey.trim();
      const comp = c.componentColumnKey.trim();
      return {
        listKey,
        componentColumnKey: comp,
        wildcardComponentPath: `${listKey}[*].${comp}`,
        allowedValues: normalizeAllowedComponentValuesList(c.allowedComponentValues) ?? [],
      };
    });
  const text = (d.textArrayFields ?? []).map((t) => {
    const k = t.fieldKey.trim();
    return {
      listKey: k,
      componentColumnKey: k,
      wildcardComponentPath: `${k}[*].${k}`,
      allowedValues: normalizeAllowedComponentValuesList(t.exampleValues) ?? [],
    };
  });
  return [...numeric, ...text];
}

/** Сопоставляет путь вида list[*].col или list[].col с полем из структуры. */
export function matchStructureRowDescriptorByPath(
  path: string,
  descriptors: StructureRowFieldDescriptor[],
): StructureRowFieldDescriptor | undefined {
  const n = path.trim().toLowerCase().replace(/\[\]/g, "[*]");
  return descriptors.find((f) => f.wildcardComponentPath.toLowerCase() === n);
}

/** Путь к числовому полю в строках массива (ключ числа совпадает с ключом поля на корне). */
export function matchStructureNumericValuePath(
  path: string,
  descriptors: StructureRowFieldDescriptor[],
): StructureRowFieldDescriptor | undefined {
  const n = path.trim().toLowerCase().replace(/\[\]/g, "[*]");
  return descriptors.find((d) => `${d.listKey}[*].${d.listKey}`.toLowerCase() === n);
}

/** Сопоставляет условие «строка массива» с полем из структуры (и перечнем значений, если он задан). */
export function matchStructureEnumByRow(
  arrayPath: string,
  nameField: string,
  descriptors: StructureRowFieldDescriptor[],
): StructureRowFieldDescriptor | undefined {
  const ap = arrayPath.trim().toLowerCase();
  const nf = nameField.trim().toLowerCase();
  return descriptors.find((f) => f.listKey === ap && f.componentColumnKey === nf);
}

export interface NumericCharacteristicsDraft {
  _version: typeof NUMERIC_CHARACTERISTICS_DRAFT_VERSION;
  catalogName: string;
  catalogDescription: string;
  modelId: string;
  /** Одна или несколько числовых характеристик (каждая: отдельный массив на корне). */
  characteristics: NumericCharacteristicLine[];
  /** Массив «прочее» на корне: строки с разным набором полей. */
  procheeEnabled?: boolean;
  procheeRows?: Array<Record<string, unknown>>;
  /** Поля вида key: [ { key: "..." }, ... ] с тем же именем ключа. */
  textArrayFields?: TextArrayFieldLine[];
}

export function defaultNumericCharacteristicsDraft(): NumericCharacteristicsDraft {
  return {
    _version: NUMERIC_CHARACTERISTICS_DRAFT_VERSION,
    catalogName: "",
    catalogDescription: "",
    modelId: "",
    /** Пустой список: поля добавляются в мастере кнопкой «Добавить поле». */
    characteristics: [],
    procheeEnabled: false,
    textArrayFields: [],
  };
}

export function serializeNumericCharacteristicsDraft(d: NumericCharacteristicsDraft): Record<string, unknown> {
  return { ...d, _version: NUMERIC_CHARACTERISTICS_DRAFT_VERSION };
}

export function parseNumericCharacteristicsDraft(raw: unknown): NumericCharacteristicsDraft | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.characteristics)) return null;
  try {
    const merged = { ...defaultNumericCharacteristicsDraft(), ...o };
    if (!Array.isArray(merged.characteristics)) merged.characteristics = [];
    merged.characteristics = merged.characteristics.map((c: any) => {
      const rawAllowed = c?.allowedComponentValues ?? c?.allowed_component_values;
      const allowed = Array.isArray(rawAllowed)
        ? rawAllowed.map((x: unknown) => String(x ?? "").trim()).filter(Boolean)
        : undefined;
      return {
        characteristicKey: String(c?.characteristicKey ?? c?.arrayKey ?? ""),
        componentColumnKey: String(c?.componentColumnKey ?? c?.nameKey ?? ""),
        allowedComponentValues: allowed?.length ? allowed : undefined,
      };
    });
    const rawText = (o as any).textArrayFields ?? (o as any).text_array_fields;
    if (Array.isArray(rawText)) {
      merged.textArrayFields = rawText.map((t: any) => ({
        fieldKey: String(t?.fieldKey ?? t?.field_key ?? ""),
        exampleValues: Array.isArray(t?.exampleValues ?? t?.example_values)
          ? (t?.exampleValues ?? t?.example_values).map((x: unknown) => String(x ?? "").trim()).filter(Boolean)
          : undefined,
      }));
    }
    merged.procheeEnabled = !!((o as any).procheeEnabled ?? (o as any).prochee_enabled);
    const pr = (o as any).procheeRows ?? (o as any).prochee_rows;
    if (Array.isArray(pr)) merged.procheeRows = pr as Array<Record<string, unknown>>;
    if (!Array.isArray(merged.textArrayFields)) merged.textArrayFields = [];
    merged._version = NUMERIC_CHARACTERISTICS_DRAFT_VERSION;
    return normalizeNumericCharacteristicsDraft(merged as NumericCharacteristicsDraft);
  } catch {
    return null;
  }
}

function procheePropertyDef(): { name: string; schema: Record<string, unknown> } {
  return {
    name: PROCHEE_ROOT_KEY,
    schema: {
      type: "array",
      min_items: 0,
      items: {
        type: "object",
        additional_properties: true,
        required: [],
        properties: [],
      },
    },
  };
}

function textArrayPropertyDef(fieldKey: string, exampleValues: string[] | undefined): { name: string; schema: Record<string, unknown> } {
  const k = fieldKey.trim();
  const strSchema: Record<string, unknown> = { type: "string" };
  const allowed = normalizeAllowedComponentValuesList(exampleValues);
  if (allowed?.length) strSchema.constraints = { enum: allowed };
  return {
    name: k,
    schema: {
      type: "array",
      min_items: 1,
      items: {
        type: "object",
        additional_properties: false,
        required: [k],
        properties: [{ name: k, schema: strSchema }],
      },
    },
  };
}

/** Схема Rule DSL под структуру с несколькими массивами числовых характеристик на корне. */
export function numericCharacteristicsToDsl(draft: NumericCharacteristicsDraft): any {
  const normalized = normalizeNumericCharacteristicsDraft(draft);
  const model_id = (normalized.modelId || suggestModelId(normalized.catalogName || "spravochnik")).trim().toLowerCase();
  const seen = new Set<string>();
  const lines = normalized.characteristics.filter((c) => {
    const k = c.characteristicKey.trim();
    if (!k || !c.componentColumnKey.trim()) return false;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const numericProps = lines.map((c) => {
    const k = c.characteristicKey.trim();
    const comp = c.componentColumnKey.trim();
    const allowed = normalizeAllowedComponentValuesList(c.allowedComponentValues);
    const compSchema: Record<string, unknown> = { type: "string" };
    if (allowed?.length) {
      compSchema.constraints = { enum: allowed };
    }
    return {
      name: k,
      schema: {
        type: "array",
        min_items: 1,
        items: {
          type: "object",
          additional_properties: false,
          required: [comp, k],
          properties: [
            { name: comp, schema: compSchema },
            { name: k, schema: { type: "number" } },
          ],
        },
      },
    };
  });

  const extra: Array<{ name: string; schema: Record<string, unknown> }> = [];
  if (normalized.procheeEnabled && !seen.has(PROCHEE_ROOT_KEY)) {
    seen.add(PROCHEE_ROOT_KEY);
    extra.push(procheePropertyDef());
  }
  for (const t of normalized.textArrayFields ?? []) {
    const fk = t.fieldKey.trim();
    if (!fk || seen.has(fk)) continue;
    seen.add(fk);
    extra.push(textArrayPropertyDef(fk, t.exampleValues));
  }

  const properties = [...numericProps, ...extra];

  return {
    model_id,
    schema: {
      type: "object",
      additional_properties: false,
      required: properties.map((p) => p.name),
      properties,
    },
    cross_rules: [],
    meta: {
      name: normalized.catalogName || undefined,
      description: normalized.catalogDescription || undefined,
      version_label: "numeric-characteristics-2",
      numeric_characteristics_draft: serializeNumericCharacteristicsDraft({
        ...normalized,
        modelId: model_id,
      }),
    },
  };
}

/** Две пустые строки массива в примере: только структура ключей, значения null. */
const SAMPLE_ROW_COUNT = 2;
/** Для текстовых характеристик в примере нужен только один элемент массива. */
const TEXT_SAMPLE_ROW_COUNT = 1;

export function generateNumericCharacteristicsSampleJson(draft: NumericCharacteristicsDraft): Record<string, unknown> {
  const d = normalizeNumericCharacteristicsDraft(draft);
  const out: Record<string, unknown> = {};
  for (const c of d.characteristics) {
    const k = c.characteristicKey.trim();
    const comp = c.componentColumnKey.trim();
    if (!k || !comp) continue;
    const allowed = normalizeAllowedComponentValuesList(c.allowedComponentValues);
    out[k] = Array.from({ length: SAMPLE_ROW_COUNT }, (_, i) => ({
      [comp]: allowed?.length ? allowed[i % allowed.length] : null,
      [k]: null,
    }));
  }
  if (d.procheeEnabled) {
    out[PROCHEE_ROOT_KEY] = d.procheeRows?.length ? cloneProcheeRows(d.procheeRows) : cloneProcheeRows(undefined);
  }
  for (const t of d.textArrayFields ?? []) {
    const k = t.fieldKey.trim();
    if (!k) continue;
    const examples = normalizeAllowedComponentValuesList(t.exampleValues) ?? [];
    out[k] = Array.from({ length: TEXT_SAMPLE_ROW_COUNT }, (_, i) => ({
      [k]: examples.length ? examples[i % examples.length] : null,
    }));
  }
  return out;
}

/** Отформатированный пример корня JSON (2 пробела), только заполненные поля-массивы. */
export function formatNumericCharacteristicsSampleJson(draft: NumericCharacteristicsDraft): string {
  const obj = generateNumericCharacteristicsSampleJson(draft);
  return JSON.stringify(obj, null, 2);
}
