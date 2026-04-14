/* eslint-disable @typescript-eslint/no-explicit-any */
import React from "react";
import type { StructureRowFieldDescriptor } from "../expert/numericCharacteristicsDraft";
import { normalizeTnVedEaeuCode } from "../catalog/tnVedCode";
import {
  classIdFromTnVedClassifierTitle,
  getTnVedClassifierTitleForCode,
  isTnVedGenericProchieTitle,
  shouldAutofillClassIdFromClassifier,
} from "../catalog/tnVedEaeuTree";
import StructureEnumValueControl from "./StructureEnumValueControl";
import TnVedGroupTreePicker from "./TnVedGroupTreePicker";

type PathCond = {
  type: "path";
  path: string;
  op: string;
  value?: unknown;
  group_id?: string;
  conjunction?: "and" | "or";
  /** false: необязательное уточнение; по умолчанию основное условие */
  primary?: boolean;
};

type RowCond = {
  type: "rowIndicator";
  array_path: string;
  name_field: string;
  value_field: string;
  name_equals: string;
  op: string;
  value?: unknown;
  /** Числовой диапазон в одной строке массива поля (границы включаются); предпочтительный формат для UI */
  value_min?: number;
  value_max?: number;
  group_id?: string;
  conjunction?: "and" | "or";
  /** false: необязательное уточнение; по умолчанию основное условие */
  primary?: boolean;
};

/** Формула над несколькими строками массива: имена переменных → компоненты, затем выражение (+ − * / скобки). */
type RowFormulaCond = {
  type: "rowFormula";
  array_path: string;
  name_field: string;
  value_field: string;
  variables: Record<string, string>;
  formula: string;
  op: "equals" | "gt" | "gte" | "lt" | "lte";
  value: number;
  tolerance_rel?: number;
  group_id?: string;
  conjunction?: "and" | "or";
  primary?: boolean;
};

/** Две строки одного массива: value(A) : value(B) ≈ ratio_left : ratio_right (как N:S = 2:1). */
type RowPairRatioCond = {
  type: "rowPairRatio";
  array_path: string;
  name_field: string;
  value_field: string;
  left_name: string;
  right_name: string;
  ratio_left: number;
  ratio_right: number;
  /** Относительная погрешность для перекрёстного произведения (по умолчанию 0.001) */
  tolerance_rel?: number;
  group_id?: string;
  conjunction?: "and" | "or";
  primary?: boolean;
};

type UiCondition = PathCond | RowCond | RowPairRatioCond | RowFormulaCond;

export type UiClassRule = {
  class_id: string;
  /** Код ТН ВЭД ЕАЭС (2–10 цифр), обязателен при заданном идентификаторе класса */
  tn_ved_group_code: string;
  title: string;
  priority: number;
  condition_groups: string[];
  conditions: UiCondition[];
};

export type UiClassification = {
  rules: UiClassRule[];
};

const PATH_OPS_LABEL: { value: string; label: string }[] = [
  { value: "equals", label: "равно" },
  { value: "notEquals", label: "не равно" },
  { value: "in", label: "одно из перечня" },
  { value: "regex", label: "соответствует regex" },
  { value: "notRegex", label: "не соответствует regex" },
  { value: "exists", label: "значение указано" },
  { value: "notExists", label: "значения нет" },
];

const PATH_STRING_OPS = new Set(["equals", "notEquals", "in", "regex", "notRegex"]);

const DEFAULT_MISC_CLASS_PRIORITY = 1000;

type UiCheckKind = "numberInRow" | "labelValue" | "sectionPresent" | "rowPairRatio" | "rowFormula";

const FORMULA_VAR_ID_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

const ROW_FORMULA_OPS_LABEL: { value: RowFormulaCond["op"]; label: string }[] = [
  { value: "equals", label: "равно" },
  { value: "gt", label: "больше" },
  { value: "gte", label: "не меньше" },
  { value: "lt", label: "меньше" },
  { value: "lte", label: "не больше" },
];

/** Все правила с непустым class_id имеют выбранный код ТН ВЭД ЕАЭС */
export function classificationHasTnVedForAllRules(ui: UiClassification): boolean {
  return ui.rules.every((r) => {
    const id = r.class_id;
    if (!id) return true;
    return !!normalizeTnVedEaeuCode(r.tn_ved_group_code ?? "");
  });
}

function emptyClassification(): UiClassification {
  return {
    rules: [emptyRule("прочее", DEFAULT_MISC_CLASS_PRIORITY)],
  };
}

function parseOptionalFiniteNumber(v: unknown): number | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function condPrimaryFromDsl(raw: any): { primary?: false } {
  return raw?.primary === false ? { primary: false } : {};
}

function condConjunctionFromDsl(raw: any): { conjunction?: "or" } {
  return raw?.conjunction === "or" ? { conjunction: "or" } : {};
}

function condGroupIdFromDsl(raw: any): { group_id?: string } {
  const groupId = String(raw?.group_id ?? "").trim();
  return groupId ? { group_id: groupId } : {};
}

function parseCondition(raw: any): UiCondition | null {
  if (!raw || typeof raw !== "object") return null;
  if (raw.type === "rowFormula") {
    const variables: Record<string, string> = {};
    const varsRaw = raw.variables;
    if (varsRaw && typeof varsRaw === "object" && !Array.isArray(varsRaw)) {
      for (const [k, v] of Object.entries(varsRaw)) {
        const id = String(k).trim();
        const comp = String(v ?? "").trim().toLowerCase();
        if (id && comp) variables[id] = comp;
      }
    }
    const opRaw = String(raw.op ?? "equals");
    const op = (["equals", "gt", "gte", "lt", "lte"].includes(opRaw) ? opRaw : "equals") as RowFormulaCond["op"];
    const val = parseOptionalFiniteNumber(raw.value);
    const tolRaw = parseOptionalFiniteNumber(raw.tolerance_rel);
    return {
      type: "rowFormula",
      array_path: String(raw.array_path ?? ""),
      name_field: String(raw.name_field ?? ""),
      value_field: String(raw.value_field ?? ""),
      variables,
      formula: String(raw.formula ?? ""),
      op,
      value: val ?? 0,
      tolerance_rel: tolRaw !== undefined && Number.isFinite(tolRaw) && tolRaw >= 0 ? tolRaw : 0.001,
      ...condGroupIdFromDsl(raw),
      ...condConjunctionFromDsl(raw),
      ...condPrimaryFromDsl(raw),
    };
  }
  if (raw.type === "rowPairRatio") {
    const rl = parseOptionalFiniteNumber(raw.ratio_left) ?? 1;
    const rr = parseOptionalFiniteNumber(raw.ratio_right) ?? 1;
    const tolRaw = parseOptionalFiniteNumber(raw.tolerance_rel);
    const tolerance_rel =
      tolRaw !== undefined && Number.isFinite(tolRaw) && tolRaw >= 0 ? tolRaw : 0.001;
    return {
      type: "rowPairRatio",
      array_path: String(raw.array_path ?? ""),
      name_field: String(raw.name_field ?? ""),
      value_field: String(raw.value_field ?? ""),
      left_name: String(raw.left_name ?? "").trim().toLowerCase(),
      right_name: String(raw.right_name ?? "").trim().toLowerCase(),
      ratio_left: rl,
      ratio_right: rr,
      tolerance_rel,
      ...condGroupIdFromDsl(raw),
      ...condConjunctionFromDsl(raw),
      ...condPrimaryFromDsl(raw),
    };
  }
  if (raw.type === "path") {
    return {
      type: "path",
      path: String(raw.path ?? ""),
      op: String(raw.op ?? "equals"),
      value: raw.value,
      ...condGroupIdFromDsl(raw),
      ...condConjunctionFromDsl(raw),
      ...condPrimaryFromDsl(raw),
    };
  }
  if (raw.type === "rowIndicator") {
    const array_path = String(raw.array_path ?? "");
    const name_field = String(raw.name_field ?? "");
    const value_field = String(raw.value_field ?? "");
    const name_equals = String(raw.name_equals ?? "");
    const vmin = parseOptionalFiniteNumber(raw.value_min);
    const vmax = parseOptionalFiniteNumber(raw.value_max);
    if (vmin !== undefined || vmax !== undefined) {
      return {
        type: "rowIndicator",
        array_path,
        name_field,
        value_field,
        name_equals,
        op: "exists",
        value: undefined,
        value_min: vmin,
        value_max: vmax,
        ...condGroupIdFromDsl(raw),
        ...condConjunctionFromDsl(raw),
        ...condPrimaryFromDsl(raw),
      };
    }
    const op = String(raw.op ?? "gte");
    const value = raw.value;
    if (op === "gte" && typeof value === "number" && Number.isFinite(value)) {
      return {
        type: "rowIndicator",
        array_path,
        name_field,
        value_field,
        name_equals,
        op: "exists",
        value: undefined,
        value_min: value,
        value_max: undefined,
        ...condGroupIdFromDsl(raw),
        ...condConjunctionFromDsl(raw),
        ...condPrimaryFromDsl(raw),
      };
    }
    if (op === "lte" && typeof value === "number" && Number.isFinite(value)) {
      return {
        type: "rowIndicator",
        array_path,
        name_field,
        value_field,
        name_equals,
        op: "exists",
        value: undefined,
        value_min: undefined,
        value_max: value,
        ...condGroupIdFromDsl(raw),
        ...condConjunctionFromDsl(raw),
        ...condPrimaryFromDsl(raw),
      };
    }
    if (op === "equals" && typeof value === "number" && Number.isFinite(value)) {
      return {
        type: "rowIndicator",
        array_path,
        name_field,
        value_field,
        name_equals,
        op: "exists",
        value: undefined,
        value_min: value,
        value_max: value,
        ...condGroupIdFromDsl(raw),
        ...condConjunctionFromDsl(raw),
        ...condPrimaryFromDsl(raw),
      };
    }
    return {
      type: "rowIndicator",
      array_path,
      name_field,
      value_field,
      name_equals,
      op,
      value,
      ...condGroupIdFromDsl(raw),
      ...condConjunctionFromDsl(raw),
      ...condPrimaryFromDsl(raw),
    };
  }
  return null;
}

function nextConditionGroupId(usedIds: string[]): string {
  for (let n = 1; n < 500; n++) {
    const id = `group_${n}`;
    if (!usedIds.includes(id)) return id;
  }
  return `group_${Date.now()}`;
}

function normalizeRuleConditionGroups(conditionGroups: string[] | undefined, conditions: UiCondition[]): { condition_groups: string[]; conditions: UiCondition[] } {
  const parsedGroups = Array.isArray(conditionGroups) ? conditionGroups.map((x) => String(x ?? "").trim()).filter(Boolean) : [];
  const nextConditions: UiCondition[] = [];
  let currentGroupId = parsedGroups[0] || "group_1";
  const knownGroups = [...parsedGroups];
  if (!knownGroups.includes(currentGroupId)) knownGroups.push(currentGroupId);
  for (const cond of conditions) {
    let groupId = cond.group_id?.trim() || "";
    if (!groupId) {
      if (cond.conjunction === "or" && nextConditions.length > 0) {
        currentGroupId = nextConditionGroupId(knownGroups);
        knownGroups.push(currentGroupId);
      }
      groupId = currentGroupId;
    } else {
      currentGroupId = groupId;
      if (!knownGroups.includes(groupId)) knownGroups.push(groupId);
    }
    nextConditions.push({ ...cond, group_id: groupId });
  }
  return { condition_groups: knownGroups.length ? knownGroups : ["group_1"], conditions: nextConditions };
}

export function parseClassificationFromDsl(raw: any): UiClassification {
  if (!raw || typeof raw !== "object") return emptyClassification();
  const rules: UiClassRule[] = Array.isArray(raw.rules)
    ? raw.rules.map((r: any) => ({
        class_id: String(r?.class_id ?? "").toLowerCase(),
        tn_ved_group_code: normalizeTnVedEaeuCode(String(r?.tn_ved_group_code ?? "")) ?? "",
        title: String(r?.title ?? ""),
        priority: typeof r?.priority === "number" && Number.isFinite(r.priority) ? r.priority : Number(r?.priority) || 0,
        ...normalizeRuleConditionGroups(
          Array.isArray(r?.condition_groups) ? r.condition_groups : [],
          (Array.isArray(r?.conditions) ? r.conditions : []).map(parseCondition).filter(Boolean) as UiCondition[],
        ),
      }))
    : [];
  const deduped = dedupeRulesByClassId(rules);
  if (deduped.length === 0) {
    return {
      rules: [emptyRule("прочее", DEFAULT_MISC_CLASS_PRIORITY)],
    };
  }
  return {
    rules: deduped,
  };
}

/** Один class_id, одно правило; при повторе в DSL сохраняется первое вхождение. */
function dedupeRulesByClassId(rules: UiClassRule[]): UiClassRule[] {
  const seen = new Set<string>();
  const out: UiClassRule[] = [];
  for (const r of rules) {
    const id = r.class_id;
    if (!id) {
      out.push(r);
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(r);
  }
  return out;
}

function isConditionReadyForDsl(cond: UiCondition): boolean {
  if (cond.type === "path") {
    if (!cond.path.trim()) return false;
    if (cond.op === "exists" || cond.op === "notExists") return true;
    if (cond.op === "regex" || cond.op === "notRegex") {
      return typeof cond.value === "string" && cond.value.trim().length > 0;
    }
    if (cond.op === "in") {
      return Array.isArray(cond.value)
        ? cond.value.length > 0
        : cond.value !== undefined && cond.value !== "" && cond.value !== null;
    }
    return cond.value !== undefined && cond.value !== "" && cond.value !== null;
  }
  if (cond.type === "rowFormula") {
    if (!cond.array_path.trim() || !cond.name_field.trim() || !cond.value_field.trim()) return false;
    if (!cond.formula.trim()) return false;
    const entries = Object.entries(cond.variables).filter(([k, v]) => k.trim() && v.trim());
    if (!entries.length) return false;
    for (const [k] of entries) {
      if (!FORMULA_VAR_ID_RE.test(k.trim())) return false;
    }
    if (!["equals", "gt", "gte", "lt", "lte"].includes(cond.op)) return false;
    if (typeof cond.value !== "number" || !Number.isFinite(cond.value)) return false;
    return true;
  }
  if (cond.type === "rowPairRatio") {
    if (!cond.array_path.trim() || !cond.name_field.trim() || !cond.value_field.trim()) return false;
    if (!cond.left_name.trim() || !cond.right_name.trim()) return false;
    if (cond.left_name.trim() === cond.right_name.trim()) return false;
    if (typeof cond.ratio_left !== "number" || !Number.isFinite(cond.ratio_left) || cond.ratio_left <= 0) return false;
    if (typeof cond.ratio_right !== "number" || !Number.isFinite(cond.ratio_right) || cond.ratio_right <= 0) return false;
    return true;
  }
  if (!cond.array_path.trim() || !cond.name_field.trim() || !cond.value_field.trim()) return false;
  if (!cond.name_equals.trim()) return false;
  const hasMin = typeof cond.value_min === "number" && Number.isFinite(cond.value_min);
  const hasMax = typeof cond.value_max === "number" && Number.isFinite(cond.value_max);
  if (hasMin || hasMax) return true;
  return cond.op.trim().length > 0;
}

export function classificationToDslPayload(ui: UiClassification): Record<string, unknown> | null {
  const seenIds = new Set<string>();
  const rules = ui.rules
    .map((r) => {
      const class_id = r.class_id.toLowerCase();
      if (!class_id) return null;
      if (seenIds.has(class_id)) return null;
      seenIds.add(class_id);
      const conditions = r.conditions.filter(isConditionReadyForDsl).map((c) => {
        if (c.type === "path") {
          const path = c.path.trim();
          const o: Record<string, unknown> = { type: "path", path, op: c.op };
          if (c.value !== undefined && c.value !== "") o.value = c.value;
          if (c.group_id) o.group_id = c.group_id;
          if (c.conjunction === "or") o.conjunction = "or";
          if (c.primary === false) o.primary = false;
          return o;
        }
        if (c.type === "rowFormula") {
          const tol =
            typeof c.tolerance_rel === "number" && Number.isFinite(c.tolerance_rel) && c.tolerance_rel >= 0
              ? c.tolerance_rel
              : 0.001;
          const varsOut: Record<string, string> = {};
          for (const [k, v] of Object.entries(c.variables)) {
            const id = k.trim();
            const comp = String(v ?? "").trim().toLowerCase();
            if (id && comp) varsOut[id] = comp;
          }
          const o: Record<string, unknown> = {
            type: "rowFormula",
            array_path: c.array_path.trim(),
            name_field: c.name_field.trim(),
            value_field: c.value_field.trim(),
            variables: varsOut,
            formula: c.formula.trim(),
            op: c.op,
            value: c.value,
            tolerance_rel: tol,
          };
          if (c.group_id) o.group_id = c.group_id;
          if (c.conjunction === "or") o.conjunction = "or";
          if (c.primary === false) o.primary = false;
          return o;
        }
        if (c.type === "rowPairRatio") {
          const tol =
            typeof c.tolerance_rel === "number" && Number.isFinite(c.tolerance_rel) && c.tolerance_rel >= 0
              ? c.tolerance_rel
              : 0.001;
          const o: Record<string, unknown> = {
            type: "rowPairRatio",
            array_path: c.array_path.trim(),
            name_field: c.name_field.trim(),
            value_field: c.value_field.trim(),
            left_name: c.left_name.trim().toLowerCase(),
            right_name: c.right_name.trim().toLowerCase(),
            ratio_left: c.ratio_left,
            ratio_right: c.ratio_right,
            tolerance_rel: tol,
          };
          if (c.group_id) o.group_id = c.group_id;
          if (c.conjunction === "or") o.conjunction = "or";
          if (c.primary === false) o.primary = false;
          return o;
        }
        const base = {
          type: "rowIndicator",
          array_path: c.array_path.trim(),
          name_field: c.name_field.trim(),
          value_field: c.value_field.trim(),
          name_equals: c.name_equals.trim(),
        };
        const hasMin = typeof c.value_min === "number" && Number.isFinite(c.value_min);
        const hasMax = typeof c.value_max === "number" && Number.isFinite(c.value_max);
        if (hasMin || hasMax) {
          const o: Record<string, unknown> = { ...base };
          if (hasMin) o.value_min = c.value_min;
          if (hasMax) o.value_max = c.value_max;
          if (c.group_id) o.group_id = c.group_id;
          if (c.conjunction === "or") o.conjunction = "or";
          if (c.primary === false) o.primary = false;
          return o;
        }
        const o: Record<string, unknown> = { ...base, op: c.op };
        if (c.value !== undefined && c.value !== "") o.value = c.value;
        if (c.group_id) o.group_id = c.group_id;
        if (c.conjunction === "or") o.conjunction = "or";
        if (c.primary === false) o.primary = false;
        return o;
      });
      const tn = normalizeTnVedEaeuCode(r.tn_ved_group_code ?? "");
      const o: Record<string, unknown> = {
        class_id: class_id,
        title: r.title.trim() || undefined,
        priority: r.priority,
        condition_groups: r.condition_groups,
        conditions,
      };
      if (tn) o.tn_ved_group_code = tn;
      return o;
    })
    .filter(Boolean) as Array<Record<string, unknown>>;

  if (!rules.length) return null;

  return {
    strategy: "exactly_one",
    rules,
    ambiguous_match_resolution: "by_priority",
  };
}

function suggestNewClassId(existing: UiClassRule[]): string {
  for (let n = 1; n < 200; n++) {
    const id = `класс_${n}`;
    if (!existing.some((r) => r.class_id === id)) return id;
  }
  return `класс_${Date.now()}`;
}

function emptyRule(classId: string, priority: number): UiClassRule {
  return { class_id: classId, tn_ved_group_code: "", title: "", priority, condition_groups: ["group_1"], conditions: [] };
}

function normalizeUiRule(rule: UiClassRule): UiClassRule {
  return { ...rule, ...normalizeRuleConditionGroups(rule.condition_groups, rule.conditions) };
}

function normPath(p: string): string {
  return p.trim().toLowerCase().replace(/\[\]/g, "[*]");
}

/** Индексы условий по дескриптору поля; отдельно «несопоставимые» с текущей структурой. */
function groupConditionIndicesByDescriptor(
  conditions: UiCondition[],
  descList: StructureRowFieldDescriptor[],
): { legacyIndices: number[]; byDescriptor: Map<number, number[]> } {
  const legacyIndices: number[] = [];
  const byDescriptor = new Map<number, number[]>();
  conditions.forEach((cond, ci) => {
    const m = getConditionUiModel(cond, descList);
    if (m.kind === "legacy" || m.descriptorIndex < 0) {
      legacyIndices.push(ci);
      return;
    }
    const di = m.descriptorIndex;
    const arr = byDescriptor.get(di) ?? [];
    arr.push(ci);
    byDescriptor.set(di, arr);
  });
  return { legacyIndices, byDescriptor };
}

function getConditionUiModel(
  cond: UiCondition,
  descList: StructureRowFieldDescriptor[],
): { kind: UiCheckKind | "legacy"; descriptorIndex: number } {
  if (descList.length === 0) return { kind: "legacy", descriptorIndex: -1 };

  if (cond.type === "rowFormula") {
    const ap = cond.array_path.trim().toLowerCase();
    const nf = cond.name_field.trim().toLowerCase();
    const idx = descList.findIndex((d) => d.listKey === ap && d.componentColumnKey === nf);
    if (idx < 0) return { kind: "legacy", descriptorIndex: -1 };
    if (!descList[idx].allowedValues.length) return { kind: "legacy", descriptorIndex: -1 };
    return { kind: "rowFormula", descriptorIndex: idx };
  }

  if (cond.type === "rowPairRatio") {
    const ap = cond.array_path.trim().toLowerCase();
    const nf = cond.name_field.trim().toLowerCase();
    const idx = descList.findIndex((d) => d.listKey === ap && d.componentColumnKey === nf);
    if (idx < 0) return { kind: "legacy", descriptorIndex: -1 };
    if (!descList[idx].allowedValues.length) return { kind: "legacy", descriptorIndex: -1 };
    return { kind: "rowPairRatio", descriptorIndex: idx };
  }

  if (cond.type === "rowIndicator") {
    const ap = cond.array_path.trim().toLowerCase();
    const nf = cond.name_field.trim().toLowerCase();
    const idx = descList.findIndex((d) => d.listKey === ap && d.componentColumnKey === nf);
    if (idx < 0) return { kind: "legacy", descriptorIndex: -1 };
    if (!descList[idx].allowedValues.length) return { kind: "legacy", descriptorIndex: -1 };
    if (cond.op === "gt" || cond.op === "lt") return { kind: "legacy", descriptorIndex: -1 };
    return { kind: "numberInRow", descriptorIndex: idx };
  }

  const p = normPath(cond.path);
  if (cond.op === "exists" || cond.op === "notExists") {
    const idx = descList.findIndex((d) => d.listKey.toLowerCase() === p);
    if (idx >= 0) return { kind: "sectionPresent", descriptorIndex: idx };
  }
  const idx = descList.findIndex((d) => d.wildcardComponentPath.toLowerCase() === p);
  if (idx >= 0) {
    if (!descList[idx].allowedValues.length) return { kind: "legacy", descriptorIndex: -1 };
    return { kind: "labelValue", descriptorIndex: idx };
  }

  return { kind: "legacy", descriptorIndex: -1 };
}

function keepPrimaryFromPrev(prev?: UiCondition): { primary?: false } {
  return prev?.primary === false ? { primary: false } : {};
}

function keepGroupIdFromPrev(prev?: UiCondition): { group_id?: string } {
  return prev?.group_id ? { group_id: prev.group_id } : {};
}

function buildConditionForKind(kind: UiCheckKind, d: StructureRowFieldDescriptor, prev?: UiCondition): UiCondition {
  if (kind === "rowFormula") {
    const v0 = d.allowedValues[0] ?? "a";
    const v1 = d.allowedValues[1] ?? v0;
    const v2 = d.allowedValues[2] ?? v0;
    const keep =
      prev?.type === "rowFormula" &&
      prev.array_path.trim().toLowerCase() === d.listKey.toLowerCase() &&
      prev.name_field.trim().toLowerCase() === d.componentColumnKey.toLowerCase();
    const prevF = keep ? prev : undefined;
    const defaultVars =
      d.allowedValues.length >= 3
        ? { n: v0, s: v1, k: v2 }
        : d.allowedValues.length >= 2
          ? { n: v0, s: v1 }
          : { a: v0 };
    const defaultFormula =
      d.allowedValues.length >= 3 ? "(n + s) / k" : d.allowedValues.length >= 2 ? "n / s" : "a";
    const defaultValue = d.allowedValues.length >= 3 ? 2 : d.allowedValues.length >= 2 ? 2 : 1;
    return {
      type: "rowFormula",
      array_path: d.listKey,
      name_field: d.componentColumnKey,
      value_field: d.listKey,
      variables: prevF ? { ...prevF.variables } : defaultVars,
      formula: prevF ? prevF.formula : defaultFormula,
      op: prevF ? prevF.op : "equals",
      value: prevF ? prevF.value : defaultValue,
      tolerance_rel: prevF?.tolerance_rel ?? 0.001,
      ...keepGroupIdFromPrev(prev),
      ...keepPrimaryFromPrev(prev),
    };
  }
  if (kind === "rowPairRatio") {
    const v0 = d.allowedValues[0] ?? "";
    const v1 = d.allowedValues.find((x) => x !== v0) ?? v0;
    const keep =
      prev?.type === "rowPairRatio" &&
      prev.array_path.trim().toLowerCase() === d.listKey.toLowerCase() &&
      prev.name_field.trim().toLowerCase() === d.componentColumnKey.toLowerCase();
    const prevPair = keep ? prev : undefined;
    return {
      type: "rowPairRatio",
      array_path: d.listKey,
      name_field: d.componentColumnKey,
      value_field: d.listKey,
      left_name: prevPair ? prevPair.left_name : v0,
      right_name: prevPair ? prevPair.right_name : v1,
      ratio_left: prevPair ? prevPair.ratio_left : 2,
      ratio_right: prevPair ? prevPair.ratio_right : 1,
      tolerance_rel: prevPair?.tolerance_rel ?? 0.001,
      ...keepGroupIdFromPrev(prev),
      ...keepPrimaryFromPrev(prev),
    };
  }
  if (kind === "numberInRow") {
    const keep =
      prev?.type === "rowIndicator" &&
      prev.array_path.trim().toLowerCase() === d.listKey &&
      prev.name_field.trim().toLowerCase() === d.componentColumnKey;
    const prevRow = keep && prev?.type === "rowIndicator" ? prev : undefined;
    const firstAllowedValue = d.allowedValues[0] ?? "";
    return {
      type: "rowIndicator",
      array_path: d.listKey,
      name_field: d.componentColumnKey,
      value_field: d.listKey,
      name_equals: prevRow ? prevRow.name_equals : firstAllowedValue,
      op: "exists",
      value: undefined,
      value_min: prevRow?.value_min,
      value_max: prevRow?.value_max,
      ...keepGroupIdFromPrev(prev),
      ...keepPrimaryFromPrev(prev),
    };
  }
  if (kind === "labelValue") {
    const keep =
      prev?.type === "path" && normPath(prev.path) === d.wildcardComponentPath.toLowerCase() && PATH_STRING_OPS.has(prev.op);
    return {
      type: "path",
      path: d.wildcardComponentPath,
      op: keep && prev ? prev.op : "equals",
      value: keep && prev ? prev.value : undefined,
      ...keepGroupIdFromPrev(prev),
      ...keepPrimaryFromPrev(prev),
    };
  }
  const keep =
    prev?.type === "path" &&
    prev.path.trim().toLowerCase() === d.listKey.toLowerCase() &&
    (prev.op === "exists" || prev.op === "notExists");
  return {
    type: "path",
    path: d.listKey,
    op: keep && prev ? prev.op : "exists",
    value: undefined,
    ...keepGroupIdFromPrev(prev),
    ...keepPrimaryFromPrev(prev),
  };
}

type ConditionRowCallbacks = {
  replaceCond: (ruleIndex: number, condIndex: number, nextCond: UiCondition) => void;
  updateCond: (ruleIndex: number, condIndex: number, patch: Partial<UiCondition>) => void;
  removeCond: (ruleIndex: number, condIndex: number) => void;
};

/** Одна строка условия (поле-массив задаётся заголовком секции, не дублируем в строке). */
function StructuredConditionRow(props: {
  ri: number;
  ci: number;
  cond: UiCondition;
  d: StructureRowFieldDescriptor;
  kind: UiCheckKind;
  descList: StructureRowFieldDescriptor[];
  cb: ConditionRowCallbacks;
}) {
  const { ri, ci, cond, d, kind, descList, cb } = props;
  const hasEnum = d.allowedValues.length > 0;

  return (
    <div
      style={{
        border: "1px solid #e2e8f0",
        borderRadius: 8,
        padding: 10,
        marginBottom: 8,
        background: "#fff",
      }}
    >
      <div style={{ display: "flex", gap: 10, maxWidth: 760, alignItems: "flex-end", flexWrap: "wrap" }}>
        <label style={{ fontSize: 13, color: "#64748b", flex: "1 1 420px", minWidth: 260 }}>
          Что проверяем
          <select
            value={kind}
            onChange={(e) => {
              const k = e.target.value as UiCheckKind;
              cb.replaceCond(ri, ci, buildConditionForKind(k, d, cond));
            }}
            style={{
              display: "block",
              width: "100%",
              marginTop: 4,
              padding: 8,
              borderRadius: 8,
              border: "1px solid #cbd5e1",
            }}
          >
            <option
              value="sectionPresent"
              title="Проверяем, есть ли на корне документа массив с выбранным ключом поля (или что его нет)."
            >
              Наличие поля в документе
            </option>
            {hasEnum ? (
              <>
                <option
                  value="numberInRow"
                  title="В массиве выбирается строка с выбранным значением из перечня; число должно попасть в диапазон min…max (границы включаются). Пустой min или max без ограничения с этой стороны."
                >
                  У поля с таким значением, диапазон числа
                </option>
                <option
                  value="labelValue"
                  title="Проверка значения текстового поля: «равно», «не равно», «одно из перечня» и т.д. Значения только из перечня на шаге «Структура»."
                >
                  Проверить текст значения в массиве
                </option>
                <option
                  value="rowPairRatio"
                  title="Соотношение чисел в двух строках массива с разными значениями из перечня (например N : S = 2 : 1 означает value(N)/value(S) ≈ 2/1)."
                >
                  Отношение двух показателей (A : B = …)
                </option>
                <option
                  value="rowFormula"
                  title="Назначьте переменным значения из перечня, затем запишите выражение (+ − × ÷, скобки). Сравнение с числом. Для двух показателей проще режим «Отношение двух»."
                >
                  Формула по нескольким показателям
                </option>
              </>
            ) : null}
          </select>
        </label>
        <label
          title="Должно выполняться, чтобы по декларации можно было подтвердить класс. Без галки условие необязательно и служит для уточнения классификации при выполнении основных."
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            cursor: "pointer",
            paddingBottom: 8,
            whiteSpace: "nowrap",
          }}
        >
          <input
            type="checkbox"
            checked={cond.primary !== false}
            onChange={(e) => cb.updateCond(ri, ci, { primary: e.target.checked ? true : false })}
            style={{ marginTop: 0, flexShrink: 0 }}
          />
          <span style={{ fontSize: 13, lineHeight: 1.35, color: "#334155" }}>
            <strong>Основное условие</strong>
          </span>
        </label>
      </div>

      {kind === "numberInRow" && cond.type === "rowIndicator" && (
        <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: 10, alignItems: "flex-end" }}>
          <p style={{ width: "100%", margin: "0 0 2px 0", fontSize: 12, color: "#64748b", lineHeight: 1.45 }}>
            Если заданы и минимум, и максимум — сравнение с их средним арифметическим (относительный допуск 0,1%, как у «отношения двух показателей»). Только минимум — значение не ниже него; только максимум — не выше.
          </p>
          <label style={{ flex: "1 1 200px" }}>
            <span style={{ fontSize: 13, color: "#64748b" }}>Значение поля</span>
            <select
              value={
                d.allowedValues.includes(cond.name_equals.trim().toLowerCase()) ? cond.name_equals.trim().toLowerCase() : ""
              }
              onChange={(e) => {
                const v = e.target.value;
                if (v) cb.updateCond(ri, ci, { name_equals: v });
              }}
              style={{
                display: "block",
                width: "100%",
                marginTop: 4,
                padding: 8,
                borderRadius: 8,
                border: "1px solid #cbd5e1",
              }}
            >
              <option value="">(выберите)</option>
              {d.allowedValues.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span style={{ fontSize: 13, color: "#64748b" }} title="Только мин.: нижняя граница (≥). Вместе с макс.: участвует в среднем (мин+макс)/2.">
              Минимум
            </span>
            <input
              type="number"
              step="any"
              style={{ display: "block", width: 120, marginTop: 4, padding: 8, borderRadius: 8, border: "1px solid #cbd5e1" }}
              value={cond.value_min === undefined || cond.value_min === null ? "" : String(cond.value_min)}
              onChange={(e) => {
                const t = e.target.value;
                cb.updateCond(ri, ci, {
                  value_min: t === "" ? undefined : Number(t),
                });
              }}
            />
          </label>
          <label>
            <span style={{ fontSize: 13, color: "#64748b" }} title="Только макс.: верхняя граница (≤). Вместе с мин.: участвует в среднем (мин+макс)/2.">
              Максимум
            </span>
            <input
              type="number"
              step="any"
              style={{ display: "block", width: 120, marginTop: 4, padding: 8, borderRadius: 8, border: "1px solid #cbd5e1" }}
              value={cond.value_max === undefined || cond.value_max === null ? "" : String(cond.value_max)}
              onChange={(e) => {
                const t = e.target.value;
                cb.updateCond(ri, ci, {
                  value_max: t === "" ? undefined : Number(t),
                });
              }}
            />
          </label>
        </div>
      )}

      {kind === "rowPairRatio" && cond.type === "rowPairRatio" && (
        <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
          <p style={{ width: "100%", margin: "0 0 4px 0", fontSize: 12, color: "#64748b", lineHeight: 1.45 }}>
            Значение числа у строки «A» относится к значению у строки «B» как указанная пропорция: value(A)·(число для B) ≈ value(B)·(число для A), с учётом допуска.
          </p>
          <label style={{ flex: "1 1 160px", minWidth: 120 }}>
            <span style={{ fontSize: 13, color: "#64748b" }}>Показатель A</span>
            <select
              value={d.allowedValues.includes(cond.left_name.trim().toLowerCase()) ? cond.left_name.trim().toLowerCase() : ""}
              onChange={(e) => {
                const v = e.target.value;
                if (!v) return;
                const nextRight =
                  cond.right_name.trim().toLowerCase() === v.toLowerCase()
                    ? d.allowedValues.find((x) => x !== v) ?? v
                    : cond.right_name;
                cb.updateCond(ri, ci, { left_name: v, right_name: nextRight });
              }}
              style={{
                display: "block",
                width: "100%",
                marginTop: 4,
                padding: 8,
                borderRadius: 8,
                border: "1px solid #cbd5e1",
              }}
            >
              <option value="">(выберите)</option>
              {d.allowedValues.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label style={{ flex: "1 1 160px", minWidth: 120 }}>
            <span style={{ fontSize: 13, color: "#64748b" }}>Показатель B</span>
            <select
              value={d.allowedValues.includes(cond.right_name.trim().toLowerCase()) ? cond.right_name.trim().toLowerCase() : ""}
              onChange={(e) => {
                const v = e.target.value;
                if (!v) return;
                if (v.toLowerCase() === cond.left_name.trim().toLowerCase()) {
                  window.alert("Выберите другой показатель B (не совпадающий с A).");
                  return;
                }
                cb.updateCond(ri, ci, { right_name: v });
              }}
              style={{
                display: "block",
                width: "100%",
                marginTop: 4,
                padding: 8,
                borderRadius: 8,
                border: "1px solid #cbd5e1",
              }}
            >
              <option value="">(выберите)</option>
              {d.allowedValues.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: 6 }}>
            <span style={{ fontSize: 13, color: "#64748b", paddingBottom: 10 }}>A : B =</span>
            <label>
              <span style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clipPath: "inset(50%)" }}>
                Числитель пропорции для A
              </span>
              <input
                type="number"
                min={0}
                step="any"
                title="Число для A в пропорции (например 2 в 2:1)"
                style={{ display: "block", width: 72, marginTop: 4, padding: 8, borderRadius: 8, border: "1px solid #cbd5e1" }}
                value={String(cond.ratio_left)}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  cb.updateCond(ri, ci, { ratio_left: Number.isFinite(n) && n > 0 ? n : cond.ratio_left });
                }}
              />
            </label>
            <span style={{ paddingBottom: 10, fontWeight: 600 }}>:</span>
            <label>
              <span style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clipPath: "inset(50%)" }}>
                Знаменатель пропорции для B
              </span>
              <input
                type="number"
                min={0}
                step="any"
                title="Число для B в пропорции (например 1 в 2:1)"
                style={{ display: "block", width: 72, marginTop: 4, padding: 8, borderRadius: 8, border: "1px solid #cbd5e1" }}
                value={String(cond.ratio_right)}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  cb.updateCond(ri, ci, { ratio_right: Number.isFinite(n) && n > 0 ? n : cond.ratio_right });
                }}
              />
            </label>
          </div>
          <label>
            <span style={{ fontSize: 13, color: "#64748b" }} title="Относительная погрешность по сравниваемым произведениям (0.001 ≈ 0.1%)">
              Допуск
            </span>
            <input
              type="number"
              min={0}
              max={1}
              step="any"
              style={{ display: "block", width: 100, marginTop: 4, padding: 8, borderRadius: 8, border: "1px solid #cbd5e1" }}
              value={String(cond.tolerance_rel ?? 0.001)}
              onChange={(e) => {
                const t = e.target.value;
                if (t === "") {
                  cb.updateCond(ri, ci, { tolerance_rel: 0.001 });
                  return;
                }
                const n = Number(t);
                if (Number.isFinite(n) && n >= 0) cb.updateCond(ri, ci, { tolerance_rel: n });
              }}
            />
          </label>
        </div>
      )}

      {kind === "rowFormula" && cond.type === "rowFormula" && (
        <div style={{ marginTop: 10 }}>
          <p style={{ margin: "0 0 10px 0", fontSize: 12, color: "#64748b", lineHeight: 1.45, maxWidth: "42rem" }}>
            Имя переменной латиницей (например n, s). Каждая переменная ссылается на одну строку массива — значение компонента из перечня. В формуле: числа, скобки,
            операторы + − * / . Пример: <code style={{ fontSize: 11 }}>(n + s) / k</code> при сравнении «равно» 2 — доли удовлетворяют соотношению. Для простой
            пары N:S = 2:1 удобнее пункт «Отношение двух показателей».
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
            {Object.entries(cond.variables)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([varId, comp]) => (
                <div
                  key={`${ci}-${varId}`}
                  style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "flex-end", borderBottom: "1px solid #f1f5f9", paddingBottom: 8 }}
                >
                  <label style={{ width: 140 }}>
                    <span style={{ fontSize: 13, color: "#64748b" }}>Имя в формуле</span>
                    <input
                      key={varId}
                      defaultValue={varId}
                      onBlur={(e) => {
                        const newId = e.target.value.trim();
                        if (!newId || newId === varId) return;
                        if (!FORMULA_VAR_ID_RE.test(newId)) {
                          window.alert("Имя переменной: латиница, цифры и _; начало с буквы или _.");
                          e.target.value = varId;
                          return;
                        }
                        if (cond.variables[newId] !== undefined && newId !== varId) {
                          window.alert("Переменная с таким именем уже есть.");
                          e.target.value = varId;
                          return;
                        }
                        const next = { ...cond.variables };
                        delete next[varId];
                        next[newId] = comp;
                        cb.updateCond(ri, ci, { variables: next });
                      }}
                      spellCheck={false}
                      style={{ display: "block", width: "100%", marginTop: 4, padding: 8, borderRadius: 8, border: "1px solid #cbd5e1" }}
                    />
                  </label>
                  <label style={{ flex: "1 1 180px", minWidth: 120 }}>
                    <span style={{ fontSize: 13, color: "#64748b" }}>Значение из перечня</span>
                    <select
                      value={d.allowedValues.includes(comp) ? comp : ""}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (!v) return;
                        cb.updateCond(ri, ci, { variables: { ...cond.variables, [varId]: v } });
                      }}
                      style={{
                        display: "block",
                        width: "100%",
                        marginTop: 4,
                        padding: 8,
                        borderRadius: 8,
                        border: "1px solid #cbd5e1",
                      }}
                    >
                      <option value="">(выберите)</option>
                      {d.allowedValues.map((v) => (
                        <option key={v} value={v}>
                          {v}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => {
                      const keys = Object.keys(cond.variables);
                      if (keys.length <= 1) {
                        window.alert("Нужна хотя бы одна переменная.");
                        return;
                      }
                      const next = { ...cond.variables };
                      delete next[varId];
                      cb.updateCond(ri, ci, { variables: next });
                    }}
                  >
                    Удалить
                  </button>
                </div>
              ))}
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                let n = 1;
                let id = `v${n}`;
                while (cond.variables[id] !== undefined) {
                  n += 1;
                  id = `v${n}`;
                }
                const first = d.allowedValues[0] ?? "";
                cb.updateCond(ri, ci, { variables: { ...cond.variables, [id]: first } });
              }}
            >
              + Переменная
            </button>
          </div>
          <label style={{ display: "block", marginBottom: 10, maxWidth: "min(40rem, 100%)" }}>
            <span style={{ fontSize: 13, color: "#64748b" }}>Формула</span>
            <input
              type="text"
              spellCheck={false}
              value={cond.formula}
              onChange={(e) => cb.updateCond(ri, ci, { formula: e.target.value })}
              placeholder="например (n + s) / k"
              className="fe-font-mono"
              style={{
                display: "block",
                width: "100%",
                marginTop: 4,
                padding: 8,
                borderRadius: 8,
                border: "1px solid #cbd5e1",
                fontSize: 13,
              }}
            />
          </label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
            <label>
              <span style={{ fontSize: 13, color: "#64748b" }}>Сравнение</span>
              <select
                style={{ display: "block", marginTop: 4, padding: 8, borderRadius: 8, border: "1px solid #cbd5e1", minWidth: 160 }}
                value={cond.op}
                onChange={(e) => cb.updateCond(ri, ci, { op: e.target.value as RowFormulaCond["op"] })}
              >
                {ROW_FORMULA_OPS_LABEL.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span style={{ fontSize: 13, color: "#64748b" }}>Число</span>
              <input
                type="number"
                step="any"
                style={{ display: "block", width: 120, marginTop: 4, padding: 8, borderRadius: 8, border: "1px solid #cbd5e1" }}
                value={String(cond.value)}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isFinite(n)) cb.updateCond(ri, ci, { value: n });
                }}
              />
            </label>
            {cond.op === "equals" ? (
              <label>
                <span style={{ fontSize: 13, color: "#64748b" }} title="Только для «равно»: относительная погрешность">
                  Допуск
                </span>
                <input
                  type="number"
                  min={0}
                  max={1}
                  step="any"
                  style={{ display: "block", width: 100, marginTop: 4, padding: 8, borderRadius: 8, border: "1px solid #cbd5e1" }}
                  value={String(cond.tolerance_rel ?? 0.001)}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (Number.isFinite(n) && n >= 0) cb.updateCond(ri, ci, { tolerance_rel: n });
                  }}
                />
              </label>
            ) : null}
          </div>
        </div>
      )}

      {kind === "labelValue" && cond.type === "path" && (
        <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: 10, alignItems: "flex-end" }}>
          <label>
            <span style={{ fontSize: 13, color: "#64748b" }}>Условие</span>
            <select
              style={{ display: "block", marginTop: 4, padding: 8, borderRadius: 8, border: "1px solid #cbd5e1" }}
              value={cond.op}
              onChange={(e) => {
                const op = e.target.value;
                let value: unknown = cond.value;
                if (op === "exists" || op === "notExists") {
                  value = undefined;
                } else if (op === "regex" || op === "notRegex") {
                  value = typeof cond.value === "string" ? cond.value : "";
                } else if (op === "in") {
                  if (cond.op !== "in") value = undefined;
                } else if (Array.isArray(cond.value)) {
                  value = undefined;
                }
                cb.updateCond(ri, ci, { op, value });
              }}
            >
              {PATH_OPS_LABEL.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          {cond.op !== "exists" && cond.op !== "notExists" ? (
            <StructureEnumValueControl
              path={cond.path}
              op={cond.op}
              value={cond.value}
              onValueChange={(v) => cb.updateCond(ri, ci, { value: v })}
              structureRowDescriptors={descList}
              enumLabel="Значение из перечня"
            />
          ) : null}
        </div>
      )}

      {kind === "sectionPresent" && cond.type === "path" && (
        <div style={{ marginTop: 10 }}>
          <label>
            <span style={{ fontSize: 13, color: "#64748b" }}>Проверка</span>
            <select
              style={{ display: "block", marginTop: 4, padding: 8, borderRadius: 8, border: "1px solid #cbd5e1", minWidth: 220 }}
              value={cond.op}
              onChange={(e) => cb.updateCond(ri, ci, { op: e.target.value })}
            >
              <option value="exists">Поле присутствует</option>
              <option value="notExists">Поля нет</option>
            </select>
          </label>
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", width: "100%", marginTop: 10 }}>
        <button type="button" className="btn-danger" onClick={() => cb.removeCond(ri, ci)}>
          Удалить условие
        </button>
      </div>
    </div>
  );
}

type Props = {
  value: UiClassification;
  onChange: (next: UiClassification) => void;
  /** Обязательно для упрощённого редактора: поля со шага «Структура» */
  structureRowDescriptors?: StructureRowFieldDescriptor[];
};

export default function ClassificationRulesPanel({ value, onChange, structureRowDescriptors }: Props) {
  const descList = structureRowDescriptors ?? [];
  const hasStructure = descList.length > 0;
  const [editingRuleIndex, setEditingRuleIndex] = React.useState<number | null>(null);
  const [expandedRuleKeys, setExpandedRuleKeys] = React.useState<Set<string>>(() => new Set());
  const pendingExpandedRuleKeyRef = React.useRef<string | null>(null);

  const ruleUiKey = React.useCallback((rule: UiClassRule, index: number) => {
    return rule.class_id.trim() || `__rule_${index}`;
  }, []);

  const patchRules = (rules: UiClassRule[]) => onChange({ ...value, rules: rules.map(normalizeUiRule) });

  const updateRuleAt = (index: number, patch: Partial<UiClassRule>) => {
    const next = value.rules.slice();
    next[index] = normalizeUiRule({ ...next[index], ...patch } as UiClassRule);
    patchRules(next);
  };

  const removeRuleAt = (index: number) => {
    patchRules(value.rules.filter((_, i) => i !== index));
  };

  /** Нижний регистр без обрезки пробелов; при дубликате с другим классом поле очищается. */
  const commitClassIdOnBlur = (ruleIndex: number) => {
    const cur = value.rules[ruleIndex];
    if (!cur) return;
    const lower = cur.class_id.toLowerCase();
    if (lower !== cur.class_id) {
      updateRuleAt(ruleIndex, { class_id: lower });
    }
    const effective = lower;
    if (!effective) return;
    const dup = value.rules.some((r, i) => i !== ruleIndex && r.class_id === effective);
    if (dup) {
      window.alert("Класс с таким идентификатором уже задан. Укажите другое имя.");
      updateRuleAt(ruleIndex, { class_id: "" });
      return;
    }
    const tn = normalizeTnVedEaeuCode(value.rules[ruleIndex]?.tn_ved_group_code ?? "");
    if (effective && !tn) {
      window.alert("Для класса с идентификатором укажите код ТН ВЭД ЕАЭС ниже.");
    }
  };

  const addNewClass = () => {
    const id = suggestNewClassId(value.rules);
    const minP = value.rules.length ? Math.min(...value.rules.map((r) => r.priority)) : DEFAULT_MISC_CLASS_PRIORITY + 50;
    pendingExpandedRuleKeyRef.current = id;
    patchRules([...value.rules, emptyRule(id, minP - 10)]);
  };

  const toggleRuleCollapsed = (ruleIndex: number) => {
    const key = ruleUiKey(value.rules[ruleIndex]!, ruleIndex);
    setExpandedRuleKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  React.useEffect(() => {
    const currentKeys = value.rules.map((rule, index) => ruleUiKey(rule, index));
    const currentKeySet = new Set(currentKeys);
    setExpandedRuleKeys((prev) => {
      const next = new Set<string>();
      for (const key of prev) {
        if (currentKeySet.has(key)) next.add(key);
      }
      if (pendingExpandedRuleKeyRef.current && currentKeySet.has(pendingExpandedRuleKeyRef.current)) {
        next.add(pendingExpandedRuleKeyRef.current);
      }
      return next;
    });
    if (pendingExpandedRuleKeyRef.current && currentKeySet.has(pendingExpandedRuleKeyRef.current)) {
      pendingExpandedRuleKeyRef.current = null;
    }
  }, [ruleUiKey, value.rules]);

  const addConditionForDescriptorInGroup = (ruleIndex: number, groupId: string, descriptorIndex: number) => {
    const rule = value.rules[ruleIndex];
    if (!rule) return;
    const d = descList[descriptorIndex];
    if (!d) return;
    const hasEnum = d.allowedValues.length > 0;
    const kind: UiCheckKind = hasEnum ? "numberInRow" : "sectionPresent";
    const cond = { ...buildConditionForKind(kind, d), group_id: groupId };
    updateRuleAt(ruleIndex, { conditions: [...rule.conditions, cond] });
  };

  const addConditionGroup = (ruleIndex: number) => {
    const rule = value.rules[ruleIndex];
    if (!rule) return;
    const groupId = nextConditionGroupId(rule.condition_groups);
    updateRuleAt(ruleIndex, { condition_groups: [...rule.condition_groups, groupId] });
  };

  const removeConditionGroup = (ruleIndex: number, groupId: string) => {
    const rule = value.rules[ruleIndex];
    if (!rule) return;
    const remainingGroups = rule.condition_groups.filter((id) => id !== groupId);
    const remainingConditions = rule.conditions.filter((cond) => cond.group_id !== groupId);
    updateRuleAt(ruleIndex, {
      condition_groups: remainingGroups.length ? remainingGroups : ["group_1"],
      conditions: remainingConditions,
    });
  };

  const updateCond = (ruleIndex: number, ci: number, patch: Partial<UiCondition>) => {
    const rule = value.rules[ruleIndex];
    if (!rule) return;
    const next = rule.conditions.slice();
    const cur = next[ci];
    if (!cur) return;
    next[ci] = { ...cur, ...patch } as UiCondition;
    updateRuleAt(ruleIndex, { conditions: next });
  };

  const replaceCond = (ruleIndex: number, ci: number, nextCond: UiCondition) => {
    const rule = value.rules[ruleIndex];
    if (!rule) return;
    const next = rule.conditions.slice();
    next[ci] = nextCond;
    updateRuleAt(ruleIndex, { conditions: next });
  };

  const removeCond = (ruleIndex: number, ci: number) => {
    const rule = value.rules[ruleIndex];
    if (!rule) return;
    updateRuleAt(ruleIndex, { conditions: rule.conditions.filter((_, j) => j !== ci) });
  };

  const condCb: ConditionRowCallbacks = {
    replaceCond,
    updateCond,
    removeCond,
  };

  return (
    <div style={{ border: "1px solid #e2e8f0", borderRadius: 12, padding: 16, background: "#fafafa" }}>
      <h3 style={{ marginTop: 0, marginBottom: 8 }}>Классы</h3>

      {value.rules.length === 0 ? (
        <p style={{ color: "#64748b", marginBottom: 16 }}>Классов пока нет. Нажмите «+ Класс».</p>
      ) : null}

      {value.rules.map((rule, ri) => {
        const isCollapsed = !expandedRuleKeys.has(ruleUiKey(rule, ri));
        return (
          <div
            key={ri}
            style={{
              border: "1px solid #cbd5e1",
              borderRadius: 10,
              padding: isCollapsed ? "8px 10px" : 14,
              marginBottom: 14,
              background: "#fff",
            }}
          >
          <div style={{ display: "flex", gap: 12, alignItems: "flex-start", marginBottom: isCollapsed ? 0 : 12, width: "100%" }}>
            <div
              style={{
                flex: "0 0 auto",
                minWidth: 32,
                height: 32,
                borderRadius: 999,
                background: "#e2e8f0",
                color: "#0f172a",
                fontWeight: 700,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                marginTop: 2,
              }}
              aria-label={`Класс ${ri + 1}`}
              title={`Класс ${ri + 1}`}
            >
              {ri + 1}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", width: "100%" }}>
            <label style={{ flex: "1 1 220px", minWidth: 0 }}>
              <span style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 700, fontSize: 18, color: "#0f172a", marginBottom: 4 }}>
                <span>{rule.class_id.trim() || "Новый класс"}</span>
                {!isCollapsed ? (
                  <button
                    type="button"
                    onClick={() => setEditingRuleIndex(ri)}
                    style={{
                      border: "1px solid #cbd5e1",
                      background: "#fff",
                      borderRadius: 6,
                      width: 28,
                      height: 28,
                      cursor: "pointer",
                      color: "#334155",
                    }}
                    aria-label={`Редактировать название класса ${ri + 1}`}
                    title="Редактировать название"
                  >
                    ✎
                  </button>
                ) : null}
              </span>
              {!isCollapsed && editingRuleIndex === ri ? (
                <input
                  autoFocus
                  style={{ width: "100%", padding: 8, borderRadius: 8, border: "1px solid #cbd5e1" }}
                  value={rule.class_id}
                  placeholder="например: состав а"
                  onChange={(e) => updateRuleAt(ri, { class_id: e.target.value.toLowerCase() })}
                  onBlur={() => {
                    commitClassIdOnBlur(ri);
                    setEditingRuleIndex((prev) => (prev === ri ? null : prev));
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.currentTarget.blur();
                    }
                  }}
                />
              ) : null}
            </label>
            <div style={{ display: "flex", gap: 8, marginLeft: "auto" }}>
              {!isCollapsed ? (
                <button type="button" className="btn-danger btn-align-end" onClick={() => removeRuleAt(ri)}>
                  Удалить класс
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => toggleRuleCollapsed(ri)}
                style={{
                  border: "1px solid #cbd5e1",
                  background: "#fff",
                  borderRadius: 6,
                  width: 32,
                  height: 32,
                  cursor: "pointer",
                  color: "#334155",
                  fontSize: 16,
                }}
                aria-label={isCollapsed ? `Развернуть класс ${ri + 1}` : `Свернуть класс ${ri + 1}`}
                title={isCollapsed ? "Развернуть" : "Свернуть"}
              >
                {isCollapsed ? "+" : "−"}
              </button>
            </div>
            </div>
          </div>

          {!isCollapsed ? (
            <>
          <div style={{ marginBottom: 12 }}>
              <TnVedGroupTreePicker
                value={rule.tn_ved_group_code}
                label={null}
                manualInputInlineLabel={
                  <>
                    Код ТН ВЭД ЕАЭС для класса <span style={{ color: "#b91c1c" }} aria-hidden="true">*</span>
                  </>
                }
                manualInputRowStyle={{
                  display: "grid",
                  gridTemplateColumns: "minmax(9rem, 14rem) auto",
                  gap: 12,
                  alignItems: "start",
                }}
                manualInputAside={
                  <div style={{ display: "grid", gridTemplateColumns: "180px 180px", gap: 12, alignItems: "start" }}>
                    <label style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
                      <span style={{ display: "block", fontWeight: 600, fontSize: 13 }}>Заметка (необязательно)</span>
                      <input
                        style={{ width: "100%", padding: 6, borderRadius: 8, border: "1px solid #cbd5e1", minWidth: 0 }}
                        value={rule.title}
                        onChange={(e) => updateRuleAt(ri, { title: e.target.value })}
                        placeholder="необязательно"
                      />
                    </label>
                    <label style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
                      <span style={{ display: "block", fontWeight: 600, fontSize: 13 }}>Приоритет</span>
                      <input
                        type="number"
                        style={{ width: "100%", padding: 6, borderRadius: 8, border: "1px solid #cbd5e1", minWidth: 0 }}
                        value={rule.priority}
                        onChange={(e) => updateRuleAt(ri, { priority: Number(e.target.value) || 0 })}
                      />
                    </label>
                  </div>
                }
                onChange={(code) => {
                  const patch: Partial<UiClassRule> = { tn_ved_group_code: code };
                  if (shouldAutofillClassIdFromClassifier(rule.class_id)) {
                    const def = getTnVedClassifierTitleForCode(code);
                    if (def && !isTnVedGenericProchieTitle(def)) {
                      patch.class_id = classIdFromTnVedClassifierTitle(def);
                    }
                  }
                  updateRuleAt(ri, patch);
                }}
              />
          </div>

          <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 14, color: "#334155" }}>Условия</div>

          {!hasStructure ? (
            <p style={{ color: "#b45309", fontSize: 13, marginBottom: 8 }}>
              Сначала на шаге «Структура» задайте хотя бы одно поле с числами, иначе это условие недоступно.
            </p>
          ) : null}

          {rule.conditions.length === 0 ? (
            hasStructure ? (
              <p style={{ color: "#64748b", fontSize: 13, marginTop: 0, marginBottom: 10 }}>
                Пока без условий: правило сработает для любого документа, пока не добавите проверки по полям ниже.
              </p>
            ) : (
              <p style={{ color: "#64748b", fontSize: 14, marginTop: 0 }}>Нет условий, правило всегда срабатывает.</p>
            )
          ) : null}

          {hasStructure ? (
            <>
              {(() => {
                const groups = rule.condition_groups.length ? rule.condition_groups : ["group_1"];
                return (
                  <>
                    {groups.map((groupId, groupIndex) => {
                      const groupConditionIndices = rule.conditions
                        .map((cond, index) => ({ cond, index }))
                        .filter(({ cond }) => cond.group_id === groupId);
                      const groupConditions = groupConditionIndices.map(({ cond }) => cond);
                      const { legacyIndices } = groupConditionIndicesByDescriptor(groupConditions, descList);
                      return (
                        <div
                          key={groupId}
                          style={{
                            border: "1px solid #cbd5e1",
                            borderRadius: 10,
                            padding: 12,
                            marginBottom: 12,
                            background: groupIndex === 0 ? "#f8fafc" : "#fdfdfd",
                          }}
                        >
                          {groupIndex > 0 ? (
                            <div style={{ display: "flex", justifyContent: "center", marginBottom: 10 }}>
                              <div
                                style={{
                                  padding: "3px 10px",
                                  borderRadius: 999,
                                  border: "1px solid #cbd5e1",
                                  background: "#fff",
                                  fontSize: 12,
                                  fontWeight: 700,
                                  color: "#334155",
                                }}
                              >
                                ИЛИ
                              </div>
                            </div>
                          ) : null}
                          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 10 }}>
                            <div style={{ fontWeight: 700, fontSize: 13, color: "#334155" }}>Группа {groupIndex + 1}</div>
                            {groups.length > 1 ? (
                              <button type="button" className="btn-danger" onClick={() => removeConditionGroup(ri, groupId)}>
                                Удалить группу
                              </button>
                            ) : null}
                          </div>
                          <div style={{ fontSize: 12, color: "#64748b", marginBottom: 10 }}>Внутри группы все условия должны выполняться одновременно.</div>
                          {legacyIndices.map((localIndex) => {
                            const ci = groupConditionIndices[localIndex]?.index;
                            if (ci == null) return null;
                            return (
                              <div
                                key={`legacy-${groupId}-${ci}`}
                                style={{
                                  border: "1px solid #fcd34d",
                                  borderRadius: 8,
                                  padding: 10,
                                  marginBottom: 10,
                                  background: "#fffbeb",
                                }}
                              >
                                <p style={{ margin: "0 0 8px", fontSize: 13, color: "#92400e", lineHeight: 1.45 }}>
                                  Условие не сопоставлено с текущей структурой (или использует строгое &gt;/&lt;, не переносимое в min/max). Удалите и
                                  добавьте новое кнопкой «+ Условие для этого поля» под нужным полем.
                                </p>
                                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                                  <button type="button" className="btn-danger" onClick={() => removeCond(ri, ci)}>
                                    Удалить условие
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                          {descList.map((d, di) => {
                            const localIndices = groupConditionIndices
                              .map((entry, localIndex) => ({ entry, localIndex }))
                              .filter(({ entry }) => {
                                const model = getConditionUiModel(entry.cond, descList);
                                return model.kind !== "legacy" && model.descriptorIndex === di;
                              })
                              .map(({ localIndex }) => localIndex);
                            return (
                              <div
                                key={`${groupId}-${d.listKey}-${d.componentColumnKey}-${di}`}
                                style={{
                                  marginBottom: 14,
                                  paddingLeft: 12,
                                  borderLeft: "3px solid #cbd5e1",
                                }}
                              >
                                <div style={{ fontWeight: 600, fontSize: 13, color: "#475569", marginBottom: 8 }}>
                                  {d.listKey} / {d.componentColumnKey}
                                </div>
                                {localIndices.map((localIndex) => {
                                  const entry = groupConditionIndices[localIndex];
                                  const cond = entry?.cond;
                                  const ci = entry?.index;
                                  if (!cond || ci == null) return null;
                                  const model = getConditionUiModel(cond, descList);
                                  if (model.kind === "legacy" || model.descriptorIndex !== di) return null;
                                  const kind = model.kind as UiCheckKind;
                                  return (
                                    <StructuredConditionRow
                                      key={ci}
                                      ri={ri}
                                      ci={ci}
                                      cond={cond}
                                      d={d}
                                      kind={kind}
                                      descList={descList}
                                      cb={condCb}
                                    />
                                  );
                                })}
                                <button
                                  type="button"
                                  className="btn"
                                  style={{ marginTop: localIndices.length ? 4 : 0 }}
                                  onClick={() => addConditionForDescriptorInGroup(ri, groupId, di)}
                                >
                                  + Условие для этого поля
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      );
                    })}
                    <button type="button" className="btn-secondary" onClick={() => addConditionGroup(ri)}>
                      + Группа ИЛИ
                    </button>
                  </>
                );
              })()}
            </>
          ) : null}
          </>
          ) : null}
        </div>
      )})}

      <button type="button" className="btn" onClick={addNewClass}>
        + Класс
      </button>
    </div>
  );
}
