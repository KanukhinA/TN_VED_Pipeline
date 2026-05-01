import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createExpertDecision,
  patchExpertDecision,
  preflightOfficerValidation,
  validateDeclarationByOfficerWithProgress,
  type OfficerValidationProgressEvent,
} from "../api/client";
import { formatClassColumnDisplay } from "../utils/formatClassColumn";
import { deepEqualJson } from "../utils/deepEqualJson";
import { ExtractedFeaturesEditor, deepClone } from "../ui/ExtractedFeaturesEditor";
import TnVedEaeuPicker from "../ui/TnVedEaeuPicker";
import { ModalCloseButton } from "../ui/ModalCloseButton";
import { getTnVedGroup } from "../catalog/tnVedGroupsData";

function formatDurationMs(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} с`;
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, "0")}`;
}

function formatDurationRu(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min <= 0) return `${sec} с.`;
  return `${min} мин. ${sec} с.`;
}

function isAbortError(e: unknown): boolean {
  return (
    (e instanceof DOMException && e.name === "AbortError") ||
    (typeof e === "object" && e !== null && (e as Error).name === "AbortError")
  );
}

type OfficerForm = {
  graph31: string;
  graph33: string;
  graph35: string;
  graph38: string;
  graph42: string;
};

const initialForm: OfficerForm = {
  graph31: "",
  graph33: "",
  graph35: "",
  graph38: "",
  graph42: "",
};

function truncateMiddle(s: string, max = 36): string {
  const t = s.trim();
  if (t.length <= max) return t;
  const half = Math.floor((max - 3) / 2);
  return `${t.slice(0, half)}…${t.slice(-half)}`;
}

/** Ответ оркестратора кладёт полный officer-run в steps; дублирует summary_ru наверх. */
function officerPayloadFromResult(raw: any): any {
  if (!raw || typeof raw !== "object") return raw;
  const steps = raw.steps;
  if (!Array.isArray(steps)) return raw;
  const officer = steps.find((s: any) => s && s.step === "officer-pipeline" && s.result);
  return officer?.result ?? raw;
}

/** Шаг оркестратора после инспектора: запрос к сервису проверки стоимости (графа 42). */
function orchestratorStepFromResult(raw: any, stepName: string): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const steps = raw.steps;
  if (!Array.isArray(steps)) return null;
  const row = steps.find((s: any) => s && s.step === stepName && s.result);
  const r = row?.result;
  return r && typeof r === "object" ? (r as Record<string, unknown>) : null;
}

function priceValidatorPayloadFromResult(raw: any): Record<string, unknown> | null {
  return orchestratorStepFromResult(raw, "price-validator");
}

function formatMoney(v: unknown): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(v);
}

function formatPct(v: unknown): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(2)}%`;
}

function formatRuleRangeForUi(raw: string): string {
  const t = raw.trim();
  if (!t.includes("..")) return t;
  const [aRaw, bRaw] = t.split("..", 2).map((x) => x.trim());
  const a = aRaw;
  const b = bRaw;
  if (b === "+inf" || b === "inf") return `не меньше ${a}`;
  if (a === "-inf") return `не больше ${b}`;
  return `от ${a} до ${b}`;
}

function humanizeSemanticRuleMessage(message: string): string {
  const base = String(message || "").trim();
  if (!base) return "";
  let out = base;
  out = out.replace(/rowIndicator\s+`([^`]+)`\s*:\s*([^;]+)(;?)/g, (_m, name: string, range: string, sep: string) => {
    const tail = sep ? ";" : "";
    return `показатель «${name}» должен быть ${formatRuleRangeForUi(range)}${tail}`;
  });
  out = out.replace(/\s{2,}/g, " ").trim();
  return out;
}

function formatActualFeatureValueForUi(raw: unknown): string {
  if (raw == null) return "не указано";
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  if (typeof raw === "string") {
    const t = raw.trim();
    return t.length > 0 ? t : "не указано";
  }
  if (Array.isArray(raw) && raw.length === 2) {
    const [left, right] = raw;
    const l = typeof left === "number" && Number.isFinite(left) ? left : null;
    const r = typeof right === "number" && Number.isFinite(right) ? right : null;
    if (l == null && r == null) return "не указано";
    if (l != null && r == null) return `от ${l} до +inf`;
    if (l == null && r != null) return `до ${r}`;
    return `от ${l} до ${r}`;
  }
  return String(raw);
}

function semanticMessageWithActualValues(
  baseMessage: string,
  semanticRuleCheckPayload: Record<string, unknown> | null | undefined,
  parsedFeatures: Record<string, unknown>,
): string {
  const base = String(baseMessage || "").trim();
  if (!base) return "";
  if (/фактическ/i.test(base)) return base;
  if (!semanticRuleCheckPayload || typeof semanticRuleCheckPayload !== "object") return base;
  const failed = semanticRuleCheckPayload.failed_conditions;
  if (!Array.isArray(failed) || failed.length === 0) return base;
  const parts: string[] = [];
  for (const row of failed) {
    if (!row || typeof row !== "object") continue;
    const condition = (row as Record<string, unknown>).condition as Record<string, unknown> | undefined;
    if (!condition || typeof condition !== "object") continue;
    if (String(condition.type ?? "") !== "rowIndicator") continue;
    const arrayPath = String(condition.array_path ?? "").trim();
    const nameField = String(condition.name_field ?? "").trim();
    const nameEquals = String(condition.name_equals ?? "").trim();
    const valueField = String(condition.value_field ?? "").trim();
    if (!arrayPath || !nameField || !nameEquals || !valueField) continue;
    const rawArray = parsedFeatures[arrayPath];
    if (!Array.isArray(rawArray)) {
      parts.push(`«${nameEquals}»: не указано`);
      continue;
    }
    const found = rawArray.find((item) => {
      if (!item || typeof item !== "object") return false;
      return String((item as Record<string, unknown>)[nameField] ?? "").trim().toLowerCase() === nameEquals.toLowerCase();
    }) as Record<string, unknown> | undefined;
    const actual = found ? formatActualFeatureValueForUi(found[valueField]) : "не указано";
    parts.push(`«${nameEquals}»: ${actual}`);
  }
  if (parts.length === 0) return base;
  return `${base} Фактические значения: ${parts.join("; ")}.`;
}

function recalculateSemanticForK(semanticPayload: Record<string, unknown> | null, k: number): Record<string, unknown> | null {
  if (!semanticPayload || typeof semanticPayload !== "object") return semanticPayload;
  const pointsRaw = semanticPayload.feature_space_points;
  if (!Array.isArray(pointsRaw)) return semanticPayload;
  const refs = pointsRaw
    .filter((p) => p && typeof p === "object" && String((p as Record<string, unknown>).kind ?? "") === "reference")
    .map((p) => {
      const row = p as Record<string, unknown>;
      return {
        class_id: String(row.class_id ?? "").trim(),
        similarity: typeof row.similarity === "number" ? row.similarity : Number(row.similarity ?? NaN),
      };
    })
    .filter((r) => r.class_id && Number.isFinite(r.similarity))
    .sort((a, b) => b.similarity - a.similarity);
  if (refs.length === 0) return semanticPayload;
  const kEff = Math.max(1, Math.min(Math.floor(k), refs.length));
  const top = refs.slice(0, kEff);
  const s0Raw = semanticPayload.neighbor_similarity_floor_s0;
  const s0 = typeof s0Raw === "number" ? s0Raw : Number(s0Raw ?? 0.35);
  const tau1Raw = semanticPayload.threshold_tau1 ?? semanticPayload.similarity_threshold;
  const tau1 = typeof tau1Raw === "number" ? tau1Raw : Number(tau1Raw ?? NaN);
  const tau2Raw = semanticPayload.threshold_tau2;
  const tau2 = typeof tau2Raw === "number" ? tau2Raw : Number(tau2Raw ?? 0.55);
  const eps = 1e-9;
  const votes = new Map<string, { vw: number; count: number; best: number }>();
  let totalWeight = 0;
  for (const n of top) {
    const w = Math.max(0, n.similarity - s0);
    totalWeight += w;
    const cur = votes.get(n.class_id) ?? { vw: 0, count: 0, best: -Infinity };
    cur.vw += w;
    cur.count += 1;
    if (n.similarity > cur.best) cur.best = n.similarity;
    votes.set(n.class_id, cur);
  }
  const winner = [...votes.entries()].sort((a, b) => {
    const pa = a[1].vw / (totalWeight + eps);
    const pb = b[1].vw / (totalWeight + eps);
    if (pb !== pa) return pb - pa;
    if (b[1].count !== a[1].count) return b[1].count - a[1].count;
    if (b[1].best !== a[1].best) return b[1].best - a[1].best;
    return a[0].localeCompare(b[0], "ru");
  })[0];
  const classId = winner?.[0] ?? null;
  const bestSim = winner?.[1]?.best ?? null;
  const supportP = winner ? winner[1].vw / (totalWeight + eps) : 0;
  const matched = Number.isFinite(bestSim as number) && Number.isFinite(tau1) && Number.isFinite(tau2)
    ? (bestSim as number) > tau1 && supportP > tau2
    : Boolean(classId);
  const knnNeighbors = top.map((n, idx) => ({
    index: idx,
    class_id: n.class_id,
    similarity: n.similarity,
    weight: Math.max(0, n.similarity - s0),
    description_text: "",
  }));
  return {
    ...semanticPayload,
    knn_k: kEff,
    knn_neighbors: knnNeighbors,
    class_id: classId,
    similarity: Number.isFinite(bestSim as number) ? bestSim : semanticPayload.similarity,
    support_p: supportP,
    matched,
    below_threshold: Number.isFinite(tau1) && Number.isFinite(bestSim as number) ? (bestSim as number) <= tau1 : semanticPayload.below_threshold,
  };
}

function describeFeatureSpaceProjectionRu(raw: unknown): string {
  if (raw === "classical_mds_cosine") {
    return (
      "Координаты на плоскости получены классическим MDS (PCoA) из попарных косинусных расстояний эмбеддингов: " +
      "близкие в модели точки стремятся оказаться ближе на карте (по аналогии с визуализацией word2vec, где часто берут t-SNE/UMAP; " +
      "здесь — явное сохранение метрики расстояния, а не раскладка по кругу). Точная схожесть — по полю «Схожесть», не по пикселям."
    );
  }
  if (raw === "pca_mean_centered_query_origin") {
    return "MDS оказался вырожденным (мало разброса векторов); использован запасной PCA-проектор с центром на запросе.";
  }
  return "";
}

function describeFeatureSpaceProjectionRuShort(raw: unknown): string {
  if (raw === "classical_mds_cosine") {
    return "Карта: MDS по косинусным расстояниям эмбеддингов (подробнее — в открывшемся окне).";
  }
  if (raw === "pca_mean_centered_query_origin") {
    return "Карта: запасной PCA (MDS вырожден); подробнее — в окне.";
  }
  return "";
}

function hasAnyMeaningfulExtractedFeature(value: unknown): boolean {
  if (value == null) return false;
  if (Array.isArray(value)) return value.some((v) => hasAnyMeaningfulExtractedFeature(v));
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((v) => hasAnyMeaningfulExtractedFeature(v));
  }
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return true;
  return false;
}

function formatFeatureScalarRu(value: unknown): string {
  if (value == null) return "не указано";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "не указано";
  if (typeof value === "boolean") return value ? "да" : "нет";
  if (typeof value === "string") return value.trim() || "не указано";
  if (Array.isArray(value) && value.length === 2) {
    const [left, right] = value;
    const l = typeof left === "number" && Number.isFinite(left) ? left : null;
    const r = typeof right === "number" && Number.isFinite(right) ? right : null;
    if (l == null && r == null) return "не указано";
    if (l != null && r == null) return `от ${l} до +inf`;
    if (l == null && r != null) return `до ${r}`;
    return `${l}..${r}`;
  }
  return String(value);
}

function flattenExtractedFeaturesRu(parsed: Record<string, unknown>): string[] {
  const lines: string[] = [];
  for (const [section, sectionValue] of Object.entries(parsed)) {
    if (Array.isArray(sectionValue)) {
      for (const row of sectionValue) {
        if (!row || typeof row !== "object") continue;
        const obj = row as Record<string, unknown>;
        const keys = Object.keys(obj);
        if (keys.length === 0) continue;
        const mainName = String(obj.вещество ?? obj.параметр ?? keys[0] ?? "").trim();
        const detail = keys
          .filter((k) => k !== "вещество" && k !== "параметр")
          .map((k) => `${k}: ${formatFeatureScalarRu(obj[k])}`)
          .join("; ");
        lines.push(`${section} · ${mainName || "показатель"} — ${detail || formatFeatureScalarRu(obj[keys[0]])}`);
      }
      continue;
    }
    if (sectionValue && typeof sectionValue === "object") {
      for (const [k, v] of Object.entries(sectionValue as Record<string, unknown>)) {
        lines.push(`${section} · ${k} — ${formatFeatureScalarRu(v)}`);
      }
      continue;
    }
    lines.push(`${section} — ${formatFeatureScalarRu(sectionValue)}`);
  }
  return lines;
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

/** Подпись класса из справочника (catalog_classification_classes) для KPI. */
function catalogTitleForClassId(catalogClasses: unknown, classId: string | null | undefined): string | null {
  if (classId == null || String(classId).trim() === "") return null;
  if (!Array.isArray(catalogClasses)) return null;
  const id = String(classId).trim();
  for (const c of catalogClasses) {
    if (!c || typeof c !== "object") continue;
    const row = c as Record<string, unknown>;
    const cid = String(row.class_id ?? "").trim();
    if (cid === id) {
      const t = String(row.title ?? "").trim();
      return t.length > 0 ? t : null;
    }
  }
  return null;
}

export default function OfficerValidationPage() {
  const [form, setForm] = useState<OfficerForm>(initialForm);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [lastServerElapsedMs, setLastServerElapsedMs] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** Один id на сессию проверок (в т.ч. перепроверка с правками признаков и запись в expert-decisions). */
  const declarationSessionRef = useRef<string | null>(null);
  const [featuresEditMode, setFeaturesEditMode] = useState(false);
  const [editedFeatures, setEditedFeatures] = useState<Record<string, unknown> | null>(null);
  const [correctionLogError, setCorrectionLogError] = useState<string | null>(null);
  const [correctionLogOk, setCorrectionLogOk] = useState(false);
  const [serverPhase, setServerPhase] = useState<{ title: string; detail: string } | null>(null);
  const [featureSpaceOpen, setFeatureSpaceOpen] = useState(false);
  const [featureSpaceZoom, setFeatureSpaceZoom] = useState(1);
  const [featureSpacePan, setFeatureSpacePan] = useState({ x: 0, y: 0 });
  const [featureSpaceHovered, setFeatureSpaceHovered] = useState<FeatureSpaceHover | null>(null);
  const [semanticK, setSemanticK] = useState(3);
  const [officerFinalDecision, setOfficerFinalDecision] = useState<"approved" | "rejected" | "expert_review" | null>(null);
  const [manualApprovalClass, setManualApprovalClass] = useState("");
  const [decisionBusy, setDecisionBusy] = useState(false);
  const [decisionElapsedMs, setDecisionElapsedMs] = useState(0);
  const [extractionAssessment, setExtractionAssessment] = useState<"contains_expected" | "no_expected" | null>(null);
  const [decisionResetSecondsLeft, setDecisionResetSecondsLeft] = useState<number | null>(null);
  const [decisionResetMessage, setDecisionResetMessage] = useState<string | null>(null);
  const [featureDebugOpen, setFeatureDebugOpen] = useState(false);
  const [rejectReasonModalOpen, setRejectReasonModalOpen] = useState(false);
  const [rejectReasonType, setRejectReasonType] = useState<"unrealistic_features" | "underpriced" | "custom" | "">("");
  const [rejectReasonCustom, setRejectReasonCustom] = useState("");

  useEffect(() => {
    if (!busy) return;
    const started = Date.now();
    setElapsedMs(0);
    const id = window.setInterval(() => setElapsedMs(Date.now() - started), 200);
    return () => window.clearInterval(id);
  }, [busy]);

  useEffect(() => {
    if (!decisionBusy) return;
    const started = Date.now();
    setDecisionElapsedMs(0);
    const id = window.setInterval(() => setDecisionElapsedMs(Date.now() - started), 200);
    return () => window.clearInterval(id);
  }, [decisionBusy]);

  useEffect(() => {
    if (!result) return;
    setFeaturesEditMode(false);
    setEditedFeatures(null);
    setCorrectionLogError(null);
    setExtractionAssessment(null);
  }, [result]);

  function setField<K extends keyof OfficerForm>(key: K, value: OfficerForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  const resetOfficerFormForNextDeclaration = useCallback(() => {
    setForm(initialForm);
    setResult(null);
    setError(null);
    setLastServerElapsedMs(null);
    declarationSessionRef.current = null;
    setFeaturesEditMode(false);
    setEditedFeatures(null);
    setCorrectionLogError(null);
    setCorrectionLogOk(false);
    setOfficerFinalDecision(null);
    setManualApprovalClass("");
    setExtractionAssessment(null);
    setFeatureSpaceOpen(false);
    setFeatureSpaceHovered(null);
    setFeatureDebugOpen(false);
    setRejectReasonModalOpen(false);
    setRejectReasonType("");
    setRejectReasonCustom("");
  }, []);

  useEffect(() => {
    if (decisionResetSecondsLeft == null) return;
    if (decisionResetSecondsLeft <= 0) {
      resetOfficerFormForNextDeclaration();
      setDecisionResetSecondsLeft(null);
      setDecisionResetMessage(null);
      return;
    }
    const id = window.setTimeout(() => {
      setDecisionResetSecondsLeft((prev) => (prev == null ? null : prev - 1));
    }, 1000);
    return () => window.clearTimeout(id);
  }, [decisionResetSecondsLeft, resetOfficerFormForNextDeclaration]);

  const canSubmit =
    form.graph31.trim().length > 0 &&
    form.graph33.trim().length > 0 &&
    form.graph35.trim().length > 0 &&
    form.graph38.trim().length > 0 &&
    form.graph42.trim().length > 0;
  const rejectReasonRu =
    rejectReasonType === "unrealistic_features"
      ? "Нереалистичные характеристики товара"
      : rejectReasonType === "underpriced"
        ? "Заниженная стоимость"
        : rejectReasonType === "custom"
          ? rejectReasonCustom.trim()
          : "";
  const busyStageUi = serverPhase ?? { title: "Ожидание статуса этапа от сервера", detail: "Запрос отправлен, ждём первое событие phase." };

  function onStop() {
    abortRef.current?.abort();
  }

  async function runValidation(
    extracted_features_override?: Record<string, unknown>,
    logParsedBeforeOverride?: Record<string, unknown>,
  ) {
    if (!canSubmit || busy) return;
    const ac = new AbortController();
    abortRef.current = ac;
    const requestStartedAt = Date.now();
    // Во время нового запроса скрываем предыдущий результат, чтобы не показывать устаревшие данные.
    setResult(null);
    setBusy(true);
    setServerPhase(null);
    setError(null);
    setCorrectionLogError(null);
    setCorrectionLogOk(false);
    if (!declarationSessionRef.current) {
      declarationSessionRef.current = `OFFICER-${Date.now()}`;
    }
    try {
      const preflight = await preflightOfficerValidation();
      if (preflight.status !== "ok") {
        const down = preflight.down_dependencies.length
          ? preflight.down_dependencies
          : Object.entries(preflight.dependencies)
              .filter(([, st]) => st !== "ok")
              .map(([name]) => name);
        throw new Error(
          `Сервер не готов к проверке декларации. Недоступны сервисы: ${down.join(", ") || "неизвестно"}.`,
        );
      }
      const response = await validateDeclarationByOfficerWithProgress(
        {
          graph31: form.graph31.trim(),
          graph33: form.graph33.trim(),
          graph35: Number(form.graph35),
          graph38: Number(form.graph38),
          graph42: Number(form.graph42),
          declaration_id: declarationSessionRef.current,
          semantic_k: semanticK,
          ...(extracted_features_override != null ? { extracted_features_override } : {}),
        },
        (ev: OfficerValidationProgressEvent) => {
          if (ev.event === "phase") {
            setServerPhase({
              title: String(ev.title ?? "Этап валидации ДТ"),
              detail: String(ev.detail ?? ""),
            });
          } else if (ev.event === "partial" && ev.result) {
            setResult(ev.result);
          }
        },
        { signal: ac.signal },
      );
      setResult(response);
      setLastServerElapsedMs(Math.max(0, Date.now() - requestStartedAt));
      if (
        extracted_features_override != null &&
        logParsedBeforeOverride != null &&
        !deepEqualJson(logParsedBeforeOverride, extracted_features_override)
      ) {
        const officer = officerPayloadFromResult(response);
        const declId = typeof officer?.declaration_id === "string" ? officer.declaration_id.trim() : "";
        const ruleRaw = officer?.catalog && typeof officer.catalog === "object" ? (officer.catalog as Record<string, unknown>).rule_id : null;
        const ruleId = ruleRaw != null && String(ruleRaw).trim() ? String(ruleRaw).trim() : undefined;
        if (declId) {
          try {
            await createExpertDecision({
              category: "inspector_feature_correction",
              declaration_id: declId,
              rule_id: ruleId,
              summary_ru: `Инспектор скорректировал извлечённые признаки (декларация ${declId})`,
              payload: {
                source: "officer_validation",
                parsed_before_override: logParsedBeforeOverride,
                parsed_after_override: extracted_features_override,
                recorded_at: new Date().toISOString(),
              },
            });
            setCorrectionLogOk(true);
          } catch (e: any) {
            setCorrectionLogError(e?.message ?? String(e));
          }
        }
      }
    } catch (e: any) {
      if (isAbortError(e)) {
        setError("Запрос остановлен.");
      } else {
        setError(e?.message ?? String(e));
      }
    } finally {
      setBusy(false);
      setServerPhase(null);
      abortRef.current = null;
    }
  }

  function onSubmit() {
    setDecisionResetSecondsLeft(null);
    setDecisionResetMessage(null);
    setFeatureDebugOpen(false);
    setRejectReasonModalOpen(false);
    setRejectReasonType("");
    setRejectReasonCustom("");
    declarationSessionRef.current = null;
    setCorrectionLogOk(false);
    setCorrectionLogError(null);
    setLastServerElapsedMs(null);
    setOfficerFinalDecision(null);
    setManualApprovalClass("");
    setExtractionAssessment(null);
    void runValidation();
  }

  function onApplyFeatureEdits(parsedBefore: Record<string, unknown>, next: Record<string, unknown>) {
    if (!canSubmit || busy) return;
    if (deepEqualJson(parsedBefore, next)) {
      setCorrectionLogError("Изменений нет — скорректируйте значения или нажмите «Отмена».");
      return;
    }
    setCorrectionLogError(null);
    void runValidation(next, parsedBefore);
  }

  const core = result ? officerPayloadFromResult(result) : null;
  const semanticPayloadRaw = result ? orchestratorStepFromResult(result, "semantic-search") : null;
  const semanticPayload = useMemo(
    () => recalculateSemanticForK(semanticPayloadRaw, semanticK),
    [semanticPayloadRaw, semanticK],
  );
  const semanticRuleCheckPayload = result ? orchestratorStepFromResult(result, "semantic-class-rule-check") : null;
  const llmNamingPayload = result ? orchestratorStepFromResult(result, "llm-class-name-suggestion") : null;
  const expertRoutingPayload = result ? orchestratorStepFromResult(result, "expert-review-routing") : null;
  const pricePayload = result ? priceValidatorPayloadFromResult(result) : null;

  const det = core?.deterministic;
  const catalog = core?.catalog;
  const validationOk = det?.validation_ok === true;
  const orchestratorFinalRaw =
    typeof result?.final_class === "string"
      ? result.final_class.trim()
      : typeof result?.final_class_id === "string"
        ? result.final_class_id.trim()
        : "";
  const coreClassRaw =
    core?.final_class_id != null && String(core.final_class_id).trim() !== ""
      ? String(core.final_class_id).trim()
      : "";
  const effectiveFinalClassId = orchestratorFinalRaw !== "" ? orchestratorFinalRaw : coreClassRaw;
  const finalClass = effectiveFinalClassId !== "" ? effectiveFinalClassId : undefined;
  const semanticRuleContradiction = Boolean(
    semanticRuleCheckPayload &&
      semanticRuleCheckPayload.consistent === false &&
      semanticRuleCheckPayload.skipped !== true,
  );
  const semanticAboveThreshold = Boolean(
    semanticPayload &&
      semanticPayload.below_threshold === false &&
      typeof semanticPayload.similarity === "number" &&
      typeof semanticPayload.similarity_threshold === "number" &&
      semanticPayload.similarity > semanticPayload.similarity_threshold,
  );
  const semanticCandidateNoClass = semanticAboveThreshold && (finalClass == null || finalClass === "");
  const semanticInspectorActionHint = useMemo(() => {
    if (semanticRuleContradiction || semanticCandidateNoClass) {
      return "Проверьте извлечённые признаки и при необходимости скорректируйте их вручную.";
    }
    if (semanticAboveThreshold && !semanticRuleContradiction && finalClass) {
      return "Проверьте назначенный класс и показатели стоимости; при несоответствии скорректируйте признаки и перепроверьте декларацию.";
    }
    return "Проверьте извлечённые признаки и выполните перепроверку при необходимости.";
  }, [semanticRuleContradiction, semanticCandidateNoClass, semanticAboveThreshold, finalClass]);
  const semanticNoClassReasonRu =
    typeof semanticRuleCheckPayload?.message_ru === "string" && semanticRuleCheckPayload.message_ru.trim()
      ? humanizeSemanticRuleMessage(semanticRuleCheckPayload.message_ru.trim())
      : "Семантический кандидат найден (схожесть выше порога), но итоговый класс не назначен: извлечённые значения противоречат правилу справочника для класса-кандидата.";
  const llmSuggestedClassNameRaw =
    llmNamingPayload && llmNamingPayload.suggested_class_name != null
      ? String(llmNamingPayload.suggested_class_name).trim()
      : "";
  const hasMeaningfulLlmClassSuggestion = Boolean(
    llmSuggestedClassNameRaw &&
      !["CLASS", "GENERATION_FAILED", "-", "—", "N/A", "UNKNOWN"].includes(llmSuggestedClassNameRaw.toUpperCase()),
  );
  const featureSpacePoints = useMemo(() => {
    const raw = semanticPayload?.feature_space_points;
    if (!Array.isArray(raw)) return [] as FeatureSpacePoint[];
    return raw
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
  }, [semanticPayload]);
  const featureSpaceProjectionRu = useMemo(
    () => describeFeatureSpaceProjectionRu(semanticPayload?.feature_space_projection),
    [semanticPayload?.feature_space_projection],
  );
  const featureSpaceProjectionRuShort = useMemo(
    () => describeFeatureSpaceProjectionRuShort(semanticPayload?.feature_space_projection),
    [semanticPayload?.feature_space_projection],
  );
  const knnActivePointKeys = useMemo(() => {
    const neighbors = semanticPayload?.knn_neighbors;
    if (!Array.isArray(neighbors)) return new Set<string>();
    const keys = new Set<string>();
    for (const n of neighbors) {
      if (!n || typeof n !== "object") continue;
      const row = n as Record<string, unknown>;
      const wRaw = row.weight;
      const w = typeof wRaw === "number" ? wRaw : Number(wRaw ?? NaN);
      if (!Number.isFinite(w) || w <= 0) continue;
      const classId = String(row.class_id ?? "").trim();
      const text = String(row.description_text ?? "").trim();
      const simRaw = row.similarity;
      const sim = typeof simRaw === "number" ? simRaw : Number(simRaw ?? NaN);
      const simKey = Number.isFinite(sim) ? sim.toFixed(6) : "nan";
      keys.add(`${classId}|${text}|${simKey}`);
    }
    return keys;
  }, [semanticPayload]);
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
  const featureSpaceLegendItems = useMemo(
    () => [...featureSpaceClassColorMap.entries()].slice(0, 16),
    [featureSpaceClassColorMap],
  );
  const featureSpaceGridTicks = useMemo(() => [0, 1, 2, 3, 4, 5], []);
  const semanticRuleMessageRaw =
    typeof semanticRuleCheckPayload?.message_ru === "string" ? semanticRuleCheckPayload.message_ru.trim() : "";
  const semanticRuleMessageUi = semanticRuleMessageRaw
    ? humanizeSemanticRuleMessage(semanticRuleMessageRaw)
    : "Семантический кандидат отклонён: извлечённые значения противоречат правилам классификации справочника для этого класса.";
  const errorsRuRaw = Array.isArray(det?.errors_ru) ? (det.errors_ru as string[]) : [];
  const errorsRu = errorsRuRaw
    .map((line) => (typeof line === "string" ? humanizeSemanticRuleMessage(line) : String(line)))
    .filter((line) => line.trim().length > 0)
    .filter((line) => line.trim() !== semanticRuleMessageUi.trim());
  const classNoteRu =
    semanticCandidateNoClass && !semanticRuleContradiction
      ? semanticNoClassReasonRu
      : semanticRuleContradiction || (finalClass != null && finalClass !== "")
        ? ""
      : typeof det?.class_note_ru === "string" && det.class_note_ru.trim()
        ? det.class_note_ru.trim()
        : "";
  const candidateClassIds = Array.isArray(det?.candidate_class_ids)
    ? (det.candidate_class_ids as unknown[])
        .map((x) => String(x ?? "").trim())
        .filter((x) => x.length > 0)
    : [];
  const classTitleForUi = catalogTitleForClassId(core?.catalog_classification_classes, finalClass ?? null);
  const classKpiDisplay = formatClassColumnDisplay(classTitleForUi ?? finalClass ?? "", candidateClassIds);
  const semanticManualClassOptions = useMemo(() => {
    const set = new Set<string>();
    if (Array.isArray(core?.catalog_classification_classes)) {
      for (const row of core.catalog_classification_classes) {
        if (!row || typeof row !== "object") continue;
        const cid = String((row as Record<string, unknown>).class_id ?? "").trim();
        if (cid) set.add(cid);
      }
    }
    for (const cid of candidateClassIds) {
      const v = String(cid ?? "").trim();
      if (v) set.add(v);
    }
    if (finalClass && finalClass.trim()) set.add(finalClass.trim());
    return [...set].sort((a, b) => a.localeCompare(b, "ru"));
  }, [candidateClassIds, core?.catalog_classification_classes, finalClass]);
  const manualClassIsListed = semanticManualClassOptions.includes(manualApprovalClass.trim());
  const manualClassSelectValue = manualClassIsListed
    ? manualApprovalClass.trim()
    : manualApprovalClass.trim()
      ? "__custom__"
      : "";
  const classificationReview =
    (det?.classification_expert_review as { kind?: string; error_ru?: string } | undefined) ??
    (det?.exactly_one_conflict as { kind?: string; error_ru?: string } | undefined);
  const exactlyOneConflictMessage =
    typeof classificationReview?.error_ru === "string" && classificationReview.error_ru.trim()
      ? classificationReview.error_ru.trim()
      : typeof det?.exactly_one_conflict?.error_ru === "string" && det.exactly_one_conflict.error_ru.trim()
        ? det.exactly_one_conflict.error_ru.trim()
        : "";
  const reviewNeedsExpert = Boolean(det?.requires_expert_review) && Boolean(classificationReview);
  const hasKpiTiles = Boolean(
    det ||
      catalog?.name ||
      classKpiDisplay !== "" ||
      (det?.matched_classification_rule_title != null && String(det.matched_classification_rule_title).trim() !== "") ||
      catalog?.tn_ved_group_code != null ||
      catalog?.rule_id != null,
  );
  const hasStructured = Boolean(
    result &&
      (result.status ||
        catalog ||
        det ||
        classKpiDisplay !== "" ||
        hasKpiTiles),
  );
  const severeUnderpricing = Boolean(
    pricePayload &&
      typeof pricePayload.deviation_pct === "number" &&
      Number.isFinite(pricePayload.deviation_pct) &&
      pricePayload.deviation_pct <= -50,
  );
  const priceBelowClassAverage = Boolean(
    pricePayload &&
      (
        (typeof pricePayload.declared_price === "number" &&
          Number.isFinite(pricePayload.declared_price) &&
          typeof pricePayload.expected_average_price === "number" &&
          Number.isFinite(pricePayload.expected_average_price) &&
          pricePayload.declared_price < pricePayload.expected_average_price) ||
        (typeof pricePayload.deviation_abs === "number" &&
          Number.isFinite(pricePayload.deviation_abs) &&
          pricePayload.deviation_abs < 0)
      ),
  );
  const autoClassAssigned = Boolean(finalClass && !semanticRuleContradiction && !semanticCandidateNoClass);
  const hasPriceIssue = priceBelowClassAverage;
  const effectiveDecisionClass = manualApprovalClass.trim() || (finalClass ?? "");
  const requiresManualClassBecauseRuleFailed = semanticRuleContradiction;
  const canApproveDeclaration = requiresManualClassBecauseRuleFailed
    ? manualApprovalClass.trim().length > 0
    : effectiveDecisionClass.trim().length > 0;
  const approveDisabledReason = !canApproveDeclaration
    ? requiresManualClassBecauseRuleFailed
      ? "При конфликте правил укажите класс вручную, затем подтверждайте декларацию."
      : "Подтвердить декларацию можно только если назначен класс."
    : "";
  const tnVedGroupDisplay = useMemo(() => {
    if (catalog?.tn_ved_group_code == null) return "";
    const raw = String(catalog.tn_ved_group_code).trim();
    if (!raw) return "";
    const ref = getTnVedGroup(raw);
    if (!ref) return raw;
    return `${ref.code} — ${ref.title}`;
  }, [catalog?.tn_ved_group_code]);
  const priceComparisonSummary = useMemo(() => {
    if (!pricePayload) return "";
    const avg = formatMoney(pricePayload.expected_average_price);
    const declared =
      typeof pricePayload.declared_price === "number"
        ? formatMoney(pricePayload.declared_price)
        : form.graph42.trim() || "—";
    const deviationAbs = formatMoney(pricePayload.deviation_abs);
    const deviationPct = formatPct(pricePayload.deviation_pct);
    const shouldReject =
      typeof pricePayload.deviation_pct === "number" &&
      Number.isFinite(pricePayload.deviation_pct) &&
      pricePayload.deviation_pct <= -50;
    return `Сравнение стоимости: средняя ${avg} руб., заявленная ${declared} руб., отклонение ${deviationAbs} руб. (${deviationPct}).${
      shouldReject ? " Критическое занижение стоимости более чем на 50%: декларацию следует отклонить." : ""
    }`;
  }, [pricePayload, form.graph42]);

  const feBlock = core?.feature_extraction as Record<string, unknown> | undefined;
  const parsedFeaturesRaw = feBlock?.parsed;
  const parsedFeatures: Record<string, unknown> =
    parsedFeaturesRaw != null && typeof parsedFeaturesRaw === "object" && !Array.isArray(parsedFeaturesRaw)
      ? (parsedFeaturesRaw as Record<string, unknown>)
      : {};
  const extractedSummaryRu =
    typeof feBlock?.extracted_document_ru === "string" && String(feBlock.extracted_document_ru).trim()
      ? String(feBlock.extracted_document_ru).trim()
      : "";
  const featureExtractionStatus = typeof feBlock?.status === "string" ? feBlock.status : "";
  const hasExtractedFeatures = hasAnyMeaningfulExtractedFeature(parsedFeatures);
  const requiresExtractionAssessment = !hasExtractedFeatures;
  const extractionAssessmentPending = requiresExtractionAssessment && extractionAssessment == null;
  const extractionDebug = feBlock?.extraction_debug as
    | { summary_lines_ru?: unknown; parse?: Record<string, unknown> }
    | undefined;
  const extractionDebugLines: string[] = Array.isArray(extractionDebug?.summary_lines_ru)
    ? extractionDebug.summary_lines_ru.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    : [];

  useEffect(() => {
    if (!result || busy) return;
    if (featureExtractionStatus !== "ok") return;
    if (hasExtractedFeatures) return;
    setFeatureDebugOpen(true);
  }, [result, busy, featureExtractionStatus, hasExtractedFeatures]);

  async function onOfficerDecision(decision: "approved" | "rejected" | "expert_review", rejectReason?: string) {
    if (extractionAssessmentPending) {
      setError(
        "Сначала подтвердите результат извлечения: декларация содержит ожидаемые характеристики или таких характеристик в тексте нет.",
      );
      return;
    }
    if (decision === "approved" && !canApproveDeclaration) {
      setError(approveDisabledReason || "Недостаточно данных для подтверждения декларации.");
      return;
    }
    setDecisionBusy(true);
    setError(null);
    setOfficerFinalDecision(decision);
    try {
      const extractedFeatureLinesRu = flattenExtractedFeaturesRu(parsedFeatures);
      const extractedFeatureSummaryRu =
        extractedSummaryRu ||
        (extractedFeatureLinesRu.length > 0 ? extractedFeatureLinesRu.join("; ") : "Признаки не извлечены автоматически.");
      const declId =
        (typeof core?.declaration_id === "string" && core.declaration_id.trim()) ||
        declarationSessionRef.current ||
        `OFFICER-${Date.now()}`;
      const ruleRaw = core?.catalog && typeof core.catalog === "object" ? (core.catalog as Record<string, unknown>).rule_id : null;
      const ruleId = ruleRaw != null && String(ruleRaw).trim() ? String(ruleRaw).trim() : undefined;
      const manualClassAssignedByOfficer = Boolean(manualApprovalClass.trim());
      const mustGoToExpertReview =
        semanticRuleContradiction || semanticCandidateNoClass || !finalClass || manualClassAssignedByOfficer;
      const autoClassificationFailed = semanticRuleContradiction || semanticCandidateNoClass || !finalClass;
      const autoClassificationFailureReason = semanticRuleContradiction
        ? "Семантический кандидат не прошёл проверку правил классификации."
        : semanticCandidateNoClass
          ? "Семантический поиск не дал назначенного класса."
          : !finalClass
            ? "Правило-ориентированная классификация не назначила класс."
            : "";
      const created = await createExpertDecision({
        category: "officer_final_decision",
        declaration_id: declId,
        rule_id: ruleId,
        summary_ru:
          decision === "approved"
            ? `Инспектор признал декларацию корректной (${declId})`
            : decision === "rejected"
              ? `Инспектор отклонил декларацию (${declId})`
              : `Инспектор отправил декларацию в экспертизу (${declId})`,
        payload: {
          source: "officer_validation",
          officer_input: {
            graph31: form.graph31.trim(),
            graph33: form.graph33.trim(),
            graph42: Number(form.graph42),
          },
          llm_result: {
            prompt_includes: {
              tnved_code: form.graph33.trim(),
              declared_price: Number(form.graph42),
              description_excerpt: form.graph31.trim().slice(0, 1200),
            },
          },
          declared_price: Number(form.graph42),
          parsed_features: parsedFeatures,
          extracted_features_lines_ru: extractedFeatureLinesRu,
          extracted_features_summary_ru: extractedFeatureSummaryRu,
          reason_ru: decision === "rejected" ? rejectReason?.trim() || null : null,
          final_decision: decision,
          final_decision_class: effectiveDecisionClass || null,
          requires_expert_validation: mustGoToExpertReview,
          extraction_assessment_required: requiresExtractionAssessment,
          extraction_assessment: extractionAssessment,
          auto_classification_status: autoClassificationFailed ? "failed" : "ok",
          auto_classification_failure_reason_ru: autoClassificationFailureReason || null,
          auto_class_before_decision: finalClass ?? null,
          manual_class_assigned_by_officer: manualClassAssignedByOfficer ? manualApprovalClass.trim() : null,
          semantic_rule_contradiction: semanticRuleContradiction,
          semantic_candidate_no_class: semanticCandidateNoClass,
        },
      });
      await patchExpertDecision(created.id, {
        status: decision === "approved" ? "resolved" : decision === "rejected" ? "dismissed" : "pending",
        resolution:
          decision === "approved"
            ? { chosen_class_id: effectiveDecisionClass || null, source: "officer_final_decision" }
            : { source: "officer_final_decision", ...(decision === "rejected" && rejectReason?.trim() ? { note: rejectReason.trim() } : {}) },
      });
      if (autoClassificationFailed || manualClassAssignedByOfficer) {
        const reviewReasonRu = autoClassificationFailed
          ? autoClassificationFailureReason || "Автоклассификация не сработала."
          : "Класс для декларации задан инспектором вручную и требует проверки экспертом.";
        await createExpertDecision({
          category: "auto_classification_review",
          declaration_id: declId,
          rule_id: ruleId,
          summary_ru: autoClassificationFailed
            ? `Требуется экспертная валидация автоклассификации (${declId})`
            : `Требуется экспертная проверка ручного выбора класса (${declId})`,
          payload: {
            source: "officer_validation",
            officer_input: {
              graph31: form.graph31.trim(),
              graph33: form.graph33.trim(),
              graph42: Number(form.graph42),
            },
            llm_result: {
              prompt_includes: {
                tnved_code: form.graph33.trim(),
                declared_price: Number(form.graph42),
                description_excerpt: form.graph31.trim().slice(0, 1200),
              },
            },
            declared_price: Number(form.graph42),
            parsed_features: parsedFeatures,
            extracted_features_lines_ru: extractedFeatureLinesRu,
            extracted_features_summary_ru: extractedFeatureSummaryRu,
            linked_officer_final_decision_id: created.id,
            auto_classification_status: autoClassificationFailed ? "failed" : "ok",
            auto_classification_failure_reason_ru: reviewReasonRu,
            extraction_assessment_required: requiresExtractionAssessment,
            extraction_assessment: extractionAssessment,
            reason_ru: decision === "rejected" ? rejectReason?.trim() || null : null,
            final_decision: decision,
            final_decision_class: effectiveDecisionClass || null,
            manual_class_assigned_by_officer: manualClassAssignedByOfficer ? manualApprovalClass.trim() : null,
          },
        });
      }
      setDecisionResetMessage(
        decision === "approved"
          ? "Декларация принята."
          : decision === "rejected"
            ? "Декларация отклонена."
            : "Декларация отправлена в экспертизу.",
      );
      setDecisionResetSecondsLeft(5);
    } catch (e: any) {
      setError(e?.message ?? "Не удалось зафиксировать решение инспектора.");
    } finally {
      setDecisionBusy(false);
    }
  }
  const semanticRuleMessageUiWithActual = semanticMessageWithActualValues(
    semanticRuleMessageUi,
    semanticRuleCheckPayload as Record<string, unknown> | null | undefined,
    parsedFeatures,
  );
  const semanticCandidateClassId =
    semanticPayload && typeof semanticPayload.class_id === "string" && semanticPayload.class_id.trim()
      ? semanticPayload.class_id.trim()
      : "";
  const semanticNarrative = useMemo(() => {
    if (!semanticPayload) return "";
    const matched = Boolean(semanticPayload.matched);
    if (matched && semanticCandidateClassId) {
      return "Пороговые условия выполнены: найден устойчивый класс-кандидат по семантической близости.";
    }
    if (semanticCandidateClassId) {
      return "Найден класс-кандидат, но пороговые условия автопринятия не выполнены.";
    }
    return "Устойчивый класс-кандидат по семантической проверке не найден.";
  }, [semanticPayload, semanticCandidateClassId]);
  return (
    <div className="container officer-page">
      <header className="officer-hero">
        <h1 className="officer-hero__title">Инспектор</h1>
      </header>

      <section className="officer-card" aria-labelledby="officer-form-heading">
        <h2 id="officer-form-heading" className="officer-card__title">
          Данные декларации
        </h2>

        <div style={{ display: "grid", gap: "1.1rem" }}>
          <label style={{ display: "grid", gap: 6 }}>
            <span className="officer-section-label">Графа 31 · грузовые места и описание товаров</span>
            <span className="officer-section-hint">Полный текст описания для извлечения признаков моделью</span>
            <textarea
              className="officer-textarea"
              value={form.graph31}
              onChange={(e) => setField("graph31", e.target.value)}
              placeholder="Вставьте или введите текст из декларации…"
            />
          </label>

          <div style={{ display: "grid", gap: 6 }}>
            <span className="officer-section-label">Графа 33 · код товара (ТН ВЭД)</span>
            <TnVedEaeuPicker
              value={form.graph33}
              onChange={(code) => setField("graph33", code)}
              label={null}
              hideLabel
              disabled={busy}
              manualInputId="officer-graph33"
            />
          </div>

          <div>
            <span className="officer-section-label" style={{ marginBottom: 8 }}>
              Графы 35, 38, 42
            </span>
            <div className="officer-grid-nums">
              <label className="officer-field-num" style={{ display: "grid", gap: 6 }}>
                <span className="officer-section-label">35 · вес брутто, кг</span>
                <input
                  className="officer-input"
                  type="number"
                  min="0"
                  step="0.001"
                  value={form.graph35}
                  onChange={(e) => setField("graph35", e.target.value)}
                />
              </label>
              <label className="officer-field-num" style={{ display: "grid", gap: 6 }}>
                <span className="officer-section-label">38 · вес нетто, кг</span>
                <input
                  className="officer-input"
                  type="number"
                  min="0"
                  step="0.001"
                  value={form.graph38}
                  onChange={(e) => setField("graph38", e.target.value)}
                />
              </label>
              <label className="officer-field-num" style={{ display: "grid", gap: 6 }}>
                <span className="officer-section-label">42 · стоимость</span>
                <input
                  className="officer-input"
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.graph42}
                  onChange={(e) => setField("graph42", e.target.value)}
                />
              </label>
            </div>
          </div>
        </div>

        <div className="officer-actions">
          <button
            type="button"
            className="btn"
            style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
            disabled={!canSubmit || busy || decisionResetSecondsLeft != null}
            onClick={() => void onSubmit()}
          >
            {busy ? (
              <>
                <span className="fe-model-admin-spinner fe-model-admin-spinner--sm" />
                Выполняется проверка…
              </>
            ) : (
              "Запустить валидацию"
            )}
          </button>
          {busy ? (
            <button type="button" className="officer-btn-stop" onClick={onStop}>
              Стоп
            </button>
          ) : null}
          <button
            type="button"
            className="btn-secondary"
            disabled={busy}
            onClick={() => {
              setDecisionResetSecondsLeft(null);
              setDecisionResetMessage(null);
              resetOfficerFormForNextDeclaration();
            }}
          >
            Очистить форму
          </button>
        </div>
      </section>

      <section className="officer-card" aria-labelledby="officer-result-heading">
        <div
          className="officer-result-header"
          style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}
        >
          <h2 id="officer-result-heading" className="officer-card__title" style={{ margin: 0 }}>
            Результат
          </h2>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap", justifyContent: "flex-end" }}>
            {result ? (
              <span className={`officer-pill ${autoClassAssigned ? "officer-pill--ok" : "officer-pill--warn"}`}>
                {autoClassAssigned ? "Класс назначен автоматически" : "Класс не назначен автоматически"}
              </span>
            ) : null}
            {result && pricePayload ? (
              <span className={`officer-pill ${hasPriceIssue ? "officer-pill--warn" : "officer-pill--ok"}`}>
                {hasPriceIssue ? "Есть проблемы с ценой" : "Проблем с ценой нет"}
              </span>
            ) : null}
            {lastServerElapsedMs != null ? (
              <span style={{ fontSize: "0.875rem", color: "#334155" }}>обработана за {formatDurationRu(lastServerElapsedMs)}</span>
            ) : null}
          </div>
        </div>

        {error ? (
          <div className="officer-alert officer-alert--error" role="alert">
            <span aria-hidden>⚠</span>
            <span>{error}</span>
          </div>
        ) : null}

        {!error && !result && !busy ? (
          <p className="officer-result-empty">
            Заполните все поля и нажмите «Запустить валидацию» — здесь появится краткий итог и при необходимости
            технические данные ответа.
          </p>
        ) : null}

        {busy && result ? (
          <div className="officer-progress" role="status" aria-live="polite" style={{ marginBottom: "0.75rem" }}>
            <div className="officer-progress__header">
              <span className="officer-progress__timer" title="Время с момента отправки запроса">
                {formatDurationMs(elapsedMs)}
              </span>
            </div>
            <p className="officer-progress__hint" style={{ marginBottom: 4 }}>
              {busyStageUi.title}
            </p>
            <p style={{ margin: 0, fontSize: "0.8125rem", color: "#475569", lineHeight: 1.4 }}>{busyStageUi.detail}</p>
          </div>
        ) : null}

        {busy && !result ? (
          <div className="officer-progress" role="status" aria-live="polite">
            <div className="officer-progress__header">
              <span className="officer-progress__timer" title="Время с момента отправки запроса">
                {formatDurationMs(elapsedMs)}
              </span>
            </div>
            <p className="officer-progress__hint" style={{ marginBottom: 4 }}>
              {busyStageUi.title}
            </p>
            <p style={{ margin: 0, fontSize: "0.8125rem", color: "#475569", lineHeight: 1.4 }}>{busyStageUi.detail}</p>
          </div>
        ) : null}

        {result ? (
          <div style={{ display: "grid", gap: "1.15rem" }}>
            {hasStructured ? (
              <div>
                {classNoteRu ? (
                  <div
                    className={semanticCandidateNoClass ? "officer-alert officer-alert--warn" : "officer-alert officer-alert--info"}
                    role={semanticCandidateNoClass ? "alert" : "status"}
                  >
                    <span aria-hidden>{semanticCandidateNoClass ? "⚠" : "ℹ"}</span>
                    <span>{classNoteRu}</span>
                  </div>
                ) : null}
                {semanticRuleContradiction ? (
                  <div className="officer-alert officer-alert--error" role="alert">
                    <span aria-hidden>⚠</span>
                    <span>{semanticRuleMessageUiWithActual}</span>
                  </div>
                ) : null}
                {errorsRu.length > 0 ? (
                  <div style={{ marginBottom: "0.85rem" }}>
                    <div className="officer-kpi__label" style={{ marginBottom: "0.35rem" }}>
                      Ошибки проверки по схеме (пояснение)
                    </div>
                    <ul className="officer-errors-ru">
                      {errorsRu.map((line, i) => (
                        <li key={i}>{line}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {priceComparisonSummary ? (
                  <div
                    className={severeUnderpricing ? "officer-alert officer-alert--error" : "officer-alert officer-alert--info"}
                    role={severeUnderpricing ? "alert" : "status"}
                    style={{ marginBottom: "0.85rem" }}
                  >
                    <span aria-hidden>{severeUnderpricing ? "⚠" : "ℹ"}</span>
                    <span>{priceComparisonSummary}</span>
                  </div>
                ) : null}
                {reviewNeedsExpert ? (
                  <div className="officer-alert officer-alert--warn" role="alert" style={{ marginBottom: "0.85rem" }}>
                    <span aria-hidden>⚠</span>
                    <span>
                      {exactlyOneConflictMessage ||
                        "Требуется экспертное решение по классификации — см. раздел «Очередь решений» у эксперта."}
                    </span>
                  </div>
                ) : null}
                {classificationReview?.kind === "none_match" ? (
                  <div style={{ marginBottom: "0.85rem", fontSize: 14, color: "#92400e" }}>
                    Ни одно правило классификации не подошло. Запись уйдёт в «Очередь решений».
                  </div>
                ) : null}
                {hasKpiTiles ? (
                  <div className="officer-kpi-grid">
                    {catalog?.name != null && String(catalog.name).trim() ? (
                      <div className="officer-kpi">
                        <div className="officer-kpi__label">Справочник</div>
                        <div className="officer-kpi__value">{String(catalog.name)}</div>
                      </div>
                    ) : null}
                    {det ? (
                      <div className="officer-kpi">
                        <div className="officer-kpi__label">Класс</div>
                        <div
                          className={`officer-kpi__value ${
                            classKpiDisplay === "" ? "officer-kpi__value--empty" : ""
                          }`}
                        >
                          {classKpiDisplay !== "" ? classKpiDisplay : "не назначен"}
                        </div>
                      </div>
                    ) : classKpiDisplay !== "" ? (
                      <div className="officer-kpi">
                        <div className="officer-kpi__label">Класс</div>
                        <div className="officer-kpi__value">{classKpiDisplay}</div>
                      </div>
                    ) : null}
                    {det?.matched_classification_rule_title != null && String(det.matched_classification_rule_title).trim() ? (
                      <div className="officer-kpi" style={{ gridColumn: "1 / -1" }}>
                        <div className="officer-kpi__label">Правило классификации</div>
                        <div className="officer-kpi__value">{String(det.matched_classification_rule_title)}</div>
                      </div>
                    ) : null}
                    {catalog?.tn_ved_group_code != null ? (
                      <div className="officer-kpi">
                        <div className="officer-kpi__label">Группа ТН ВЭД</div>
                        <div className="officer-kpi__value">{tnVedGroupDisplay || String(catalog.tn_ved_group_code)}</div>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}

            <div
              className="officer-pipeline-fallback"
              style={{
                border: "1px solid #cbd5e1",
                borderRadius: 12,
                padding: "1rem 1.1rem",
                background: "linear-gradient(165deg, #f8fafc 0%, #f1f5f9 100%)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: "0.35rem" }}>
                <h3 style={{ margin: 0, fontSize: "0.95rem", fontWeight: 650, color: "#0f172a" }}>Извлечённые признаки</h3>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setFeatureDebugOpen((v) => !v)}
                  aria-label={featureDebugOpen ? "Скрыть служебные данные" : "Показать служебные данные"}
                  title={featureDebugOpen ? "Скрыть служебные данные" : "Показать служебные данные"}
                  style={{
                    width: 28,
                    height: 28,
                    minWidth: 28,
                    minHeight: 28,
                    maxWidth: 28,
                    maxHeight: 28,
                    flex: "0 0 28px",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: 0,
                    lineHeight: 0,
                    border: "none",
                    background: "transparent",
                    color: featureDebugOpen ? "#0f172a" : "#64748b",
                    cursor: busy ? "not-allowed" : "pointer",
                  }}
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                    aria-hidden="true"
                  >
                    <path
                      d="M10.325 4.317a1.724 1.724 0 0 1 3.35 0c.138.602.694 1.02 1.31.978a1.724 1.724 0 0 1 1.931 2.743 1.724 1.724 0 0 0 .39 2.012 1.724 1.724 0 0 1 0 2.9 1.724 1.724 0 0 0-.39 2.012 1.724 1.724 0 0 1-1.93 2.743 1.724 1.724 0 0 0-1.311.978 1.724 1.724 0 0 1-3.35 0 1.724 1.724 0 0 0-1.31-.978 1.724 1.724 0 0 1-1.931-2.743 1.724 1.724 0 0 0-.39-2.012 1.724 1.724 0 0 1 0-2.9 1.724 1.724 0 0 0 .39-2.012 1.724 1.724 0 0 1 1.93-2.743c.617.042 1.173-.376 1.311-.978Z"
                      stroke="currentColor"
                      strokeWidth="1.5"
                    />
                    <circle cx="12" cy="12" r="3.25" stroke="currentColor" strokeWidth="1.5" />
                  </svg>
                </button>
              </div>
              {!hasExtractedFeatures && featureExtractionStatus === "ok" && extractionDebug ? (
                <div
                  className="officer-alert officer-alert--warn"
                  role="status"
                  style={{ marginBottom: "0.75rem", fontSize: "0.84rem", lineHeight: 1.45 }}
                >
                  <div style={{ fontWeight: 650, marginBottom: 6, color: "#0f172a" }}>Отладка: модель не дала пригодных признаков</div>
                  {extractionDebugLines.length > 0 ? (
                    <ul style={{ margin: 0, paddingLeft: "1.15rem" }}>
                      {extractionDebugLines.map((line, i) => (
                        <li key={i} style={{ marginBottom: 4 }}>
                          {line}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p style={{ margin: 0 }}>См. сырой ответ модели по каждой попытке и промпт в JSON ниже (шестерёнка).</p>
                  )}
                  <p style={{ margin: "0.5rem 0 0", fontSize: "0.8rem", color: "#475569" }}>
                    В блоке «Служебные данные» — поля <code className="fe-font-mono">llm_request.attempt_results</code> (фрагмент{" "}
                    <code className="fe-font-mono">raw_response_excerpt</code> до 8000 символов на попытку), параметры генерации и{" "}
                    <code className="fe-font-mono">runtime_generation</code>.
                  </p>
                </div>
              ) : null}
              {Object.keys(parsedFeatures).length === 0 ? (
                <p style={{ margin: "0 0 0.75rem", fontSize: "0.8125rem", color: "#475569", lineHeight: 1.45 }}>
                  Модель не извлекла признаки автоматически. Проверьте данные и добавьте недостающие поля вручную перед повторной
                  проверкой.
                </p>
              ) : null}
              {featureExtractionStatus === "inspector_override" ? (
                <p style={{ margin: "0 0 0.75rem", fontSize: "0.8125rem", color: "#92400e", lineHeight: 1.45 }}>
                  Признаки заданы вручную после предыдущей корректировки.
                </p>
              ) : null}
              {!featuresEditMode ? (
                <>
                  <div
                    className="officer-summary"
                    style={{
                      whiteSpace: "pre-wrap",
                      fontSize: "0.875rem",
                      lineHeight: 1.5,
                      minHeight: "2.5rem",
                    }}
                  >
                    {extractedSummaryRu || (Object.keys(parsedFeatures).length === 0 ? "(нет данных)" : "")}
                  </div>
                  <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: 8 }}>
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={busy || !canSubmit}
                      onClick={() => {
                        setEditedFeatures(deepClone(parsedFeatures));
                        setFeaturesEditMode(true);
                        setCorrectionLogError(null);
                      }}
                    >
                      {Object.keys(parsedFeatures).length === 0 ? "Добавить признаки вручную" : "Откорректировать извлеченные характеристики"}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  {editedFeatures ? (
                    <ExtractedFeaturesEditor
                      value={editedFeatures}
                      disabled={busy}
                      onChange={(next) => setEditedFeatures(next)}
                    />
                  ) : null}
                  <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                    <button
                      type="button"
                      className="btn"
                      disabled={busy || !canSubmit || !editedFeatures}
                      onClick={() => {
                        if (!editedFeatures) return;
                        onApplyFeatureEdits(parsedFeatures, editedFeatures);
                      }}
                    >
                      Применить и перепроверить
                    </button>
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={busy}
                      onClick={() => {
                        setFeaturesEditMode(false);
                        setEditedFeatures(null);
                        setCorrectionLogError(null);
                      }}
                    >
                      Отмена
                    </button>
                  </div>
                  {correctionLogError ? (
                    <p style={{ margin: "0.65rem 0 0", fontSize: "0.8125rem", color: "#b91c1c" }}>{correctionLogError}</p>
                  ) : null}
                  {correctionLogOk ? (
                    <p style={{ margin: "0.65rem 0 0", fontSize: "0.8125rem", color: "#166534" }}>
                      Корректировка записана для эксперта.
                    </p>
                  ) : null}
                </>
              )}
              {featureDebugOpen ? (
                <div style={{ marginTop: 10 }}>
                  <pre
                    style={{
                      fontSize: 12,
                      overflow: "auto",
                      maxHeight: 320,
                      margin: 0,
                      padding: "8px 10px",
                      border: "1px solid #e2e8f0",
                      background: "#fff",
                      borderRadius: 6,
                    }}
                  >
                    {JSON.stringify(
                      {
                        parsed_features: parsedFeatures,
                        extraction_debug:
                          feBlock && typeof feBlock === "object"
                            ? (feBlock as Record<string, unknown>).extraction_debug ?? null
                            : null,
                        llm_request:
                          feBlock && typeof feBlock === "object"
                            ? (feBlock as Record<string, unknown>).llm_request ?? null
                            : null,
                        extraction_config:
                          feBlock && typeof feBlock === "object"
                            ? {
                                config_id: (feBlock as Record<string, unknown>).config_id ?? null,
                                config_name: (feBlock as Record<string, unknown>).config_name ?? null,
                                model: (feBlock as Record<string, unknown>).model ?? null,
                              }
                            : null,
                      },
                      null,
                      2,
                    )}
                  </pre>
                </div>
              ) : null}
            </div>

            {semanticPayload ? (
              <div
                className="officer-pipeline-fallback"
                style={{
                  border: "1px solid #fde68a",
                  borderRadius: 12,
                  padding: "1rem 1.1rem",
                  background: "linear-gradient(165deg, #fffbeb 0%, #fef3c7 100%)",
                }}
              >
                <h3 style={{ margin: "0 0 0.5rem", fontSize: "0.95rem", fontWeight: 650, color: "#78350f" }}>
                  Семантический поиск
                </h3>
                <p style={{ margin: "0 0 0.3rem", fontSize: "0.9rem", color: "#78350f", lineHeight: 1.3 }}>
                  Класс: <strong>{semanticCandidateClassId || "не определён"}</strong>
                </p>
                <p style={{ margin: "0 0 0.35rem", fontSize: "0.84rem", color: "#92400e", lineHeight: 1.3 }}>
                  Схожесть:{" "}
                  <strong>
                    {typeof semanticPayload.similarity === "number"
                      ? semanticPayload.similarity.toFixed(4)
                      : String(semanticPayload.similarity ?? "—")}
                  </strong>
                  {" · k="}
                  <strong>{typeof semanticPayload.knn_k === "number" ? semanticPayload.knn_k : semanticK}</strong>
                </p>
                <p style={{ margin: 0, fontSize: "0.84rem", color: "#451a03", lineHeight: 1.3 }}>
                  {semanticNarrative} {semanticInspectorActionHint}
                </p>
                {featureSpacePoints.length > 0 ? (
                  <div style={{ marginTop: 10 }}>
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => {
                        setFeatureSpaceZoom(1);
                        setFeatureSpacePan({ x: 0, y: 0 });
                        setFeatureSpaceHovered(null);
                        setFeatureSpaceOpen(true);
                      }}
                    >
                      Навигация в пространстве признаков
                    </button>
                    {featureSpaceProjectionRuShort ? (
                      <p style={{ margin: "6px 0 0", fontSize: "0.78rem", color: "#78716c", lineHeight: 1.35 }}>
                        {featureSpaceProjectionRuShort}
                      </p>
                    ) : null}
                  </div>
                ) : null}
                {/* Убрали техподробности (service_mode/model/note_ru) как нерелевантные для инспектора. */}
              </div>
            ) : null}

            {llmNamingPayload && hasMeaningfulLlmClassSuggestion ? (
              <div
                className="officer-pipeline-fallback"
                style={{
                  border: "1px solid #c4b5fd",
                  borderRadius: 12,
                  padding: "1rem 1.1rem",
                  background: "linear-gradient(165deg, #f5f3ff 0%, #ede9fe 100%)",
                }}
              >
                <h3 style={{ margin: "0 0 0.5rem", fontSize: "0.95rem", fontWeight: 650, color: "#4c1d95" }}>
                  Предложенное имя класса
                </h3>
                <p style={{ margin: "0 0 0.5rem", fontSize: "0.875rem", color: "#5b21b6", lineHeight: 1.45 }}>
                  <code className="fe-font-mono" style={{ fontWeight: 700 }}>
                    {llmSuggestedClassNameRaw}
                  </code>
                </p>
                <p style={{ margin: 0, fontSize: "0.875rem", color: "#5b21b6", lineHeight: 1.45 }}>
                  Декларация отправлена на экспертную оценку.
                </p>
              </div>
            ) : null}
            {expertRoutingPayload ? (
              <div
                className="officer-pipeline-fallback"
                style={{
                  border: "1px solid #fdba74",
                  borderRadius: 12,
                  padding: "1rem 1.1rem",
                  background: "linear-gradient(165deg, #fff7ed 0%, #ffedd5 100%)",
                }}
              >
                <h3 style={{ margin: "0 0 0.5rem", fontSize: "0.95rem", fontWeight: 650, color: "#9a3412" }}>
                  Передано на экспертную оценку
                </h3>
                <p style={{ margin: 0, fontSize: "0.875rem", color: "#9a3412", lineHeight: 1.45 }}>
                  {typeof expertRoutingPayload.explanation_ru === "string" && expertRoutingPayload.explanation_ru.trim()
                    ? expertRoutingPayload.explanation_ru
                    : "Обнаружен конфликт правил классификации; декларация направлена эксперту."}
                </p>
              </div>
            ) : null}

            {pricePayload ? (
              <div className="officer-price-service" aria-labelledby="officer-price-heading">
                <div className="officer-price-service__top">
                  <div>
                    <h3 id="officer-price-heading" className="officer-price-service__title">
                      Согласование стоимости
                    </h3>
                  </div>
                  <span className={`officer-pill ${pricePayload.status === "price_mismatch" ? "officer-pill--warn" : "officer-pill--ok"}`}>
                    {pricePayload.status === "price_mismatch" ? "Отклонение" : "Норма"}
                  </span>
                </div>
                <div className="officer-price-service__row">
                  <span className="officer-price-service__k">Средняя</span>
                  <span className="officer-price-service__v fe-font-mono">{formatMoney(pricePayload.expected_average_price)}</span>
                </div>
                <div className="officer-price-service__row">
                  <span className="officer-price-service__k">Заявленная (гр. 42)</span>
                  <span className="officer-price-service__v fe-font-mono">
                    {typeof pricePayload.declared_price === "number"
                      ? formatMoney(pricePayload.declared_price)
                      : form.graph42.trim() || "—"}
                  </span>
                </div>
                <div className="officer-price-service__row">
                  <span className="officer-price-service__k">Отклонение</span>
                  <span className="officer-price-service__v fe-font-mono">
                    {formatMoney(pricePayload.deviation_abs)}{" "}
                    <span
                      style={{
                        color:
                          typeof pricePayload.deviation_pct === "number"
                            ? pricePayload.deviation_pct < 0
                              ? "#b91c1c"
                              : pricePayload.deviation_pct > 0
                                ? "#166534"
                                : "#0f172a"
                            : "#0f172a",
                        fontWeight: 700,
                      }}
                    >
                      ({formatPct(pricePayload.deviation_pct)})
                    </span>
                  </span>
                </div>
              </div>
            ) : null}

            <div
              style={{
                border: "1px solid #e2e8f0",
                borderRadius: 10,
                padding: "0.9rem 1rem",
                background: "#f8fafc",
                display: "grid",
                gap: 10,
              }}
            >
              <div style={{ fontSize: "0.875rem", color: "#334155", fontWeight: 600 }}>
                Итоговое решение инспектора по декларации
              </div>
              <div style={{ display: "grid", gap: 6 }}>
                <div style={{ fontSize: "0.8125rem", color: "#475569" }}>
                  Назначенный класс:{" "}
                  <strong>{finalClass && finalClass.trim() ? finalClass : "не назначен"}</strong>
                </div>
                {requiresExtractionAssessment ? (
                  <div
                    style={{
                      border: "1px solid #f59e0b",
                      background: "#fffbeb",
                      borderRadius: 8,
                      padding: "8px 10px",
                      display: "grid",
                      gap: 8,
                    }}
                  >
                    <div style={{ fontSize: "0.8125rem", color: "#92400e", fontWeight: 600 }}>
                      Модель не извлекла признаки. Перед финальным решением подтвердите оценку:
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                      <button
                        type="button"
                        className="btn-secondary"
                        disabled={busy || decisionBusy}
                        onClick={() => setExtractionAssessment("contains_expected")}
                        style={{
                          borderColor: extractionAssessment === "contains_expected" ? "#b45309" : "#f59e0b",
                          color: "#92400e",
                          background: extractionAssessment === "contains_expected" ? "#fde68a" : "#fff7ed",
                          fontWeight: 600,
                        }}
                      >
                        Декларация содержит характеристики, которые модель не извлекла
                      </button>
                      <button
                        type="button"
                        className="btn-secondary"
                        disabled={busy || decisionBusy}
                        onClick={() => setExtractionAssessment("no_expected")}
                        style={{
                          borderColor: extractionAssessment === "no_expected" ? "#166534" : "#86efac",
                          color: "#166534",
                          background: extractionAssessment === "no_expected" ? "#dcfce7" : "#f0fdf4",
                          fontWeight: 600,
                        }}
                      >
                        В тексте декларации нет характеристик для извлечения
                      </button>
                    </div>
                  </div>
                ) : null}
                {semanticRuleContradiction ? (
                  <label style={{ display: "grid", gap: 4 }}>
                    <span style={{ fontSize: "0.8125rem", color: "#b45309", fontWeight: 600 }}>
                      При конфликте правил укажите класс вручную перед подтверждением
                    </span>
                    <select
                      value={manualClassSelectValue}
                      disabled={busy || decisionBusy}
                      onChange={(e) => {
                        const next = e.target.value;
                        if (next === "__custom__" || next === "") {
                          setManualApprovalClass("");
                          return;
                        }
                        setManualApprovalClass(next);
                      }}
                      style={{ padding: "7px 9px", borderRadius: 8, border: "1px solid #cbd5e1", maxWidth: 420, background: "#fff" }}
                    >
                      <option value="">Выберите класс из списка</option>
                      {semanticManualClassOptions.map((cid) => (
                        <option key={cid} value={cid}>
                          {cid}
                        </option>
                      ))}
                      <option value="__custom__">Свой класс (ввести вручную)</option>
                    </select>
                    {manualClassSelectValue === "__custom__" ? (
                      <input
                        type="text"
                        value={manualApprovalClass}
                        disabled={busy || decisionBusy}
                        onChange={(e) => setManualApprovalClass(e.target.value)}
                        placeholder="Введите свой класс"
                        style={{ padding: "7px 9px", borderRadius: 8, border: "1px solid #cbd5e1", maxWidth: 420 }}
                      />
                    ) : null}
                  </label>
                ) : null}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                <button
                  type="button"
                  className="btn"
                  disabled={busy || decisionBusy || !canApproveDeclaration || extractionAssessmentPending || decisionResetSecondsLeft != null}
                  title={canApproveDeclaration ? "Подтвердить корректность декларации" : approveDisabledReason}
                  onClick={() => void onOfficerDecision("approved")}
                  style={{
                    background: "#16a34a",
                    borderColor: "#15803d",
                    color: "#fff",
                  }}
                >
                  Признать декларацию корректной
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={busy || decisionBusy || extractionAssessmentPending || decisionResetSecondsLeft != null}
                  onClick={() => {
                    setRejectReasonType("");
                    setRejectReasonCustom("");
                    setRejectReasonModalOpen(true);
                  }}
                  style={{
                    background: "#dc2626",
                    borderColor: "#b91c1c",
                    color: "#fff",
                  }}
                >
                  Отклонить декларацию
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={busy || decisionBusy || extractionAssessmentPending || decisionResetSecondsLeft != null}
                  onClick={() => void onOfficerDecision("expert_review")}
                  style={{
                    borderColor: "#f59e0b",
                    color: "#92400e",
                    background: "#fffbeb",
                  }}
                >
                  Отправить в экспертизу
                </button>
              </div>
              {officerFinalDecision ? (
                <div
                  style={{
                    fontSize: "0.8125rem",
                    color:
                      officerFinalDecision === "approved"
                        ? "#166534"
                        : officerFinalDecision === "rejected"
                          ? "#991b1b"
                          : "#92400e",
                  }}
                >
                  {officerFinalDecision === "approved"
                    ? "Декларация корректна."
                    : officerFinalDecision === "rejected"
                      ? "Декларация отклонена."
                      : "Декларация отправлена в экспертизу."}
                </div>
              ) : (
                <div style={{ fontSize: "0.8125rem", color: "#64748b" }}>
                  {extractionAssessmentPending
                    ? "Сначала подтвердите оценку отсутствия извлечённых признаков, затем выберите итоговое решение."
                    : canApproveDeclaration
                      ? "Выберите один из вариантов решения."
                      : approveDisabledReason || "Выберите один из вариантов решения."}
                </div>
              )}
              {decisionBusy ? (
                <div className="officer-progress" role="status" aria-live="polite" style={{ marginTop: 6 }}>
                  <div className="officer-progress__header">
                    <span className="officer-progress__timer" title="Время фиксации решения инспектора">
                      {formatDurationMs(decisionElapsedMs)}
                    </span>
                  </div>
                  <p className="officer-progress__hint" style={{ marginBottom: 0 }}>
                    Фиксируем решение инспектора...
                  </p>
                </div>
              ) : null}
            </div>

          </div>
        ) : null}
      </section>
      {decisionResetSecondsLeft != null && decisionResetMessage ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Подтверждение решения инспектора"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1350,
            background: "rgba(15, 23, 42, 0.35)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
        >
          <div className="card" style={{ width: "min(92vw, 520px)", padding: "16px 18px", background: "#fff" }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: "#0f172a", marginBottom: 6 }}>{decisionResetMessage}</div>
            <div style={{ fontSize: 14, color: "#475569" }}>
              Подготовка формы для новой декларации через{" "}
              <strong>{decisionResetSecondsLeft}</strong> сек.
            </div>
          </div>
        </div>
      ) : null}
      {rejectReasonModalOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Укажите причину отклонения декларации"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1360,
            background: "rgba(15, 23, 42, 0.35)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !decisionBusy) setRejectReasonModalOpen(false);
          }}
        >
          <div className="card" style={{ width: "min(92vw, 620px)", padding: "16px 18px", background: "#fff", display: "grid", gap: 10 }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: "#0f172a" }}>Укажите причину отклонения декларации</div>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, color: "#334155" }}>
              <input
                type="radio"
                name="reject-reason"
                checked={rejectReasonType === "unrealistic_features"}
                onChange={() => setRejectReasonType("unrealistic_features")}
                disabled={decisionBusy}
              />
              Нереалистичные характеристики товара
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, color: "#334155" }}>
              <input
                type="radio"
                name="reject-reason"
                checked={rejectReasonType === "underpriced"}
                onChange={() => setRejectReasonType("underpriced")}
                disabled={decisionBusy}
              />
              Заниженная стоимость
            </label>
            <label style={{ display: "grid", gap: 6, fontSize: 14, color: "#334155" }}>
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  type="radio"
                  name="reject-reason"
                  checked={rejectReasonType === "custom"}
                  onChange={() => setRejectReasonType("custom")}
                  disabled={decisionBusy}
                />
                Своя причина
              </span>
              {rejectReasonType === "custom" ? (
                <textarea
                  value={rejectReasonCustom}
                  disabled={decisionBusy}
                  onChange={(e) => setRejectReasonCustom(e.target.value)}
                  placeholder="Опишите причину отклонения"
                  rows={3}
                  style={{ width: "100%", resize: "vertical", minHeight: 72, border: "1px solid #cbd5e1", borderRadius: 6, padding: "8px 10px" }}
                />
              ) : null}
            </label>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
              <button type="button" className="btn-secondary" disabled={decisionBusy} onClick={() => setRejectReasonModalOpen(false)}>
                Отмена
              </button>
              <button
                type="button"
                className="btn"
                disabled={decisionBusy || !rejectReasonRu}
                onClick={() => {
                  if (!rejectReasonRu) return;
                  setRejectReasonModalOpen(false);
                  void onOfficerDecision("rejected", rejectReasonRu);
                }}
                style={{ background: "#dc2626", borderColor: "#b91c1c", color: "#fff" }}
              >
                Подтвердить отклонение
              </button>
            </div>
          </div>
        </div>
      ) : null}
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
          <div
            className="card"
            style={{ width: "min(95vw, 980px)", maxHeight: "90vh", overflow: "auto", padding: 14, background: "#fff" }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 8 }}>
              <h3 style={{ margin: 0, fontSize: 17, color: "#0f172a" }}>Пространство признаков (kNN)</h3>
              <ModalCloseButton onClick={() => setFeatureSpaceOpen(false)} />
            </div>
            <p style={{ margin: "0 0 10px", fontSize: 13, color: "#475569" }}>
              Синий маркер — текущий запрос инспектора. Цвета эталонных точек соответствуют присвоенным классам.
            </p>
            {featureSpaceProjectionRu ? (
              <p style={{ margin: "0 0 10px", fontSize: 12, color: "#64748b", lineHeight: 1.4 }}>{featureSpaceProjectionRu}</p>
            ) : null}
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
              <span style={{ fontSize: 13, fontWeight: 600, color: "#334155", marginLeft: 6 }}>k</span>
              <input
                type="number"
                min={1}
                max={25}
                step={1}
                value={semanticK}
                disabled={busy}
                onChange={(e) => {
                  const next = Number(e.target.value);
                  if (!Number.isFinite(next)) return;
                  setSemanticK(Math.max(1, Math.min(25, Math.floor(next))));
                }}
                style={{ width: 74, padding: "6px 8px", borderRadius: 8, border: "1px solid #cbd5e1" }}
              />
              <button
                type="button"
                className="btn-secondary"
                disabled={busy}
                onClick={() => {
                  setFeatureSpaceOpen(false);
                }}
              >
                Применить k
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
                  const x = 40 + (780 / 5) * t;
                  return <line key={`gx-${t}`} x1={x} y1={40} x2={x} y2={440} stroke="#e2e8f0" strokeDasharray="4 4" />;
                })}
                {featureSpaceGridTicks.map((t) => {
                  const y = 40 + (400 / 5) * t;
                  return <line key={`gy-${t}`} x1={40} y1={y} x2={820} y2={y} stroke="#e2e8f0" strokeDasharray="4 4" />;
                })}
                <line x1={40} y1={440} x2={820} y2={440} stroke="#cbd5e1" />
                <line x1={40} y1={40} x2={40} y2={440} stroke="#cbd5e1" />
                {featureSpacePoints.map((p, i) => {
                  const pt = projectFeatureSpacePoint(p);
                  const isQuery = p.kind === "query";
                  const classKey = String(p.class_id ?? "").trim();
                  const fill = isQuery ? "#2563eb" : featureSpaceClassColorMap.get(classKey) ?? "#f59e0b";
                  const stroke = isQuery ? "#1d4ed8" : "#78350f";
                  const simKey = Number.isFinite(Number(p.similarity)) ? Number(p.similarity).toFixed(6) : "nan";
                  const pointKey = `${classKey}|${String(p.text ?? "").trim()}|${simKey}`;
                  const isKnnActive = !isQuery && knnActivePointKeys.has(pointKey);
                  const pointLabel = isQuery ? "Текущая декларация" : isKnnActive ? classKey : "";
                  return (
                    <g key={`${p.kind}-${i}`}>
                      <circle
                        cx={pt.x}
                        cy={pt.y}
                        r={isQuery ? 6 : 4}
                        fill={fill}
                        stroke={stroke}
                        strokeWidth={1}
                        opacity={isQuery ? 0.95 : 0.78}
                        onMouseEnter={() => setFeatureSpaceHovered({ point: p, x: pt.x, y: pt.y })}
                        onMouseLeave={() => setFeatureSpaceHovered((prev) => (prev?.point === p ? null : prev))}
                      >
                        <title>{p.text}</title>
                      </circle>
                      {isKnnActive ? (
                        <circle
                          cx={pt.x}
                          cy={pt.y}
                          r={8}
                          fill="none"
                          stroke="#dc2626"
                          strokeWidth={1.5}
                          opacity={0.95}
                          pointerEvents="none"
                        />
                      ) : null}
                      {pointLabel ? (
                        <text
                          x={pt.x + (isQuery ? 8 : 6)}
                          y={pt.y - (isQuery ? 8 : 6)}
                          fontSize={11}
                          fontWeight={isQuery ? 700 : 500}
                          fill={isQuery ? "#1d4ed8" : "#334155"}
                          stroke="#f8fafc"
                          strokeWidth={2}
                          paintOrder="stroke"
                          pointerEvents="none"
                        >
                          {truncateMiddle(pointLabel, 26)}
                        </text>
                      ) : null}
                    </g>
                  );
                })}
                {featureSpaceHovered ? (
                  <foreignObject
                    x={Math.max(46, Math.min(520, featureSpaceHovered.x + 10))}
                    y={Math.max(46, Math.min(360, featureSpaceHovered.y - 14))}
                    width={300}
                    height={180}
                  >
                    <div
                      style={{
                        background: "rgba(255,255,255,0.96)",
                        border: "1px solid #cbd5e1",
                        borderRadius: 8,
                        padding: "7px 8px",
                        boxShadow: "0 8px 16px rgba(15, 23, 42, 0.12)",
                        fontSize: 12,
                        color: "#1f2937",
                        lineHeight: 1.35,
                        overflow: "hidden",
                        whiteSpace: "pre-wrap",
                      }}
                    >
                      <div style={{ fontWeight: 600, marginBottom: 4 }}>
                        {featureSpaceHovered.point.kind === "query"
                          ? "Текущая декларация"
                          : `Эталон ${featureSpaceHovered.point.class_id ?? ""}${
                              typeof featureSpaceHovered.point.similarity === "number" && Number.isFinite(featureSpaceHovered.point.similarity)
                                ? ` · ${featureSpaceHovered.point.similarity.toFixed(4)}`
                                : ""
                            }`}
                      </div>
                      <div>
                        {(featureSpaceHovered.point.text || "(пустое описание)").slice(0, 400)}
                      </div>
                    </div>
                  </foreignObject>
                ) : null}
              </svg>
            </div>
            <aside
              style={{
                width: 250,
                minWidth: 220,
                border: "1px solid #e2e8f0",
                borderRadius: 10,
                background: "#fff",
                padding: "8px 10px",
                overflow: "auto",
              }}
            >
              <div style={{ fontSize: 12, fontWeight: 700, color: "#334155", marginBottom: 8 }}>Легенда классов</div>
              <div style={{ display: "grid", gap: 6 }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "#334155" }}>
                  <span style={{ width: 10, height: 10, borderRadius: "50%", background: "#2563eb", border: "1px solid rgba(15,23,42,0.15)" }} />
                  Текущая декларация
                </span>
                {featureSpaceLegendItems.length > 0 ? (
                  featureSpaceLegendItems.map(([classId, color]) => (
                    <span key={classId} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "#334155" }}>
                      <span style={{ width: 10, height: 10, borderRadius: "50%", background: color, border: "1px solid rgba(15,23,42,0.15)" }} />
                      {classId}
                    </span>
                  ))
                ) : (
                  <div style={{ fontSize: 12, color: "#94a3b8" }}>Классы не определены.</div>
                )}
              </div>
            </aside>
            </div>
            <div style={{ marginTop: 8, fontSize: 12, color: "#64748b" }}>
              Наведите курсор на точку для отображения полного текста описания товара.
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
