/**
 * Черновик «разговорного» мастера: отраслевой язык → Rule DSL под капотом.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { normalizeTnVedEaeuCode } from "../catalog/tnVedCode";

export const EXPERT_DRAFT_VERSION = 2;

/**
 * Одна строка перечня показателей: наименование как в документе.
 * (В данных поле по-прежнему хранится в id: текстовый ключ строки таблицы.)
 * shareFrom/shareTo: устаревшее хранение допусков; для новых справочников диапазон задаётся в карточке класса.
 */
export interface ExpertIndicator {
  /** Наименование показателя так, как оно должно быть в документе */
  id: string;
  /** @deprecated задаётся в классе, см. ExpertClassIndicatorBounds */
  shareFrom?: number;
  /** @deprecated задаётся в классе, см. ExpertClassIndicatorBounds */
  shareTo?: number;
}

/** Операция сравнения для порога по числовому столбцу перечня (совпадает с Rule DSL). */
export type ExpertClassConditionOp = "equals" | "gte" | "lte" | "gt" | "lt";

/** Условие по строке перечня: наименование показателя + порог по значению. */
export interface ExpertClassConditionRow {
  indicatorName: string;
  op: ExpertClassConditionOp;
  value: number;
  conjunction?: "and" | "or";
  /** true по умолчанию: обязательно для подтверждения класса; false — необязательное уточнение */
  primary?: boolean;
}

/**
 * Допустимый диапазон числового значения показателя, задаётся при настройке класса.
 * По всем классам границы объединяются в общие min/max числового столбца в схеме.
 */
export interface ExpertClassIndicatorBounds {
  indicatorName: string;
  min?: number;
  max?: number;
}

/** Правило присвоения класса декларации (все условия по И). */
export interface ExpertClassRule {
  classId: string;
  /** Код ТН ВЭД ЕАЭС (2, 4, 6, 8 или 10 цифр) для номенклатурной привязки класса */
  tnVedGroupCode: string;
  title: string;
  priority: number;
  /** Допустимые значения показателей для этого класса (влияют на схему вместе с другими классами). */
  indicatorBounds: ExpertClassIndicatorBounds[];
  conditions: ExpertClassConditionRow[];
}

export interface ExpertCatalogDraft {
  _version: typeof EXPERT_DRAFT_VERSION;
  catalogName: string;
  catalogDescription: string;
  /** Явный model_id; если пусто, генерируется при сохранении */
  modelId: string;
  mainSectionTitle: string;
  codeColumnTitle: string;
  valueColumnTitle: string;
  indicators: ExpertIndicator[];
  includeMiscSection: boolean;
  miscSectionTitle: string;
  /** Оба раздела должны присутствовать в документе */
  requireBothSectionsPresent: boolean;
  enforceSumOfShares: boolean;
  sumOfSharesTarget: number;
  classRules: ExpertClassRule[];
}

export function defaultExpertDraft(): ExpertCatalogDraft {
  return {
    _version: EXPERT_DRAFT_VERSION,
    catalogName: "",
    catalogDescription: "",
    modelId: "",
    mainSectionTitle: "показатели",
    codeColumnTitle: "наименование",
    valueColumnTitle: "значение",
    indicators: [],
    includeMiscSection: true,
    miscSectionTitle: "прочие сведения",
    requireBothSectionsPresent: true,
    enforceSumOfShares: false,
    sumOfSharesTarget: 100,
    classRules: [
      {
        classId: "прочее",
        tnVedGroupCode: "",
        title: "",
        priority: 1000,
        indicatorBounds: [],
        conditions: [],
      },
    ],
  };
}

function normalizeClassConditionOp(raw: unknown): ExpertClassConditionOp {
  const s = String(raw ?? "gte");
  const allowed: ExpertClassConditionOp[] = ["equals", "gte", "lte", "gt", "lt"];
  return allowed.includes(s as ExpertClassConditionOp) ? (s as ExpertClassConditionOp) : "gte";
}

function normalizeClassIndicatorBounds(raw: unknown): ExpertClassIndicatorBounds[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((b: any) => ({
    indicatorName: String(b?.indicatorName ?? ""),
    min: b?.min != null && Number.isFinite(Number(b.min)) ? Number(b.min) : undefined,
    max: b?.max != null && Number.isFinite(Number(b.max)) ? Number(b.max) : undefined,
  }));
}

function normalizeClassRules(raw: unknown): ExpertClassRule[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((r: any) => ({
    classId: String(r?.classId ?? r?.class_id ?? "")
      .trim()
      .toLowerCase(),
    tnVedGroupCode: normalizeTnVedEaeuCode(String(r?.tnVedGroupCode ?? r?.tn_ved_group_code ?? "")) ?? "",
    title: String(r?.title ?? ""),
    priority: typeof r?.priority === "number" && Number.isFinite(r.priority) ? r.priority : Number(r?.priority) || 0,
    indicatorBounds: normalizeClassIndicatorBounds(r?.indicatorBounds),
    conditions: Array.isArray(r?.conditions)
      ? r.conditions.map((c: any) => ({
          indicatorName: String(c?.indicatorName ?? c?.name_equals ?? ""),
          op: normalizeClassConditionOp(c?.op),
          value: typeof c?.value === "number" && Number.isFinite(c.value) ? c.value : Number(c?.value) || 0,
          conjunction: c?.conjunction === "or" ? "or" : "and",
          primary: c?.primary !== false,
        }))
      : [],
  }));
}

function mergeClassificationFromDsl(draft: ExpertCatalogDraft, dsl: any): void {
  const c = dsl?.classification;
  if (!c || !Array.isArray(c.rules) || !c.rules.length) return;
  draft.classRules = c.rules.map((r: any) => ({
    classId: String(r.class_id ?? "")
      .trim()
      .toLowerCase(),
    tnVedGroupCode: normalizeTnVedEaeuCode(String(r.tn_ved_group_code ?? "")) ?? "",
    title: String(r.title ?? ""),
    priority: typeof r.priority === "number" && Number.isFinite(r.priority) ? r.priority : Number(r.priority) || 0,
    indicatorBounds: [],
    conditions: (Array.isArray(r.conditions) ? r.conditions : [])
      .filter((cond: any) => cond?.type === "rowIndicator")
      .map((cond: any) => ({
        indicatorName: String(cond.name_equals ?? ""),
        op: normalizeClassConditionOp(cond.op),
        value:
          typeof cond.value === "number" && Number.isFinite(cond.value)
            ? cond.value
            : Number(cond.value) || 0,
        conjunction: cond.conjunction === "or" ? "or" : "and",
        primary: cond.primary !== false,
      })),
  }));
}

const CYRILLIC_LATIN: Record<string, string> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ё: "e",
  ж: "zh",
  з: "z",
  и: "i",
  й: "y",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "h",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "sch",
  ъ: "",
  ы: "y",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
};

export function slugifyModelId(name: string): string {
  const lower = name.trim().toLowerCase();
  let out = "";
  for (const ch of lower) {
    if (CYRILLIC_LATIN[ch]) out += CYRILLIC_LATIN[ch];
    else if (/[a-z0-9]/.test(ch)) out += ch;
    else if (/\s|[-_]/.test(ch)) out += "_";
  }
  const collapsed = out.replace(/_+/g, "_").replace(/^_|_$/g, "");
  return collapsed || "spravochnik";
}

export function suggestModelId(catalogName: string): string {
  const base = slugifyModelId(catalogName);
  return `${base}_${Date.now().toString(36)}`;
}

/** Объединённый диапазон для числовой колонки (одна схема на все строки). */
function mergedShareRange(indicators: ExpertIndicator[]): { min: number; max: number } {
  const mins = indicators.map((i) => (Number.isFinite(i.shareFrom as number) ? i.shareFrom! : 0));
  const maxs = indicators.map((i) => (Number.isFinite(i.shareTo as number) ? i.shareTo! : 100));
  return {
    min: mins.length ? Math.min(...mins) : 0,
    max: maxs.length ? Math.max(...maxs) : 100,
  };
}

/**
 * Границы числового столбца: из допусков в карточках классов; если их нет, из устаревших полей перечня (шаг 2).
 */
export function mergedValueRangeForSchema(draft: ExpertCatalogDraft): { min: number; max: number } {
  const ids = draft.indicators.map((i) => i.id.trim()).filter(Boolean);
  const mins: number[] = [];
  const maxs: number[] = [];
  for (const rule of draft.classRules) {
    for (const b of rule.indicatorBounds ?? []) {
      const n = b.indicatorName.trim();
      if (!n || !ids.includes(n)) continue;
      if (b.min != null && Number.isFinite(b.min)) mins.push(b.min);
      if (b.max != null && Number.isFinite(b.max)) maxs.push(b.max);
    }
  }
  if (mins.length || maxs.length) {
    return {
      min: mins.length ? Math.min(...mins) : mergedShareRange(draft.indicators).min,
      max: maxs.length ? Math.max(...maxs) : mergedShareRange(draft.indicators).max,
    };
  }
  return mergedShareRange(draft.indicators);
}

function valueRangeForIndicatorRow(draft: ExpertCatalogDraft, indicatorId: string): { min: number; max: number } {
  const global_ = mergedValueRangeForSchema(draft);
  const mins: number[] = [];
  const maxs: number[] = [];
  const id = indicatorId.trim();
  for (const rule of draft.classRules) {
    for (const b of rule.indicatorBounds ?? []) {
      if (b.indicatorName.trim() !== id) continue;
      if (b.min != null && Number.isFinite(b.min)) mins.push(b.min);
      if (b.max != null && Number.isFinite(b.max)) maxs.push(b.max);
    }
  }
  return {
    min: mins.length ? Math.min(...mins) : global_.min,
    max: maxs.length ? Math.max(...maxs) : global_.max,
  };
}

export function draftToDsl(draft: ExpertCatalogDraft): any {
  const model_id = (draft.modelId || suggestModelId(draft.catalogName || "spravochnik")).trim();
  const codes = draft.indicators.map((i) => i.id.trim()).filter(Boolean);
  const { min: vmin, max: vmax } = mergedValueRangeForSchema(draft);

  const rowObject: any = {
    type: "object",
    additional_properties: false,
    required: [draft.codeColumnTitle, draft.valueColumnTitle],
    properties: [
      {
        name: draft.codeColumnTitle,
        schema: {
          type: "string",
          constraints: codes.length ? { enum: codes } : undefined,
        },
      },
      {
        name: draft.valueColumnTitle,
        schema: {
          type: "number",
          constraints: { min: vmin, max: vmax },
        },
      },
    ],
  };

  const mainProp = {
    name: draft.mainSectionTitle,
    schema: {
      type: "array",
      min_items: 1,
      items: rowObject,
    },
  };

  const miscProp = {
    name: draft.miscSectionTitle,
    schema: {
      type: "array",
      min_items: 0,
      items: {
        type: "object",
        additional_properties: false,
        required: ["параметр"],
        properties: [
          { name: "параметр", schema: { type: "string" } },
          { name: "масса", schema: { type: "number", constraints: { min: 0 } } },
          { name: "единица", schema: { type: "string" } },
          { name: "количество", schema: { type: "number", constraints: { min: 0 } } },
          { name: "значение", schema: { type: "string" } },
        ],
      },
    },
  };

  const rootProps = draft.includeMiscSection ? [mainProp, miscProp] : [mainProp];
  const requiredRoot = draft.includeMiscSection
    ? [draft.mainSectionTitle, draft.miscSectionTitle]
    : [draft.mainSectionTitle];

  const cross_rules: any[] = [];
  if (draft.enforceSumOfShares && Number.isFinite(draft.sumOfSharesTarget)) {
    cross_rules.push({
      template: "sumEquals",
      path: `${draft.mainSectionTitle}[*].${draft.valueColumnTitle}`,
      expected: draft.sumOfSharesTarget,
      tolerance: 0.0001,
    });
  }
  if (draft.requireBothSectionsPresent && draft.includeMiscSection) {
    cross_rules.push({
      template: "atLeastOnePresent",
      paths: [draft.mainSectionTitle, draft.miscSectionTitle],
      min_count: 2,
    });
  }

  const mainPath = draft.mainSectionTitle.trim();
  const nameField = draft.codeColumnTitle.trim();
  const valueField = draft.valueColumnTitle.trim();
  let classification: Record<string, unknown> | undefined;
  if (mainPath && nameField && valueField) {
    const rules = draft.classRules
      .map((r) => {
        const class_id = r.classId.trim().toLowerCase();
        if (!class_id) return null;
        const conditions = r.conditions
          .filter((c) => c.indicatorName.trim())
          .map((c) => {
            const row: Record<string, unknown> = {
              type: "rowIndicator",
              array_path: mainPath,
              name_field: nameField,
              name_equals: c.indicatorName.trim(),
              value_field: valueField,
              op: c.op,
              value: c.value,
            };
            if (c.conjunction === "or") row.conjunction = "or";
            if (c.primary === false) row.primary = false;
            return row;
          });
        const tn = normalizeTnVedEaeuCode(r.tnVedGroupCode ?? "");
        const row: Record<string, unknown> = {
          class_id,
          title: r.title.trim() || undefined,
          priority: r.priority,
          conditions,
        };
        if (tn) row.tn_ved_group_code = tn;
        return row;
      })
      .filter(Boolean) as Array<{
      class_id: string;
      title?: string;
      priority: number;
      conditions: Array<Record<string, unknown>>;
    }>;

    if (rules.length) {
      classification = {
        strategy: "exactly_one",
        rules,
        ambiguous_match_resolution: "by_priority",
      };
    }
  }

  const meta: any = {
    name: draft.catalogName || undefined,
    description: draft.catalogDescription || undefined,
    version_label: "expert-1",
    expert_draft: serializeExpertDraft(draft),
  };

  return {
    model_id,
    meta,
    schema: {
      type: "object",
      additional_properties: false,
      required: requiredRoot,
      properties: rootProps,
    },
    cross_rules,
    ...(classification ? { classification } : {}),
  };
}

export function serializeExpertDraft(draft: ExpertCatalogDraft): Record<string, unknown> {
  return { ...draft, _version: EXPERT_DRAFT_VERSION };
}

export function parseExpertDraft(raw: unknown): ExpertCatalogDraft | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o._version !== EXPERT_DRAFT_VERSION && o._version !== undefined) {
    /* допускаем отсутствие _version для старых данных */
  }
  try {
    const merged = { ...defaultExpertDraft(), ...o };
    if (!Array.isArray(merged.indicators)) merged.indicators = [];
    merged.indicators = merged.indicators.map((i: any) => ({
      id: String(i?.id ?? ""),
      shareFrom: i?.shareFrom != null ? Number(i.shareFrom) : undefined,
      shareTo: i?.shareTo != null ? Number(i.shareTo) : undefined,
    }));
    merged.classRules = normalizeClassRules(merged.classRules);
    merged._version = EXPERT_DRAFT_VERSION;
    return merged as ExpertCatalogDraft;
  } catch {
    return null;
  }
}

/**
 * Пытается восстановить черновик из DSL (без meta.expert_draft).
 * Успех только для схемы «корень: два раздела, первый: массив строка+число».
 */
export function tryDslToDraft(dsl: any): ExpertCatalogDraft | null {
  if (!dsl?.schema || dsl.schema.type !== "object") return null;
  const props = dsl.schema.properties as any[] | undefined;
  if (!Array.isArray(props) || props.length < 1) return null;

  let main: any = null;
  let misc: any = null;
  for (const p of props) {
    if (p?.schema?.type === "array" && p?.schema?.items?.type === "object") {
      if (!main) main = p;
      else if (!misc) misc = p;
    }
  }
  if (!main) return null;

  const mainSectionTitle = main.name;
  const items = main.schema.items;
  const itemProps = items.properties as any[];
  if (!Array.isArray(itemProps) || itemProps.length < 2) return null;
  const strField = itemProps.find((p) => p?.schema?.type === "string");
  const numField = itemProps.find((p) => p?.schema?.type === "number" || p?.schema?.type === "integer");
  if (!strField || !numField) return null;

  const enumVals = strField.schema?.constraints?.enum;
  const indicators: ExpertIndicator[] = Array.isArray(enumVals)
    ? enumVals.map((id: string) => ({
        id: String(id),
        shareFrom: numField.schema?.constraints?.min,
        shareTo: numField.schema?.constraints?.max,
      }))
    : [];

  const cr = Array.isArray(dsl.cross_rules) ? dsl.cross_rules : [];
  const sumRule = cr.find((r: any) => r?.template === "sumEquals");
  const presenceRule = cr.find((r: any) => r?.template === "atLeastOnePresent");

  const draft = defaultExpertDraft();
  draft.catalogName = dsl.meta?.name ?? "";
  draft.catalogDescription = dsl.meta?.description ?? "";
  draft.modelId = dsl.model_id ?? "";
  draft.mainSectionTitle = mainSectionTitle;
  draft.codeColumnTitle = strField.name;
  draft.valueColumnTitle = numField.name;
  draft.indicators = indicators;
  draft.includeMiscSection = !!misc;
  draft.miscSectionTitle = misc?.name ?? draft.miscSectionTitle;
  draft.enforceSumOfShares = !!sumRule;
  draft.sumOfSharesTarget = sumRule?.expected ?? 100;
  draft.requireBothSectionsPresent = !!(
    presenceRule &&
    draft.includeMiscSection &&
    Array.isArray(presenceRule.paths) &&
    presenceRule.paths.length >= 2
  );

  mergeClassificationFromDsl(draft, dsl);
  return draft;
}

export function loadDraftFromDslResponse(full: any): ExpertCatalogDraft | null {
  const fromMeta = parseExpertDraft(full?.dsl?.meta?.expert_draft ?? full?.meta?.expert_draft);
  if (fromMeta) return fromMeta;
  return tryDslToDraft(full?.dsl ?? full);
}

/** Черновик JSON для проверки кнопки «Проверить»: из текущих настроек, не из статического примера. */
export function generateSampleJson(draft: ExpertCatalogDraft): Record<string, unknown> {
  const fallbackDraft =
    draft.indicators.length > 0
      ? draft
      : { ...draft, indicators: [{ id: "example", shareFrom: 0, shareTo: 10 }] };
  const { min: vmin, max: vmax } = mergedValueRangeForSchema(fallbackDraft);
  const mid = (vmin + vmax) / 2;

  const rows = draft.indicators.length
    ? draft.indicators.map((i) => {
        const { min: lo, max: hi } = valueRangeForIndicatorRow(draft, i.id);
        const v = (lo + hi) / 2;
        return {
          [draft.codeColumnTitle]: i.id.trim() || "показатель",
          [draft.valueColumnTitle]: Math.round(v * 1000) / 1000,
        };
      })
    : [
        {
          [draft.codeColumnTitle]: "пример",
          [draft.valueColumnTitle]: mid,
        },
      ];

  const out: Record<string, unknown> = {
    [draft.mainSectionTitle]: rows,
  };

  if (draft.includeMiscSection) {
    out[draft.miscSectionTitle] = [
      { параметр: "строка_1", значение: "пример" },
      { параметр: "строка_2", количество: 1.0, единица: "шт" },
    ];
  }

  return out;
}
