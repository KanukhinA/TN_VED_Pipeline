/**
 * Расчёт P(c), V_best, P₀(c) для отображения в интерфейсе инспектора (согласовано с semantic-search).
 */

export type KnnNeighborLike = {
  class_id: string;
  similarity: number;
  weight?: number;
};

export type KnnMetrics = {
  knnK: number;
  classId: string | null;
  vBest: number;
  supportP: number;
  p0: number;
  vw: number;
  totalWeight: number;
};

/** ε в знаменателе (30)–(31); согласовано с SEMANTIC_SEARCH_SUPPORT_EPSILON на semantic-search. */
export const SEMANTIC_SUPPORT_EPSILON = 1e-9;
const EPS = SEMANTIC_SUPPORT_EPSILON;

export function neighborVoteWeight(sim: number, s0: number, gamma: number): number {
  const margin = Math.max(0, sim - s0);
  if (margin <= 0) return 0;
  const g = Number.isFinite(gamma) && gamma >= 1 ? gamma : 2;
  return margin ** g;
}

function parseNeighbors(raw: unknown): KnnNeighborLike[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((n) => n && typeof n === "object")
    .map((n) => {
      const row = n as Record<string, unknown>;
      return {
        class_id: String(row.class_id ?? "").trim(),
        similarity: typeof row.similarity === "number" ? row.similarity : Number(row.similarity ?? NaN),
        weight: typeof row.weight === "number" ? row.weight : Number(row.weight ?? NaN),
      };
    })
    .filter((n) => n.class_id && Number.isFinite(n.similarity));
}

function neighborsFromFeatureSpace(sp: Record<string, unknown>): KnnNeighborLike[] {
  const pointsRaw = sp.feature_space_points;
  if (!Array.isArray(pointsRaw)) return [];
  return pointsRaw
    .filter((p) => p && typeof p === "object" && String((p as Record<string, unknown>).kind ?? "") === "reference")
    .map((p) => {
      const row = p as Record<string, unknown>;
      return {
        class_id: String(row.class_id ?? "").trim(),
        similarity: typeof row.similarity === "number" ? row.similarity : Number(row.similarity ?? NaN),
      };
    })
    .filter((n) => n.class_id && Number.isFinite(n.similarity))
    .sort((a, b) => b.similarity - a.similarity);
}

/** kNN: класс по max V_w; P(c)=V_best·V_w/(ε+Σw_j), P₀=V_w/(ε+Σw_j). */
export function computeKnnMetricsFromNeighbors(
  neighbors: KnnNeighborLike[],
  k: number,
  s0: number,
  gamma: number,
): KnnMetrics | null {
  if (neighbors.length === 0) return null;
  const kEff = Math.max(1, Math.min(Math.floor(k), neighbors.length));
  const top = neighbors.slice(0, kEff);
  let totalWeight = 0;
  const votes = new Map<string, { vw: number; count: number; best: number }>();
  for (const n of top) {
    const w =
      Number.isFinite(n.weight) && (n.weight as number) > 0
        ? (n.weight as number)
        : neighborVoteWeight(n.similarity, s0, gamma);
    totalWeight += w;
    const cur = votes.get(n.class_id) ?? { vw: 0, count: 0, best: -Infinity };
    cur.vw += w;
    cur.count += 1;
    if (n.similarity > cur.best) cur.best = n.similarity;
    votes.set(n.class_id, cur);
  }
  const winner = [...votes.entries()].sort((a, b) => {
    const pa = a[1].vw / (totalWeight + EPS);
    const pb = b[1].vw / (totalWeight + EPS);
    if (pb !== pa) return pb - pa;
    if (b[1].count !== a[1].count) return b[1].count - a[1].count;
    if (b[1].best !== a[1].best) return b[1].best - a[1].best;
    return a[0].localeCompare(b[0], "ru");
  })[0];
  if (!winner) return null;
  const classId = winner[0];
  const vBest = winner[1].best;
  const vw = winner[1].vw;
  const p0 = vw / (totalWeight + EPS);
  const supportP = vBest * p0;
  return { knnK: kEff, classId, vBest, supportP, p0, vw, totalWeight };
}

export function computeKnnMetrics(sp: Record<string, unknown>, fallbackK: number): KnnMetrics | null {
  const knnKRaw = sp.knn_k;
  const knnK =
    typeof knnKRaw === "number" && Number.isFinite(knnKRaw) ? Math.max(1, Math.floor(knnKRaw)) : Math.max(1, Math.floor(fallbackK));
  const s0Raw = sp.neighbor_similarity_floor_s0;
  const s0 = typeof s0Raw === "number" && Number.isFinite(s0Raw) ? s0Raw : Number(s0Raw ?? 0.35);
  const gammaRaw = sp.neighbor_weight_gamma;
  const gamma = typeof gammaRaw === "number" && Number.isFinite(gammaRaw) && gammaRaw >= 1 ? gammaRaw : 2;

  let neighbors = parseNeighbors(sp.knn_neighbors);
  if (neighbors.length === 0) {
    neighbors = neighborsFromFeatureSpace(sp);
  }

  const computed = computeKnnMetricsFromNeighbors(neighbors, knnK, s0, gamma);
  if (computed) return computed;

  const v = typeof sp.similarity === "number" && Number.isFinite(sp.similarity) ? (sp.similarity as number) : NaN;
  const p = typeof sp.support_p === "number" && Number.isFinite(sp.support_p) ? (sp.support_p as number) : NaN;
  if (!Number.isFinite(v)) return null;
  const supportP = Number.isFinite(p) ? p : v;
  const p0 = v > 0 ? supportP / v : 0;
  return {
    knnK,
    classId: typeof sp.class_id === "string" ? sp.class_id : null,
    vBest: v,
    supportP,
    p0,
    vw: supportP,
    totalWeight: v > 0 ? supportP / v : 0,
  };
}

export type SemanticUiLead = {
  metricLabel: "P(c)" | "V_best";
  metricValue: number;
  knnK: number;
  vBest: number;
  supportP: number;
  p0: number;
  vw: number;
  sumNeighborWeights: number;
  epsilon: number;
  thresholdTau1: number | null;
  thresholdTau2: number | null;
};

function leadFromMetrics(
  m: KnnMetrics,
  metricLabel: "P(c)" | "V_best",
  metricValue: number,
  tau1: number | null,
  tau2: number | null,
): SemanticUiLead {
  return {
    metricLabel,
    metricValue,
    knnK: m.knnK,
    vBest: m.vBest,
    supportP: m.supportP,
    p0: m.p0,
    vw: m.vw,
    sumNeighborWeights: m.totalWeight,
    epsilon: EPS,
    thresholdTau1: tau1,
    thresholdTau2: tau2,
  };
}

export function pickSemanticUiLead(sp: Record<string, unknown>, fallbackK: number): SemanticUiLead | null {
  const m = computeKnnMetrics(sp, fallbackK);
  if (!m) return null;
  const tau1Raw = sp.threshold_tau1 ?? sp.similarity_threshold;
  const tau1 = typeof tau1Raw === "number" && Number.isFinite(tau1Raw) ? (tau1Raw as number) : null;
  const tau2Raw = sp.threshold_tau2;
  const tau2 = typeof tau2Raw === "number" && Number.isFinite(tau2Raw) ? (tau2Raw as number) : null;

  if (m.knnK > 1) {
    return leadFromMetrics(m, "P(c)", m.supportP, tau1, tau2);
  }
  return leadFromMetrics(m, "V_best", m.vBest, tau1, tau2);
}

/** Обновляет payload шага semantic-search пересчитанными P(c) и соседями для выбранного k. */
export function applyKnnMetricsToSemanticPayload(
  semanticPayload: Record<string, unknown> | null,
  k: number,
): Record<string, unknown> | null {
  if (!semanticPayload || typeof semanticPayload !== "object") return semanticPayload;
  const m = computeKnnMetrics(semanticPayload, k);
  if (!m) return semanticPayload;
  const tau1Raw = semanticPayload.threshold_tau1 ?? semanticPayload.similarity_threshold;
  const tau1 = typeof tau1Raw === "number" ? tau1Raw : Number(tau1Raw ?? NaN);
  const tau2Raw = semanticPayload.threshold_tau2;
  const tau2 = typeof tau2Raw === "number" ? tau2Raw : Number(tau2Raw ?? 0.55);
  const matched =
    Number.isFinite(tau1) && Number.isFinite(tau2) ? m.vBest > tau1 && m.supportP > tau2 : Boolean(m.classId);
  return {
    ...semanticPayload,
    knn_k: m.knnK,
    class_id: m.classId ?? semanticPayload.class_id,
    similarity: m.vBest,
    support_p: m.supportP,
    matched,
    below_threshold: Number.isFinite(tau1) ? m.vBest <= tau1 : semanticPayload.below_threshold,
  };
}
