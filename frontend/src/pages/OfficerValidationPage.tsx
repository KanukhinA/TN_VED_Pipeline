import React, { useEffect, useRef, useState } from "react";
import { validateDeclarationByOfficer } from "../api/client";
import TnVedEaeuPicker from "../ui/TnVedEaeuPicker";

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

function priceStatusLabel(status: unknown): string {
  const s = typeof status === "string" ? status : "";
  if (s === "accepted_info_only") return "Принято к сведению";
  if (s === "ok") return "Проверка выполнена";
  return s || "Ответ получен";
}

function priceSourceLabel(source: unknown): string | null {
  if (source === "no_external_price_service") {
    return "Внешняя рыночная сверка не выполнялась";
  }
  if (source == null || source === "") return null;
  return String(source);
}

export default function OfficerValidationPage() {
  const [form, setForm] = useState<OfficerForm>(initialForm);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const [featuresDraft, setFeaturesDraft] = useState("");
  const [featuresDraftError, setFeaturesDraftError] = useState<string | null>(null);

  useEffect(() => {
    if (!busy) return;
    const started = Date.now();
    setElapsedMs(0);
    const id = window.setInterval(() => setElapsedMs(Date.now() - started), 200);
    return () => window.clearInterval(id);
  }, [busy]);

  useEffect(() => {
    if (!result) return;
    const payload = officerPayloadFromResult(result);
    const fe = payload?.feature_extraction;
    const raw = fe?.parsed;
    const parsed =
      raw != null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    setFeaturesDraft(JSON.stringify(parsed, null, 2));
    setFeaturesDraftError(null);
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

  function onStop() {
    abortRef.current?.abort();
  }

  async function runValidation(extracted_features_override?: Record<string, unknown>) {
    if (!canSubmit || busy) return;
    const ac = new AbortController();
    abortRef.current = ac;
    setBusy(true);
    setError(null);
    try {
      const response = await validateDeclarationByOfficer(
        {
          graph31: form.graph31.trim(),
          graph33: form.graph33.trim(),
          graph35: Number(form.graph35),
          graph38: Number(form.graph38),
          graph42: Number(form.graph42),
          ...(extracted_features_override != null ? { extracted_features_override } : {}),
        },
        { signal: ac.signal },
      );
      setResult(response);
    } catch (e: any) {
      if (isAbortError(e)) {
        setError("Запрос остановлен.");
      } else {
        setError(e?.message ?? String(e));
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  function onSubmit() {
    void runValidation();
  }

  function onRevalidateWithCorrectedFeatures() {
    if (!canSubmit || busy) return;
    let parsed: Record<string, unknown>;
    try {
      const t = featuresDraft.trim();
      if (!t) {
        setFeaturesDraftError("Введите JSON объекта с признаками.");
        return;
      }
      const raw = JSON.parse(t) as unknown;
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        setFeaturesDraftError("Нужен JSON-объект { … }, не массив.");
        return;
      }
      parsed = raw as Record<string, unknown>;
    } catch {
      setFeaturesDraftError("Некорректный JSON.");
      return;
    }
    setFeaturesDraftError(null);
    void runValidation(parsed);
  }

  const core = result ? officerPayloadFromResult(result) : null;
  const semanticPayload = result ? orchestratorStepFromResult(result, "semantic-search") : null;
  const llmNamingPayload = result ? orchestratorStepFromResult(result, "llm-class-name-suggestion") : null;
  const expertRoutingPayload = result ? orchestratorStepFromResult(result, "expert-review-routing") : null;
  const pricePayload = result ? priceValidatorPayloadFromResult(result) : null;
  const priceSourceFootnote = pricePayload ? priceSourceLabel(pricePayload.source) : null;

  const det = core?.deterministic;
  const catalog = core?.catalog;
  const validationOk = det?.validation_ok === true;
  const finalClass = core?.final_class_id ?? result?.final_class ?? result?.final_class_id;
  const summaryText =
    (typeof result?.summary_ru === "string" && result.summary_ru.trim()
      ? result.summary_ru
      : typeof core?.summary_ru === "string" && core.summary_ru.trim()
        ? core.summary_ru
        : "") || "";
  const errorsRu = Array.isArray(det?.errors_ru) ? (det.errors_ru as string[]) : [];
  const classNoteRu =
    typeof det?.class_note_ru === "string" && det.class_note_ru.trim() ? det.class_note_ru.trim() : "";
  const candidateClassIds = Array.isArray(det?.candidate_class_ids)
    ? (det.candidate_class_ids as unknown[])
        .map((x) => String(x ?? "").trim())
        .filter((x) => x.length > 0)
    : [];
  const exactlyOneConflictMessage =
    typeof det?.exactly_one_conflict?.error_ru === "string" && det.exactly_one_conflict.error_ru.trim()
      ? det.exactly_one_conflict.error_ru.trim()
      : "";
  const hasKpiTiles = Boolean(
    det ||
      catalog?.name ||
      (finalClass != null && String(finalClass).trim() !== "") ||
      (det?.matched_classification_rule_title != null && String(det.matched_classification_rule_title).trim() !== "") ||
      catalog?.tn_ved_group_code != null ||
      catalog?.rule_id != null,
  );
  const hasStructured = Boolean(
    result &&
      (result.status ||
        catalog ||
        det ||
        (finalClass != null && String(finalClass).trim() !== "") ||
        hasKpiTiles),
  );

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
              setFeaturesDraft("");
              setFeaturesDraftError(null);
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
            <p className="officer-progress__hint">Повторная проверка на сервере…</p>
          </div>
        ) : null}

        {busy && !result ? (
          <div className="officer-progress" role="status" aria-live="polite">
            <div className="officer-progress__header">
              <span className="officer-progress__timer" title="Время с момента отправки запроса">
                {formatDurationMs(elapsedMs)}
              </span>
            </div>
            <p className="officer-progress__hint">Запрос выполняется на сервере. Отображается фактическое время текущего запроса.</p>
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
                  <div className="officer-alert officer-alert--info" role="status">
                    <span aria-hidden>ℹ</span>
                    <span>{classNoteRu}</span>
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
                {candidateClassIds.length > 1 ? (
                  <div className="officer-alert officer-alert--warn" role="alert" style={{ marginBottom: "0.85rem" }}>
                    <span aria-hidden>⚠</span>
                    <span>
                      {exactlyOneConflictMessage || "Ошибка в справочнике: для стратегии exactly_one найдено несколько классов."}
                    </span>
                  </div>
                ) : null}
                {candidateClassIds.length > 1 ? (
                  <div style={{ marginBottom: "0.85rem" }}>
                    <div className="officer-kpi__label" style={{ marginBottom: "0.35rem" }}>
                      Подходящие классы (несколько совпадений)
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {candidateClassIds.map((cid) => (
                        <span key={cid} className="officer-pill officer-pill--warn">
                          {cid}
                        </span>
                      ))}
                    </div>
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
                            finalClass == null || String(finalClass).trim() === "" ? "officer-kpi__value--empty" : ""
                          }`}
                        >
                          {finalClass != null && String(finalClass).trim() !== "" ? String(finalClass) : "не назначен"}
                        </div>
                      </div>
                    ) : finalClass != null && String(finalClass).trim() ? (
                      <div className="officer-kpi">
                        <div className="officer-kpi__label">Класс</div>
                        <div className="officer-kpi__value">{String(finalClass)}</div>
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
                  </div>
                ) : null}
              </div>
            ) : null}

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
                  {" · "}
                  Ниже порога:{" "}
                  {semanticPayload.below_threshold === true ? "да" : semanticPayload.below_threshold === false ? "нет" : "—"}
                </p>
                {typeof semanticPayload.explanation_ru === "string" && semanticPayload.explanation_ru.trim() ? (
                  <p style={{ margin: 0, fontSize: "0.875rem", color: "#451a03" }}>{semanticPayload.explanation_ru}</p>
                ) : null}
                {typeof semanticPayload.service_mode === "string" && semanticPayload.service_mode.trim() ? (
                  <p style={{ margin: "0.5rem 0 0", fontSize: "0.875rem", color: "#78350f", lineHeight: 1.45 }}>
                    <strong>Режим семантики:</strong> {semanticPayload.service_mode}
                    {typeof semanticPayload.embedding_model === "string" && semanticPayload.embedding_model.trim()
                      ? ` · модель ${semanticPayload.embedding_model}`
                      : ""}
                    {typeof semanticPayload.n_reference_examples_used === "number" ? (
                      <>
                        {" "}
                        · эталонов с текстом (использовано): {semanticPayload.n_reference_examples_used}
                        {typeof semanticPayload.n_reference_examples_total === "number"
                          ? ` / ${semanticPayload.n_reference_examples_total}`
                          : ""}
                      </>
                    ) : null}
                  </p>
                ) : null}
                {typeof semanticPayload.note_ru === "string" && semanticPayload.note_ru.trim() ? (
                  <p style={{ margin: "0.35rem 0 0", fontSize: "0.8125rem", color: "#92400e", lineHeight: 1.45 }}>
                    {semanticPayload.note_ru}
                  </p>
                ) : null}
              </div>
            ) : null}

            {llmNamingPayload ? (
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
                    {String(llmNamingPayload.suggested_class_name ?? "—")}
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
                    <p className="officer-price-service__subtitle">
                      Запрос к сервису проверки заявленной стоимости (графа 42) выполнен; ниже ответ сервера.
                    </p>
                  </div>
                  <span className="officer-pill officer-pill--ok">Сервис ответил</span>
                </div>
                <div className="officer-price-service__endpoint" title="Маршрут сервиса в контуре оркестратора">
                  <span className="officer-price-service__method">POST</span>
                  <code className="officer-price-service__path">/api/v1/price/validate</code>
                  {typeof pricePayload.declaration_id === "string" && pricePayload.declaration_id.trim() ? (
                    <span className="officer-price-service__decl">· {pricePayload.declaration_id}</span>
                  ) : null}
                </div>
                <div className="officer-price-service__row">
                  <span className="officer-price-service__k">Статус обработки</span>
                  <span className="officer-price-service__v">{priceStatusLabel(pricePayload.status)}</span>
                </div>
                <div className="officer-price-service__row">
                  <span className="officer-price-service__k">Сумма в запросе (графа 42)</span>
                  <span className="officer-price-service__v fe-font-mono">
                    {typeof pricePayload.declared_price === "number"
                      ? String(pricePayload.declared_price)
                      : form.graph42.trim() || "—"}
                  </span>
                </div>
                {typeof pricePayload.status_ru === "string" && pricePayload.status_ru.trim() ? (
                  <div className="officer-price-service__body">{pricePayload.status_ru}</div>
                ) : null}
                {priceSourceFootnote ? (
                  <p className="officer-price-service__footnote">{priceSourceFootnote}</p>
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
                Корректировка извлечённых признаков
              </h3>
              <p style={{ margin: "0 0 0.75rem", fontSize: "0.8125rem", color: "#475569", lineHeight: 1.45 }}>
                Если модель ошиблась, отредактируйте JSON ниже и нажмите «Перепроверить с исправленными признаками» — повторный
                вызов модели извлечения не выполняется, классификация пересчитывается с вашими данными.
              </p>
              <label style={{ display: "grid", gap: 6 }}>
                <span className="officer-section-label">JSON признаков (как после парсинга ответа модели)</span>
                <textarea
                  className="officer-textarea fe-font-mono"
                  style={{ minHeight: 200, fontSize: 13 }}
                  value={featuresDraft}
                  onChange={(e) => {
                    setFeaturesDraft(e.target.value);
                    setFeaturesDraftError(null);
                  }}
                  disabled={busy}
                  spellCheck={false}
                  aria-invalid={featuresDraftError != null}
                />
              </label>
              {featuresDraftError ? (
                <p style={{ margin: "0.5rem 0 0", fontSize: "0.8125rem", color: "#b91c1c" }}>{featuresDraftError}</p>
              ) : null}
              <div style={{ marginTop: 10 }}>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={busy || !canSubmit}
                  onClick={() => void onRevalidateWithCorrectedFeatures()}
                >
                  Перепроверить с исправленными признаками
                </button>
              </div>
            </div>

            {summaryText ? (
              <div>
                <h3
                  style={{
                    margin: "0 0 0.6rem",
                    fontSize: "0.9375rem",
                    fontWeight: 650,
                    letterSpacing: "-0.02em",
                    color: "#0f172a",
                  }}
                >
                  Краткий итог
                </h3>
                <div className="officer-summary">{summaryText}</div>
              </div>
            ) : null}

            <details className="officer-details">
              <summary>Технические данные (JSON)</summary>
              <pre>{JSON.stringify(result, null, 2)}</pre>
            </details>
          </div>
        ) : null}
      </section>
    </div>
  );
}
