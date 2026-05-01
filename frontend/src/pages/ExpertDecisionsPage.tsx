import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getRule,
  listExpertDecisions,
  patchExpertDecision,
  type ExpertDecisionItem,
} from "../api/client";
import { TN_VED_SECTION_DEFS } from "../catalog/tnVedSectionTree";

const CATEGORY_LABEL: Record<string, string> = {
  classification_ambiguous: "Несколько подходящих классов",
  classification_none: "Ни одно правило классификации не подошло",
  class_name_confirmation: "Нужно подтвердить название класса",
  inspector_feature_correction: "Правка извлечения признаков (инспектор)",
  auto_classification_review: "Проверка сбоя авто-классификации",
  officer_final_decision: "Решение инспектора",
  other: "Другое",
};

const STATUS_LABEL: Record<string, string> = {
  pending: "В экспертизе",
  resolved: "Корректна",
  dismissed: "Не корректна",
};

type UiIssueType =
  | "all"
  | "class_confirmation"
  | "classification"
  | "inspector_correction"
  | "officer_decision"
  | "other";

const UI_ISSUE_TYPE_LABEL: Record<UiIssueType, string> = {
  all: "Все типы проблем",
  class_confirmation: "Подтверждение класса",
  classification: "Проблемы классификации",
  inspector_correction: "Корректировка инспектора",
  officer_decision: "Решения инспектора",
  other: "Прочее",
};

function labelCategory(cat: string): string {
  return CATEGORY_LABEL[cat] ?? CATEGORY_LABEL.other;
}

function labelStatus(status: string): string {
  return STATUS_LABEL[status] ?? status;
}

function issueTypeFromCategory(category: string): UiIssueType {
  if (["class_name_confirmation", "auto_classification_review", "classification_unresolved"].includes(category)) {
    return "class_confirmation";
  }
  if (["classification_ambiguous", "classification_none"].includes(category)) {
    return "classification";
  }
  if (category === "inspector_feature_correction") {
    return "inspector_correction";
  }
  if (category === "officer_final_decision") {
    return "officer_decision";
  }
  return "other";
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
  const [openClassPickerKey, setOpenClassPickerKey] = useState<string | null>(null);
  const [pendingStatusChange, setPendingStatusChange] = useState<PendingStatusChange | null>(null);

  const load = useCallback(async () => {
    setStatus(null);
    try {
      const list = await listExpertDecisions(
        filter === "pending"
          ? {
              status: "pending",
              issue_type: issueTypeFilter === "all" ? undefined : issueTypeFilter,
              page: 1,
              page_size: 100,
            }
          : {
              issue_type: issueTypeFilter === "all" ? undefined : issueTypeFilter,
              page: 1,
              page_size: 100,
            },
      );
      setItems(list.items);
    } catch (e: unknown) {
      setStatus(e instanceof Error ? e.message : "Не удалось загрузить данные.");
    }
  }, [filter, issueTypeFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const namingRows = useMemo(() => {
    const raw = items
      .filter((it) =>
        ["class_name_confirmation", "auto_classification_review", "classification_unresolved"].includes(it.category),
      )
      .map(namingRowFromDecision);
    return dedupeNamingDecisionRows(raw);
  }, [items]);
  const sectionCounts = useMemo(() => {
    const m = new Map<string, { label: string; count: number }>();
    for (const it of items) {
      const sec = sectionInfoFromDecision(it);
      const prev = m.get(sec.sectionKey);
      if (!prev) m.set(sec.sectionKey, { label: sec.sectionLabel, count: 1 });
      else m.set(sec.sectionKey, { label: prev.label, count: prev.count + 1 });
    }
    return [...m.entries()].sort((a, b) => a[1].label.localeCompare(b[1].label, "ru"));
  }, [items]);
  const issueTypeCounts = useMemo(() => {
    const base: Record<UiIssueType, number> = {
      all: items.length,
      class_confirmation: 0,
      classification: 0,
      inspector_correction: 0,
      officer_decision: 0,
      other: 0,
    };
    for (const it of items) {
      const key = issueTypeFromCategory(it.category);
      base[key] += 1;
    }
    return base;
  }, [items]);
  const visibleNamingRows = useMemo(() => {
    if (selectedSection === "all") return namingRows;
    return namingRows.filter((row) => row.sectionKey === selectedSection);
  }, [namingRows, selectedSection]);
  const aggregatedNamingRows = useMemo(() => aggregateNamingRows(visibleNamingRows), [visibleNamingRows]);

  const visibleWorkItemsBySection = useMemo(() => {
    const rows = items.filter(
      (it) => !["class_name_confirmation", "auto_classification_review", "classification_unresolved"].includes(it.category),
    );
    const filtered = rows.filter((it) => {
      const issueType = issueTypeFromCategory(it.category);
      if (issueTypeFilter !== "all" && issueType !== issueTypeFilter) return false;
      if (selectedSection === "all") return true;
      return sectionInfoFromDecision(it).sectionKey === selectedSection;
    });
    const map = new Map<string, { label: string; items: ExpertDecisionItem[] }>();
    for (const it of filtered) {
      const sec = sectionInfoFromDecision(it);
      const prev = map.get(sec.sectionKey);
      if (!prev) {
        map.set(sec.sectionKey, { label: sec.sectionLabel, items: [it] });
      } else {
        prev.items.push(it);
      }
    }
    return [...map.entries()]
      .map(([key, value]) => ({ sectionKey: key, sectionLabel: value.label, items: value.items.sort((a, b) => b.created_at.localeCompare(a.created_at)) }))
      .sort((a, b) => a.sectionLabel.localeCompare(b.sectionLabel, "ru"));
  }, [items, issueTypeFilter, selectedSection]);

  useEffect(() => {
    if (selectedSection === "all") return;
    const exists = sectionCounts.some(([key]) => key === selectedSection);
    if (!exists) setSelectedSection("all");
  }, [sectionCounts, selectedSection]);

  useEffect(() => {
    const next: Record<string, string> = {};
    for (const row of namingRows) {
      if (row.item.status !== "pending") continue;
      const fallback = row.suggestedClassName === "—" ? "" : row.suggestedClassName;
      next[row.item.id] = manualClassById[row.item.id] ?? fallback;
    }
    if (Object.keys(next).length === 0) return;
    setManualClassById((prev) => ({ ...next, ...prev }));
  }, [namingRows]);

  useEffect(() => {
    const ruleIds = Array.from(new Set(namingRows.map((row) => String(row.item.rule_id ?? "").trim()).filter(Boolean)));
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
  }, [catalogOptionsByRule, namingRows]);

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

  return (
    <div style={shell}>
      <header style={{ textAlign: "center", marginBottom: 22 }}>
        <h1 style={{ margin: "0 0 10px", fontSize: 24, fontWeight: 700, color: "#0f172a", letterSpacing: "-0.02em" }}>
          Очередь решений
        </h1>
        <p
          style={{
            margin: 0,
            color: "#64748b",
            fontSize: 15,
            lineHeight: 1.6,
            maxWidth: 560,
            marginLeft: "auto",
            marginRight: "auto",
          }}
        >
          Здесь накапливаются ситуации, где система не может завершить шаг без вашего выбора: неоднозначная классификация,
          отсутствие подходящего правила или сомнительное имя класса, предложенное моделью. Записи появляются при обработке
          деклараций и когда при проверке декларации требуется ваше решение.
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

      {items.length === 0 ? (
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
          {namingRows.length > 0 && (issueTypeFilter === "all" || issueTypeFilter === "class_confirmation") ? (
            <section>
              <h2 style={{ fontSize: 16, fontWeight: 700, color: "#0f172a", margin: "0 0 12px" }}>
                Подтверждение имени класса (таблица по категориям) ({namingRows.length})
              </h2>
              <div
                className="card"
                style={{
                  border: "1px solid #e2e8f0",
                  borderRadius: 12,
                  padding: 14,
                  background: "#fff",
                }}
              >
                <p style={{ margin: "0 0 10px", fontSize: 14, color: "#475569", lineHeight: 1.45 }}>
                  Сначала выберите категорию, затем откройте таблицу деклараций для анализа.
                </p>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
                  <select
                    value={selectedSection}
                    onChange={(e) => setSelectedSection(e.target.value)}
                    style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #cbd5e1", minWidth: 360 }}
                  >
                    <option value="all">Все категории ({namingRows.length})</option>
                    {sectionCounts.map(([key, meta]) => (
                      <option key={key} value={key}>
                        {meta.label} ({meta.count})
                      </option>
                    ))}
                  </select>
                  <button type="button" className="btn" onClick={() => setNamingModalOpen(true)}>
                  Открыть таблицу подтверждения ({namingRows.length})
                  </button>
                </div>
              </div>
            </section>
          ) : null}
          {visibleWorkItemsBySection.map((section) => (
              <section key={section.sectionKey}>
                <h2 style={{ fontSize: 16, fontWeight: 700, color: "#0f172a", margin: "0 0 12px" }}>
                  {section.sectionLabel} ({section.items.length})
                </h2>
                <div style={{ display: "grid", gap: 12 }}>
                  {section.items.map((it) => (
                    <div
                      key={it.id}
                      className="card"
                      style={{
                        padding: 16,
                        border: "1px solid #e2e8f0",
                        borderRadius: 10,
                        background: it.status === "pending" ? "#fff" : "#f8fafc",
                      }}
                    >
                      <div
                        style={{
                          fontSize: 13,
                          color: "#64748b",
                          marginBottom: 8,
                          display: "flex",
                          flexWrap: "wrap",
                          gap: "6px 10px",
                          alignItems: "baseline",
                        }}
                      >
                        <span>{it.created_at}</span>
                        <span aria-hidden="true" style={{ color: "#cbd5e1" }}>
                          ·
                        </span>
                        <span>декларация {it.declaration_id}</span>
                        {it.rule_id ? (
                          <>
                            <span aria-hidden="true" style={{ color: "#cbd5e1" }}>
                              ·
                            </span>
                            <span>справочник {it.rule_id}</span>
                          </>
                        ) : null}
                        <span aria-hidden="true" style={{ color: "#cbd5e1" }}>
                          ·
                        </span>
                        <span style={{ fontWeight: 600, color: "#475569" }}>{labelStatus(it.status)}</span>
                        <span aria-hidden="true" style={{ color: "#cbd5e1" }}>
                          ·
                        </span>
                        <span style={{ fontWeight: 600, color: "#334155" }}>{UI_ISSUE_TYPE_LABEL[issueTypeFromCategory(it.category)]}</span>
                      </div>
                      <div style={{ fontSize: 15, color: "#0f172a", marginBottom: 12, lineHeight: 1.5 }}>{it.summary_ru}</div>
                      {it.category === "inspector_feature_correction" ? (
                        <InspectorCorrectionView payload={it.payload_json} />
                      ) : (
                        <details style={{ fontSize: 12, color: "#475569", marginBottom: 12 }}>
                          <summary style={{ cursor: "pointer" }}>Технические подробности</summary>
                          <pre
                            style={{
                              marginTop: 10,
                              padding: 10,
                              background: "#f1f5f9",
                              borderRadius: 8,
                              overflow: "auto",
                              maxHeight: 220,
                              fontSize: 11,
                              textAlign: "left",
                            }}
                          >
                            {JSON.stringify(it.payload_json, null, 2)}
                          </pre>
                        </details>
                      )}
                      {it.status === "pending" ? (
                        <div
                          style={{
                            display: "flex",
                            flexWrap: "wrap",
                            gap: 12,
                            alignItems: "flex-end",
                            justifyContent: "space-between",
                          }}
                        >
                          <div
                            style={{
                              display: "flex",
                              flexWrap: "wrap",
                              gap: 10,
                              alignItems: "flex-end",
                              flex: "1 1 240px",
                            }}
                          >
                            {(it.category === "classification_ambiguous" || it.category === "classification_none") && (
                              <>
                                <label style={{ display: "grid", gap: 6, fontSize: 13, color: "#334155", minWidth: 200 }}>
                                  <span style={{ fontWeight: 600 }}>Класс в справочнике</span>
                                  <input
                                    type="text"
                                    id={`chosen-${it.id}`}
                                    placeholder="идентификатор из справочника"
                                    autoComplete="off"
                                    style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #cbd5e1" }}
                                  />
                                </label>
                                <button
                                  type="button"
                                  className="btn"
                                  disabled={busyId === it.id}
                                  onClick={() => {
                                    const el = document.getElementById(`chosen-${it.id}`) as HTMLInputElement | null;
                                    const chosen = (el?.value ?? "").trim();
                                    void onResolve(it.id, { chosen_class_id: chosen });
                                  }}
                                >
                                  Сохранить выбор
                                </button>
                              </>
                            )}
                            {it.category === "class_name_confirmation" && (
                              <>
                                <label style={{ display: "grid", gap: 6, fontSize: 13, color: "#334155", minWidth: 220 }}>
                                  <span style={{ fontWeight: 600 }}>Название класса</span>
                                  <input
                                    type="text"
                                    id={`name-${it.id}`}
                                    defaultValue={String(
                                      (it.payload_json?.llm_result as { suggested_class_name?: string } | undefined)
                                        ?.suggested_class_name ?? "",
                                    )}
                                    autoComplete="off"
                                    style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #cbd5e1" }}
                                  />
                                </label>
                                <button
                                  type="button"
                                  className="btn"
                                  disabled={busyId === it.id}
                                  onClick={() => {
                                    const el = document.getElementById(`name-${it.id}`) as HTMLInputElement | null;
                                    const name = (el?.value ?? "").trim();
                                    void onResolve(it.id, { confirmed_class_id: name });
                                  }}
                                >
                                  Подтвердить
                                </button>
                              </>
                            )}
                            {it.category === "inspector_feature_correction" && (
                              <button
                                type="button"
                                className="btn"
                                disabled={busyId === it.id}
                                onClick={() => void onResolve(it.id, { acknowledged_by_expert: true })}
                              >
                                Принять к сведению
                              </button>
                            )}
                          </div>
                          <button
                            type="button"
                            className="btn-secondary"
                            disabled={busyId === it.id}
                            onClick={() => void onDismiss(it.id)}
                            style={{ flex: "0 0 auto", alignSelf: "center" }}
                          >
                            Закрыть без решения
                          </button>
                        </div>
                      ) : it.resolution_json && Object.keys(it.resolution_json).length > 0 ? (
                        <div style={{ fontSize: 13, color: "#64748b" }}>Итог: {formatResolutionRu(it.resolution_json)}</div>
                      ) : null}
                    </div>
                  ))}
                </div>
              </section>
            ))}
        </div>
      )}
      {namingModalOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Подтверждение имени класса"
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
            if (e.target === e.currentTarget) setNamingModalOpen(false);
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
                <strong style={{ color: "#0f172a", fontSize: 14 }}>Раздел ТН ВЭД:</strong>
                <select
                  value={selectedSection}
                  onChange={(e) => setSelectedSection(e.target.value)}
                  style={{ padding: "6px 9px", borderRadius: 8, border: "1px solid #cbd5e1", minWidth: 360 }}
                >
                  <option value="all">Все категории ({namingRows.length})</option>
                  {sectionCounts.map(([key, meta]) => (
                    <option key={key} value={key}>
                      {meta.label} ({meta.count})
                    </option>
                  ))}
                </select>
              </div>
              <button type="button" className="btn-secondary" onClick={() => setNamingModalOpen(false)}>
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
                                        <span style={{ fontSize: 12, color: "#64748b" }}>
                                          Имя класса (выберите из списка или введите вручную)
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
