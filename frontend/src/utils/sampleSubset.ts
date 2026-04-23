/**
 * Равномерная случайная выборка без повторений.
 * Для больших датасетов few-shot: в запрос не отправляем все строки, а только выборку заданного размера.
 */
export function sampleSubset<T>(items: readonly T[], k: number): T[] {
  if (k <= 0 || items.length === 0) return [];
  if (items.length <= k) return [...items];
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = copy[i]!;
    copy[i] = copy[j]!;
    copy[j] = a;
  }
  return copy.slice(0, k);
}
