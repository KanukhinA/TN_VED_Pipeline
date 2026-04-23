import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createExpertDecision,
  preflightOfficerValidation,
  validateDeclarationByOfficerWithProgress,
  type OfficerValidationProgressEvent,
} from "../api/client";
import { formatClassColumnDisplay } from "../utils/formatClassColumn";
import { deepEqualJson } from "../utils/deepEqualJson";
import { ExtractedFeaturesEditor, deepClone } from "../ui/ExtractedFeaturesEditor";
import TnVedEaeuPicker from "../ui/TnVedEaeuPicker";
import { ModalCloseButton } from "../ui/ModalCloseButton";

function formatDurationMs(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} с`;
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, "0")}`;
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

type FeatureSpacePoint = {
  kind: "query" | "reference";
  x: number;
  y: number;
  text: string;
  class_id?: string | null;
  similarity?: number;
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
  const [featureSpaceHovered, setFeatureSpaceHovered] = useState<FeatureSpacePoint | null>(null);

  useEffect(() => {
    if (!busy) return;
    const started = Date.now();
    setElapsedMs(0);
    const id = window.setInterval(() => setElapsedMs(Date.now() - started), 200);
    return () => window.clearInterval(id);
  }, [busy]);

  useEffect(() => {
    if (!result) return;
    setFeaturesEditMode(false);
    setEditedFeatures(null);
    setCorrectionLogError(null);
  }, [result]);

  function setField<K extends keyof OfficerForm>(key: K, value: OfficerForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  const canSubmit =
    form.graph31.trim().length > 0 &&
    form.graph33.trim().length > 0 &&
    form.graph35.trim().length > 0 &&
    form.graph38.trim().length > 0 &&
    form.graph42.trim().length > 0;
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
    declarationSessionRef.current = null;
    setCorrectionLogOk(false);
    setCorrectionLogError(null);
    setLastServerElapsedMs(null);
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
  const semanticPayload = result ? orchestratorStepFromResult(result, "semantic-search") : null;
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
  const semanticNoClassReasonRu =
    typeof semanticRuleCheckPayload?.message_ru === "string" && semanticRuleCheckPayload.message_ru.trim()
      ? semanticRuleCheckPayload.message_ru.trim()
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
  const errorsRu = Array.isArray(det?.errors_ru) ? (det.errors_ru as string[]) : [];
  const classNoteRu =
    semanticCandidateNoClass
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
  return (
    <div className="container officer-page">
      <header className="officer-hero">
        <h1 className="officer-hero__title">Инспектор</h1>
        <p className="officer-hero__sub">
          Введите данные по графам и запустите валидацию таможенной декларации
        </p>
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
            disabled={!canSubmit || busy}
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
              setForm(initialForm);
              setResult(null);
              setError(null);
              setLastServerElapsedMs(null);
              declarationSessionRef.current = null;
              setFeaturesEditMode(false);
              setEditedFeatures(null);
              setCorrectionLogError(null);
              setCorrectionLogOk(false);
            }}
          >
            Очистить форму
          </button>
        </div>
      </section>

      <section className="officer-card" aria-labelledby="officer-result-heading">
        <h2 id="officer-result-heading" className="officer-card__title">
          Результат
        </h2>

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
                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.5rem", marginBottom: "0.75rem" }}>
                  {typeof result?.status === "string" ? (
                    <span className={`officer-pill ${validationOk ? "officer-pill--ok" : "officer-pill--warn"}`}>
                      {result.status === "completed" ? "Готово" : result.status}
                    </span>
                  ) : null}
                  {det ? (
                    <span className={`officer-pill ${validationOk ? "officer-pill--ok" : "officer-pill--warn"}`}>
                      {validationOk ? "Валидация пройдена" : "Есть замечания"}
                    </span>
                  ) : null}
                </div>
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
                    <span>
                      {typeof semanticRuleCheckPayload?.message_ru === "string" &&
                      semanticRuleCheckPayload.message_ru.trim()
                        ? semanticRuleCheckPayload.message_ru.trim()
                        : "Семантический кандидат отклонён: извлечённые значения противоречат правилам классификации справочника для этого класса."}
                    </span>
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
                {reviewNeedsExpert ? (
                  <div className="officer-alert officer-alert--warn" role="alert" style={{ marginBottom: "0.85rem" }}>
                    <span aria-hidden>⚠</span>
                    <span>
                      {exactlyOneConflictMessage ||
                        "Требуется экспертное решение по классификации — см. раздел «Решение спорных ситуаций» у эксперта."}
                    </span>
                  </div>
                ) : null}
                {classificationReview?.kind === "none_match" ? (
                  <div style={{ marginBottom: "0.85rem", fontSize: 14, color: "#92400e" }}>
                    Ни одно правило классификации не подошло. Запись уйдёт в очередь «Решение спорных ситуаций».
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
                        <div className="officer-kpi__value">{String(catalog.tn_ved_group_code)}</div>
                      </div>
                    ) : null}
                    {catalog?.rule_id != null ? (
                      <div className="officer-kpi">
                        <div className="officer-kpi__label">ID справочника</div>
                        <div className="officer-kpi__value fe-font-mono" title={String(catalog.rule_id)}>
                          {truncateMiddle(String(catalog.rule_id), 40)}
                        </div>
                      </div>
                    ) : null}
                    {lastServerElapsedMs != null ? (
                      <div className="officer-kpi">
                        <div className="officer-kpi__label">Скорость обработки на сервере</div>
                        <div className="officer-kpi__value fe-font-mono">{formatDurationMs(lastServerElapsedMs)}</div>
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
              <h3 style={{ margin: "0 0 0.35rem", fontSize: "0.95rem", fontWeight: 650, color: "#0f172a" }}>
                Извлечённые признаки
              </h3>
              <p style={{ margin: "0 0 0.75rem", fontSize: "0.8125rem", color: "#475569", lineHeight: 1.45 }}>
                Краткая форма по результату модели. При необходимости откорректируйте значения в форме ниже.
              </p>
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
                      Откорректировать результат извлечения
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
              <details style={{ marginTop: 14 }} className="officer-details">
                <summary>Технический JSON признаков (для отладки)</summary>
                <pre style={{ fontSize: 12, overflow: "auto", maxHeight: 240 }}>{JSON.stringify(parsedFeatures, null, 2)}</pre>
              </details>
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
                  Семантический поиск и проверка порога
                </h3>
                <p style={{ margin: "0 0 0.5rem", fontSize: "0.875rem", color: "#92400e", lineHeight: 1.45 }}>
                  Схожесть:{" "}
                  <strong>
                    {typeof semanticPayload.similarity === "number"
                      ? semanticPayload.similarity.toFixed(4)
                      : String(semanticPayload.similarity ?? "—")}
                  </strong>
                  {" · "}
                  Порог:{" "}
                  <strong>
                    {typeof semanticPayload.similarity_threshold === "number"
                      ? semanticPayload.similarity_threshold.toFixed(4)
                      : String(semanticPayload.similarity_threshold ?? "—")}
                  </strong>
                </p>
                {typeof semanticPayload.explanation_ru === "string" && semanticPayload.explanation_ru.trim() ? (
                  <p style={{ margin: 0, fontSize: "0.875rem", color: "#451a03" }}>{semanticPayload.explanation_ru}</p>
                ) : null}
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
                  </div>
                ) : null}
                {(
                  (typeof semanticPayload.service_mode === "string" && semanticPayload.service_mode.trim()) ||
                  (typeof semanticPayload.note_ru === "string" && semanticPayload.note_ru.trim())
                ) ? (
                  <details style={{ marginTop: 10 }} className="officer-details">
                    <summary>Техподробности семантического шага</summary>
                    <div style={{ marginTop: 8, fontSize: "0.8125rem", color: "#92400e", lineHeight: 1.45 }}>
                      {typeof semanticPayload.service_mode === "string" && semanticPayload.service_mode.trim() ? (
                        <p style={{ margin: 0 }}>
                          <strong>Режим:</strong> {semanticPayload.service_mode}
                          {typeof semanticPayload.embedding_model === "string" && semanticPayload.embedding_model.trim()
                            ? ` · модель ${semanticPayload.embedding_model}`
                            : ""}
                          {typeof semanticPayload.n_reference_examples_used === "number" ? (
                            <>
                              {" "}
                              · эталонов: {semanticPayload.n_reference_examples_used}
                              {typeof semanticPayload.n_reference_examples_total === "number"
                                ? ` / ${semanticPayload.n_reference_examples_total}`
                                : ""}
                            </>
                          ) : null}
                        </p>
                      ) : null}
                      {typeof semanticPayload.note_ru === "string" && semanticPayload.note_ru.trim() ? (
                        <p style={{ margin: "0.4rem 0 0" }}>{semanticPayload.note_ru}</p>
                      ) : null}
                    </div>
                  </details>
                ) : null}
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
                            ? pricePayload.deviation_pct > 0
                              ? "#b91c1c"
                              : pricePayload.deviation_pct < 0
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
                <div className="officer-price-service__row">
                  <span className="officer-price-service__k">Объём</span>
                  <span className="officer-price-service__v fe-font-mono">
                    {typeof pricePayload.basis_mass_kg === "number" ? `${formatMoney(pricePayload.basis_mass_kg)} кг` : "—"}
                  </span>
                </div>
              </div>
            ) : null}

          </div>
        ) : null}
      </section>
      {featureSpaceOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Навигация в пространстве признаков кластеризации"
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
              <h3 style={{ margin: 0, fontSize: 17, color: "#0f172a" }}>Пространство признаков кластеризации</h3>
              <ModalCloseButton onClick={() => setFeatureSpaceOpen(false)} />
            </div>
            <p style={{ margin: "0 0 10px", fontSize: 13, color: "#475569" }}>
              Каждая точка — описание товара. Наведите курсор, чтобы увидеть текст ДТ. Синий маркер — текущий запрос инспектора.
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", marginBottom: 10 }}>
              <button type="button" className="btn-secondary" onClick={() => setFeatureSpaceZoom((z) => Math.max(0.6, z / 1.2))}>
                − Масштаб
              </button>
              <button type="button" className="btn-secondary" onClick={() => setFeatureSpaceZoom((z) => Math.min(4, z * 1.2))}>
                + Масштаб
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
            <div style={{ border: "1px solid #e2e8f0", borderRadius: 10, overflow: "hidden", background: "#f8fafc" }}>
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
                <line x1={40} y1={440} x2={820} y2={440} stroke="#cbd5e1" />
                <line x1={40} y1={40} x2={40} y2={440} stroke="#cbd5e1" />
                {featureSpacePoints.map((p, i) => {
                  const pt = projectFeatureSpacePoint(p);
                  const isQuery = p.kind === "query";
                  return (
                    <circle
                      key={`${p.kind}-${i}`}
                      cx={pt.x}
                      cy={pt.y}
                      r={isQuery ? 6 : 4}
                      fill={isQuery ? "#2563eb" : "#f59e0b"}
                      stroke={isQuery ? "#1d4ed8" : "#92400e"}
                      strokeWidth={1}
                      opacity={isQuery ? 0.95 : 0.78}
                      onMouseEnter={() => setFeatureSpaceHovered(p)}
                      onMouseLeave={() => setFeatureSpaceHovered((prev) => (prev === p ? null : prev))}
                    >
                      <title>{p.text}</title>
                    </circle>
                  );
                })}
              </svg>
            </div>
            <div
              style={{
                marginTop: 10,
                minHeight: 72,
                border: "1px solid #e2e8f0",
                borderRadius: 8,
                padding: "8px 10px",
                background: "#fff",
                fontSize: 13,
                color: "#334155",
                whiteSpace: "pre-wrap",
              }}
            >
              {featureSpaceHovered ? (
                <>
                  <div style={{ marginBottom: 4, fontWeight: 600, color: "#0f172a" }}>
                    {featureSpaceHovered.kind === "query" ? "Запрос инспектора" : `Эталон ${featureSpaceHovered.class_id ?? ""}`}
                  </div>
                  <div>{featureSpaceHovered.text || "(пустое описание)"}</div>
                </>
              ) : (
                "Наведите курсор на точку, чтобы увидеть текст описания ДТ."
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
