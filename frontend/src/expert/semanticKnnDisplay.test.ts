import { describe, expect, it } from "vitest";
import { computeKnnMetrics, pickSemanticUiLead, SEMANTIC_SUPPORT_EPSILON } from "./semanticKnnDisplay";

describe("semanticKnnDisplay", () => {
  it("при k=3 и одном классе у соседей P(c)=V_best и P₀=1", () => {
    const sp = {
      knn_k: 3,
      knn_neighbors: [
        { class_id: "кальциевая селитра", similarity: 0.8695, weight: 0.42 },
        { class_id: "кальциевая селитра", similarity: 0.85, weight: 0.38 },
        { class_id: "кальциевая селитра", similarity: 0.82, weight: 0.35 },
      ],
      neighbor_similarity_floor_s0: 0.35,
      neighbor_weight_gamma: 2,
    };
    const m = computeKnnMetrics(sp, 3);
    expect(m).not.toBeNull();
    expect(m!.knnK).toBe(3);
    expect(m!.vBest).toBeCloseTo(0.8695, 4);
    expect(m!.p0).toBeCloseTo(1, 3);
    expect(m!.supportP).toBeCloseTo(m!.vBest, 4);
    expect(m!.supportP).toBeCloseTo(
      (m!.vBest * m!.vw) / (SEMANTIC_SUPPORT_EPSILON + m!.totalWeight),
      6,
    );
    const lead = pickSemanticUiLead(sp, 3);
    expect(lead?.vw).toBeCloseTo(m!.vw, 6);
    expect(lead?.metricLabel).toBe("P(c)");
    expect(lead?.metricValue).toBeCloseTo(m!.supportP, 6);
    expect(lead?.metricValue).not.toBeLessThan(0);
  });

  it("при смешанных классах P(c) < V_best", () => {
    const sp = {
      knn_k: 3,
      knn_neighbors: [
        { class_id: "A", similarity: 0.9, weight: 0.5 },
        { class_id: "A", similarity: 0.85, weight: 0.4 },
        { class_id: "B", similarity: 0.8, weight: 0.3 },
      ],
      neighbor_similarity_floor_s0: 0.35,
      neighbor_weight_gamma: 2,
    };
    const m = computeKnnMetrics(sp, 3);
    expect(m!.classId).toBe("A");
    expect(m!.vBest).toBeCloseTo(0.9, 4);
    expect(m!.supportP).toBeLessThan(m!.vBest);
    expect(m!.p0).toBeLessThan(1);
    const lead = pickSemanticUiLead(sp, 3);
    expect(lead?.metricLabel).toBe("P(c)");
    expect(lead?.metricValue).toBe(m!.supportP);
    expect(lead?.metricValue).toBeLessThan(lead!.vBest);
    expect(lead?.metricValue).toBeCloseTo(
      (lead!.vBest * lead!.vw) / (SEMANTIC_SUPPORT_EPSILON + lead!.sumNeighborWeights),
      6,
    );
  });

  it("берёт support_p с бэкенда, если нет соседей", () => {
    const sp = {
      knn_k: 3,
      similarity: 0.8695,
      support_p: 0.41,
      class_id: "кальциевая селитра",
    };
    const lead = pickSemanticUiLead(sp, 3);
    expect(lead?.metricLabel).toBe("P(c)");
    expect(lead?.metricValue).toBeCloseTo(0.41, 4);
    expect(lead?.vBest).toBeCloseTo(0.8695, 4);
  });

  it("при k=1 показывает V_best", () => {
    const sp = {
      knn_k: 1,
      similarity: 0.77,
      support_p: 0.77,
      knn_neighbors: [{ class_id: "X", similarity: 0.77, weight: 0.2 }],
    };
    const lead = pickSemanticUiLead(sp, 3);
    expect(lead?.metricLabel).toBe("V_best");
    expect(lead?.metricValue).toBeCloseTo(0.77, 4);
  });
});
