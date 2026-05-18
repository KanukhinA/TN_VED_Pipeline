/**
 * Разделение очереди эксперта на ленту «имя от модели» и «после таможенного контроля».
 * Чистые функции — покрыты unit-тестами (vitest).
 */

export type ExpertDecisionLike = {
  id: string;
  category: string;
  declaration_id: string;
  status: string;
  payload_json?: Record<string, unknown> | null;
};

export const NAMING_DECISION_CATEGORIES = [
  "class_name_confirmation",
  "auto_classification_review",
  "classification_unresolved",
] as const;

export const NAMING_POST_CONTROL_CATEGORIES = ["auto_classification_review", "classification_unresolved"] as const;

const MEANINGLESS_LLM_CLASS_NAMES = new Set(["CLASS", "GENERATION_FAILED", "-", "—", "N/A", "UNKNOWN", "EMPTY"]);

export function isNamingPostControlCategory(category: string): boolean {
  return (NAMING_POST_CONTROL_CATEGORIES as readonly string[]).includes(category);
}

export function isNamingDecisionCategory(category: string): boolean {
  return (NAMING_DECISION_CATEGORIES as readonly string[]).includes(category);
}

export function llmSuggestedClassFromPayload(payload: Record<string, unknown> | undefined): string {
  if (!payload) return "";
  const llm = payload.llm_result as Record<string, unknown> | undefined;
  const fromLlm = String(llm?.suggested_class_name ?? "").trim();
  if (fromLlm) return fromLlm;
  return String(payload.llm_naming_suggested_class ?? "").trim();
}

export function isMeaningfulLlmClassName(name: string): boolean {
  const n = name.trim();
  if (!n) return false;
  return !MEANINGLESS_LLM_CLASS_NAMES.has(n.toUpperCase());
}

/** Явный маркер с бэкенда/инспектора или осмысленное имя в payload. */
export function payloadIndicatesLlmNaming(payload: Record<string, unknown> | undefined): boolean {
  if (!payload) return false;
  if (payload.llm_naming_ran === true) return true;
  if (payload.naming_lane === "model") return true;
  if (payload.semantic_llm_naming_applied === true) return true;
  return isMeaningfulLlmClassName(llmSuggestedClassFromPayload(payload));
}

function declarationIdKey(declarationId: string): string {
  return declarationId.trim().toLowerCase();
}

export function relatedItemsForDeclaration(allItems: ExpertDecisionLike[], declarationId: string): ExpertDecisionLike[] {
  const key = declarationIdKey(declarationId);
  if (!key) return [];
  return allItems.filter((it) => declarationIdKey(String(it.declaration_id ?? "")) === key);
}

function findItemById(allItems: ExpertDecisionLike[], id: string): ExpertDecisionLike | undefined {
  const needle = id.trim().toLowerCase();
  if (!needle) return undefined;
  return allItems.find((it) => String(it.id).trim().toLowerCase() === needle);
}

/** LLM из связанной записи officer_final_decision (часто dismissed и не в pending-списке). */
export function payloadWithLinkedOfficerLlm(
  payload: Record<string, unknown> | undefined,
  allItems: ExpertDecisionLike[],
): Record<string, unknown> | undefined {
  if (!payload) return payload;
  if (payloadIndicatesLlmNaming(payload)) return payload;
  const linkedRaw = payload.linked_officer_final_decision_id;
  if (linkedRaw == null) return payload;
  const officer = findItemById(allItems, String(linkedRaw));
  if (!officer) return payload;
  const officerPayload = officer.payload_json as Record<string, unknown> | undefined;
  if (!payloadIndicatesLlmNaming(officerPayload)) return payload;
  const merged: Record<string, unknown> = { ...payload, llm_naming_ran: true };
  const name = llmSuggestedClassFromPayload(officerPayload);
  if (name) merged.llm_naming_suggested_class = name;
  const llm = officerPayload?.llm_result;
  if (llm && typeof llm === "object") {
    merged.llm_result = { ...(payload.llm_result as object), ...llm };
  }
  return merged;
}

export function declarationHasLlmNaming(allItems: ExpertDecisionLike[], declarationId: string): boolean {
  const related = relatedItemsForDeclaration(allItems, declarationId);
  if (related.some((it) => it.category === "class_name_confirmation")) return true;
  return related.some((it) => {
    const p = payloadWithLinkedOfficerLlm(it.payload_json as Record<string, unknown>, allItems);
    return payloadIndicatesLlmNaming(p);
  });
}

export type NamingLane = "model" | "post";

export function declarationNamingLane(allItems: ExpertDecisionLike[], declarationId: string): NamingLane | null {
  const declId = declarationId.trim();
  if (!declId) return null;
  if (declarationHasLlmNaming(allItems, declId)) return "model";
  const related = relatedItemsForDeclaration(allItems, declId);
  if (related.some((it) => isNamingPostControlCategory(it.category))) return "post";
  return null;
}

export function isNamingModelItem(item: ExpertDecisionLike, allItems: ExpertDecisionLike[]): boolean {
  if (item.category === "class_name_confirmation") return true;
  const declId = String(item.declaration_id ?? "").trim();
  if (declId && declarationHasLlmNaming(allItems, declId)) return true;
  const payload = payloadWithLinkedOfficerLlm(item.payload_json as Record<string, unknown>, allItems);
  if (isNamingPostControlCategory(item.category)) {
    return payloadIndicatesLlmNaming(payload);
  }
  return false;
}

export function isNamingPostControlItem(item: ExpertDecisionLike, allItems: ExpertDecisionLike[]): boolean {
  if (item.category === "class_name_confirmation") return false;
  if (!isNamingPostControlCategory(item.category)) return false;
  const declId = String(item.declaration_id ?? "").trim();
  if (declId && declarationHasLlmNaming(allItems, declId)) return false;
  const payload = payloadWithLinkedOfficerLlm(item.payload_json as Record<string, unknown>, allItems);
  return !payloadIndicatesLlmNaming(payload);
}

/** Не показывать в «Очередь по источнику» (officer), если задача уже в ленте именования LLM. */
export function shouldShowInOfficerWorkQueue(item: ExpertDecisionLike, allItems: ExpertDecisionLike[]): boolean {
  if (item.category !== "officer_final_decision") return false;
  const declId = String(item.declaration_id ?? "").trim();
  if (declId && declarationNamingLane(allItems, declId) === "model") return false;
  const payload = item.payload_json as Record<string, unknown> | undefined;
  if (payloadIndicatesLlmNaming(payload)) return false;
  const fd = String(payload?.final_decision ?? "").trim().toLowerCase();
  if (fd === "expert_review") return false;
  return true;
}

export function namingRowPriority(item: ExpertDecisionLike): number {
  if (item.category === "class_name_confirmation") return 4;
  const p = item.payload_json as Record<string, unknown> | undefined;
  if (payloadIndicatesLlmNaming(p)) return 3;
  if (item.status === "pending") return 2;
  return 1;
}
