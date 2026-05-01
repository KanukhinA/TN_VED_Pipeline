import React, { useCallback, useEffect, useMemo, useState } from "react";
import { deleteExpertDecision, getRule, listExpertDecisions, listRules, patchExpertDecision, type ExpertDecisionItem } from "../api/client";
import { getTnVedGroup } from "../catalog/tnVedGroupsData";
import { ModalCloseButton } from "../ui/ModalCloseButton";
import PaginationControls from "../ui/PaginationControls";
import TnVedEaeuTreeListbox from "../ui/TnVedEaeuTreeListbox";

const STATUS_LABEL: Record<string, string> = {
  pending: "Ожидает подтверждения эксперта",
  resolved: "Принята",
  dismissed: "Отклонена",
};

function labelStatus(status: string): string {
  return STATUS_LABEL[status] ?? status;
}

function statusBadgeStyle(status: string): React.CSSProperties {
  if (status === "resolved") {
    return { color: "#166534", background: "#dcfce7", border: "1px solid #86efac" };
  }
  if (status === "dismissed") {
    return { color: "#991b1b", background: "#fee2e2", border: "1px solid #fca5a5" };
  }
  return { color: "#92400e", background: "#fef3c7", border: "1px solid #fcd34d" };
}

type FeatureSpacePoint = {
  kind: "query" | "reference";
  x: number;
  y: number;
  text: string;
  class_id?: string | null;
  similarity?: number;
};

type FeatureSpaceHover = {
  point: FeatureSpacePoint;
  x: number;
  y: number;
};

function extractFeatureSpacePoints(item: ExpertDecisionItem): FeatureSpacePoint[] {
  const payload = item.payload_json as Record<string, unknown> | undefined;
  if (!payload || typeof payload !== "object") return [];
  const candidates: unknown[] = [
    payload.feature_space_points,
    (payload.semantic_payload as Record<string, unknown> | undefined)?.feature_space_points,
    (payload.semantic_search as Record<string, unknown> | undefined)?.feature_space_points,
    (payload.semantic as Record<string, unknown> | undefined)?.feature_space_points,
  ];
  for (const raw of candidates) {
    if (!Array.isArray(raw)) continue;
    const parsed = raw
      .filter((p) => p && typeof p === "object")
      .map((p: any) => ({
        kind: (p.kind === "query" ? "query" : "reference") as FeatureSpacePoint["kind"],
        x: typeof p.x === "number" ? p.x : Number(p.x ?? 0),
        y: typeof p.y === "number" ? p.y : Number(p.y ?? 0),
        text: String(p.text ?? "").trim(),
        class_id: p.class_id != null ? String(p.class_id) : null,
        similarity: typeof p.similarity === "number" ? p.similarity : undefined,
      }))
      .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
    if (parsed.length > 0) return parsed;
  }
  return [];
}

function classFromResolution(item: ExpertDecisionItem): string {
  const r = item.resolution_json ?? {};
  const chosen = typeof r.chosen_class_id === "string" ? r.chosen_class_id.trim() : "";
  if (chosen) return chosen;
  const confirmed = typeof r.confirmed_class_id === "string" ? r.confirmed_class_id.trim() : "";
  if (confirmed) return confirmed;
  return "";
}

function descriptionFromItem(item: ExpertDecisionItem): string {
  const payload = item.payload_json as Record<string, unknown> | undefined;
  if (!payload || typeof payload !== "object") {
    return String(item.summary_ru ?? "").trim() || "—";
  }
  const llmResult = payload.llm_result as Record<string, unknown> | undefined;
  const promptIncludes = llmResult?.prompt_includes as Record<string, unknown> | undefined;
  const fromPrompt = String(promptIncludes?.description_excerpt ?? "").trim();
  if (fromPrompt) return fromPrompt;
  const fromExtracted = String(payload.extracted_features_summary_ru ?? "").trim();
  if (fromExtracted) return fromExtracted;
  const fromSummary = String(item.summary_ru ?? "").trim();
  return fromSummary || "—";
}

function extractedFeaturesFromItem(item: ExpertDecisionItem): string {
  const payload = item.payload_json as Record<string, unknown> | undefined;
  if (!payload || typeof payload !== "object") return "—";
  const lines = payload.extracted_features_lines_ru;
  if (Array.isArray(lines)) {
    const prepared = lines
      .map((x) => String(x ?? "").trim())
      .filter((x) => x.length > 0);
    if (prepared.length > 0) return prepared.join("\n");
  }
  const summary = String(payload.extracted_features_summary_ru ?? "").trim();
  if (summary) return summary;
  const parsed = payload.parsed_after_override ?? payload.parsed_features ?? payload.features_json;
  if (parsed != null) {
    if (parsed && typeof parsed === "object") {
      const rows: string[] = [];
      for (const [section, sectionValue] of Object.entries(parsed as Record<string, unknown>)) {
        if (Array.isArray(sectionValue)) {
          for (const row of sectionValue) {
            if (!row || typeof row !== "object") continue;
            const obj = row as Record<string, unknown>;
            const keys = Object.keys(obj);
            if (keys.length === 0) continue;
            const mainName = String(obj.вещество ?? obj.параметр ?? keys[0] ?? "").trim();
            const detail = keys
              .filter((k) => k !== "вещество" && k !== "параметр")
              .map((k) => {
                const raw = obj[k];
                if (Array.isArray(raw) && raw.length === 2) {
                  const left = typeof raw[0] === "number" ? raw[0] : null;
                  const right = typeof raw[1] === "number" ? raw[1] : null;
                  if (left != null && right == null) return `${k}: от ${left} до +inf`;
                  if (left == null && right != null) return `${k}: до ${right}`;
                  if (left != null && right != null) return `${k}: ${left}..${right}`;
                }
                return `${k}: ${String(raw ?? "не указано")}`;
              })
              .join("; ");
            rows.push(`${section} · ${mainName || "показатель"} — ${detail || "не указано"}`);
          }
        } else {
          rows.push(`${section} — ${String(sectionValue ?? "не указано")}`);
        }
      }
      if (rows.length > 0) return rows.join("\n");
    }
  }
  return "—";
}

function autoClassificationStatusFromItem(item: ExpertDecisionItem): { label: string; color: string } {
  const payload = item.payload_json as Record<string, unknown> | undefined;
  if (!payload || typeof payload !== "object") {
    return { label: "—", color: "#64748b" };
  }
  const st = String(payload.auto_classification_status ?? "").trim().toLowerCase();
  if (st === "failed") {
    return { label: "Не сработала", color: "#b91c1c" };
  }
  if (st === "ok") {
    return { label: "Сработала", color: "#166534" };
  }
  const semConflict = payload.semantic_rule_contradiction === true || payload.semantic_candidate_no_class === true;
  if (semConflict) {
    return { label: "Не сработала", color: "#b91c1c" };
  }
  return { label: "—", color: "#64748b" };
}

function tnvedFromItem(item: ExpertDecisionItem): string {
  const resolution = item.resolution_json as Record<string, unknown> | undefined;
  const override = String(resolution?.tnved_code_override ?? "").trim();
  if (override) return override;
  const payload = item.payload_json as Record<string, unknown> | undefined;
  if (!payload || typeof payload !== "object") return "—";
  const llmResult = payload.llm_result as Record<string, unknown> | undefined;
  const promptIncludes = llmResult?.prompt_includes as Record<string, unknown> | undefined;
  const code = String(promptIncludes?.tnved_code ?? "").trim();
  return code || "—";
}

function tnvedDescriptionFromItem(item: ExpertDecisionItem): string {
  const raw = tnvedFromItem(item);
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 2) return "—";
  const grpCode = digits.slice(0, 2);
  const grp = getTnVedGroup(grpCode);
  return grp ? grp.title : "—";
}

function tnvedCellText(item: ExpertDecisionItem): string {
  const code = tnvedFromItem(item);
  const desc = tnvedDescriptionFromItem(item);
  if (code === "—" && desc === "—") return "—";
  if (desc === "—") return code;
  if (code === "—") return desc;
  return `${code} — ${desc}`;
}

function extractClassIdsFromDsl(dsl: unknown): string[] {
  if (!dsl || typeof dsl !== "object") return [];
  const rules = (dsl as { classification?: { rules?: unknown } }).classification?.rules;
  if (!Array.isArray(rules)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of rules) {
    if (!raw || typeof raw !== "object") continue;
    const id = String((raw as { class_id?: unknown }).class_id ?? "").trim();
    if (!id) continue;
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(id);
  }
  return out;
}

function isPlaceholderClassValue(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v === "" || ["—", "-", "n/a", "na", "unknown", "none", "null", "undefined", "class", "generation_failed"].includes(v);
}

function looksLikeCodeValue(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (!v) return false;
  // Примеры мусорных значений: 3102500000_0001, 3102509000, a79b4908-...
  if (/^\d{4,}(?:[_-]\d+)?$/.test(v)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v)) return true;
  return false;
}

function isImportedFromExternalSource(item: ExpertDecisionItem): boolean {
  const payload = item.payload_json as Record<string, unknown> | undefined;
  const sources: string[] = [];
  if (payload && typeof payload === "object") {
    const rootSource = payload.source;
    if (rootSource != null) sources.push(String(rootSource));
    const rootOrigin = payload.origin;
    if (rootOrigin != null) sources.push(String(rootOrigin));
    const importSource = payload.import_source;
    if (importSource != null) sources.push(String(importSource));
    const meta = payload.metadata as Record<string, unknown> | undefined;
    if (meta && typeof meta === "object") {
      if (meta.source != null) sources.push(String(meta.source));
      if (meta.origin != null) sources.push(String(meta.origin));
      if (meta.import_source != null) sources.push(String(meta.import_source));
    }
  }
  const normalized = sources.join(" ").toLowerCase();
  if (/(import|external|upload|csv|xlsx|xls|file)/.test(normalized)) return true;
  const did = String(item.declaration_id ?? "").trim().toUpperCase();
  if (/^(IMPORT|IMPORTED|EXT|EXTERNAL|UPLOAD|FILE)[-_]/.test(did)) return true;
  return false;
}

function formatCreatedAtRu(iso: string): string {
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return "—";
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(dt);
}

function formatMoneyRu(value: unknown): string {
  const n = typeof value === "number" ? value : Number(String(value ?? "").replace(",", "."));
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(n);
}

function declaredPriceFromItem(item: ExpertDecisionItem): string {
  const payload = item.payload_json as Record<string, unknown> | undefined;
  if (!payload || typeof payload !== "object") return "—";
  const llmResult = payload.llm_result as Record<string, unknown> | undefined;
  const promptIncludes = llmResult?.prompt_includes as Record<string, unknown> | undefined;
  const candidates: unknown[] = [
    payload.declared_price,
    payload.price,
    promptIncludes?.price,
    promptIncludes?.declared_price,
    (payload.validation_input as Record<string, unknown> | undefined)?.price,
    (payload.officer_input as Record<string, unknown> | undefined)?.graph42,
    (payload.request as Record<string, unknown> | undefined)?.price,
  ];
  for (const c of candidates) {
    const v = formatMoneyRu(c);
    if (v !== "—") return v;
  }
  return "—";
}

function formatMassKgRu(value: unknown): string {
  const n = typeof value === "number" ? value : Number(String(value ?? "").replace(",", "."));
  if (!Number.isFinite(n)) return "—";
  return `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 3 }).format(n)} кг`;
}

function grossWeightFromItem(item: ExpertDecisionItem): string {
  const payload = item.payload_json as Record<string, unknown> | undefined;
  if (!payload || typeof payload !== "object") return "—";
  const officerInput = payload.officer_input as Record<string, unknown> | undefined;
  const validationInput = payload.validation_input as Record<string, unknown> | undefined;
  const request = payload.request as Record<string, unknown> | undefined;
  const candidates: unknown[] = [payload.gross_weight_kg, officerInput?.graph35, validationInput?.graph35, request?.graph35];
  for (const c of candidates) {
    const v = formatMassKgRu(c);
    if (v !== "—") return v;
  }
  return "—";
}

function netWeightFromItem(item: ExpertDecisionItem): string {
  const payload = item.payload_json as Record<string, unknown> | undefined;
  if (!payload || typeof payload !== "object") return "—";
  const officerInput = payload.officer_input as Record<string, unknown> | undefined;
  const validationInput = payload.validation_input as Record<string, unknown> | undefined;
  const request = payload.request as Record<string, unknown> | undefined;
  const candidates: unknown[] = [payload.net_weight_kg, officerInput?.graph38, validationInput?.graph38, request?.graph38];
  for (const c of candidates) {
    const v = formatMassKgRu(c);
    if (v !== "—") return v;
  }
  return "—";
}

type ArchiveReason = {
  code: string;
  label: string;
  detail?: string;
  severity: "negative" | "warning" | "neutral";
};

type ColumnKey = "declaration" | "date" | "tnved" | "description" | "className" | "status";

type ColumnFilters = {
  declaration: string;
  dateFrom: string;
  dateTo: string;
  tnved: string;
  description: string;
  className: string;
  status: "all" | "pending" | "resolved" | "dismissed";
};

type ResizableColumnKey =
  | "rowNo"
  | "declaration"
  | "date"
  | "tnved"
  | "declaredPrice"
  | "grossWeight"
  | "netWeight"
  | "description"
  | "extractedFeatures"
  | "autoClassification"
  | "className"
  | "status"
  | "reason"
  | "actions";

const DEFAULT_COLUMN_WIDTHS: Record<ResizableColumnKey, number> = {
  rowNo: 56,
  declaration: 170,
  date: 170,
  tnved: 280,
  declaredPrice: 170,
  grossWeight: 150,
  netWeight: 150,
  description: 460,
  extractedFeatures: 280,
  autoClassification: 220,
  className: 240,
  status: 190,
  reason: 320,
  actions: 44,
};

const MIN_COLUMN_WIDTHS: Record<ResizableColumnKey, number> = {
  rowNo: 48,
  declaration: 140,
  date: 140,
  tnved: 180,
  declaredPrice: 150,
  grossWeight: 130,
  netWeight: 130,
  description: 260,
  extractedFeatures: 200,
  autoClassification: 180,
  className: 180,
  status: 150,
  reason: 220,
  actions: 44,
};

function deriveArchiveReasons(item: ExpertDecisionItem): ArchiveReason[] {
  const payload = item.payload_json as Record<string, unknown> | undefined;
  const resolution = item.resolution_json as Record<string, unknown> | undefined;
  const reasons: ArchiveReason[] = [];

  const add = (code: string, label: string, severity: ArchiveReason["severity"], detail?: string) => {
    if (reasons.some((r) => r.code === code)) return;
    reasons.push({ code, label, severity, detail: detail?.trim() || undefined });
  };

  if (item.status === "dismissed") {
    add("dismissed", "Признана некорректной", "negative");
  }

  const source = String(resolution?.source ?? payload?.source ?? "").trim().toLowerCase();
  if (source.includes("current_catalog_recheck")) {
    add("catalog_recheck", "Переклассифицирована по актуальному справочнику", "neutral");
  }

  const review = payload?.review as Record<string, unknown> | undefined;
  const reviewErr = String(review?.error_ru ?? "").trim();
  if (reviewErr) {
    add("rule_conflict", "Несоответствие характеристик правилам для класса", "negative", reviewErr);
  }

  const deterministicErrorsRu = (payload?.deterministic_errors_ru as unknown[] | undefined) ?? [];
  if (Array.isArray(deterministicErrorsRu) && deterministicErrorsRu.length > 0) {
    add("deterministic_error", "Несоответствие характеристик правилам для класса", "negative", String(deterministicErrorsRu[0] ?? ""));
  }

  const semantic = payload?.semantic_rule_check as Record<string, unknown> | undefined;
  const semanticConsistent = semantic?.consistent;
  if (semanticConsistent === false) {
    const msg = String(semantic?.message_ru ?? "").trim();
    add("semantic_rule_mismatch", "Семантический кандидат не прошёл проверку правил", "warning", msg);
  }

  const price = payload?.price_validator as Record<string, unknown> | undefined;
  const priceStatus = String(price?.status ?? payload?.price_status ?? "").trim().toLowerCase();
  const deviationPctRaw = price?.deviation_pct ?? payload?.price_deviation_pct;
  const deviationPct = typeof deviationPctRaw === "number" ? deviationPctRaw : Number(deviationPctRaw);
  if (priceStatus === "price_mismatch" || (Number.isFinite(deviationPct) && Math.abs(deviationPct) >= 20)) {
    const det = Number.isFinite(deviationPct) ? `Отклонение: ${deviationPct.toFixed(2)}%.` : "";
    add("price_mismatch", "Несоответствие стоимости", "warning", det);
  }

  if ((payload?.parsed_after_override as Record<string, unknown> | undefined) != null) {
    add("inspector_override", "Требовалась ручная корректировка признаков инспектором", "neutral");
  }

  const freeText = String(resolution?.note ?? payload?.reason_ru ?? payload?.reason ?? "").trim();
  if (freeText) {
    add("custom_reason", "Комментарий по решению", "neutral", freeText);
  }

  if (reasons.length === 0) {
    if (item.status === "resolved") add("resolved", "Проверка пройдена", "neutral");
    if (item.status === "pending") add("pending", "Ожидает решения эксперта", "neutral");
  }
  return reasons;
}

export default function ExpertDatabasePage() {
  const [items, setItems] = useState<ExpertDecisionItem[]>([]);
  const [totalItems, setTotalItems] = useState(0);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingStatusId, setEditingStatusId] = useState<string | null>(null);
  const [editingClassId, setEditingClassId] = useState<string | null>(null);
  const [editingTnvedId, setEditingTnvedId] = useState<string | null>(null);
  const [manualClassById, setManualClassById] = useState<Record<string, string>>({});
  const [customClassInputOpenById, setCustomClassInputOpenById] = useState<Record<string, boolean>>({});
  const [manualTnvedById, setManualTnvedById] = useState<Record<string, string>>({});
  const [columnFilters, setColumnFilters] = useState<ColumnFilters>({
    declaration: "",
    dateFrom: "",
    dateTo: "",
    tnved: "",
    description: "",
    className: "",
    status: "all",
  });
  const [openFilter, setOpenFilter] = useState<ColumnKey | null>(null);
  const [sortColumn, setSortColumn] = useState<ColumnKey | null>("date");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [hoveredRowId, setHoveredRowId] = useState<string | null>(null);
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [columnWidths, setColumnWidths] = useState<Record<ResizableColumnKey, number>>(DEFAULT_COLUMN_WIDTHS);
  const [catalogClassIdsByRule, setCatalogClassIdsByRule] = useState<Record<string, string[]>>({});
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [featureSpaceOpen, setFeatureSpaceOpen] = useState(false);
  const [featureSpaceZoom, setFeatureSpaceZoom] = useState(1);
  const [featureSpacePan, setFeatureSpacePan] = useState({ x: 0, y: 0 });
  const [featureSpaceHovered, setFeatureSpaceHovered] = useState<FeatureSpaceHover | null>(null);

  const load = useCallback(async () => {
    setStatus(null);
    setLoading(true);
    try {
      const res = await listExpertDecisions({
        page,
        page_size: pageSize,
        include_imported: true,
        status: columnFilters.status === "all" ? undefined : columnFilters.status,
        tnved_prefix: columnFilters.tnved || undefined,
        created_from: columnFilters.dateFrom ? `${columnFilters.dateFrom}T00:00:00` : undefined,
        created_to: columnFilters.dateTo ? `${columnFilters.dateTo}T23:59:59` : undefined,
      });
      setItems(res.items);
      setTotalItems(res.total);
    } catch (e: unknown) {
      setStatus(e instanceof Error ? e.message : "Не удалось загрузить архив решений.");
    } finally {
      setLoading(false);
    }
  }, [columnFilters.dateFrom, columnFilters.dateTo, columnFilters.status, columnFilters.tnved, page, pageSize]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setPage(1);
  }, [columnFilters]);

  useEffect(() => {
    const onDocMouseDown = (ev: MouseEvent) => {
      const target = ev.target as HTMLElement | null;
      if (!target) return;
      if (target.closest("[data-filter-root='true']")) return;
      setOpenFilter(null);
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const loadCatalogClassIdsByRule = async () => {
      try {
        const rules = await listRules({ include_archived: false });
        const byRule: Record<string, string[]> = {};
        await Promise.all(
          rules.map(async (r) => {
            const ruleId = String(r?.rule_id ?? "").trim();
            if (!ruleId) return;
            try {
              const full = await getRule(ruleId);
              const classIds = extractClassIdsFromDsl(full?.dsl).sort((a, b) => a.localeCompare(b, "ru"));
              byRule[ruleId] = classIds;
            } catch {
              byRule[ruleId] = [];
            }
          }),
        );
        if (!cancelled) setCatalogClassIdsByRule(byRule);
      } catch {
        if (!cancelled) setCatalogClassIdsByRule({});
      }
    };
    void loadCatalogClassIdsByRule();
    return () => {
      cancelled = true;
    };
  }, []);

  const startColumnResize = useCallback(
    (column: ResizableColumnKey, ev: React.MouseEvent<HTMLSpanElement>) => {
      ev.preventDefault();
      ev.stopPropagation();
      const startX = ev.clientX;
      const startWidth = columnWidths[column];
      const minWidth = MIN_COLUMN_WIDTHS[column];
      const onMouseMove = (moveEv: MouseEvent) => {
        const next = Math.max(minWidth, startWidth + (moveEv.clientX - startX));
        setColumnWidths((prev) => ({ ...prev, [column]: next }));
      };
      const onMouseUp = () => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
      };
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [columnWidths],
  );

  const tableMinWidth = useMemo(() => Object.values(columnWidths).reduce((sum, w) => sum + w, 0), [columnWidths]);

  async function onSetStatus(item: ExpertDecisionItem, nextStatus: "pending" | "resolved" | "dismissed") {
    const currentClass = classFromResolution(item);
    const chosenClass = String(manualClassById[item.id] ?? "").trim() || currentClass;
    const nextResolution =
      nextStatus === "resolved"
        ? { ...(item.resolution_json ?? {}), chosen_class_id: chosenClass || null }
        : nextStatus === "dismissed"
          ? {}
          : (item.resolution_json ?? {});
    setBusyId(item.id);
    setStatus(null);
    try {
      await patchExpertDecision(item.id, { status: nextStatus, resolution: nextResolution });
      await load();
    } catch (e: unknown) {
      setStatus(e instanceof Error ? e.message : "Не удалось изменить статус.");
    } finally {
      setBusyId(null);
      setEditingStatusId(null);
    }
  }

  async function onSetClass(item: ExpertDecisionItem, explicitClass?: string) {
    const currentClass = classFromResolution(item);
    const chosenClass = String(explicitClass ?? manualClassById[item.id] ?? currentClass).trim();
    const nextResolution = { ...(item.resolution_json ?? {}), chosen_class_id: chosenClass || null };
    setBusyId(item.id);
    setStatus(null);
    try {
      await patchExpertDecision(item.id, { status: item.status as "pending" | "resolved" | "dismissed", resolution: nextResolution });
      await load();
    } catch (e: unknown) {
      setStatus(e instanceof Error ? e.message : "Не удалось изменить класс.");
    } finally {
      setBusyId(null);
      setEditingClassId(null);
    }
  }

  async function onSetTnved(item: ExpertDecisionItem, nextCode: string) {
    setBusyId(item.id);
    setStatus(null);
    try {
      await patchExpertDecision(item.id, {
        status: item.status as "pending" | "resolved" | "dismissed",
        resolution: {
          ...(item.resolution_json ?? {}),
          tnved_code_override: nextCode || null,
        },
      });
      await load();
    } catch (e: unknown) {
      setStatus(e instanceof Error ? e.message : "Не удалось изменить код ТН ВЭД.");
    } finally {
      setBusyId(null);
      setEditingTnvedId(null);
    }
  }

  async function onDeleteRow(item: ExpertDecisionItem) {
    if (isImportedFromExternalSource(item)) return;
    const ok = window.confirm("Удалить эту запись из базы деклараций?");
    if (!ok) return;
    setBusyId(item.id);
    setStatus(null);
    try {
      await deleteExpertDecision(item.id);
      if (visibleItems.length <= 1 && page > 1) {
        setPage((prev) => Math.max(1, prev - 1));
      } else {
        await load();
      }
    } catch (e: unknown) {
      setStatus(e instanceof Error ? e.message : "Не удалось удалить запись.");
    } finally {
      setBusyId(null);
    }
  }

  const pageCount = Math.max(1, Math.ceil(totalItems / pageSize));
  useEffect(() => {
    if (page > pageCount) {
      setPage(pageCount);
    }
  }, [page, pageCount]);
  const safePage = Math.min(page, pageCount);
  const pageStart = totalItems === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const pageEnd = totalItems === 0 ? 0 : Math.min(totalItems, safePage * pageSize);

  const visibleItems = useMemo(() => {
    const declQ = columnFilters.declaration.trim().toLowerCase();
    const descQ = columnFilters.description.trim().toLowerCase();
    const classQ = columnFilters.className.trim().toLowerCase();
    const out = items.filter((it) => {
      if (declQ && !String(it.declaration_id ?? "").toLowerCase().includes(declQ)) return false;
      if (columnFilters.tnved.trim()) {
        const q = columnFilters.tnved.trim().toLowerCase();
        const combined = `${tnvedFromItem(it)} ${tnvedDescriptionFromItem(it)}`.toLowerCase();
        if (!combined.includes(q)) return false;
      }
      if (descQ && !descriptionFromItem(it).toLowerCase().includes(descQ)) return false;
      if (classQ && !classFromResolution(it).toLowerCase().includes(classQ)) return false;
      return true;
    });
    if (!sortColumn) return out;
    const dir = sortDir === "asc" ? 1 : -1;
    return [...out].sort((a, b) => {
      const getValue = (it: ExpertDecisionItem): string => {
        if (sortColumn === "declaration") return String(it.declaration_id ?? "");
        if (sortColumn === "date") return String(it.created_at ?? "");
        if (sortColumn === "tnved") return tnvedFromItem(it);
        if (sortColumn === "description") return descriptionFromItem(it);
        if (sortColumn === "className") return classFromResolution(it);
        if (sortColumn === "status") return it.status;
        return "";
      };
      return getValue(a).localeCompare(getValue(b), "ru") * dir;
    });
  }, [columnFilters.className, columnFilters.declaration, columnFilters.description, columnFilters.tnved, items, sortColumn, sortDir]);

  function toggleSort(column: ColumnKey) {
    if (sortColumn !== column) {
      setSortColumn(column);
      setSortDir("asc");
      return;
    }
    setSortDir((prev) => (prev === "asc" ? "desc" : "asc"));
  }

  function isFilterActive(column: ColumnKey): boolean {
    if (column === "declaration") return columnFilters.declaration.trim().length > 0;
    if (column === "date") return columnFilters.dateFrom.trim().length > 0 || columnFilters.dateTo.trim().length > 0;
    if (column === "tnved") return columnFilters.tnved.trim().length > 0;
    if (column === "description") return columnFilters.description.trim().length > 0;
    if (column === "className") return columnFilters.className.trim().length > 0;
    if (column === "status") return columnFilters.status !== "all";
    return false;
  }

  const activeFilterChips = useMemo(() => {
    const chips: Array<{ key: string; label: string; onClear: () => void }> = [];
    if (columnFilters.declaration.trim()) {
      chips.push({ key: "declaration", label: `Декларация: ${columnFilters.declaration.trim()}`, onClear: () => setColumnFilters((p) => ({ ...p, declaration: "" })) });
    }
    if (columnFilters.dateFrom.trim() || columnFilters.dateTo.trim()) {
      const from = columnFilters.dateFrom.trim() || "…";
      const to = columnFilters.dateTo.trim() || "…";
      chips.push({ key: "date", label: `Дата: ${from} — ${to}`, onClear: () => setColumnFilters((p) => ({ ...p, dateFrom: "", dateTo: "" })) });
    }
    if (columnFilters.tnved.trim()) {
      chips.push({ key: "tnved", label: `Код ТН ВЭД: ${columnFilters.tnved.trim()}`, onClear: () => setColumnFilters((p) => ({ ...p, tnved: "" })) });
    }
    if (columnFilters.description.trim()) {
      chips.push({ key: "description", label: `Описание: ${columnFilters.description.trim()}`, onClear: () => setColumnFilters((p) => ({ ...p, description: "" })) });
    }
    if (columnFilters.className.trim()) {
      chips.push({ key: "className", label: `Класс: ${columnFilters.className.trim()}`, onClear: () => setColumnFilters((p) => ({ ...p, className: "" })) });
    }
    if (columnFilters.status !== "all") {
      chips.push({
        key: "status",
        label: `Статус: ${columnFilters.status === "pending" ? "Ожидает подтверждения эксперта" : columnFilters.status === "resolved" ? "Принята" : "Отклонена"}`,
        onClear: () => setColumnFilters((p) => ({ ...p, status: "all" })),
      });
    }
    return chips;
  }, [columnFilters]);

  const renderResizeHandle = (column: ResizableColumnKey) => (
    <span
      role="separator"
      aria-orientation="vertical"
      aria-label="Изменить ширину столбца"
      onMouseDown={(ev) => startColumnResize(column, ev)}
      style={{ position: "absolute", top: 0, right: 0, width: 8, height: "100%", cursor: "col-resize", userSelect: "none", zIndex: 40 }}
    />
  );

  const tnvedFilterDigits = columnFilters.tnved.replace(/\D/g, "");
  const canOpenFeatureSpace = tnvedFilterDigits.length >= 2;
  const featureSpacePoints = useMemo(() => {
    if (!canOpenFeatureSpace) return [] as FeatureSpacePoint[];
    const out: FeatureSpacePoint[] = [];
    for (const item of visibleItems) {
      const points = extractFeatureSpacePoints(item);
      for (const p of points) {
        const classId = (p.class_id ?? classFromResolution(item) ?? "").toString().trim() || null;
        out.push({
          ...p,
          kind: p.kind,
          class_id: classId,
          text: p.text || `${item.declaration_id} · ${descriptionFromItem(item)}`,
        });
      }
    }
    const uniq = new Map<string, FeatureSpacePoint>();
    for (const p of out) {
      const key = `${p.kind}|${p.x.toFixed(6)}|${p.y.toFixed(6)}|${String(p.class_id ?? "")}|${p.text}`;
      if (!uniq.has(key)) uniq.set(key, p);
    }
    return [...uniq.values()];
  }, [canOpenFeatureSpace, visibleItems]);
  const featureSpaceExtent = useMemo(() => {
    if (featureSpacePoints.length === 0) return { minX: -1, maxX: 1, minY: -1, maxY: 1 };
    const xs = featureSpacePoints.map((p) => p.x);
    const ys = featureSpacePoints.map((p) => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    return {
      minX,
      maxX: maxX === minX ? minX + 1 : maxX,
      minY,
      maxY: maxY === minY ? minY + 1 : maxY,
    };
  }, [featureSpacePoints]);
  const projectFeatureSpacePoint = useCallback(
    (p: FeatureSpacePoint) => {
      const W = 860;
      const H = 480;
      const pad = 42;
      const nx = (p.x - featureSpaceExtent.minX) / (featureSpaceExtent.maxX - featureSpaceExtent.minX);
      const ny = (p.y - featureSpaceExtent.minY) / (featureSpaceExtent.maxY - featureSpaceExtent.minY);
      const x0 = pad + nx * (W - 2 * pad);
      const y0 = H - pad - ny * (H - 2 * pad);
      return {
        x: W / 2 + (x0 - W / 2) * featureSpaceZoom + featureSpacePan.x,
        y: H / 2 + (y0 - H / 2) * featureSpaceZoom + featureSpacePan.y,
      };
    },
    [featureSpaceExtent, featureSpaceZoom, featureSpacePan.x, featureSpacePan.y],
  );
  const featureSpaceClassColorMap = useMemo(() => {
    const palette = ["#f59e0b", "#10b981", "#8b5cf6", "#ef4444", "#06b6d4", "#84cc16", "#ec4899", "#f97316"];
    const ids = Array.from(
      new Set(
        featureSpacePoints
          .filter((p) => p.kind === "reference")
          .map((p) => String(p.class_id ?? "").trim())
          .filter(Boolean),
      ),
    ).sort((a, b) => a.localeCompare(b, "ru"));
    const m = new Map<string, string>();
    ids.forEach((id, i) => m.set(id, palette[i % palette.length]));
    return m;
  }, [featureSpacePoints]);
  const featureSpaceLegendItems = useMemo(() => [...featureSpaceClassColorMap.entries()].slice(0, 16), [featureSpaceClassColorMap]);
  const getAvailableClassOptionsForItem = useCallback(
    (item: ExpertDecisionItem) => {
      const ruleId = String(item.rule_id ?? "").trim();
      const catalogForRule = ruleId ? catalogClassIdsByRule[ruleId] ?? [] : [];
      const catalogSetLower = new Set(catalogForRule.map((x) => x.trim().toLowerCase()).filter(Boolean));
      const currentGroup = tnvedFromItem(item).replace(/\D/g, "").slice(0, 2);
      const declarationSet = new Set<string>();
      for (const it of items) {
        if (String(it.rule_id ?? "").trim() !== ruleId) continue;
        const itGroup = tnvedFromItem(it).replace(/\D/g, "").slice(0, 2);
        if (currentGroup && itGroup && currentGroup !== itGroup) continue;
        const cls = classFromResolution(it).trim();
        if (cls && !isPlaceholderClassValue(cls)) {
          const clsLower = cls.toLowerCase();
          if (catalogSetLower.has(clsLower) || !looksLikeCodeValue(cls)) {
            declarationSet.add(cls);
          }
        }
        const payload = it.payload_json as Record<string, unknown> | undefined;
        const llmResult = payload?.llm_result as Record<string, unknown> | undefined;
        const suggested = String(llmResult?.suggested_class_name ?? "").trim();
        if (suggested && !isPlaceholderClassValue(suggested) && !looksLikeCodeValue(suggested)) {
          declarationSet.add(suggested);
        }
      }
      const all = new Set<string>([...declarationSet, ...catalogForRule]);
      return [...all]
        .filter((value) => value.trim().length > 0)
        .sort((a, b) => a.localeCompare(b, "ru"))
        .map((value) => ({
          value,
          fromCatalog: catalogForRule.some((x) => x.toLowerCase() === value.toLowerCase()),
        }));
    },
    [catalogClassIdsByRule, items],
  );
  const featureSpaceGridTicks = useMemo(() => [0, 1, 2, 3, 4, 5], []);

  function resetFilters() {
    setColumnFilters({
      declaration: "",
      dateFrom: "",
      dateTo: "",
      tnved: "",
      description: "",
      className: "",
      status: "all",
    });
    setOpenFilter(null);
    setPage(1);
  }

  return (
    <div style={{ width: "100%", maxWidth: 1240, margin: "0 auto", paddingBottom: 28 }}>
      <header style={{ textAlign: "center", marginBottom: 22 }}>
        <h1 style={{ margin: "0 0 10px", fontSize: 24, fontWeight: 700, color: "#0f172a", letterSpacing: "-0.02em" }}>
          Архив решений
        </h1>
        <p style={{ margin: 0, color: "#64748b", fontSize: 15, lineHeight: 1.6 }}>
          История всех обработанных деклараций и принятых решений.
        </p>
      </header>

      <div className="card" style={{ border: "1px solid #e2e8f0", borderRadius: 12, background: "#fff", overflow: "hidden" }}>
        <div
          style={{
            borderBottom: "1px solid #e2e8f0",
            padding: 12,
            display: "flex",
            flexWrap: "wrap",
            gap: 10,
            alignItems: "center",
          }}
        >
          <button type="button" className="btn-secondary" onClick={resetFilters} disabled={busyId != null || loading}>
            Сбросить фильтры
          </button>
          <button type="button" className="btn-secondary" onClick={() => void load()} disabled={busyId != null || loading}>
            Обновить
          </button>
          {canOpenFeatureSpace ? (
            <button
              type="button"
              className="btn-secondary"
              disabled={featureSpacePoints.length === 0}
              title={featureSpacePoints.length === 0 ? "Нет данных пространства признаков для текущих записей" : undefined}
              onClick={() => {
                setFeatureSpaceZoom(1);
                setFeatureSpacePan({ x: 0, y: 0 });
                setFeatureSpaceHovered(null);
                setFeatureSpaceOpen(true);
              }}
            >
              Навигация в пространстве признаков
            </button>
          ) : null}
          <span style={{ fontSize: 13, color: "#64748b" }}>Всего записей в базе: {totalItems}</span>
          <span style={{ fontSize: 13, color: "#64748b" }}>Найдено на странице: {visibleItems.length}</span>
        </div>

        {status ? (
          <div role="alert" style={{ color: "#b91c1c", fontWeight: 600, fontSize: 14, padding: "10px 12px" }}>
            {status}
          </div>
        ) : null}

        {activeFilterChips.length > 0 ? (
          <div style={{ padding: "8px 12px", borderBottom: "1px solid #e2e8f0", display: "flex", flexWrap: "wrap", gap: 6 }}>
            {activeFilterChips.map((chip) => (
              <span
                key={chip.key}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "4px 8px",
                  borderRadius: 999,
                  border: "1px solid #cbd5e1",
                  background: "#f8fafc",
                  fontSize: 12,
                  color: "#334155",
                }}
              >
                {chip.label}
                <button
                  type="button"
                  onClick={chip.onClear}
                  style={{ border: "none", background: "transparent", color: "#64748b", cursor: "pointer", padding: 0, lineHeight: 1 }}
                  title="Убрать фильтр"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : null}

        <div style={{ overflow: "auto", maxHeight: "70vh" }}>
          <table style={{ width: "100%", minWidth: tableMinWidth, borderCollapse: "collapse", fontSize: 13, tableLayout: "fixed" }}>
            <thead style={{ background: "#f8fafc" }}>
              <tr>
                <th style={{ textAlign: "center", padding: "8px 10px", borderBottom: "1px solid #e2e8f0", borderRight: "1px solid #e2e8f0", width: columnWidths.rowNo, minWidth: columnWidths.rowNo, maxWidth: columnWidths.rowNo, position: "sticky", top: 0, left: 0, zIndex: 9, background: "#f8fafc" }}>№{renderResizeHandle("rowNo")}</th>
                <th data-filter-root="true" style={{ textAlign: "center", padding: "8px 10px", borderBottom: "1px solid #e2e8f0", borderRight: "1px solid #e2e8f0", position: "sticky", top: 0, left: columnWidths.rowNo, zIndex: 8, background: "#f8fafc", width: columnWidths.declaration, minWidth: columnWidths.declaration }}>
                  <span>Декларация</span>
                  <button type="button" style={{ marginLeft: 6, padding: 0, border: "none", background: "transparent", color: "#64748b", cursor: "pointer", fontSize: 12 }} onClick={() => toggleSort("declaration")} title="Сортировка">
                    {sortColumn === "declaration" ? (sortDir === "asc" ? "↑" : "↓") : "↕"}
                  </button>
                  <button type="button" style={{ marginLeft: 6, padding: 0, border: "none", background: "transparent", color: isFilterActive("declaration") ? "#0369a1" : "#64748b", cursor: "pointer", fontSize: 12, fontWeight: isFilterActive("declaration") ? 700 : 500 }} onClick={() => setOpenFilter(openFilter === "declaration" ? null : "declaration")}>{isFilterActive("declaration") ? "⏷•" : "⏷"}</button>
                  {openFilter === "declaration" ? (
                    <div style={{ position: "absolute", top: "calc(100% + 6px)", left: 8, zIndex: 30, background: "#fff", border: "1px solid #cbd5e1", borderRadius: 8, padding: 8, minWidth: 220, boxShadow: "0 10px 30px rgba(15,23,42,0.15)" }}>
                      <input type="text" value={columnFilters.declaration} onChange={(e) => setColumnFilters((p) => ({ ...p, declaration: e.target.value }))} placeholder="Содержит..." style={{ width: "100%", padding: "6px 8px", border: "1px solid #cbd5e1", borderRadius: 6 }} />
                    </div>
                  ) : null}
                  {renderResizeHandle("declaration")}
                </th>
                <th data-filter-root="true" style={{ textAlign: "center", padding: "8px 10px", borderBottom: "1px solid #e2e8f0", borderRight: "1px solid #e2e8f0", position: "sticky", top: 0, zIndex: 7, background: "#f8fafc", width: columnWidths.date, minWidth: columnWidths.date }}>
                  <span>Дата</span>
                  <button type="button" style={{ marginLeft: 6, padding: 0, border: "none", background: "transparent", color: "#64748b", cursor: "pointer", fontSize: 12 }} onClick={() => toggleSort("date")} title="Сортировка">
                    {sortColumn === "date" ? (sortDir === "asc" ? "↑" : "↓") : "↕"}
                  </button>
                  <button type="button" style={{ marginLeft: 6, padding: 0, border: "none", background: "transparent", color: isFilterActive("date") ? "#0369a1" : "#64748b", cursor: "pointer", fontSize: 12, fontWeight: isFilterActive("date") ? 700 : 500 }} onClick={() => setOpenFilter(openFilter === "date" ? null : "date")}>{isFilterActive("date") ? "⏷•" : "⏷"}</button>
                  {openFilter === "date" ? (
                    <div style={{ position: "absolute", top: "calc(100% + 6px)", left: 8, zIndex: 30, background: "#fff", border: "1px solid #cbd5e1", borderRadius: 8, padding: 8, minWidth: 230, display: "grid", gap: 6, boxShadow: "0 10px 30px rgba(15,23,42,0.15)" }}>
                      <input type="date" value={columnFilters.dateFrom} onChange={(e) => setColumnFilters((p) => ({ ...p, dateFrom: e.target.value }))} style={{ padding: "6px 8px", border: "1px solid #cbd5e1", borderRadius: 6 }} />
                      <input type="date" value={columnFilters.dateTo} onChange={(e) => setColumnFilters((p) => ({ ...p, dateTo: e.target.value }))} style={{ padding: "6px 8px", border: "1px solid #cbd5e1", borderRadius: 6 }} />
                    </div>
                  ) : null}
                  {renderResizeHandle("date")}
                </th>
                <th data-filter-root="true" style={{ textAlign: "center", padding: "8px 10px", borderBottom: "1px solid #e2e8f0", borderRight: "1px solid #e2e8f0", position: "sticky", top: 0, zIndex: 7, background: "#f8fafc", width: columnWidths.tnved, minWidth: columnWidths.tnved }}>
                  <span>Код/описание ТН ВЭД</span>
                  <button type="button" style={{ marginLeft: 6, padding: 0, border: "none", background: "transparent", color: "#64748b", cursor: "pointer", fontSize: 12 }} onClick={() => toggleSort("tnved")} title="Сортировка">
                    {sortColumn === "tnved" ? (sortDir === "asc" ? "↑" : "↓") : "↕"}
                  </button>
                  <button type="button" style={{ marginLeft: 6, padding: 0, border: "none", background: "transparent", color: isFilterActive("tnved") ? "#0369a1" : "#64748b", cursor: "pointer", fontSize: 12, fontWeight: isFilterActive("tnved") ? 700 : 500 }} onClick={() => setOpenFilter(openFilter === "tnved" ? null : "tnved")}>{isFilterActive("tnved") ? "⏷•" : "⏷"}</button>
                  {openFilter === "tnved" ? (
                    <div style={{ position: "absolute", top: "calc(100% + 6px)", left: 8, zIndex: 30, background: "#fff", border: "1px solid #cbd5e1", borderRadius: 8, padding: 8, minWidth: 220, boxShadow: "0 10px 30px rgba(15,23,42,0.15)" }}>
                      <input type="text" value={columnFilters.tnved} onChange={(e) => setColumnFilters((p) => ({ ...p, tnved: e.target.value }))} placeholder="Код или описание" style={{ width: "100%", padding: "6px 8px", border: "1px solid #cbd5e1", borderRadius: 6 }} />
                    </div>
                  ) : null}
                  {renderResizeHandle("tnved")}
                </th>
                <th style={{ textAlign: "center", padding: "8px 10px", borderBottom: "1px solid #e2e8f0", borderRight: "1px solid #e2e8f0", width: columnWidths.declaredPrice, minWidth: columnWidths.declaredPrice, position: "sticky", top: 0, zIndex: 7, background: "#f8fafc" }}>Заявленная стоимость{renderResizeHandle("declaredPrice")}</th>
                <th style={{ textAlign: "center", padding: "8px 10px", borderBottom: "1px solid #e2e8f0", borderRight: "1px solid #e2e8f0", width: columnWidths.grossWeight, minWidth: columnWidths.grossWeight, position: "sticky", top: 0, zIndex: 7, background: "#f8fafc" }}>Вес брутто{renderResizeHandle("grossWeight")}</th>
                <th style={{ textAlign: "center", padding: "8px 10px", borderBottom: "1px solid #e2e8f0", borderRight: "1px solid #e2e8f0", width: columnWidths.netWeight, minWidth: columnWidths.netWeight, position: "sticky", top: 0, zIndex: 7, background: "#f8fafc" }}>Вес нетто{renderResizeHandle("netWeight")}</th>
                <th data-filter-root="true" style={{ textAlign: "center", padding: "8px 10px", borderBottom: "1px solid #e2e8f0", borderRight: "1px solid #e2e8f0", width: columnWidths.description, minWidth: columnWidths.description, position: "sticky", top: 0, zIndex: 7, background: "#f8fafc" }}>
                  <span>Описание</span>
                  <button type="button" style={{ marginLeft: 6, padding: 0, border: "none", background: "transparent", color: "#64748b", cursor: "pointer", fontSize: 12 }} onClick={() => toggleSort("description")} title="Сортировка">
                    {sortColumn === "description" ? (sortDir === "asc" ? "↑" : "↓") : "↕"}
                  </button>
                  <button type="button" style={{ marginLeft: 6, padding: 0, border: "none", background: "transparent", color: isFilterActive("description") ? "#0369a1" : "#64748b", cursor: "pointer", fontSize: 12, fontWeight: isFilterActive("description") ? 700 : 500 }} onClick={() => setOpenFilter(openFilter === "description" ? null : "description")}>{isFilterActive("description") ? "⏷•" : "⏷"}</button>
                  {openFilter === "description" ? (
                    <div style={{ position: "absolute", top: "calc(100% + 6px)", left: 8, zIndex: 30, background: "#fff", border: "1px solid #cbd5e1", borderRadius: 8, padding: 8, minWidth: 260, boxShadow: "0 10px 30px rgba(15,23,42,0.15)" }}>
                      <input type="text" value={columnFilters.description} onChange={(e) => setColumnFilters((p) => ({ ...p, description: e.target.value }))} placeholder="Содержит..." style={{ width: "100%", padding: "6px 8px", border: "1px solid #cbd5e1", borderRadius: 6 }} />
                    </div>
                  ) : null}
                  {renderResizeHandle("description")}
                </th>
                <th style={{ textAlign: "center", padding: "8px 10px", borderBottom: "1px solid #e2e8f0", borderRight: "1px solid #e2e8f0", width: columnWidths.extractedFeatures, minWidth: columnWidths.extractedFeatures, position: "sticky", top: 0, zIndex: 7, background: "#f8fafc" }}>
                  Извлечённые характеристики
                  {renderResizeHandle("extractedFeatures")}
                </th>
                <th style={{ textAlign: "center", padding: "8px 10px", borderBottom: "1px solid #e2e8f0", borderRight: "1px solid #e2e8f0", width: columnWidths.autoClassification, minWidth: columnWidths.autoClassification, position: "sticky", top: 0, zIndex: 7, background: "#f8fafc" }}>
                  Результат автоклассификации
                  {renderResizeHandle("autoClassification")}
                </th>
                <th data-filter-root="true" style={{ textAlign: "center", padding: "8px 10px", borderBottom: "1px solid #e2e8f0", borderRight: "1px solid #e2e8f0", position: "sticky", top: 0, zIndex: 7, background: "#f8fafc", width: columnWidths.className, minWidth: columnWidths.className }}>
                  <span>Класс</span>
                  <button type="button" style={{ marginLeft: 6, padding: 0, border: "none", background: "transparent", color: "#64748b", cursor: "pointer", fontSize: 12 }} onClick={() => toggleSort("className")} title="Сортировка">
                    {sortColumn === "className" ? (sortDir === "asc" ? "↑" : "↓") : "↕"}
                  </button>
                  <button type="button" style={{ marginLeft: 6, padding: 0, border: "none", background: "transparent", color: isFilterActive("className") ? "#0369a1" : "#64748b", cursor: "pointer", fontSize: 12, fontWeight: isFilterActive("className") ? 700 : 500 }} onClick={() => setOpenFilter(openFilter === "className" ? null : "className")}>{isFilterActive("className") ? "⏷•" : "⏷"}</button>
                  {openFilter === "className" ? (
                    <div style={{ position: "absolute", top: "calc(100% + 6px)", left: 8, zIndex: 30, background: "#fff", border: "1px solid #cbd5e1", borderRadius: 8, padding: 8, minWidth: 220, boxShadow: "0 10px 30px rgba(15,23,42,0.15)" }}>
                      <input type="text" value={columnFilters.className} onChange={(e) => setColumnFilters((p) => ({ ...p, className: e.target.value }))} placeholder="Содержит..." style={{ width: "100%", padding: "6px 8px", border: "1px solid #cbd5e1", borderRadius: 6 }} />
                    </div>
                  ) : null}
                  {renderResizeHandle("className")}
                </th>
                <th data-filter-root="true" style={{ textAlign: "center", padding: "8px 10px", borderBottom: "1px solid #e2e8f0", borderRight: "1px solid #e2e8f0", position: "sticky", top: 0, zIndex: 7, background: "#f8fafc", width: columnWidths.status, minWidth: columnWidths.status }}>
                  <span>Статус</span>
                  <button type="button" style={{ marginLeft: 6, padding: 0, border: "none", background: "transparent", color: "#64748b", cursor: "pointer", fontSize: 12 }} onClick={() => toggleSort("status")} title="Сортировка">
                    {sortColumn === "status" ? (sortDir === "asc" ? "↑" : "↓") : "↕"}
                  </button>
                  <button type="button" style={{ marginLeft: 6, padding: 0, border: "none", background: "transparent", color: isFilterActive("status") ? "#0369a1" : "#64748b", cursor: "pointer", fontSize: 12, fontWeight: isFilterActive("status") ? 700 : 500 }} onClick={() => setOpenFilter(openFilter === "status" ? null : "status")}>{isFilterActive("status") ? "⏷•" : "⏷"}</button>
                  {openFilter === "status" ? (
                    <div style={{ position: "absolute", top: "calc(100% + 6px)", left: 8, zIndex: 30, background: "#fff", border: "1px solid #cbd5e1", borderRadius: 8, padding: 8, minWidth: 180, boxShadow: "0 10px 30px rgba(15,23,42,0.15)" }}>
                      <select value={columnFilters.status} onChange={(e) => setColumnFilters((p) => ({ ...p, status: e.target.value as ColumnFilters["status"] }))} style={{ width: "100%", padding: "6px 8px", border: "1px solid #cbd5e1", borderRadius: 6 }}>
                        <option value="all">Все</option>
                        <option value="pending">Ожидает подтверждения эксперта</option>
                        <option value="resolved">Принята</option>
                        <option value="dismissed">Отклонена</option>
                      </select>
                    </div>
                  ) : null}
                  {renderResizeHandle("status")}
                </th>
                <th style={{ textAlign: "center", padding: "8px 10px", borderBottom: "1px solid #e2e8f0", borderRight: "1px solid #e2e8f0", minWidth: columnWidths.reason, width: columnWidths.reason, position: "sticky", top: 0, zIndex: 7, background: "#f8fafc" }}>Причина/пояснение{renderResizeHandle("reason")}</th>
                <th style={{ textAlign: "center", padding: "8px 10px", borderBottom: "1px solid #e2e8f0", width: columnWidths.actions, minWidth: columnWidths.actions, position: "sticky", top: 0, zIndex: 7, background: "#f8fafc" }}>{renderResizeHandle("actions")}</th>
              </tr>
            </thead>
            <tbody style={{ textAlign: "center" }}>
              {visibleItems.map((it, idx) => {
                const current = classFromResolution(it);
                const availableClassOptions = getAvailableClassOptionsForItem(it);
                const autoClassStatus = autoClassificationStatusFromItem(it);
                const isEditingStatus = editingStatusId === it.id;
                const isEditingClass = editingClassId === it.id;
                const reasons = deriveArchiveReasons(it);
                const dismissalReasonLines = reasons
                  .filter((r) => ["rule_conflict", "deterministic_error", "semantic_rule_mismatch", "price_mismatch", "custom_reason"].includes(r.code))
                  .map((r) => (r.detail ? `${r.label}: ${r.detail}` : r.label));
                const shouldShowDismissalReasons = it.status === "dismissed" && dismissalReasonLines.length > 0;
                const isSelectedRow = selectedRowId === it.id;
                const baseRowBg = isSelectedRow ? "#eaf4ff" : idx % 2 === 0 ? "#ffffff" : "#f8fafc";
                const rowBg = hoveredRowId === it.id ? "#eff6ff" : baseRowBg;
                const showDeleteControl = (isSelectedRow || hoveredRowId === it.id) && !isImportedFromExternalSource(it);
                return (
                  <tr
                    key={it.id}
                    style={{ background: rowBg, transition: "background-color 120ms ease", cursor: "pointer" }}
                    onClick={() => setSelectedRowId(it.id)}
                    onMouseEnter={() => setHoveredRowId(it.id)}
                    onMouseLeave={() => setHoveredRowId((prev) => (prev === it.id ? null : prev))}
                  >
                    <td style={{ padding: "8px 10px", borderBottom: "1px solid #f1f5f9", borderRight: "1px solid #f1f5f9", color: "#64748b", fontVariantNumeric: "tabular-nums", position: "sticky", left: 0, zIndex: 5, background: rowBg, width: columnWidths.rowNo, minWidth: columnWidths.rowNo, maxWidth: columnWidths.rowNo }}>
                      {(safePage - 1) * pageSize + idx + 1}
                    </td>
                    <td
                      style={{
                        padding: "8px 10px",
                        borderBottom: "1px solid #f1f5f9",
                        borderRight: "1px solid #f1f5f9",
                        whiteSpace: "normal",
                        overflowWrap: "anywhere",
                        wordBreak: "break-word",
                        position: "sticky",
                        left: columnWidths.rowNo,
                        zIndex: 4,
                        background: rowBg,
                        width: columnWidths.declaration,
                        minWidth: columnWidths.declaration,
                      }}
                    >
                      <div style={{ display: "grid", justifyItems: "center", gap: 4 }}>
                        <span style={{ overflowWrap: "anywhere", wordBreak: "break-word" }}>{it.declaration_id}</span>
                        {isImportedFromExternalSource(it) ? (
                          <span
                            style={{
                              fontSize: 11,
                              lineHeight: 1,
                              padding: "3px 6px",
                              borderRadius: 999,
                              border: "1px solid #cbd5e1",
                              background: "#f8fafc",
                              color: "#334155",
                              fontWeight: 600,
                            }}
                            title="Запись импортирована из внешнего источника"
                          >
                            Импорт
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td style={{ padding: "8px 10px", borderBottom: "1px solid #f1f5f9", borderRight: "1px solid #f1f5f9", whiteSpace: "nowrap", color: "#334155", width: columnWidths.date, minWidth: columnWidths.date }}>
                      {formatCreatedAtRu(it.created_at)}
                    </td>
                    <td
                      style={{ padding: "8px 10px", borderBottom: "1px solid #f1f5f9", borderRight: "1px solid #f1f5f9", width: columnWidths.tnved, minWidth: columnWidths.tnved, whiteSpace: "normal", overflowWrap: "anywhere", wordBreak: "break-word" }}
                      onClick={() => {
                        if (busyId !== it.id && !isImportedFromExternalSource(it)) {
                          setManualTnvedById((prev) => ({ ...prev, [it.id]: tnvedFromItem(it) === "—" ? "" : tnvedFromItem(it) }));
                          setEditingTnvedId(it.id);
                        }
                      }}
                    >
                      {editingTnvedId === it.id ? (
                        <div style={{ minWidth: 220 }}>
                          <TnVedEaeuTreeListbox
                            value={manualTnvedById[it.id] ?? ""}
                            disabled={busyId === it.id}
                            onChange={(nextCode) => {
                              setManualTnvedById((prev) => ({ ...prev, [it.id]: nextCode }));
                              void onSetTnved(it, nextCode);
                            }}
                          />
                        </div>
                      ) : (
                        tnvedCellText(it)
                      )}
                    </td>
                    <td style={{ padding: "8px 10px", borderBottom: "1px solid #f1f5f9", borderRight: "1px solid #f1f5f9", whiteSpace: "nowrap", width: columnWidths.declaredPrice, minWidth: columnWidths.declaredPrice }}>{declaredPriceFromItem(it)}</td>
                    <td style={{ padding: "8px 10px", borderBottom: "1px solid #f1f5f9", borderRight: "1px solid #f1f5f9", whiteSpace: "nowrap", width: columnWidths.grossWeight, minWidth: columnWidths.grossWeight }}>{grossWeightFromItem(it)}</td>
                    <td style={{ padding: "8px 10px", borderBottom: "1px solid #f1f5f9", borderRight: "1px solid #f1f5f9", whiteSpace: "nowrap", width: columnWidths.netWeight, minWidth: columnWidths.netWeight }}>{netWeightFromItem(it)}</td>
                    <td style={{ padding: "8px 10px", borderBottom: "1px solid #f1f5f9", borderRight: "1px solid #f1f5f9", whiteSpace: "pre-wrap", width: columnWidths.description, minWidth: columnWidths.description }}>
                      {descriptionFromItem(it)}
                    </td>
                    <td style={{ padding: "8px 10px", borderBottom: "1px solid #f1f5f9", borderRight: "1px solid #f1f5f9", whiteSpace: "pre-wrap", width: columnWidths.extractedFeatures, minWidth: columnWidths.extractedFeatures, textAlign: "left" }}>
                      {extractedFeaturesFromItem(it)}
                    </td>
                    <td style={{ padding: "8px 10px", borderBottom: "1px solid #f1f5f9", borderRight: "1px solid #f1f5f9", width: columnWidths.autoClassification, minWidth: columnWidths.autoClassification, color: autoClassStatus.color, fontWeight: 700 }}>
                      {autoClassStatus.label}
                    </td>
                    <td
                      style={{ padding: "8px 10px", borderBottom: "1px solid #f1f5f9", borderRight: "1px solid #f1f5f9", width: columnWidths.className, minWidth: columnWidths.className }}
                      onClick={() => {
                        if (busyId !== it.id) {
                          setManualClassById((prev) => ({ ...prev, [it.id]: prev[it.id] ?? current }));
                          setCustomClassInputOpenById((prev) => ({ ...prev, [it.id]: false }));
                          setEditingClassId(it.id);
                        }
                      }}
                    >
                      {isEditingClass ? (
                        <div
                          onClick={(e) => e.stopPropagation()}
                          style={{ display: "grid", gap: 6, padding: 6, border: "1px solid #cbd5e1", background: "#fff", textAlign: "left" }}
                        >
                          <div style={{ border: "1px solid #cbd5e1", maxHeight: 220, overflowY: "auto", background: "#fff" }}>
                            {availableClassOptions.length === 0 ? (
                              <div style={{ padding: "6px 8px", color: "#64748b", fontSize: 12 }}>Нет доступных классов</div>
                            ) : (
                              availableClassOptions.map((opt) => (
                                <button
                                  key={opt.value}
                                  type="button"
                                  disabled={busyId === it.id}
                                  onClick={() => {
                                    setManualClassById((prev) => ({ ...prev, [it.id]: opt.value }));
                                    void onSetClass(it, opt.value);
                                  }}
                                  style={{
                                    width: "100%",
                                    textAlign: "left",
                                    border: "none",
                                    borderBottom: "1px solid #f1f5f9",
                                    background: (manualClassById[it.id] ?? current) === opt.value ? "#eff6ff" : "#fff",
                                    padding: "6px 8px",
                                    cursor: busyId === it.id ? "not-allowed" : "pointer",
                                    display: "flex",
                                    justifyContent: "space-between",
                                    alignItems: "center",
                                    gap: 8,
                                  }}
                                >
                                  <span>{opt.value}</span>
                                  {opt.fromCatalog ? (
                                    <span title="Класс из справочника" style={{ color: "#dc2626", fontWeight: 700, fontSize: 12 }}>
                                      *
                                    </span>
                                  ) : null}
                                </button>
                              ))
                            )}
                            <div style={{ borderTop: "1px solid #e2e8f0" }}>
                              <button
                                type="button"
                                onClick={() => setCustomClassInputOpenById((prev) => ({ ...prev, [it.id]: !prev[it.id] }))}
                                disabled={busyId === it.id}
                                style={{
                                  width: "100%",
                                  textAlign: "left",
                                  border: "none",
                                  background: "#fff",
                                  padding: "6px 8px",
                                  cursor: busyId === it.id ? "not-allowed" : "pointer",
                                  display: "flex",
                                  justifyContent: "space-between",
                                  alignItems: "center",
                                }}
                              >
                                <span>Свое значение</span>
                                <span style={{ color: "#64748b", fontSize: 13 }}>✎</span>
                              </button>
                              {customClassInputOpenById[it.id] ? (
                                <div style={{ borderTop: "1px solid #f1f5f9", padding: "6px 8px", display: "grid", gap: 6 }}>
                                  <input
                                    type="text"
                                    value={manualClassById[it.id] ?? current}
                                    disabled={busyId === it.id}
                                    onChange={(e) => setManualClassById((prev) => ({ ...prev, [it.id]: e.target.value }))}
                                    onKeyDown={(e) => {
                                      if (e.key === "Enter") {
                                        e.preventDefault();
                                        void onSetClass(it);
                                      }
                                      if (e.key === "Escape") setEditingClassId(null);
                                    }}
                                    placeholder="Введите свой класс"
                                    autoComplete="off"
                                    style={{ width: "100%", padding: "7px 9px", border: "1px solid #cbd5e1" }}
                                  />
                                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                                    <button type="button" onClick={() => void onSetClass(it)} disabled={busyId === it.id} style={{ border: "1px solid #cbd5e1", background: "#fff", padding: "4px 8px", cursor: "pointer" }}>
                                      Применить
                                    </button>
                                    <button type="button" onClick={() => setCustomClassInputOpenById((prev) => ({ ...prev, [it.id]: false }))} disabled={busyId === it.id} style={{ border: "1px solid #cbd5e1", background: "#fff", padding: "4px 8px", cursor: "pointer" }}>
                                      Скрыть
                                    </button>
                                  </div>
                                </div>
                              ) : null}
                            </div>
                          </div>
                          <div style={{ fontSize: 11, color: "#64748b", textAlign: "left" }}>
                            <span style={{ color: "#dc2626", fontWeight: 700 }}>*</span> класс из справочника
                          </div>
                        </div>
                      ) : (
                        <button
                          type="button"
                          disabled={busyId === it.id}
                          style={{
                            border: "none",
                            background: "transparent",
                            padding: 0,
                            margin: 0,
                            color: "#0f172a",
                            fontWeight: 500,
                            cursor: busyId === it.id ? "not-allowed" : "pointer",
                          }}
                        >
                          {current || "—"}
                        </button>
                      )}
                    </td>
                    <td
                      style={{ padding: "8px 10px", borderBottom: "1px solid #f1f5f9", borderRight: "1px solid #f1f5f9", fontWeight: 600, width: columnWidths.status, minWidth: columnWidths.status }}
                      onClick={() => {
                        if (busyId !== it.id) setEditingStatusId(it.id);
                      }}
                    >
                      {isEditingStatus ? (
                        <select
                          autoFocus
                          value={it.status}
                          disabled={busyId === it.id}
                          onChange={(e) => void onSetStatus(it, e.target.value as "pending" | "resolved" | "dismissed")}
                          onBlur={() => setEditingStatusId(null)}
                          style={{ padding: "6px 8px", borderRadius: 8, border: "1px solid #cbd5e1", minWidth: 160 }}
                        >
                          <option value="pending">Ожидает подтверждения эксперта</option>
                          <option value="resolved">Принята</option>
                          <option value="dismissed">Отклонена</option>
                        </select>
                      ) : (
                        <button
                          type="button"
                          disabled={busyId === it.id}
                          style={{
                            padding: "4px 8px",
                            fontWeight: 700,
                            borderRadius: 6,
                            cursor: busyId === it.id ? "not-allowed" : "pointer",
                            ...statusBadgeStyle(it.status),
                          }}
                        >
                          {labelStatus(it.status)}
                        </button>
                      )}
                    </td>
                    <td
                      style={{
                        padding: "8px 10px",
                        borderBottom: "1px solid #f1f5f9",
                        borderRight: "1px solid #f1f5f9",
                        verticalAlign: "middle",
                        width: columnWidths.reason,
                        minWidth: columnWidths.reason,
                        textAlign: "center",
                        whiteSpace: "pre-wrap",
                        overflowWrap: "anywhere",
                        wordBreak: "break-word",
                        color: "#334155",
                        fontSize: 12,
                        lineHeight: 1.35,
                      }}
                    >
                      {shouldShowDismissalReasons ? dismissalReasonLines.join("\n") : "—"}
                    </td>
                    <td style={{ padding: "8px 6px", borderBottom: "1px solid #f1f5f9", textAlign: "center", verticalAlign: "middle", width: columnWidths.actions, minWidth: columnWidths.actions }}>
                      {showDeleteControl ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            void onDeleteRow(it);
                          }}
                          disabled={busyId === it.id}
                          title="Удалить запись"
                          aria-label="Удалить запись"
                          style={{
                            width: 24,
                            height: 24,
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            border: "1px solid #fecaca",
                            background: "#fff1f2",
                            color: "#b91c1c",
                            cursor: busyId === it.id ? "not-allowed" : "pointer",
                            fontSize: 18,
                            lineHeight: 1,
                            padding: 0,
                          }}
                        >
                          ×
                        </button>
                      ) : <span style={{ color: "#cbd5e1" }}>·</span>}
                    </td>
                  </tr>
                );
              })}
              {visibleItems.length === 0 ? (
                <tr>
                  <td colSpan={14} style={{ padding: "18px 10px", textAlign: "center", color: "#64748b" }}>
                    {loading ? "Загрузка..." : "Ничего не найдено по заданным фильтрам."}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <PaginationControls
          currentPage={safePage}
          totalPages={pageCount}
          loading={loading}
          summaryText={`Показано: ${pageStart}-${pageEnd} из ${totalItems}`}
          pageSize={pageSize}
          onPageChange={(next) => setPage(next)}
          onPageSizeChange={(next) => {
            setPageSize(next);
            setPage(1);
          }}
        />
      </div>
      {featureSpaceOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Навигация в пространстве признаков (kNN)"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1200,
            background: "rgba(15, 23, 42, 0.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 20,
          }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setFeatureSpaceOpen(false);
          }}
        >
          <div className="card" style={{ width: "min(95vw, 980px)", maxHeight: "90vh", overflow: "auto", padding: 14, background: "#fff" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 8 }}>
              <h3 style={{ margin: 0, fontSize: 17, color: "#0f172a" }}>Пространство признаков (kNN)</h3>
              <ModalCloseButton onClick={() => setFeatureSpaceOpen(false)} />
            </div>
            <p style={{ margin: "0 0 10px", fontSize: 13, color: "#475569" }}>
              Синий маркер — текущая декларация. Цвета эталонных точек соответствуют присвоенным классам.
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", marginBottom: 10 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: "#334155" }}>Масштаб</span>
              <button type="button" className="btn-secondary" onClick={() => setFeatureSpaceZoom((z) => Math.max(0.6, z / 1.2))}>
                −
              </button>
              <button type="button" className="btn-secondary" onClick={() => setFeatureSpaceZoom((z) => Math.min(4, z * 1.2))}>
                +
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  setFeatureSpaceZoom(1);
                  setFeatureSpacePan({ x: 0, y: 0 });
                }}
              >
                Сброс
              </button>
              <span style={{ fontSize: 12, color: "#64748b" }}>Точек: {featureSpacePoints.length}</span>
            </div>
            <div style={{ display: "flex", gap: 12, alignItems: "stretch" }}>
              <div style={{ flex: "1 1 auto", border: "1px solid #e2e8f0", borderRadius: 10, overflow: "hidden", background: "#f8fafc" }}>
                <svg
                  viewBox="0 0 860 480"
                  width="100%"
                  style={{ display: "block", cursor: "grab", touchAction: "none" }}
                  onWheel={(e) => {
                    e.preventDefault();
                    setFeatureSpaceZoom((z) => Math.min(4, Math.max(0.6, e.deltaY < 0 ? z * 1.08 : z / 1.08)));
                  }}
                  onMouseDown={(e) => {
                    const sx = e.clientX;
                    const sy = e.clientY;
                    const start = { ...featureSpacePan };
                    const onMove = (ev: MouseEvent) => {
                      setFeatureSpacePan({ x: start.x + (ev.clientX - sx), y: start.y + (ev.clientY - sy) });
                    };
                    const onUp = () => {
                      window.removeEventListener("mousemove", onMove);
                      window.removeEventListener("mouseup", onUp);
                    };
                    window.addEventListener("mousemove", onMove);
                    window.addEventListener("mouseup", onUp);
                  }}
                >
                  <rect x={0} y={0} width={860} height={480} fill="#f8fafc" />
                  {featureSpaceGridTicks.map((t) => {
                    const x = 42 + (t / 5) * (860 - 84);
                    return <line key={`vx-${t}`} x1={x} x2={x} y1={42} y2={438} stroke="#e2e8f0" strokeWidth={1} />;
                  })}
                  {featureSpaceGridTicks.map((t) => {
                    const y = 42 + (t / 5) * (480 - 84);
                    return <line key={`hy-${t}`} x1={42} x2={818} y1={y} y2={y} stroke="#e2e8f0" strokeWidth={1} />;
                  })}
                  <rect x={42} y={42} width={776} height={396} fill="none" stroke="#94a3b8" strokeWidth={1.2} />
                  {featureSpacePoints.map((p, i) => {
                    const { x, y } = projectFeatureSpacePoint(p);
                    const isQuery = p.kind === "query";
                    const classKey = String(p.class_id ?? "").trim();
                    const fill = isQuery ? "#2563eb" : featureSpaceClassColorMap.get(classKey) ?? "#f59e0b";
                    return (
                      <g key={`${p.kind}-${i}`} onMouseEnter={() => setFeatureSpaceHovered({ point: p, x, y })} onMouseLeave={() => setFeatureSpaceHovered(null)}>
                        <circle cx={x} cy={y} r={isQuery ? 7 : 5} fill={fill} opacity={isQuery ? 0.95 : 0.82} stroke="#0f172a" strokeWidth={isQuery ? 1.3 : 0.6} />
                      </g>
                    );
                  })}
                  {featureSpaceHovered ? (
                    <foreignObject x={Math.max(46, Math.min(520, featureSpaceHovered.x + 10))} y={Math.max(46, Math.min(360, featureSpaceHovered.y - 14))} width={300} height={120}>
                      <div
                        style={{
                          background: "rgba(15,23,42,0.92)",
                          color: "#f8fafc",
                          borderRadius: 8,
                          padding: "8px 10px",
                          fontSize: 12,
                          lineHeight: 1.35,
                          boxShadow: "0 8px 20px rgba(15,23,42,0.3)",
                        }}
                      >
                        <div style={{ fontWeight: 700, marginBottom: 4 }}>
                          {featureSpaceHovered.point.kind === "query" ? "Текущая декларация" : `Эталон ${featureSpaceHovered.point.class_id ?? ""}`}
                        </div>
                        <div>{featureSpaceHovered.point.text || "(пустое описание)"}</div>
                      </div>
                    </foreignObject>
                  ) : null}
                </svg>
              </div>
              {featureSpaceLegendItems.length > 0 ? (
                <div style={{ width: 220, flex: "0 0 220px", border: "1px solid #e2e8f0", borderRadius: 10, padding: 10, background: "#fff" }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#334155", marginBottom: 8 }}>Легенда классов</div>
                  <div style={{ display: "grid", gap: 6 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ width: 11, height: 11, borderRadius: 999, background: "#2563eb", border: "1px solid #64748b" }} />
                      <span style={{ fontSize: 12, color: "#334155", lineHeight: 1.3, wordBreak: "break-word" }}>Анализируемая декларация</span>
                    </div>
                    {featureSpaceLegendItems.map(([classId, color]) => (
                      <div key={classId} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ width: 11, height: 11, borderRadius: 999, background: color, border: "1px solid #64748b" }} />
                        <span style={{ fontSize: 12, color: "#334155", lineHeight: 1.3, wordBreak: "break-word" }}>{classId}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

