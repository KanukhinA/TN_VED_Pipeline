const EAEU_LEN = new Set([2, 4, 6, 8, 10]);

/**
 * Код ТН ВЭД ЕАЭС: 2 (глава), 4, 6, 8 или 10 цифр; первые две — глава 01–97.
 */
export function normalizeTnVedEaeuCode(raw: string): string | null {
  const s = String(raw ?? "")
    .trim()
    .replace(/\s+/g, "");
  if (!s || !/^\d+$/.test(s)) return null;
  if (!EAEU_LEN.has(s.length)) return null;
  const ch = parseInt(s.slice(0, 2), 10);
  if (ch < 1 || ch > 97) return null;
  return s;
}

/** Только двузначная глава 01–97 (совместимость и узкие проверки). */
export function normalizeTnVedGroupCode(raw: string): string | null {
  const n = normalizeTnVedEaeuCode(raw);
  if (!n || n.length !== 2) return null;
  return n;
}

/**
 * Глава 01–97 из сохранённого meta.tn_ved_group_code: раньше могли хранить полный код (4–10 цифр).
 * Для отображения и миграции берём первые две цифры валидного кода ЕАЭС.
 */
export function normalizeTnVedChapterMeta(raw: string): string | null {
  const s = String(raw ?? "")
    .trim()
    .replace(/\s+/g, "");
  if (!s) return null;
  const full = normalizeTnVedEaeuCode(s);
  if (full) return full.slice(0, 2);
  return null;
}
