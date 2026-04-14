/**
 * Иерархия ТН ВЭД ЕАЭС для каскадного выбора в UI.
 * Данные `TN_VED_CHILDREN` собираются из `tnVedChildren.generated.ts`
 * (команда: `python scripts/build_tn_ved_tree.py` и файл `data/ТН ВЭД.xlsx`).
 */

import { TN_VED_CHILDREN_BUILD_INFO, TN_VED_CHILDREN_GENERATED } from "./tnVedChildren.generated";
import { normalizeTnVedEaeuCode } from "./tnVedCode";
import { getTnVedGroup } from "./tnVedGroupsData";

export type TnVedChildRef = { code: string; title: string };

/** Дочерние позиции по коду родителя (например "31" → товарные позиции главы 31). */
export const TN_VED_CHILDREN: Record<string, TnVedChildRef[]> = TN_VED_CHILDREN_GENERATED;

/** Метаданные последней сборки `tnVedChildren.generated.ts` из Excel. */
export { TN_VED_CHILDREN_BUILD_INFO };

const TN_VED_PARENT_BY_CODE = new Map<string, string>();
const TN_VED_TITLE_BY_CODE = new Map<string, string>();

for (const [parent, items] of Object.entries(TN_VED_CHILDREN)) {
  for (const item of items) {
    TN_VED_PARENT_BY_CODE.set(item.code, parent);
    TN_VED_TITLE_BY_CODE.set(item.code, item.title);
  }
}

/**
 * true, если в сборке слишком мало строк для полного классификатора ЕАЭС (в репозитории — демо).
 * После `python scripts/build_tn_ved_tree.py` с полным `data/ТН ВЭД.xlsx` станет false.
 */
export function isTnVedChildrenDatasetIncomplete(): boolean {
  const minRows = 3000;
  return TN_VED_CHILDREN_BUILD_INFO.rowCount < minRows;
}

export function listTnVedChildren(parentCode: string): TnVedChildRef[] {
  return TN_VED_CHILDREN[parentCode] ?? [];
}

/** Наибольший префикс из набора кодов, совпадающий с norm. */
export function pickLongestMatchingChildCode(norm: string, childCodes: string[]): string {
  let best = "";
  for (const c of childCodes) {
    if (norm.startsWith(c) && c.length > best.length) best = c;
  }
  return best;
}

/**
 * Префиксы родительских кодов, которые нужно раскрыть в дереве, чтобы был виден выбранный код.
 * Сам выбранный код в набор не входит.
 */
export function getTnVedParentPrefixesForExpansion(raw: string): string[] {
  const n = normalizeTnVedEaeuCode(String(raw ?? "").trim());
  if (!n) return [];
  const chain: string[] = [];
  let cur = TN_VED_PARENT_BY_CODE.get(n);
  while (cur) {
    chain.push(cur);
    cur = TN_VED_PARENT_BY_CODE.get(cur);
  }
  return chain.reverse();
}

/** Слишком общее наименование в классификаторе — не подставляем в идентификатор автоматически. */
export function isTnVedGenericProchieTitle(title: string): boolean {
  return title.trim().toLowerCase() === "прочие";
}

/** Наименование позиции ТН ВЭД → идентификатор класса: нижний регистр, пробелы сохраняются. */
export function classIdFromTnVedClassifierTitle(title: string): string {
  let s = title.trim().toLowerCase().replace(/\s+/g, " ");
  if (s.length > 120) s = s.slice(0, 120);
  return s;
}

/**
 * Подставлять идентификатор из классификатора, только если поле пустое или всё ещё шаблон «класс_N».
 */
export function shouldAutofillClassIdFromClassifier(classId: string): boolean {
  const c = classId.trim();
  if (!c) return true;
  return /^класс_\d+$/.test(c);
}

/**
 * Наименование выбранного уровня ТН ВЭД (только текст из справочника, без кода).
 */
export function getTnVedClassifierTitleForCode(raw: string): string | null {
  const n = normalizeTnVedEaeuCode(String(raw ?? "").trim());
  if (!n) return null;
  if (n.length === 2) {
    const g = getTnVedGroup(n);
    return g?.title ?? null;
  }
  return TN_VED_TITLE_BY_CODE.get(n) ?? null;
}

export function resolveTnVedCodeLabel(code: string): string {
  const n = normalizeTnVedEaeuCode(code);
  if (!n) return "";
  if (n.length === 2) {
    const g = getTnVedGroup(n);
    return g ? `${g.code} — ${g.title}` : n;
  }
  const lastTitle = TN_VED_TITLE_BY_CODE.get(n);
  if (lastTitle) return `${n} — ${lastTitle}`;
  return n;
}
