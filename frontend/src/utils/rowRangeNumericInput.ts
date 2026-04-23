/**
 * Значения полей «С» / «По» для диапазона строк: разрешаем пустую строку во время ввода,
 * иначе controlled input с Number('') || 1 не даёт стереть число.
 */
export type RowInputValue = number | "";

export function rowRangeBounds(
  rowStart: RowInputValue,
  rowEnd: RowInputValue,
  rowCount: number,
): { s0: number; e0: number; incomplete: boolean } {
  const n = rowCount;
  if (n === 0) return { s0: 1, e0: 0, incomplete: false };
  const incomplete = rowStart === "" || rowEnd === "";
  const rawS = rowStart === "" ? NaN : Number(rowStart);
  const rawE = rowEnd === "" ? NaN : Number(rowEnd);
  const s0 = Number.isFinite(rawS) ? rawS : 1;
  const e0 = Number.isFinite(rawE) ? rawE : n;
  return { s0, e0, incomplete };
}

/** После blur: пустое или невалидное → 1..maxRow */
export function finalizeRowInput(value: RowInputValue, maxRow: number): number {
  const hi = Math.max(1, maxRow);
  if (value === "") return 1;
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(hi, n));
}
