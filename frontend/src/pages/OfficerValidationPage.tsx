import React, { useState } from "react";
import { validateDeclarationByOfficer } from "../api/client";

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

export default function OfficerValidationPage() {
  const [form, setForm] = useState<OfficerForm>(initialForm);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  function setField<K extends keyof OfficerForm>(key: K, value: OfficerForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  const canSubmit =
    form.graph31.trim().length > 0 &&
    form.graph33.trim().length > 0 &&
    form.graph35.trim().length > 0 &&
    form.graph38.trim().length > 0 &&
    form.graph42.trim().length > 0;

  async function onSubmit() {
    if (!canSubmit || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const response = await validateDeclarationByOfficer({
        graph31: form.graph31.trim(),
        graph33: form.graph33.trim(),
        graph35: Number(form.graph35),
        graph38: Number(form.graph38),
        graph42: Number(form.graph42),
      });
      setResult(response);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  const core = result ? officerPayloadFromResult(result) : null;
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
  const hasKpiTiles = Boolean(
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
        <span className="officer-hero__badge">Проверка декларации</span>
        <h1 className="officer-hero__title">Инспектор</h1>
        <p className="officer-hero__sub">
          Введите данные по графам и запустите валидацию: извлечение признаков, проверка по справочнику и
          детерминированная классификация.
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

          <label style={{ display: "grid", gap: 6 }}>
            <span className="officer-section-label">Графа 33 · код товара (ТН ВЭД)</span>
            <input
              className="officer-input"
              type="text"
              value={form.graph33}
              onChange={(e) => setField("graph33", e.target.value)}
              placeholder="Например, 3105201000"
              inputMode="numeric"
            />
          </label>

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
          <button
            type="button"
            className="btn-secondary"
            disabled={busy}
            onClick={() => {
              setForm(initialForm);
              setResult(null);
              setError(null);
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

        {busy && !result ? (
          <p className="officer-result-empty" style={{ borderStyle: "solid", color: "#64748b" }}>
            <span className="fe-model-admin-spinner" style={{ marginRight: 10, verticalAlign: "middle" }} />
            Запрос выполняется — извлечение и проверка по справочнику могут занять до нескольких минут.
          </p>
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
                {hasKpiTiles ? (
                  <div className="officer-kpi-grid">
                    {catalog?.name != null && String(catalog.name).trim() ? (
                      <div className="officer-kpi">
                        <div className="officer-kpi__label">Справочник</div>
                        <div className="officer-kpi__value">{String(catalog.name)}</div>
                      </div>
                    ) : null}
                    {finalClass != null && String(finalClass).trim() ? (
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
