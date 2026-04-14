/* eslint-disable @typescript-eslint/no-explicit-any */

import type { NumericCharacteristicsDraft } from "../expert/numericCharacteristicsDraft";

export type CrossRulePathSuggestion = {
  /** Группа в выпадающем поле выбора */
  group: string;
  /** Короткий текст для человека */
  label: string;
  /** Путь в синтаксисе движка (точки, [*] для элементов массива) */
  path: string;
  /** Подсказка под полем */
  hint?: string;
};

/**
 * Пути для справочника «несколько числовых полей на корне» (мастер числовых характеристик).
 */
export function buildPathSuggestionsFromNumericDraft(draft: NumericCharacteristicsDraft): CrossRulePathSuggestion[] {
  const out: CrossRulePathSuggestion[] = [];
  for (const c of draft.characteristics) {
    const k = c.characteristicKey.trim();
    const comp = c.componentColumnKey.trim();
    if (!k || !comp) continue;
    out.push({
      group: `Поле «${k}»`,
      label: "Ключ поля на корне документа",
      path: k,
      hint: "Удобно для проверки «поле-массив присутствует на корне»",
    });
    out.push({
      group: `Поле «${k}»`,
      label: `Числа по всем строкам поля (сумма долей и т.п.)`,
      path: `${k}[*].${k}`,
      hint: "Собирает все числа из числового поля в строках массива (имя поля совпадает с ключом поля на корне)",
    });
    out.push({
      group: `Поле «${k}»`,
      label: `Значение поля («${comp}»)`,
      path: `${k}[*].${comp}`,
      hint: "Текст значения в каждой строке массива",
    });
  }
  return out;
}

type RuleSchemaNode = {
  type?: string;
  name?: string;
  schema?: RuleSchemaNode;
  properties?: Array<{ name?: string; schema?: RuleSchemaNode }>;
  items?: RuleSchemaNode;
};

function walkObjectProperties(
  basePath: string,
  props: Array<{ name?: string; schema?: RuleSchemaNode }> | undefined,
  out: CrossRulePathSuggestion[],
): void {
  if (!Array.isArray(props)) return;
  for (const p of props) {
    const name = p.name?.trim();
    const sch = p.schema;
    if (!name || !sch) continue;
    const path = basePath ? `${basePath}.${name}` : name;
    if (sch.type === "array") {
      out.push({
        group: "Поля на корне",
        label: `Массив «${name}»`,
        path,
        hint: "Проверка наличия поля-массива в документе",
      });
      const items = sch.items;
      if (items?.type === "object" && Array.isArray(items.properties)) {
        for (const ip of items.properties) {
          const leaf = ip.name?.trim();
          if (!leaf) continue;
          out.push({
            group: `Внутри «${name}»`,
            label: leaf,
            path: `${path}[*].${leaf}`,
            hint: "Значение в каждой строке массива",
          });
        }
      }
    } else {
      out.push({
        group: basePath ? `Внутри «${basePath}»` : "Поля",
        label: name,
        path,
      });
    }
  }
}

/**
 * Пути из Rule DSL schema (объект с properties: [{ name, schema }]).
 */
export function buildPathSuggestionsFromRuleSchema(schema: any): CrossRulePathSuggestion[] {
  if (!schema || schema.type !== "object" || !Array.isArray(schema.properties)) return [];
  const out: CrossRulePathSuggestion[] = [];
  walkObjectProperties("", schema.properties as RuleSchemaNode[], out);
  return out;
}

export function groupSuggestions(suggestions: CrossRulePathSuggestion[]): Map<string, CrossRulePathSuggestion[]> {
  const m = new Map<string, CrossRulePathSuggestion[]>();
  for (const s of suggestions) {
    const g = s.group || "Другое";
    if (!m.has(g)) m.set(g, []);
    m.get(g)!.push(s);
  }
  return m;
}
