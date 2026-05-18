import { describe, expect, it } from "vitest";
import type { ExpertDecisionLike } from "./expertDecisionQueueLanes";
import {
  declarationHasLlmNaming,
  declarationNamingLane,
  isNamingModelItem,
  isNamingPostControlItem,
  payloadWithLinkedOfficerLlm,
  shouldShowInOfficerWorkQueue,
} from "./expertDecisionQueueLanes";

function item(
  partial: Partial<ExpertDecisionLike> & Pick<ExpertDecisionLike, "id" | "category" | "declaration_id">,
): ExpertDecisionLike {
  return {
    status: "pending",
    payload_json: {},
    ...partial,
  };
}

describe("expertDecisionQueueLanes", () => {
  const declId = "DT-SULFATE-001";

  it("auto_review с naming_lane=model идёт в ленту модели, не в пост-контроль", () => {
    const review = item({
      id: "rev-1",
      category: "auto_classification_review",
      declaration_id: declId,
      payload_json: {
        naming_lane: "model",
        llm_naming_ran: true,
        llm_result: { suggested_class_name: "сульфат_бора" },
      },
    });
    const all = [review];
    expect(declarationNamingLane(all, declId)).toBe("model");
    expect(isNamingModelItem(review, all)).toBe(true);
    expect(isNamingPostControlItem(review, all)).toBe(false);
  });

  it("auto_review без LLM — только пост-контроль", () => {
    const review = item({
      id: "rev-2",
      category: "auto_classification_review",
      declaration_id: declId,
      payload_json: { auto_classification_status: "failed" },
    });
    const all = [review];
    expect(declarationNamingLane(all, declId)).toBe("post");
    expect(isNamingModelItem(review, all)).toBe(false);
    expect(isNamingPostControlItem(review, all)).toBe(true);
  });

  it("class_name_confirmation всегда в ленте модели", () => {
    const confirm = item({
      id: "cnf-1",
      category: "class_name_confirmation",
      declaration_id: declId,
      payload_json: { llm_result: { suggested_class_name: "сульфат_бора" } },
    });
    const review = item({
      id: "rev-3",
      category: "auto_classification_review",
      declaration_id: declId,
      payload_json: {},
    });
    const all = [confirm, review];
    expect(isNamingModelItem(review, all)).toBe(true);
    expect(isNamingPostControlItem(review, all)).toBe(false);
  });

  it("подтягивает LLM из связанного officer_final_decision", () => {
    const officer = item({
      id: "off-1",
      category: "officer_final_decision",
      declaration_id: declId,
      status: "dismissed",
      payload_json: {
        final_decision: "expert_review",
        llm_naming_ran: true,
        llm_result: { suggested_class_name: "сульфат_бора" },
      },
    });
    const review = item({
      id: "rev-4",
      category: "auto_classification_review",
      declaration_id: declId,
      payload_json: { linked_officer_final_decision_id: "off-1" },
    });
    const all = [officer, review];
    expect(declarationHasLlmNaming(all, declId)).toBe(true);
    const merged = payloadWithLinkedOfficerLlm(review.payload_json as Record<string, unknown>, all);
    expect(merged?.llm_naming_ran).toBe(true);
    expect(isNamingPostControlItem(review, all)).toBe(false);
    expect(isNamingModelItem(review, all)).toBe(true);
  });

  it("officer expert_review с LLM не попадает в очередь по итогам инспектора", () => {
    const officer = item({
      id: "off-2",
      category: "officer_final_decision",
      declaration_id: declId,
      status: "pending",
      payload_json: {
        final_decision: "expert_review",
        llm_naming_ran: true,
        llm_result: { suggested_class_name: "сульфат_бора" },
      },
    });
    const review = item({
      id: "rev-5",
      category: "auto_classification_review",
      declaration_id: declId,
      payload_json: { naming_lane: "model", llm_naming_ran: true },
    });
    const all = [officer, review];
    expect(shouldShowInOfficerWorkQueue(officer, all)).toBe(false);
  });

  it("сценарий: селитра — семантика + LLM сульфат_бора (как в багрепорте)", () => {
    const review = item({
      id: "rev-bug",
      category: "auto_classification_review",
      declaration_id: declId,
      payload_json: {
        naming_lane: "model",
        llm_naming_ran: true,
        llm_naming_suggested_class: "сульфат_бора",
        llm_result: {
          suggested_class_name: "сульфат_бора",
          prompt_includes: { tnved_code: "3105590000" },
        },
        semantic_rule_contradiction: true,
        auto_classification_status: "failed",
      },
    });
    const all = [review];
    expect(isNamingPostControlItem(review, all)).toBe(false);
    expect(isNamingModelItem(review, all)).toBe(true);
    expect(declarationNamingLane(all, declId)).toBe("model");
  });
});
