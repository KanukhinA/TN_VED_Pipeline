import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import {
  getRule,
  listExpertDecisions,
  patchExpertDecision,
  repairExpertLlmNamingQueue,
  type ExpertDecisionItem,
} from "../api/client";
import { TN_VED_SECTION_DEFS } from "../catalog/tnVedSectionTree";
import {
  isNamingDecisionCategory,
  isNamingModelItem,
  isNamingPostControlItem,
  llmSuggestedClassFromPayload,
  namingRowPriority,
  shouldShowInOfficerWorkQueue,
} from "../expert/expertDecisionQueueLanes";

/**
 * Соответствие category → источник в системе (для сопровождения и UI):
 * - class_name_confirmation: предложение модели / каталог (POST API, реже — внешний клиент).
 * - auto_classification_review, classification_unresolved: проверка декларации (OfficerValidationPage).
 * - officer_final_decision, inspector_feature_correction: проверка декларации (OfficerValidationPage).
 * - classification_ambiguous, classification_none: правила справочника (в репозитории сейчас не создаются; возможны старые БД / ручной POST).
 */
const CATEGORY_LABEL: Record<string, string> = {
  classification_ambiguous: "Несколько подходящих классов",
  classification_none: "Ни одно правило классификации не подошло",
  class_name_confirmation: "Нужно подтвердить название класса",
  inspector_feature_correction: "Согласование правок извлечённых признаков",
  auto_classification_review: "Проверка сбоя авто-классификации",
  officer_final_decision: "Решение инспектора",
  classification_unresolved: "Классификация не разрешена",
};

const STANDARD_EXPERT_CATEGORIES = new Set<string>([
  "class_name_confirmation",
  "auto_classification_review",
  "classification_unresolved",
  "classification_ambiguous",
  "classification_none",
  "officer_final_decision",
  "inspector_feature_correction",
]);

const STATUS_LABEL: Record<string, string> = {
  pending: "В экспертизе",
  resolved: "Корректна",
  dismissed: "Не корректна",
};

/** Фильтр списка: совпадает с query listExpertDecisions (category / issue_type) и группировкой карточек. */
type UiIssueType =
  | "all"
  | "model_class"
  | "post_customs_control"
  | "classification"
  | "inspector_correction"
  | "officer_decision";

const UI_ISSUE_TYPE_LABEL: Record<UiIssueType, string> = {
  all: "Все",
  model_class: "Класс: модель",
  post_customs_control: "После контроля",
  classification: "По справочнику",
  inspector_correction: "Правки признаков",
  officer_decision: "Итог инспектора",
};

function labelCategory(cat: string): string {
  return CATEGORY_LABEL[cat] ?? cat;
}

function labelStatus(status: string): string {
  return STATUS_LABEL[status] ?? status;
}

const WORK_QUEUE_RULE_CATEGORIES = ["classification_ambiguous", "classification_none"] as const;

function isWorkQueueRuleCategory(category: string): boolean {
  return (WORK_QUEUE_RULE_CATEGORIES as readonly string[]).includes(category);
}

function isStandardExpertCategory(category: string): boolean {
  return STANDARD_EXPERT_CATEGORIES.has(category);
}

/** Для счётчика в селекторе «Тип проблемы»: какой фильтр соответствует категории записи. */
function toolbarIssueTypeFromItem(item: ExpertDecisionItem, allItems: ExpertDecisionItem[]): UiIssueType {
  if (isNamingModelItem(item, allItems)) return "model_class";
  if (isNamingPostControlItem(item, allItems)) return "post_customs_control";
  if (isWorkQueueRuleCategory(item.category)) return "classification";
  if (item.category === "inspector_feature_correction") return "inspector_correction";
  if (item.category === "officer_final_decision") return "officer_decision";
  return "all";
}

/** Краткие строки по вложенному объекту признаков (без сырого JSON в интерфейсе). */
function flattenFeatureLines(obj: unknown, prefix = ""): string[] {
  if (obj === null || obj === undefined) return [`${prefix || "·"}: —`];
  const t = typeof obj;
  if (t === "string" || t === "number" || t === "boolean") {
    return [`${prefix || "·"}: ${String(obj)}`];
  }
  if (Array.isArray(obj)) {
    if (obj.length === 0) return [`${prefix || "·"}: —`];
    const out: string[] = [];
    obj.forEach((item, i) => {
      const p = prefix ? `${prefix}[${i}]` : `[${i}]`;
      out.push(...flattenFeatureLines(item, p));
    });
    return out;
  }
  if (t === "object") {
    const o = obj as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length === 0) return [`${prefix || "·"}: —`];
    const out: string[] = [];
    for (const k of keys) {
      const p = prefix ? `${prefix}.${k}` : k;
      out.push(...flattenFeatureLines(o[k], p));
    }
    return out;
  }
  return [`${prefix || "·"}: ${String(obj)}`];
}

function InspectorCorrectionView({ payload }: { payload: Record<string, unknown> }) {
  const before = payload.parsed_before_override;
  const after = payload.parsed_after_override;
  const beforeLines = flattenFeatureLines(before);
  const afterLines = flattenFeatureLines(after);
  return (
    <div style={{ fontSize: 13, color: "#334155", marginBottom: 12, lineHeight: 1.5 }}>
      <div style={{ fontWeight: 600, marginBottom: 6, color: "#0f172a" }}>Было (модель)</div>
      <ul style={{ margin: "0 0 14px", paddingLeft: 18 }}>
        {beforeLines.length === 0 ? (
          <li style={{ color: "#94a3b8" }}>(нет данных)</li>
        ) : (
          beforeLines.map((line, i) => (
            <li key={i} style={{ marginBottom: 3 }}>
              {line}
            </li>
          ))
        )}
      </ul>
      <div style={{ fontWeight: 600, marginBottom: 6, color: "#0f172a" }}>Стало (инспектор)</div>
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        {afterLines.length === 0 ? (
          <li style={{ color: "#94a3b8" }}>(нет данных)</li>
        ) : (
          afterLines.map((line, i) => (
            <li key={i} style={{ marginBottom: 3 }}>
              {line}
            </li>
          ))
        )}
      </ul>
    </div>
  );
}

function formatResolutionRu(res: Record<string, unknown> | null | undefined): string {
  if (!res || Object.keys(res).length === 0) return "";
  const chosen = res.chosen_class_id;
  const confirmed = res.confirmed_class_id;
  if (typeof chosen === "string" && chosen.trim()) {
    return `Выбран класс: ${chosen.trim()}`;
  }
  if (typeof confirmed === "string" && confirmed.trim()) {
    return `Подтверждено название: ${confirmed.trim()}`;
  }
  try {
    return JSON.stringify(res);
  } catch {
    return "";
  }
}

type WorkSectionGroup = { sectionKey: string; sectionLabel: string; items: ExpertDecisionItem[] };

type WorkQueueViewState =
  | { kind: "lane"; lane: "rules" | "officer" | "features" }
  | { kind: "orphan"; category: string };

function workQueueTnvedCode(item: ExpertDecisionItem): string {
  const res = item.resolution_json as Record<string, unknown> | undefined;
  const override = String(res?.tnved_code_override ?? "").trim();
  if (override) return override;
  const payload = item.payload_json as Record<string, unknown> | undefined;
  if (!payload) return "";
  const llm = payload.llm_result as Record<string, unknown> | undefined;
  const pi = llm?.prompt_includes as Record<string, unknown> | undefined;
  const fromPrompt = String(pi?.tnved_code ?? "").trim();
  if (fromPrompt) return fromPrompt;
  const officer = payload.officer_input as Record<string, unknown> | undefined;
  return String(officer?.graph33 ?? "").trim();
}

function workQueueDescriptionRu(item: ExpertDecisionItem): string {
  const payload = item.payload_json as Record<string, unknown> | undefined;
  if (!payload) return String(item.summary_ru ?? "").trim() || "—";
  const llm = payload.llm_result as Record<string, unknown> | undefined;
  const pi = llm?.prompt_includes as Record<string, unknown> | undefined;
  const fromPrompt = String(pi?.description_excerpt ?? "").trim();
  if (fromPrompt) return fromPrompt;
  const officer = payload.officer_input as Record<string, unknown> | undefined;
  const g31 = String(officer?.graph31 ?? "").trim();
  if (g31) return g31;
  const summary = String(payload.extracted_features_summary_ru ?? "").trim();
  if (summary) return summary;
  return String(item.summary_ru ?? "").trim() || "—";
}

function officerSuggestedClassId(item: ExpertDecisionItem): string {
  const p = item.payload_json as Record<string, unknown> | undefined;
  if (!p) return "";
  const manual = String(p.manual_class_assigned_by_officer ?? "").trim();
  if (manual) return manual;
  const fin = String(p.final_decision_class ?? "").trim();
  if (fin) return fin;
  return String(p.auto_class_before_decision ?? "").trim();
}

type ClassOption = { id: string; label: string };

type NamingDecisionRow = {
  item: ExpertDecisionItem;
  suggestedClassName: string;
  description: string;
  extractedFeatures: string;
  tnvedCode: string;
  tnvedGroupCode: string;
  sectionKey: string;
  sectionLabel: string;
};

type AggregatedNamingRow = {
  key: string;
  declarations: string[];
  description: string;
  extractedFeatures: string;
  tnvedCode: string;
  tnvedGroupCode: string;
  sectionKey: string;
  sectionLabel: string;
  suggestedClassName: string;
  pendingItems: ExpertDecisionItem[];
  latestItem: ExpertDecisionItem;
};

type PendingStatusChange = {
  row: AggregatedNamingRow;
  nextStatus: "resolved" | "dismissed";
  className: string;
};

function extractClassOptionsFromDsl(dsl: unknown): ClassOption[] {
  if (!dsl || typeof dsl !== "object") return [];
  const rules = (dsl as { classification?: { rules?: unknown } }).classification?.rules;
  if (!Array.isArray(rules)) return [];
  const seen = new Set<string>();
  const out: ClassOption[] = [];
  for (const raw of rules) {
    if (!raw || typeof raw !== "object") continue;
    const id = String((raw as { class_id?: unknown }).class_id ?? "").trim();
    if (!id || seen.has(id.toLowerCase())) continue;
    seen.add(id.toLowerCase());
    const title = String((raw as { title?: unknown }).title ?? "").trim();
    out.push({ id, label: title ? `${id} — ${title}` : id });
  }
  out.sort((a, b) => a.id.localeCompare(b.id, "ru"));
  return out;
}

function classifyTnVedSection(tnvedCode: string): { groupCode: string; sectionKey: string; sectionLabel: string } {
  const digits = String(tnvedCode ?? "").replace(/\D/g, "");
  if (digits.length < 2) {
    return {
      groupCode: "—",
      sectionKey: "unknown",
      sectionLabel: "Не определено",
    };
  }
  const groupNum = Number(digits.slice(0, 2));
  if (!Number.isFinite(groupNum)) {
    return {
      groupCode: "—",
      sectionKey: "unknown",
      sectionLabel: "Не определено",
    };
  }
  const def = TN_VED_SECTION_DEFS.find((x) => groupNum >= x.groupFrom && groupNum <= x.groupTo);
  const grp = String(groupNum).padStart(2, "0");
  if (!def) {
    return {
      groupCode: grp,
      sectionKey: "unknown",
      sectionLabel: "Не определено",
    };
  }
  return {
    groupCode: grp,
    sectionKey: def.roman,
    sectionLabel: `${def.roman}. ${def.title}`,
  };
}

function namingRowFromDecision(item: ExpertDecisionItem): NamingDecisionRow {
  const llmResult = item.payload_json?.llm_result as Record<string, unknown> | undefined;
  const suggested = String(llmResult?.suggested_class_name ?? "").trim() || "—";
  const description = String(
    (llmResult?.prompt_includes as Record<string, unknown> | undefined)?.description_excerpt ??
      item.summary_ru ??
      "",
  ).trim();
  const extractedFeatures = String(item.payload_json?.extracted_features_summary_ru ?? "").trim();
  const tnved = String((llmResult?.prompt_includes as Record<string, unknown> | undefined)?.tnved_code ?? "").trim();
  const sec = classifyTnVedSection(tnved);
  return {
    item,
    suggestedClassName: suggested,
    description: description || "—",
    extractedFeatures: extractedFeatures || "—",
    tnvedCode: tnved || "—",
    tnvedGroupCode: sec.groupCode,
    sectionKey: sec.sectionKey,
    sectionLabel: sec.sectionLabel,
  };
}

function sectionInfoFromDecision(item: ExpertDecisionItem): { tnvedCode: string; sectionKey: string; sectionLabel: string } {
  const payload = item.payload_json as Record<string, unknown> | undefined;
  const llmResult = payload?.llm_result as Record<string, unknown> | undefined;
  const promptIncludes = llmResult?.prompt_includes as Record<string, unknown> | undefined;
  const tnved = String(promptIncludes?.tnved_code ?? "").trim();
  const sec = classifyTnVedSection(tnved);
  return {
    tnvedCode: tnved || "—",
    sectionKey: sec.sectionKey,
    sectionLabel: sec.sectionLabel,
  };
}

function itemMatchesTnvedSection(item: ExpertDecisionItem, selectedSection: string): boolean {
  if (selectedSection === "all") return true;
  return sectionInfoFromDecision(item).sectionKey === selectedSection;
}

function groupItemsIntoWorkSections(rows: ExpertDecisionItem[]): WorkSectionGroup[] {
  const map = new Map<string, { label: string; items: ExpertDecisionItem[] }>();
  for (const it of rows) {
    const sec = sectionInfoFromDecision(it);
    const prev = map.get(sec.sectionKey);
    if (!prev) map.set(sec.sectionKey, { label: sec.sectionLabel, items: [it] });
    else prev.items.push(it);
  }
  return [...map.entries()]
    .map(([key, value]) => ({
      sectionKey: key,
      sectionLabel: value.label,
      items: value.items.sort((a, b) => b.created_at.localeCompare(a.created_at)),
    }))
    .sort((a, b) => a.sectionLabel.localeCompare(b.sectionLabel, "ru"));
}

function dedupeNamingDecisionRows(rows: NamingDecisionRow[]): NamingDecisionRow[] {
  const byDeclaration = new Map<string, NamingDecisionRow>();
  for (const row of rows) {
    const key = String(row.item.declaration_id ?? "").trim().toLowerCase();
    if (!key) continue;
    const prev = byDeclaration.get(key);
    if (!prev) {
      byDeclaration.set(key, row);
      continue;
    }
    const prevPri = namingRowPriority(prev.item);
    const curPri = namingRowPriority(row.item);
    if (curPri > prevPri) {
      byDeclaration.set(key, row);
      continue;
    }
    if (curPri < prevPri) continue;
    const prevPending = prev.item.status === "pending";
    const curPending = row.item.status === "pending";
    if (curPending && !prevPending) {
      byDeclaration.set(key, row);
      continue;
    }
    if (curPending === prevPending && row.item.created_at > prev.item.created_at) {
      byDeclaration.set(key, row);
    }
  }
  return [...byDeclaration.values()].sort((a, b) => b.item.created_at.localeCompare(a.item.created_at));
}

function normalizeDescriptionKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function aggregateNamingRows(rows: NamingDecisionRow[]): AggregatedNamingRow[] {
  const byKey = new Map<string, AggregatedNamingRow>();
  for (const row of rows) {
    const descKey = normalizeDescriptionKey(row.description);
    const key = `${descKey}::${row.tnvedCode}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        key,
        declarations: [row.item.declaration_id],
        description: row.description,
        extractedFeatures: row.extractedFeatures,
        tnvedCode: row.tnvedCode,
        tnvedGroupCode: row.tnvedGroupCode,
        sectionKey: row.sectionKey,
        sectionLabel: row.sectionLabel,
        suggestedClassName: row.suggestedClassName,
        pendingItems: row.item.status === "pending" ? [row.item] : [],
        latestItem: row.item,
      });
      continue;
    }
    if (!existing.declarations.includes(row.item.declaration_id)) {
      existing.declarations.push(row.item.declaration_id);
    }
    if (row.item.status === "pending") existing.pendingItems.push(row.item);
    if (row.item.created_at > existing.latestItem.created_at) {
      existing.latestItem = row.item;
      existing.suggestedClassName = row.suggestedClassName;
      existing.extractedFeatures = row.extractedFeatures;
    }
  }
  return [...byKey.values()].sort((a, b) => b.latestItem.created_at.localeCompare(a.latestItem.created_at));
}

function WorkQueueTable({
  sections,
  busyId,
  catalogOptionsByRule,
  workQueueClassByItemId,
  setWorkQueueClassByItemId,
  openWorkClassPickerKey,
  setOpenWorkClassPickerKey,
  onResolve,
  onDismiss,
}: {
  sections: WorkSectionGroup[];
  busyId: string | null;
  catalogOptionsByRule: Record<string, ClassOption[]>;
  workQueueClassByItemId: Record<string, string>;
  setWorkQueueClassByItemId: Dispatch<SetStateAction<Record<string, string>>>;
  openWorkClassPickerKey: string | null;
  setOpenWorkClassPickerKey: Dispatch<SetStateAction<string | null>>;
  onResolve: (id: string, resolution: Record<string, unknown>) => void | Promise<void>;
  onDismiss: (id: string) => void | Promise<void>;
}) {
  if (sections.length === 0) {
    return <div style={{ color: "#64748b", fontSize: 14 }}>Нет записей для выбранных фильтров.</div>;
  }
  return (
    <div style={{ display: "grid", gap: 22 }}>
      {sections.map((section) => (
        <section key={section.sectionKey}>
          <h3 style={{ fontSize: 15, fontWeight: 700, color: "#0f172a", margin: "0 0 10px" }}>
            {section.sectionLabel} ({section.items.length})
          </h3>
          <div style={{ border: "1px solid #e2e8f0", borderRadius: 10, overflow: "hidden" }}>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", minWidth: 1080, borderCollapse: "collapse", fontSize: 13, tableLayout: "fixed" }}>
                <thead style={{ background: "#f8fafc" }}>
                  <tr>
                    <th style={{ width: 125, textAlign: "left", padding: "8px 10px", borderBottom: "1px solid #e2e8f0" }}>Дата</th>
                    <th style={{ width: 120, textAlign: "left", padding: "8px 10px", borderBottom: "1px solid #e2e8f0" }}>Декларация</th>
                    <th style={{ width: 115, textAlign: "left", padding: "8px 10px", borderBottom: "1px solid #e2e8f0" }}>ТН ВЭД</th>
                    <th style={{ width: "22%", textAlign: "left", padding: "8px 10px", borderBottom: "1px solid #e2e8f0" }}>Описание</th>
                    <th style={{ width: 155, textAlign: "left", padding: "8px 10px", borderBottom: "1px solid #e2e8f0" }}>Тип</th>
                    <th style={{ width: "26%", textAlign: "left", padding: "8px 10px", borderBottom: "1px solid #e2e8f0" }}>Действия эксперта</th>
                  </tr>
                </thead>
                <tbody>
                  {section.items.map((it) => {
                    const tn = workQueueTnvedCode(it) || "—";
                    const desc = workQueueDescriptionRu(it);
                    const typeLabel = labelCategory(it.category);
                    const rid = String(it.rule_id ?? "").trim();
                    const options = rid ? catalogOptionsByRule[rid] ?? [] : [];
                    const isClassification =
                      it.category === "classification_ambiguous" || it.category === "classification_none";
                    const isInspector = it.category === "inspector_feature_correction";
                    const isOfficer = it.category === "officer_final_decision";
                    const suggestedOfficer = officerSuggestedClassId(it);
                    const classDraft =
                      workQueueClassByItemId[it.id] ??
                      (isClassification ? "" : suggestedOfficer);
                    const pending = it.status === "pending";

                    return (
                      <tr key={it.id} style={{ background: pending ? "#fff" : "#f8fafc", verticalAlign: "top" }}>
                        <td style={{ padding: "8px 10px", borderBottom: "1px solid #f1f5f9", fontSize: 12, color: "#64748b", whiteSpace: "nowrap" }}>
                          {it.created_at?.slice(0, 19) ?? "—"}
                        </td>
                        <td style={{ padding: "8px 10px", borderBottom: "1px solid #f1f5f9", fontFamily: "ui-monospace, monospace", fontSize: 12 }}>
                          {it.declaration_id}
                        </td>
                        <td style={{ padding: "8px 10px", borderBottom: "1px solid #f1f5f9", fontSize: 12 }}>{tn}</td>
                        <td style={{ padding: "8px 10px", borderBottom: "1px solid #f1f5f9", lineHeight: 1.4, wordBreak: "break-word" }}>
                          <div style={{ color: "#0f172a" }}>{desc}</div>
                          {it.rule_id ? (
                            <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 4 }}>Справочник: {it.rule_id}</div>
                          ) : null}
                        </td>
                        <td style={{ padding: "8px 10px", borderBottom: "1px solid #f1f5f9", fontWeight: 600, color: "#334155" }}>{typeLabel}</td>
                        <td style={{ padding: "8px 10px", borderBottom: "1px solid #f1f5f9" }}>
                          {!pending ? (
                            <div style={{ fontSize: 13, color: "#64748b" }}>
                              <span style={{ fontWeight: 600 }}>{labelStatus(it.status)}</span>
                              {it.resolution_json && Object.keys(it.resolution_json).length > 0 ? (
                                <div style={{ marginTop: 6 }}>Итог: {formatResolutionRu(it.resolution_json)}</div>
                              ) : null}
                            </div>
                          ) : isInspector ? (
                            <div style={{ display: "grid", gap: 8 }}>
                              <details style={{ fontSize: 12, color: "#475569" }}>
                                <summary style={{ cursor: "pointer" }}>Сравнение признаков</summary>
                                <div style={{ marginTop: 8 }}>
                                  <InspectorCorrectionView payload={it.payload_json} />
                                </div>
                              </details>
                              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                                <button
                                  type="button"
                                  className="btn"
                                  disabled={busyId === it.id}
                                  onClick={() => void onResolve(it.id, { acknowledged_by_expert: true })}
                                >
                                  Принять к сведению
                                </button>
                                <button type="button" className="btn-secondary" disabled={busyId === it.id} onClick={() => void onDismiss(it.id)}>
                                  Отклонить
                                </button>
                              </div>
                            </div>
                          ) : isClassification ? (
                            <div style={{ display: "grid", gap: 8 }}>
                              <div style={{ position: "relative", display: "grid", gridTemplateColumns: "1fr auto", gap: 6 }}>
                                <input
                                  type="text"
                                  value={classDraft}
                                  onChange={(e) => {
                                    const v = e.target.value;
                                    setWorkQueueClassByItemId((prev) => ({ ...prev, [it.id]: v }));
                                    setOpenWorkClassPickerKey(it.id);
                                  }}
                                  onFocus={() => setOpenWorkClassPickerKey(it.id)}
                                  placeholder="Класс из справочника"
                                  autoComplete="off"
                                  style={{ padding: "7px 9px", borderRadius: 8, border: "1px solid #cbd5e1" }}
                                />
                                <button
                                  type="button"
                                  className="btn-secondary"
                                  onClick={() => setOpenWorkClassPickerKey((prev) => (prev === it.id ? null : it.id))}
                                  style={{ padding: "6px 10px" }}
                                  title="Варианты из справочника"
                                >
                                  ▼
                                </button>
                                {openWorkClassPickerKey === it.id && options.length > 0 ? (
                                  <div
                                    style={{
                                      position: "absolute",
                                      top: "100%",
                                      left: 0,
                                      right: 0,
                                      zIndex: 20,
                                      marginTop: 4,
                                      background: "#fff",
                                      border: "1px solid #cbd5e1",
                                      borderRadius: 8,
                                      boxShadow: "0 8px 18px rgba(15, 23, 42, 0.12)",
                                      maxHeight: 200,
                                      overflow: "auto",
                                    }}
                                  >
                                    {options
                                      .filter((opt) => {
                                        const q = String(classDraft ?? "").trim().toLowerCase();
                                        if (!q) return true;
                                        return opt.id.toLowerCase().includes(q) || opt.label.toLowerCase().includes(q);
                                      })
                                      .slice(0, 60)
                                      .map((opt) => (
                                        <button
                                          key={opt.id}
                                          type="button"
                                          onMouseDown={(e) => e.preventDefault()}
                                          onClick={() => {
                                            setWorkQueueClassByItemId((prev) => ({ ...prev, [it.id]: opt.id }));
                                            setOpenWorkClassPickerKey(null);
                                          }}
                                          style={{
                                            display: "block",
                                            width: "100%",
                                            textAlign: "left",
                                            background: "transparent",
                                            border: "none",
                                            borderBottom: "1px solid #f1f5f9",
                                            padding: "7px 9px",
                                            cursor: "pointer",
                                            fontSize: 13,
                                            color: "#0f172a",
                                          }}
                                        >
                                          {opt.label}
                                        </button>
                                      ))}
                                  </div>
                                ) : null}
                              </div>
                              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                                <button
                                  type="button"
                                  className="btn"
                                  disabled={busyId === it.id}
                                  onClick={() => void onResolve(it.id, { chosen_class_id: String(classDraft ?? "").trim() })}
                                >
                                  Подтвердить класс
                                </button>
                                <button type="button" className="btn-secondary" disabled={busyId === it.id} onClick={() => void onDismiss(it.id)}>
                                  Отклонить
                                </button>
                              </div>
                            </div>
                          ) : isOfficer ? (
                            <div style={{ display: "grid", gap: 8 }}>
                              {suggestedOfficer ? (
                                <div style={{ fontSize: 12, color: "#64748b" }}>
                                  Класс по данным инспектора: <strong style={{ color: "#334155" }}>{suggestedOfficer}</strong>
                                </div>
                              ) : null}
                              <div style={{ position: "relative", display: "grid", gridTemplateColumns: "1fr auto", gap: 6 }}>
                                <input
                                  type="text"
                                  value={classDraft}
                                  onChange={(e) => {
                                    setWorkQueueClassByItemId((prev) => ({ ...prev, [it.id]: e.target.value }));
                                    setOpenWorkClassPickerKey(`officer-${it.id}`);
                                  }}
                                  onFocus={() => setOpenWorkClassPickerKey(`officer-${it.id}`)}
                                  placeholder="Итоговый класс для эталона"
                                  autoComplete="off"
                                  style={{ padding: "7px 9px", borderRadius: 8, border: "1px solid #cbd5e1" }}
                                />
                                {rid ? (
                                  <button
                                    type="button"
                                    className="btn-secondary"
                                    onClick={() => setOpenWorkClassPickerKey((prev) => (prev === `officer-${it.id}` ? null : `officer-${it.id}`))}
                                    style={{ padding: "6px 10px" }}
                                    title="Варианты из справочника"
                                  >
                                    ▼
                                  </button>
                                ) : null}
                                {openWorkClassPickerKey === `officer-${it.id}` && options.length > 0 ? (
                                  <div
                                    style={{
                                      position: "absolute",
                                      top: "100%",
                                      left: 0,
                                      right: 0,
                                      zIndex: 20,
                                      marginTop: 4,
                                      background: "#fff",
                                      border: "1px solid #cbd5e1",
                                      borderRadius: 8,
                                      boxShadow: "0 8px 18px rgba(15, 23, 42, 0.12)",
                                      maxHeight: 200,
                                      overflow: "auto",
                                    }}
                                  >
                                    {options
                                      .filter((opt) => {
                                        const q = String(classDraft ?? "").trim().toLowerCase();
                                        if (!q) return true;
                                        return opt.id.toLowerCase().includes(q) || opt.label.toLowerCase().includes(q);
                                      })
                                      .slice(0, 60)
                                      .map((opt) => (
                                        <button
                                          key={opt.id}
                                          type="button"
                                          onMouseDown={(e) => e.preventDefault()}
                                          onClick={() => {
                                            setWorkQueueClassByItemId((prev) => ({ ...prev, [it.id]: opt.id }));
                                            setOpenWorkClassPickerKey(null);
                                          }}
                                          style={{
                                            display: "block",
                                            width: "100%",
                                            textAlign: "left",
                                            background: "transparent",
                                            border: "none",
                                            borderBottom: "1px solid #f1f5f9",
                                            padding: "7px 9px",
                                            cursor: "pointer",
                                            fontSize: 13,
                                            color: "#0f172a",
                                          }}
                                        >
                                          {opt.label}
                                        </button>
                                      ))}
                                  </div>
                                ) : null}
                              </div>
                              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                                <button
                                  type="button"
                                  className="btn"
                                  disabled={busyId === it.id}
                                  onClick={() => {
                                    const chosen = String(classDraft ?? "").trim();
                                    void onResolve(it.id, { chosen_class_id: chosen || null, source: "expert_queue" });
                                  }}
                                >
                                  Подтвердить
                                </button>
                                <button type="button" className="btn-secondary" disabled={busyId === it.id} onClick={() => void onDismiss(it.id)}>
                                  Отклонить
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div style={{ display: "grid", gap: 8 }}>
                              <div style={{ position: "relative", display: "grid", gridTemplateColumns: rid ? "1fr auto" : "1fr", gap: 6 }}>
                                <input
                                  type="text"
                                  value={classDraft}
                                  onChange={(e) => {
                                    setWorkQueueClassByItemId((prev) => ({ ...prev, [it.id]: e.target.value }));
                                    setOpenWorkClassPickerKey(`other-${it.id}`);
                                  }}
                                  onFocus={() => setOpenWorkClassPickerKey(`other-${it.id}`)}
                                  placeholder="Класс (при необходимости)"
                                  autoComplete="off"
                                  style={{ padding: "7px 9px", borderRadius: 8, border: "1px solid #cbd5e1" }}
                                />
                                {rid ? (
                                  <button
                                    type="button"
                                    className="btn-secondary"
                                    onClick={() => setOpenWorkClassPickerKey((prev) => (prev === `other-${it.id}` ? null : `other-${it.id}`))}
                                    style={{ padding: "6px 10px" }}
                                    title="Варианты из справочника"
                                  >
                                    ▼
                                  </button>
                                ) : null}
                                {openWorkClassPickerKey === `other-${it.id}` && options.length > 0 ? (
                                  <div
                                    style={{
                                      position: "absolute",
                                      top: "100%",
                                      left: 0,
                                      right: 0,
                                      zIndex: 20,
                                      marginTop: 4,
                                      background: "#fff",
                                      border: "1px solid #cbd5e1",
                                      borderRadius: 8,
                                      boxShadow: "0 8px 18px rgba(15, 23, 42, 0.12)",
                                      maxHeight: 200,
                                      overflow: "auto",
                                    }}
                                  >
                                    {options
                                      .filter((opt) => {
                                        const q = String(classDraft ?? "").trim().toLowerCase();
                                        if (!q) return true;
                                        return opt.id.toLowerCase().includes(q) || opt.label.toLowerCase().includes(q);
                                      })
                                      .slice(0, 60)
                                      .map((opt) => (
                                        <button
                                          key={opt.id}
                                          type="button"
                                          onMouseDown={(e) => e.preventDefault()}
                                          onClick={() => {
                                            setWorkQueueClassByItemId((prev) => ({ ...prev, [it.id]: opt.id }));
                                            setOpenWorkClassPickerKey(null);
                                          }}
                                          style={{
                                            display: "block",
                                            width: "100%",
                                            textAlign: "left",
                                            background: "transparent",
                                            border: "none",
                                            borderBottom: "1px solid #f1f5f9",
                                            padding: "7px 9px",
                                            cursor: "pointer",
                                            fontSize: 13,
                                            color: "#0f172a",
                                          }}
                                        >
                                          {opt.label}
                                        </button>
                                      ))}
                                  </div>
                                ) : null}
                              </div>
                              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                                <button
                                  type="button"
                                  className="btn"
                                  disabled={busyId === it.id}
                                  onClick={() => {
                                    const chosen = String(classDraft ?? "").trim();
                                    void onResolve(it.id, chosen ? { chosen_class_id: chosen } : { acknowledged_by_expert: true });
                                  }}
                                >
                                  Подтвердить
                                </button>
                                <button type="button" className="btn-secondary" disabled={busyId === it.id} onClick={() => void onDismiss(it.id)}>
                                  Отклонить
                                </button>
                              </div>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      ))}
    </div>
  );
}

export default function ExpertDecisionsPage() {
  const [items, setItems] = useState<ExpertDecisionItem[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [filter, setFilter] = useState<"pending" | "all">("pending");
  const [issueTypeFilter, setIssueTypeFilter] = useState<UiIssueType>("all");
  const [selectedSection, setSelectedSection] = useState<string>("all");
  const [manualClassById, setManualClassById] = useState<Record<string, string>>({});
  const [catalogOptionsByRule, setCatalogOptionsByRule] = useState<Record<string, ClassOption[]>>({});
  const [namingModalOpen, setNamingModalOpen] = useState(false);
  const [namingModalLane, setNamingModalLane] = useState<"model" | "post" | null>(null);
  const [workQueueModalOpen, setWorkQueueModalOpen] = useState(false);
  const [workQueueView, setWorkQueueView] = useState<WorkQueueViewState | null>(null);
  const [workQueueClassByItemId, setWorkQueueClassByItemId] = useState<Record<string, string>>({});
  const [openWorkClassPickerKey, setOpenWorkClassPickerKey] = useState<string | null>(null);
  const [openClassPickerKey, setOpenClassPickerKey] = useState<string | null>(null);
  const [pendingStatusChange, setPendingStatusChange] = useState<PendingStatusChange | null>(null);

  const load = useCallback(async () => {
    setStatus(null);
    try {
      try {
        await repairExpertLlmNamingQueue();
      } catch {
        /* очередь всё равно загружаем; repair — best-effort для старых записей */
      }
      const list = await listExpertDecisions({
        page: 1,
        page_size: 100,
        ...(filter === "pending" ? { status: "pending" } : {}),
      });
      setItems(list.items);
    } catch (e: unknown) {
      setStatus(e instanceof Error ? e.message : "Не удалось загрузить данные.");
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  const displayItems = useMemo(() => {
    if (issueTypeFilter === "all") return items;
    return items.filter((it) => toolbarIssueTypeFromItem(it, items) === issueTypeFilter);
  }, [items, issueTypeFilter]);

  const namingRowsAll = useMemo(() => {
    const raw = displayItems.filter((it) => isNamingDecisionCategory(it.category)).map(namingRowFromDecision);
    return dedupeNamingDecisionRows(raw);
  }, [displayItems]);

  const namingRowsForModalTable = useMemo(() => {
    if (!namingModalOpen || namingModalLane == null) {
      return namingRowsAll;
    }
    const raw = displayItems
      .filter((it) =>
        namingModalLane === "model" ? isNamingModelItem(it, displayItems) : isNamingPostControlItem(it, displayItems),
      )
      .map(namingRowFromDecision);
    return dedupeNamingDecisionRows(raw);
  }, [displayItems, namingModalOpen, namingModalLane, namingRowsAll]);

  const modelLaneUniqueCount = useMemo(() => {
    const ids = new Set<string>();
    for (const it of displayItems) {
      if (!isNamingModelItem(it, displayItems)) continue;
      if (!itemMatchesTnvedSection(it, selectedSection)) continue;
      const id = String(it.declaration_id ?? "").trim().toLowerCase();
      if (id) ids.add(id);
    }
    return ids.size;
  }, [displayItems, selectedSection]);

  const postLaneUniqueCount = useMemo(() => {
    const ids = new Set<string>();
    for (const it of displayItems) {
      if (!isNamingPostControlItem(it, displayItems)) continue;
      if (!itemMatchesTnvedSection(it, selectedSection)) continue;
      const id = String(it.declaration_id ?? "").trim().toLowerCase();
      if (id) ids.add(id);
    }
    return ids.size;
  }, [displayItems, selectedSection]);

  const namingUniqueDeclCountBySectionModel = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const it of displayItems) {
      if (!isNamingModelItem(it, displayItems)) continue;
      const id = String(it.declaration_id ?? "").trim().toLowerCase();
      if (!id) continue;
      const sec = sectionInfoFromDecision(it).sectionKey;
      if (!m.has(sec)) m.set(sec, new Set());
      m.get(sec)!.add(id);
    }
    return m;
  }, [displayItems]);

  const namingUniqueDeclCountBySectionPost = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const it of displayItems) {
      if (!isNamingPostControlItem(it, displayItems)) continue;
      const id = String(it.declaration_id ?? "").trim().toLowerCase();
      if (!id) continue;
      const sec = sectionInfoFromDecision(it).sectionKey;
      if (!m.has(sec)) m.set(sec, new Set());
      m.get(sec)!.add(id);
    }
    return m;
  }, [displayItems]);

  const namingModalAllSectionDeclCount = useMemo(() => {
    if (namingModalLane === "model") {
      const ids = new Set<string>();
      for (const it of displayItems) {
        if (!isNamingModelItem(it, displayItems)) continue;
        const id = String(it.declaration_id ?? "").trim().toLowerCase();
        if (id) ids.add(id);
      }
      return ids.size;
    }
    if (namingModalLane === "post") {
      const ids = new Set<string>();
      for (const it of displayItems) {
        if (!isNamingPostControlItem(it, displayItems)) continue;
        const id = String(it.declaration_id ?? "").trim().toLowerCase();
        if (id) ids.add(id);
      }
      return ids.size;
    }
    const ids = new Set<string>();
    for (const it of displayItems) {
      if (!isNamingDecisionCategory(it.category)) continue;
      const id = String(it.declaration_id ?? "").trim().toLowerCase();
      if (id) ids.add(id);
    }
    return ids.size;
  }, [displayItems, namingModalLane]);

  const namingModalDeclBySection = useMemo(() => {
    if (namingModalLane === "model") return namingUniqueDeclCountBySectionModel;
    if (namingModalLane === "post") return namingUniqueDeclCountBySectionPost;
    const merged = new Map<string, Set<string>>();
    for (const it of displayItems) {
      if (!isNamingDecisionCategory(it.category)) continue;
      const id = String(it.declaration_id ?? "").trim().toLowerCase();
      if (!id) continue;
      const sec = sectionInfoFromDecision(it).sectionKey;
      if (!merged.has(sec)) merged.set(sec, new Set());
      merged.get(sec)!.add(id);
    }
    return merged;
  }, [displayItems, namingModalLane, namingUniqueDeclCountBySectionModel, namingUniqueDeclCountBySectionPost]);

  const hasModelLaneItems = useMemo(
    () => displayItems.some((it) => isNamingModelItem(it, displayItems)),
    [displayItems],
  );
  const hasPostLaneItems = useMemo(
    () => displayItems.some((it) => isNamingPostControlItem(it, displayItems)),
    [displayItems],
  );

  const sectionCounts = useMemo(() => {
    const m = new Map<string, { label: string; count: number }>();
    for (const it of displayItems) {
      const sec = sectionInfoFromDecision(it);
      const prev = m.get(sec.sectionKey);
      if (!prev) m.set(sec.sectionKey, { label: sec.sectionLabel, count: 1 });
      else m.set(sec.sectionKey, { label: prev.label, count: prev.count + 1 });
    }
    return [...m.entries()].sort((a, b) => a[1].label.localeCompare(b[1].label, "ru"));
  }, [displayItems]);

  const issueTypeCounts = useMemo(() => {
    const base: Record<UiIssueType, number> = {
      all: items.length,
      model_class: 0,
      post_customs_control: 0,
      classification: 0,
      inspector_correction: 0,
      officer_decision: 0,
    };
    for (const it of items) {
      const t = toolbarIssueTypeFromItem(it, items);
      if (t !== "all") base[t] += 1;
    }
    return base;
  }, [items]);

  const visibleNamingRows = useMemo(() => {
    if (selectedSection === "all") return namingRowsForModalTable;
    return namingRowsForModalTable.filter((row) => row.sectionKey === selectedSection);
  }, [namingRowsForModalTable, selectedSection]);
  const aggregatedNamingRows = useMemo(() => aggregateNamingRows(visibleNamingRows), [visibleNamingRows]);

  const rulesLaneCount = useMemo(
    () =>
      displayItems.filter((it) => isWorkQueueRuleCategory(it.category) && itemMatchesTnvedSection(it, selectedSection)).length,
    [displayItems, selectedSection],
  );
  const officerLaneCount = useMemo(
    () =>
      displayItems.filter(
        (it) => shouldShowInOfficerWorkQueue(it, items) && itemMatchesTnvedSection(it, selectedSection),
      ).length,
    [displayItems, items, selectedSection],
  );
  const featuresLaneCount = useMemo(
    () =>
      displayItems.filter(
        (it) => it.category === "inspector_feature_correction" && itemMatchesTnvedSection(it, selectedSection),
      ).length,
    [displayItems, selectedSection],
  );

  const orphanCategories = useMemo(() => {
    const s = new Set<string>();
    for (const it of displayItems) {
      if (!isStandardExpertCategory(it.category)) s.add(it.category);
    }
    return [...s].sort((a, b) => a.localeCompare(b, "ru"));
  }, [displayItems]);

  const workQueueModalSections = useMemo(() => {
    if (!workQueueView) return [];
    const rows = displayItems.filter((it) => {
      if (!itemMatchesTnvedSection(it, selectedSection)) return false;
      if (workQueueView.kind === "orphan") return it.category === workQueueView.category;
      if (workQueueView.lane === "rules") return isWorkQueueRuleCategory(it.category);
      if (workQueueView.lane === "officer") return shouldShowInOfficerWorkQueue(it, items);
      return it.category === "inspector_feature_correction";
    });
    return groupItemsIntoWorkSections(rows);
  }, [displayItems, workQueueView, selectedSection]);

  const anyWorkStandardLane =
    rulesLaneCount > 0 || officerLaneCount > 0 || featuresLaneCount > 0 || orphanCategories.length > 0;

  useEffect(() => {
    if (selectedSection === "all") return;
    const exists = sectionCounts.some(([key]) => key === selectedSection);
    if (!exists) setSelectedSection("all");
  }, [sectionCounts, selectedSection]);

  useEffect(() => {
    const next: Record<string, string> = {};
    for (const row of namingRowsAll) {
      if (row.item.status !== "pending") continue;
      const fallback = row.suggestedClassName === "—" ? "" : row.suggestedClassName;
      next[row.item.id] = manualClassById[row.item.id] ?? fallback;
    }
    if (Object.keys(next).length === 0) return;
    setManualClassById((prev) => ({ ...next, ...prev }));
  }, [namingRowsAll]);

  useEffect(() => {
    const ruleIds = Array.from(new Set(items.map((it) => String(it.rule_id ?? "").trim()).filter(Boolean)));
    const missing = ruleIds.filter((rid) => catalogOptionsByRule[rid] == null);
    if (missing.length === 0) return;
    let cancelled = false;
    void (async () => {
      const entries = await Promise.all(
        missing.map(async (rid) => {
          try {
            const full = await getRule(rid);
            return [rid, extractClassOptionsFromDsl(full?.dsl)] as const;
          } catch {
            return [rid, [] as ClassOption[]] as const;
          }
        }),
      );
      if (cancelled) return;
      setCatalogOptionsByRule((prev) => {
        const next = { ...prev };
        for (const [rid, options] of entries) next[rid] = options;
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [catalogOptionsByRule, items]);

  useEffect(() => {
    setWorkQueueClassByItemId((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const sec of workQueueModalSections) {
        for (const it of sec.items) {
          if (it.status !== "pending") continue;
          if (next[it.id] != null && String(next[it.id]).length > 0) continue;
          if (it.category !== "officer_final_decision") continue;
          const suggested = officerSuggestedClassId(it);
          if (suggested) {
            next[it.id] = suggested;
            changed = true;
          }
        }
      }
      return changed ? next : prev;
    });
  }, [workQueueModalSections]);

  async function onResolve(id: string, resolution: Record<string, unknown>) {
    setBusyId(id);
    setStatus(null);
    try {
      await patchExpertDecision(id, { status: "resolved", resolution });
      await load();
    } catch (e: unknown) {
      setStatus(e instanceof Error ? e.message : "Ошибка сохранения.");
    } finally {
      setBusyId(null);
    }
  }

  async function onDismiss(id: string) {
    setBusyId(id);
    setStatus(null);
    try {
      await patchExpertDecision(id, { status: "dismissed", resolution: {} });
      await load();
    } catch (e: unknown) {
      setStatus(e instanceof Error ? e.message : "Ошибка.");
    } finally {
      setBusyId(null);
    }
  }


  async function onApplyNamingForAggregate(
    agg: AggregatedNamingRow,
    nextStatus: "resolved" | "dismissed",
    classNameRaw?: string,
  ) {
    const targetItems = agg.pendingItems;
    if (targetItems.length === 0) return;
    const finalClass = String(classNameRaw ?? "").trim();
    if (nextStatus === "resolved" && !finalClass) {
      setStatus("Укажите имя класса перед подтверждением.");
      return;
    }
    setBusyId(agg.key);
    setStatus(null);
    try {
      await Promise.all(
        targetItems.map((it) =>
          patchExpertDecision(it.id, {
            status: nextStatus,
            resolution:
              nextStatus === "resolved"
                ? {
                    confirmed_class_id: finalClass,
                    source: "aggregate_manual",
                  }
                : {},
          }),
        ),
      );
      await load();
    } catch (e: unknown) {
      setStatus(e instanceof Error ? e.message : "Не удалось сохранить решение.");
    } finally {
      setBusyId(null);
    }
  }

  async function confirmPendingStatusChange() {
    if (!pendingStatusChange) return;
    const payload = pendingStatusChange;
    setPendingStatusChange(null);
    await onApplyNamingForAggregate(payload.row, payload.nextStatus, payload.className);
  }

  const shell: React.CSSProperties = {
    width: "100%",
    maxWidth: 1240,
    margin: "0 auto",
    paddingBottom: 28,
  };

  const namingModalTitle =
    namingModalLane === "model"
      ? "Утверждение класса по предложению модели"
      : namingModalLane === "post"
        ? "Проверка класса после таможенного контроля"
        : "Наименование класса";

  const workQueueModalTitle =
    workQueueView == null
      ? "Таблица очереди"
      : workQueueView.kind === "orphan"
        ? labelCategory(workQueueView.category)
        : workQueueView.lane === "rules"
          ? "Выбор класса по правилам справочника"
          : workQueueView.lane === "officer"
            ? "Записи по итогам решения инспектора"
            : "Согласование правок признаков";

  return (
    <div style={shell}>
      <header style={{ textAlign: "center", marginBottom: 22 }}>
        <h1 style={{ margin: "0 0 10px", fontSize: 24, fontWeight: 700, color: "#0f172a", letterSpacing: "-0.02em" }}>
          Очередь на проверку экспертом
        </h1>
        <p
          style={{
            margin: 0,
            color: "#64748b",
            fontSize: 15,
            lineHeight: 1.6,
            maxWidth: 620,
            marginLeft: "auto",
            marginRight: "auto",
          }}
        >
          Сюда попадают спорные декларации, которые необходимо проверить эксперту. Например, декларации отправленные в
          экспертизу инспектором или декларации, для которых LLM сгенерировала имя.
        </p>
      </header>

      <div
        className="card"
        style={{
          padding: "14px 18px",
          marginBottom: 18,
          display: "flex",
          flexWrap: "wrap",
          gap: 12,
          alignItems: "center",
          justifyContent: "center",
          border: "1px solid #e2e8f0",
        }}
      >
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, color: "#334155", fontWeight: 500 }}>
          Группа ТН ВЭД
          <select
            value={selectedSection}
            onChange={(e) => setSelectedSection(e.target.value)}
            style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid #cbd5e1", minWidth: 230 }}
          >
            <option value="all">Все группы ({items.length})</option>
            {sectionCounts.map(([key, meta]) => (
              <option key={key} value={key}>
                {meta.label} ({meta.count})
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, color: "#334155", fontWeight: 500 }}>
          Тип проблемы
          <select
            value={issueTypeFilter}
            onChange={(e) => setIssueTypeFilter(e.target.value as UiIssueType)}
            style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid #cbd5e1", minWidth: 220 }}
          >
            {Object.entries(UI_ISSUE_TYPE_LABEL).map(([key, label]) => (
              <option key={key} value={key}>
                {label} ({issueTypeCounts[key as UiIssueType] ?? 0})
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, color: "#334155", fontWeight: 500 }}>
          Показать
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as "pending" | "all")}
            style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid #cbd5e1", minWidth: 200 }}
          >
            <option value="pending">только ожидающие</option>
            <option value="all">все записи</option>
          </select>
        </label>
        <button type="button" className="btn-secondary" onClick={() => void load()}>
          Обновить
        </button>
      </div>

      {status ? (
        <div
          role="alert"
          style={{
            color: "#b91c1c",
            fontWeight: 600,
            marginBottom: 14,
            fontSize: 14,
            textAlign: "center",
          }}
        >
          {status}
        </div>
      ) : null}

      {displayItems.length === 0 ? (
        <div
          className="card"
          style={{
            border: "1px dashed #cbd5e1",
            background: "#f8fafc",
            color: "#475569",
            textAlign: "center",
            padding: "32px 20px",
          }}
        >
          <p style={{ margin: 0, fontSize: 15 }}>Пока нет записей для выбранного фильтра.</p>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 28 }}>
          {(hasModelLaneItems || hasPostLaneItems) &&
          (issueTypeFilter === "all" || issueTypeFilter === "model_class" || issueTypeFilter === "post_customs_control") ? (
            <section>
              <h2 style={{ fontSize: 16, fontWeight: 700, color: "#0f172a", margin: "0 0 12px" }}>
                Классификация и наименование
              </h2>
              <div style={{ display: "grid", gap: 14 }}>
                {hasModelLaneItems && (issueTypeFilter === "all" || issueTypeFilter === "model_class") ? (
                  <div
                    className="card"
                    style={{
                      border: "1px solid #e2e8f0",
                      borderRadius: 12,
                      padding: 14,
                      background: "#fff",
                    }}
                  >
                    <h3 style={{ margin: "0 0 8px", fontSize: 15, fontWeight: 700, color: "#0f172a" }}>
                      Утверждение класса по предложению модели
                    </h3>
                    <p style={{ margin: "0 0 12px", fontSize: 14, color: "#475569", lineHeight: 1.45 }}>
                      Система предложила класс или наименование — нужно подтвердить или исправить.
                    </p>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        setNamingModalLane("model");
                        setNamingModalOpen(true);
                      }}
                    >
                      Открыть таблицу ({modelLaneUniqueCount})
                    </button>
                  </div>
                ) : null}
                {hasPostLaneItems && (issueTypeFilter === "all" || issueTypeFilter === "post_customs_control") ? (
                  <div
                    className="card"
                    style={{
                      border: "1px solid #e2e8f0",
                      borderRadius: 12,
                      padding: 14,
                      background: "#fff",
                    }}
                  >
                    <h3 style={{ margin: "0 0 8px", fontSize: 15, fontWeight: 700, color: "#0f172a" }}>
                      Проверка класса после таможенного контроля
                    </h3>
                    <p style={{ margin: "0 0 12px", fontSize: 14, color: "#475569", lineHeight: 1.45 }}>
                      Заявки с проверки декларации: автоклассификация не сработала, класс задан вручную или инспектор направил декларацию на проверку экспертом.
                    </p>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        setNamingModalLane("post");
                        setNamingModalOpen(true);
                      }}
                    >
                      Открыть таблицу ({postLaneUniqueCount})
                    </button>
                  </div>
                ) : null}
              </div>
            </section>
          ) : null}

          {anyWorkStandardLane &&
          (issueTypeFilter === "all" ||
            issueTypeFilter === "classification" ||
            issueTypeFilter === "officer_decision" ||
            issueTypeFilter === "inspector_correction") ? (
            <section>
              <h2 style={{ fontSize: 16, fontWeight: 700, color: "#0f172a", margin: "0 0 12px" }}>
                Очередь по источнику заявки
              </h2>
              <div style={{ display: "grid", gap: 14 }}>
                {rulesLaneCount > 0 && (issueTypeFilter === "all" || issueTypeFilter === "classification") ? (
                  <div className="card" style={{ border: "1px solid #e2e8f0", borderRadius: 12, padding: 14, background: "#fff" }}>
                    <h3 style={{ margin: "0 0 8px", fontSize: 15, fontWeight: 700, color: "#0f172a" }}>
                      Выбор класса по правилам справочника
                    </h3>
                    <p style={{ margin: "0 0 12px", fontSize: 14, color: "#475569", lineHeight: 1.45 }}>
                      Несколько подходящих классов или ни один не подошёл — решение по правилам каталога ТН ВЭД.
                    </p>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        setWorkQueueView({ kind: "lane", lane: "rules" });
                        setWorkQueueModalOpen(true);
                      }}
                    >
                      Открыть таблицу ({rulesLaneCount})
                    </button>
                  </div>
                ) : null}
                {officerLaneCount > 0 && (issueTypeFilter === "all" || issueTypeFilter === "officer_decision") ? (
                  <div className="card" style={{ border: "1px solid #e2e8f0", borderRadius: 12, padding: 14, background: "#fff" }}>
                    <h3 style={{ margin: "0 0 8px", fontSize: 15, fontWeight: 700, color: "#0f172a" }}>
                      Записи по итогам решения инспектора
                    </h3>
                    <p style={{ margin: "0 0 12px", fontSize: 14, color: "#475569", lineHeight: 1.45 }}>
                      Сюда попадают только декларации, по которым инспектор нажал кнопку решения: принять, отклонить или
                      направить на проверку эксперту — в том числе если класс был указан вручную. Если противоречий не
                      было и достаточно обычного подтверждения без этих действий, отдельная заявка в эту очередь не
                      формируется. Нужна ваша оценка именно таких записей.
                    </p>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        setWorkQueueView({ kind: "lane", lane: "officer" });
                        setWorkQueueModalOpen(true);
                      }}
                    >
                      Открыть таблицу ({officerLaneCount})
                    </button>
                  </div>
                ) : null}
                {featuresLaneCount > 0 && (issueTypeFilter === "all" || issueTypeFilter === "inspector_correction") ? (
                  <div className="card" style={{ border: "1px solid #e2e8f0", borderRadius: 12, padding: 14, background: "#fff" }}>
                    <h3 style={{ margin: "0 0 8px", fontSize: 15, fontWeight: 700, color: "#0f172a" }}>
                      Согласование правок признаков
                    </h3>
                    <p style={{ margin: "0 0 12px", fontSize: 14, color: "#475569", lineHeight: 1.45 }}>
                      Инспектор изменил автоматически извлечённые характеристики — примите правку или отклоните.
                    </p>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        setWorkQueueView({ kind: "lane", lane: "features" });
                        setWorkQueueModalOpen(true);
                      }}
                    >
                      Открыть таблицу ({featuresLaneCount})
                    </button>
                  </div>
                ) : null}
                {orphanCategories.map((oc) => {
                  const cnt = displayItems.filter((it) => it.category === oc && itemMatchesTnvedSection(it, selectedSection)).length;
                  if (cnt === 0) return null;
                  return (
                    <div key={oc} className="card" style={{ border: "1px solid #e2e8f0", borderRadius: 12, padding: 14, background: "#fff" }}>
                      <h3 style={{ margin: "0 0 8px", fontSize: 15, fontWeight: 700, color: "#0f172a" }}>{labelCategory(oc)}</h3>
                      <p style={{ margin: "0 0 12px", fontSize: 14, color: "#475569", lineHeight: 1.45 }}>
                        Запись с нестандартным типом; уточните источник в данных.
                      </p>
                      <button
                        type="button"
                        className="btn"
                        onClick={() => {
                          setWorkQueueView({ kind: "orphan", category: oc });
                          setWorkQueueModalOpen(true);
                        }}
                      >
                        Открыть таблицу ({cnt})
                      </button>
                    </div>
                  );
                })}
              </div>
            </section>
          ) : null}
        </div>
      )}
      {namingModalOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={namingModalTitle}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1300,
            background: "rgba(15, 23, 42, 0.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 18,
          }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) {
              setNamingModalOpen(false);
              setNamingModalLane(null);
            }
          }}
        >
          <div
            className="card"
            style={{
              width: "min(98vw, 1560px)",
              maxHeight: "94vh",
              overflow: "auto",
              padding: 0,
              background: "#fff",
              border: "1px solid #cbd5e1",
              borderRadius: 12,
            }}
          >
            <div
              style={{
                position: "sticky",
                top: 0,
                zIndex: 1,
                background: "#fff",
                borderBottom: "1px solid #e2e8f0",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 8,
                padding: "8px 12px",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <strong style={{ color: "#0f172a", fontSize: 14 }}>{namingModalTitle}</strong>
                <span style={{ color: "#94a3b8", fontSize: 13 }}>·</span>
                <span style={{ color: "#475569", fontSize: 13 }}>Раздел ТН ВЭД:</span>
                <select
                  value={selectedSection}
                  onChange={(e) => setSelectedSection(e.target.value)}
                  style={{ padding: "6px 9px", borderRadius: 8, border: "1px solid #cbd5e1", minWidth: 360 }}
                >
                  <option value="all">Все категории ({namingModalAllSectionDeclCount})</option>
                  {sectionCounts.map(([key, meta]) => (
                    <option key={key} value={key}>
                      {meta.label} ({namingModalDeclBySection.get(key)?.size ?? 0})
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  setNamingModalOpen(false);
                  setNamingModalLane(null);
                }}
              >
                Закрыть
              </button>
            </div>
            <div style={{ minWidth: 0, padding: 12, display: "grid", gap: 14 }}>
                {aggregatedNamingRows.length === 0 ? (
                  <div style={{ color: "#64748b", fontSize: 14 }}>Для выбранной категории нет записей.</div>
                ) : (
                  <div style={{ border: "1px solid #e2e8f0", borderRadius: 10, overflow: "hidden" }}>
                      <div style={{ overflowX: "auto" }}>
                        <table style={{ width: "100%", minWidth: 1120, borderCollapse: "collapse", fontSize: 13, tableLayout: "fixed" }}>
                          <thead style={{ background: "#f8fafc" }}>
                            <tr>
                              <th style={{ width: 170, textAlign: "left", padding: "8px 10px", borderBottom: "1px solid #e2e8f0" }}>Декларации</th>
                              <th style={{ width: 140, textAlign: "left", padding: "8px 10px", borderBottom: "1px solid #e2e8f0" }}>Код ТН ВЭД</th>
                              <th style={{ width: "34%", textAlign: "left", padding: "8px 10px", borderBottom: "1px solid #e2e8f0" }}>Описание товара</th>
                              <th style={{ width: "28%", textAlign: "left", padding: "8px 10px", borderBottom: "1px solid #e2e8f0" }}>Класс</th>
                              <th style={{ width: 170, textAlign: "left", padding: "8px 10px", borderBottom: "1px solid #e2e8f0" }}>Статус</th>
                            </tr>
                          </thead>
                          <tbody>
                            {aggregatedNamingRows.map((row) => {
                              const options = (() => {
                                const rid = String(row.latestItem.rule_id ?? "").trim();
                                return rid ? catalogOptionsByRule[rid] ?? [] : [];
                              })();
                              const defaultClass = row.suggestedClassName === "—" ? "" : row.suggestedClassName;
                              const fieldKey = row.key;
                              return (
                                <tr key={row.key} style={{ background: row.pendingItems.length > 0 ? "#fff" : "#f8fafc" }}>
                                  <td style={{ padding: "8px 10px", borderBottom: "1px solid #f1f5f9", verticalAlign: "top", lineHeight: 1.35 }}>
                                    {row.declarations.join(", ")}
                                  </td>
                                  <td
                                    style={{
                                      padding: "8px 10px",
                                      borderBottom: "1px solid #f1f5f9",
                                      verticalAlign: "top",
                                      whiteSpace: "nowrap",
                                      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                                    }}
                                  >
                                    {row.tnvedCode || "—"}
                                  </td>
                                  <td style={{ padding: "8px 10px", borderBottom: "1px solid #f1f5f9", verticalAlign: "top" }}>
                                    <div style={{ color: "#0f172a", lineHeight: 1.4, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                                      {row.description}
                                    </div>
                                    <div style={{ color: "#64748b", fontSize: 12, marginTop: 4 }}>{row.sectionLabel}</div>
                                    <div style={{ color: "#64748b", fontSize: 12 }}>Группа ТН ВЭД: {row.tnvedGroupCode}</div>
                                  </td>
                                  <td style={{ padding: "8px 10px", borderBottom: "1px solid #f1f5f9", verticalAlign: "top" }}>
                                    {row.pendingItems.length > 0 ? (
                                      <div style={{ display: "grid", gap: 6 }}>
                                        {row.suggestedClassName !== "—" ? (
                                          <div
                                            style={{
                                              fontSize: 12,
                                              color: namingModalLane === "model" ? "#1d4ed8" : "#475569",
                                              lineHeight: 1.4,
                                              padding: "6px 8px",
                                              borderRadius: 8,
                                              background: namingModalLane === "model" ? "#eff6ff" : "#f8fafc",
                                              border: `1px solid ${namingModalLane === "model" ? "#bfdbfe" : "#e2e8f0"}`,
                                            }}
                                          >
                                            {namingModalLane === "model" ? (
                                              <>
                                                <strong style={{ fontWeight: 600 }}>Предложение модели:</strong>{" "}
                                                {row.suggestedClassName}
                                              </>
                                            ) : (
                                              <>
                                                <span style={{ color: "#64748b" }}>Модель также предложила класс:</span>{" "}
                                                <strong style={{ fontWeight: 600, color: "#0f172a" }}>{row.suggestedClassName}</strong>
                                                <span style={{ display: "block", marginTop: 4, color: "#94a3b8" }}>
                                                  Подтверждение имени — в блоке «Утверждение класса по предложению модели».
                                                </span>
                                              </>
                                            )}
                                          </div>
                                        ) : null}
                                        <span style={{ fontSize: 12, color: "#64748b" }}>
                                          {namingModalLane === "model"
                                            ? "Подтвердите или исправьте имя класса"
                                            : "Имя класса (выберите из списка или введите вручную)"}
                                        </span>
                                        <div style={{ position: "relative", display: "grid", gridTemplateColumns: "1fr auto", gap: 6 }}>
                                          <input
                                            type="text"
                                            value={manualClassById[fieldKey] ?? defaultClass}
                                            onChange={(e) => {
                                              const v = e.target.value;
                                              setManualClassById((prev) => ({ ...prev, [fieldKey]: v }));
                                              setOpenClassPickerKey(fieldKey);
                                            }}
                                            onFocus={() => setOpenClassPickerKey(fieldKey)}
                                            placeholder="Начните вводить имя класса..."
                                            autoComplete="off"
                                            style={{ padding: "7px 9px", borderRadius: 8, border: "1px solid #cbd5e1" }}
                                          />
                                          <button
                                            type="button"
                                            className="btn-secondary"
                                            onClick={() => setOpenClassPickerKey((prev) => (prev === fieldKey ? null : fieldKey))}
                                            style={{ padding: "6px 10px" }}
                                            title="Показать варианты из справочника"
                                          >
                                            ▼
                                          </button>
                                          {openClassPickerKey === fieldKey ? (
                                            <div
                                              style={{
                                                position: "absolute",
                                                top: "100%",
                                                left: 0,
                                                right: 0,
                                                zIndex: 20,
                                                marginTop: 4,
                                                background: "#fff",
                                                border: "1px solid #cbd5e1",
                                                borderRadius: 8,
                                                boxShadow: "0 8px 18px rgba(15, 23, 42, 0.12)",
                                                maxHeight: 220,
                                                overflow: "auto",
                                              }}
                                            >
                                              {options
                                                .filter((opt) => {
                                                  const q = String(manualClassById[fieldKey] ?? "").trim().toLowerCase();
                                                  if (!q) return true;
                                                  return opt.id.toLowerCase().includes(q) || opt.label.toLowerCase().includes(q);
                                                })
                                                .slice(0, 80)
                                                .map((opt) => (
                                                  <button
                                                    key={opt.id}
                                                    type="button"
                                                    onMouseDown={(e) => e.preventDefault()}
                                                    onClick={() => {
                                                      setManualClassById((prev) => ({ ...prev, [fieldKey]: opt.id }));
                                                      setOpenClassPickerKey(null);
                                                    }}
                                                    style={{
                                                      display: "block",
                                                      width: "100%",
                                                      textAlign: "left",
                                                      background: "transparent",
                                                      border: "none",
                                                      borderBottom: "1px solid #f1f5f9",
                                                      padding: "7px 9px",
                                                      cursor: "pointer",
                                                      fontSize: 13,
                                                      color: "#0f172a",
                                                    }}
                                                  >
                                                    {opt.label}
                                                  </button>
                                                ))}
                                            </div>
                                          ) : null}
                                        </div>
                                      </div>
                                    ) : (
                                      <span style={{ color: "#475569" }}>{formatResolutionRu(row.latestItem.resolution_json)}</span>
                                    )}
                                  </td>
                                  <td style={{ padding: "8px 10px", borderBottom: "1px solid #f1f5f9", verticalAlign: "top" }}>
                                    {row.pendingItems.length > 0 ? (
                                      <select
                                        value="pending"
                                        disabled={busyId === row.key}
                                        onChange={(e) => {
                                          const v = e.target.value;
                                          if (v === "resolved") {
                                            setPendingStatusChange({
                                              row,
                                              nextStatus: "resolved",
                                              className: String(manualClassById[fieldKey] ?? defaultClass),
                                            });
                                          } else if (v === "dismissed") {
                                            setPendingStatusChange({
                                              row,
                                              nextStatus: "dismissed",
                                              className: String(manualClassById[fieldKey] ?? defaultClass),
                                            });
                                          }
                                        }}
                                        style={{ padding: "7px 9px", borderRadius: 8, border: "1px solid #cbd5e1", minWidth: 150 }}
                                      >
                                        <option value="pending">В экспертизе</option>
                                        <option value="resolved">Корректна</option>
                                        <option value="dismissed">Не корректна</option>
                                      </select>
                                    ) : (
                                      <span style={{ color: "#64748b" }}>{labelStatus(row.latestItem.status)}</span>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                  </div>
                )}
            </div>
          </div>
        </div>
      ) : null}
      {workQueueModalOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={workQueueModalTitle}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1350,
            background: "rgba(15, 23, 42, 0.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 18,
          }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) {
              setWorkQueueModalOpen(false);
              setWorkQueueView(null);
            }
          }}
        >
          <div
            className="card"
            style={{
              width: "min(98vw, 1560px)",
              maxHeight: "94vh",
              overflow: "auto",
              padding: 0,
              background: "#fff",
              border: "1px solid #cbd5e1",
              borderRadius: 12,
            }}
          >
            <div
              style={{
                position: "sticky",
                top: 0,
                zIndex: 1,
                background: "#fff",
                borderBottom: "1px solid #e2e8f0",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 8,
                padding: "10px 14px",
              }}
            >
              <strong style={{ color: "#0f172a", fontSize: 15 }}>{workQueueModalTitle}</strong>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  setWorkQueueModalOpen(false);
                  setWorkQueueView(null);
                }}
              >
                Закрыть окно
              </button>
            </div>
            <div style={{ padding: 14, display: "grid", gap: 22 }}>
              {workQueueView?.kind === "lane" && workQueueView.lane === "officer" ? (
                <p style={{ margin: 0, fontSize: 13, color: "#64748b", lineHeight: 1.5 }}>
                  В таблице — только записи по кнопкам инспектора «Принять», «Отклонить» или «На экспертизу» (включая
                  ручной ввод класса). Обычное подтверждение без этих действий сюда не попадает.
                </p>
              ) : null}
              <WorkQueueTable
                sections={workQueueModalSections}
                busyId={busyId}
                catalogOptionsByRule={catalogOptionsByRule}
                workQueueClassByItemId={workQueueClassByItemId}
                setWorkQueueClassByItemId={setWorkQueueClassByItemId}
                openWorkClassPickerKey={openWorkClassPickerKey}
                setOpenWorkClassPickerKey={setOpenWorkClassPickerKey}
                onResolve={onResolve}
                onDismiss={onDismiss}
              />
            </div>
          </div>
        </div>
      ) : null}
      {pendingStatusChange ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Подтверждение изменения статуса декларации"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1400,
            background: "rgba(15, 23, 42, 0.48)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setPendingStatusChange(null);
          }}
        >
          <div
            className="card"
            style={{
              width: "min(92vw, 620px)",
              background: "#fff",
              borderRadius: 12,
              border: "1px solid #cbd5e1",
              padding: 16,
              display: "grid",
              gap: 12,
            }}
          >
            <h3 style={{ margin: 0, fontSize: 18, color: "#0f172a" }}>
              Вы уверены, что хотите изменить статус декларации?
            </h3>
            <p style={{ margin: 0, fontSize: 14, color: "#334155", lineHeight: 1.5 }}>
              {pendingStatusChange.nextStatus === "resolved"
                ? `Статус изменится на «Корректна». Это закроет ${pendingStatusChange.row.pendingItems.length} связанных заявок и сохранит выбранный класс «${pendingStatusChange.className || "—"}».`
                : `Статус изменится на «Не корректна». Это закроет ${pendingStatusChange.row.pendingItems.length} связанных заявок без подтверждения класса.`}
            </p>
            <div
              style={{
                fontSize: 13,
                color: "#64748b",
                background: "#f8fafc",
                border: "1px solid #e2e8f0",
                borderRadius: 8,
                padding: "8px 10px",
              }}
            >
              После подтверждения запись уйдёт из списка «В экспертизе». Чтобы вернуть её в работу, потребуется новая заявка.
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button type="button" className="btn-secondary" onClick={() => setPendingStatusChange(null)}>
                Отмена
              </button>
              <button type="button" className="btn" onClick={() => void confirmPendingStatusChange()}>
                Подтвердить изменение
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
