/**
 * Текст для колонки / KPI «Класс»: все потенциальные class_id через запятую.
 * Сначала явный список с бэкенда (candidate_class_ids), иначе итоговый assigned_class_id
 * (в т.ч. уже объединённый через запятую при comma_join).
 */
export function formatClassColumnDisplay(
  finalClass: unknown,
  candidateClassIds: string[] | undefined | null,
): string {
  const ids = (candidateClassIds ?? [])
    .map((x) => String(x ?? "").trim())
    .filter((x) => x.length > 0);
  if (ids.length > 0) {
    return ids.join(", ");
  }
  const fc = finalClass != null ? String(finalClass).trim() : "";
  if (!fc) return "";
  return fc
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .join(", ");
}
