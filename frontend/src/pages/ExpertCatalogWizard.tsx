/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  archiveRule,
  cloneRule,
  deleteRule,
  getRule,
  listRules,
  saveRule,
  unarchiveRule,
  validateRule,
} from "../api/client";
import CatalogListSection from "../ui/CatalogListSection";
import TnVedGroupTreePicker from "../ui/TnVedGroupTreePicker";
import TnVedGroupSelect from "../ui/TnVedGroupSelect";
import { normalizeTnVedChapterMeta, normalizeTnVedEaeuCode, normalizeTnVedGroupCode } from "../catalog/tnVedCode";
import {
  classIdFromTnVedClassifierTitle,
  getTnVedClassifierTitleForCode,
  isTnVedGenericProchieTitle,
  shouldAutofillClassIdFromClassifier,
} from "../catalog/tnVedEaeuTree";
import {
  defaultExpertDraft,
  draftToDsl,
  generateSampleJson,
  loadDraftFromDslResponse,
  suggestModelId,
  type ExpertCatalogDraft,
  type ExpertClassConditionOp,
  type ExpertClassIndicatorBounds,
  type ExpertClassRule,
  type ExpertIndicator,
} from "../expert/expertDraft";

type Step = 1 | 2 | 3 | 4;

/** Встраивание в единый мастер «Создание справочника» (встроенный режим без отдельного заголовка экрана). */
export type ExpertCatalogIntegration = {
  segment: "all" | "structure" | "classification" | "finalize";
  draft: ExpertCatalogDraft;
  patchDraft: (p: Partial<ExpertCatalogDraft>) => void;
  compactChrome?: boolean;
  /** В едином мастере: группа ТН ВЭД задаётся на шаге 1 родителя */
  tnVedSelected?: boolean;
};

export type ExpertCatalogWizardProps = {
  /** В полном режиме: переход к конструктору; в unified не используется */
  onOpenAdvanced?: () => void;
  integration?: ExpertCatalogIntegration;
};

function updateIndicator(list: ExpertIndicator[], index: number, patch: Partial<ExpertIndicator>): ExpertIndicator[] {
  const next = list.slice();
  next[index] = { ...next[index], ...patch };
  return next;
}

function removeIndicator(list: ExpertIndicator[], index: number): ExpertIndicator[] {
  return list.filter((_, i) => i !== index);
}

function updateClassRule(list: ExpertClassRule[], index: number, patch: Partial<ExpertClassRule>): ExpertClassRule[] {
  const next = list.slice();
  next[index] = { ...next[index], ...patch };
  return next;
}

function removeClassRule(list: ExpertClassRule[], index: number): ExpertClassRule[] {
  return list.filter((_, i) => i !== index);
}

function groupClassRuleIndices(classRules: ExpertClassRule[]): { key: string; indices: number[] }[] {
  const order: string[] = [];
  const map = new Map<string, number[]>();
  classRules.forEach((r, i) => {
    const k = r.classId.trim().toLowerCase() || "__unset__";
    if (!map.has(k)) {
      order.push(k);
      map.set(k, []);
    }
    map.get(k)!.push(i);
  });
  return order.map((k) => ({ key: k, indices: map.get(k)! }));
}

function suggestNewExpertClassId(classRules: ExpertClassRule[]): string {
  for (let n = 1; n < 200; n++) {
    const id = `класс_${n}`;
    if (!classRules.some((r) => r.classId.trim().toLowerCase() === id)) return id;
  }
  return `класс_${Date.now()}`;
}

const CONDITION_OP_LABELS: Record<string, string> = {
  gte: "не меньше (≥)",
  lte: "не больше (≤)",
  gt: "строго больше",
  lt: "строго меньше",
  equals: "равно",
};

export default function ExpertCatalogWizard({ onOpenAdvanced, integration }: ExpertCatalogWizardProps) {
  const [internalDraft, setInternalDraft] = useState<ExpertCatalogDraft>(() => defaultExpertDraft());
  const draft = integration?.draft ?? internalDraft;
  const [step, setStep] = useState<Step>(1);
  const [ruleId, setRuleId] = useState<string | null>(null);
  const [dataJson, setDataJson] = useState("{}");
  const [validateResult, setValidateResult] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  const [catalogs, setCatalogs] = useState<any[]>([]);
  const [catalogQuery, setCatalogQuery] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [tnVedGroupCode, setTnVedGroupCode] = useState("");
  const [editingClassKey, setEditingClassKey] = useState<string | null>(null);

  const refreshCatalogs = useCallback(async () => {
    try {
      setCatalogs(
        await listRules({
          q: catalogQuery.trim() || undefined,
          include_archived: includeArchived,
        }),
      );
    } catch {
      setCatalogs([]);
    }
  }, [catalogQuery, includeArchived]);

  useEffect(() => {
    const t = window.setTimeout(() => void refreshCatalogs(), 200);
    return () => window.clearTimeout(t);
  }, [refreshCatalogs]);

  const canGoStep2 = useMemo(() => {
    if (!draft.catalogName.trim().length) return false;
    if (integration?.segment === "structure") return !!integration.tnVedSelected;
    if (integration) return true;
    return !!normalizeTnVedGroupCode(tnVedGroupCode);
  }, [draft.catalogName, integration, tnVedGroupCode]);
  const canGoStep3 = useMemo(
    () =>
      draft.mainSectionTitle.trim() &&
      draft.codeColumnTitle.trim() &&
      draft.valueColumnTitle.trim() &&
      draft.indicators.some((i) => i.id.trim()),
    [draft],
  );

  function patchDraft(p: Partial<ExpertCatalogDraft>) {
    if (integration?.patchDraft) integration.patchDraft(p);
    else setInternalDraft((prev) => ({ ...prev, ...p }));
  }

  useEffect(() => {
    if (!integration) return;
    if (integration.segment === "classification") setStep(3);
    else if (integration.segment === "finalize") setStep(4);
    else if (integration.segment === "structure") setStep(1);
  }, [integration?.segment]);

  async function handleSave() {
    if (!draft.indicators.some((i) => i.id.trim())) {
      window.alert("Добавьте в перечень хотя бы одно наименование показателя (шаг 2).");
      return;
    }
    for (const r of draft.classRules) {
      if (r.classId.trim() && !normalizeTnVedEaeuCode(r.tnVedGroupCode ?? "")) {
        window.alert(`Укажите код ТН ВЭД ЕАЭС для класса «${r.classId.trim()}».`);
        return;
      }
    }
    setBusy(true);
    try {
      const toSave = {
        ...draft,
        modelId: draft.modelId.trim() || suggestModelId(draft.catalogName),
      };
      const dsl = draftToDsl(toSave);
      const tn = normalizeTnVedGroupCode(tnVedGroupCode);
      if (!tn) {
        window.alert("Укажите главу ТН ВЭД (шаг 1): поле обязательно для сохранения.");
        setBusy(false);
        return;
      }
      dsl.meta = { ...(dsl.meta ?? {}), tn_ved_group_code: tn };
      const res = await saveRule(dsl, ruleId);
      setRuleId(res.rule_id);
      patchDraft({ modelId: dsl.model_id });
      setValidateResult(null);
      await refreshCatalogs();
    } catch (e: any) {
      window.alert(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleValidate() {
    if (!ruleId) {
      window.alert("Сначала сохраните справочник.");
      return;
    }
    setBusy(true);
    try {
      setValidateResult(await validateRule(ruleId, JSON.parse(dataJson)));
    } catch (e: any) {
      setValidateResult({ ok: false, errors: [{ message: e?.message ?? String(e) }] });
    } finally {
      setBusy(false);
    }
  }

  function fillSampleFromDraft() {
    const sample = generateSampleJson(draft);
    setDataJson(JSON.stringify(sample, null, 2));
  }

  async function openExpertCatalog(id: string, targetStep: Step = 1) {
    setBusy(true);
    try {
      const full = await getRule(id);
      const restored = loadDraftFromDslResponse(full);
      if (!restored) {
        window.alert(
          "Этот справочник создан в расширенном режиме. Откройте его там, чтобы править структуру.",
        );
        onOpenAdvanced();
        return;
      }
      if (full.model_id) restored.modelId = full.model_id;
      setInternalDraft(restored);
      const rawTn = full.dsl?.meta?.tn_ved_group_code;
      setTnVedGroupCode(
        rawTn != null && String(rawTn).trim() !== "" ? normalizeTnVedChapterMeta(String(rawTn)) ?? "" : "",
      );
      setRuleId(full.rule_id);
      setStep(targetStep);
      if (targetStep === 4) setDataJson(JSON.stringify(generateSampleJson(restored), null, 2));
      setValidateResult(null);
    } catch (e: any) {
      window.alert(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  async function openExpertValidate(id: string) {
    await openExpertCatalog(id, 4);
  }

  async function cloneExpert(id: string) {
    setBusy(true);
    try {
      const cloned = await cloneRule(id);
      const restored = loadDraftFromDslResponse({ dsl: cloned.dsl });
      if (restored) {
        restored.modelId = cloned.dsl?.model_id ?? "";
        setInternalDraft(restored);
        const rawTn = cloned.dsl?.meta?.tn_ved_group_code;
        setTnVedGroupCode(
          rawTn != null && String(rawTn).trim() !== "" ? normalizeTnVedChapterMeta(String(rawTn)) ?? "" : "",
        );
        setRuleId(String(cloned.rule_id));
        setStep(2);
      } else {
        window.alert("Клон сохранён. Для правки откройте расширенный режим.");
      }
      await refreshCatalogs();
    } catch (e: any) {
      window.alert(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  async function quickValidate(id: string) {
    setBusy(true);
    try {
      const full = await getRule(id);
      const restored = loadDraftFromDslResponse(full);
      const payload = restored ? generateSampleJson(restored) : { проверка: true };
      setValidateResult(await validateRule(id, payload));
    } catch (e: any) {
      setValidateResult({ ok: false, errors: [{ message: e?.message ?? String(e) }] });
    } finally {
      setBusy(false);
    }
  }

  async function onArchiveCatalog(id: string) {
    if (!window.confirm("Отправить справочник в архив? Он исчезнет из основного перечня.")) return;
    setBusy(true);
    try {
      await archiveRule(id);
      if (ruleId === id) setRuleId(null);
      await refreshCatalogs();
    } catch (e: any) {
      window.alert(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onUnarchiveCatalog(id: string) {
    setBusy(true);
    try {
      await unarchiveRule(id);
      await refreshCatalogs();
    } catch (e: any) {
      window.alert(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onDeleteCatalog(id: string) {
    if (!window.confirm("Удалить справочник безвозвратно?")) return;
    setBusy(true);
    try {
      await deleteRule(id);
      if (ruleId === id) setRuleId(null);
      await refreshCatalogs();
    } catch (e: any) {
      window.alert(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  function newCatalog() {
    setInternalDraft(defaultExpertDraft());
    setTnVedGroupCode("");
    setRuleId(null);
    setStep(1);
    setDataJson("{}");
    setValidateResult(null);
  }

  const stepTitle =
    step === 1
      ? "Шаг 1. О справочнике"
      : step === 2
        ? "Шаг 2. Перечень показателей в документе"
        : step === 3
          ? "Шаг 3. Классы, допуски по показателям и сумма"
          : "Шаг 4. Проверка и сохранение";

  const schemaPreviewJson = useMemo(() => {
    try {
      const toPreview: ExpertCatalogDraft = {
        ...draft,
        modelId: draft.modelId.trim() || suggestModelId(draft.catalogName || "spravochnik"),
      };
      return JSON.stringify(draftToDsl(toPreview), null, 2);
    } catch (e: any) {
      return `Ошибка предпросмотра: ${e?.message ?? String(e)}`;
    }
  }, [draft]);

  const seg = integration?.segment ?? "all";
  const compact = !!integration?.compactChrome;
  const showChrome = !compact;
  const showStep1 = seg === "all" ? step === 1 : seg === "structure" && step === 1;
  const showStep2 = seg === "all" ? step === 2 : seg === "structure" && step === 2;
  const showStep3 = seg === "all" ? step === 3 : seg === "classification";
  const showStep4 = seg === "all" ? step === 4 : false;
  const flexWithPreview =
    seg === "classification" ||
    (seg === "structure" && step >= 1) ||
    (seg === "all" && step >= 1);

  return (
    <div className={integration?.compactChrome ? undefined : "container"}>
      {showChrome ? (
        <>
          <h1>Проверка сведений о товаре</h1>
          <p style={{ maxWidth: "min(45rem, 100%)", lineHeight: 1.5, color: "#334155" }}>
            Мастер для товароведа и таможенного эксперта: задаёте перечень показателей из декларации, сертификата, паспорта безопасности или
            иного сопроводительного документа; система сформирует правила контроля. Речь не о коде ТН ВЭД, а о том,{" "}
            <strong>как в вашем файле назван показатель и какое у него числовое значение</strong>. Полный цикл создания справочника: в разделе
            «Создание справочника» на главной странице.
          </p>

          <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
            <button type="button" className="btn-secondary" onClick={newCatalog}>
              Новый справочник
            </button>
            {onOpenAdvanced ? (
              <button type="button" className="btn-secondary" onClick={onOpenAdvanced}>
                Расширенный режим (импорт, произвольная структура)
              </button>
            ) : null}
          </div>

          <CatalogListSection
            catalogs={catalogs}
            catalogQuery={catalogQuery}
            onCatalogQueryChange={setCatalogQuery}
            includeArchived={includeArchived}
            onIncludeArchivedChange={setIncludeArchived}
            busy={busy}
            onOpenPrimary={(id) => void openExpertCatalog(id, 1)}
            onOpenValidate={(id) => void openExpertValidate(id)}
            onClone={(id) => void cloneExpert(id)}
            onQuickValidate={(id) => void quickValidate(id)}
            onArchive={(id) => void onArchiveCatalog(id)}
            onUnarchive={(id) => void onUnarchiveCatalog(id)}
            onDelete={(id) => void onDeleteCatalog(id)}
            openPrimaryLabel="Редактировать"
            openValidateLabel="Проверка"
          />
        </>
      ) : null}

      {showChrome ? (
        <div style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "center", flexWrap: "wrap" }}>
          {(seg === "structure" ? ([1, 2] as const) : ([1, 2, 3, 4] as const)).map((n) => (
            <button key={n} type="button" className={step === n ? "btn" : "btn-secondary"} onClick={() => setStep(n)}>
              {n}
            </button>
          ))}
          <span style={{ color: "#64748b", marginLeft: 8 }}>{stepTitle}</span>
        </div>
      ) : seg === "structure" ? (
        <div style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontWeight: 600, color: "#0f172a" }}>Часть 1 справочника: таблица показателей в документе</span>
          <span style={{ color: "#64748b", fontSize: 14 }}>шаг {step} из 2</span>
        </div>
      ) : seg === "classification" ? (
        <div style={{ marginBottom: 12 }}>
          <span style={{ fontWeight: 600, color: "#0f172a" }}>Часть 2 справочника: классы документа и условия отнесения</span>
        </div>
      ) : null}

      {flexWithPreview && (
        <div style={{ display: "flex", gap: 20, alignItems: "flex-start", flexWrap: "wrap", width: "100%" }}>
          <div style={{ flex: "1 1 min(28rem, 100%)", minWidth: 0, maxWidth: "100%" }}>
            {showStep1 && (
              <div className="card" style={{ marginBottom: compact ? 0 : 16 }}>
                <h2 style={{ marginTop: 0 }}>Как назвать этот справочник?</h2>
                <p>Короткое имя, по которому вы и коллеги узнают набор правил.</p>
                <input
                  style={{ width: "100%", maxWidth: "100%", padding: 8, borderRadius: 8, border: "1px solid #cbd5e1", marginBottom: 12 }}
                  value={draft.catalogName}
                  onChange={(e) => patchDraft({ catalogName: e.target.value })}
                  placeholder="Например: Контроль приложения к декларации по составу"
                />
                <h3>Для чего вы его будете использовать?</h3>
                <p>Одно–два предложения для себя и коллег.</p>
                <textarea
                  style={{ width: "100%", minHeight: 72, padding: 8, borderRadius: 8, border: "1px solid #cbd5e1", marginBottom: 16 }}
                  value={draft.catalogDescription}
                  onChange={(e) => patchDraft({ catalogDescription: e.target.value })}
                  placeholder="Например: сверка сведений из сертификата анализа перед выпуском товара"
                />
                {!integration ? (
                  <div style={{ marginBottom: 16 }}>
                    <TnVedGroupSelect id="expert-tn-ved" value={tnVedGroupCode} onChange={setTnVedGroupCode} disabled={busy} />
                  </div>
                ) : null}
                {compact ? (
                  <p style={{ fontSize: 14, color: "#64748b", marginBottom: 16 }}>
                    Нужна произвольная структура или пример JSON? На шаге 1 справочника выберите «Конструктор полей» или «Готовый JSON».
                  </p>
                ) : (
                  <details style={{ marginBottom: 16 }}>
                    <summary style={{ cursor: "pointer", color: "#0b5ed7" }}>Другой формат данных или готовый файл</summary>
                    <p style={{ marginTop: 8 }}>
                      Если в документе нет таблицы «наименование показателя, значение» и при необходимости блока прочих сведений о товаре, на
                      главной странице в «Создание справочника» выберите конструктор полей или загрузку JSON.
                    </p>
                  </details>
                )}
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <button type="button" className="btn" disabled={busy} onClick={() => void handleSave()}>
                    Сохранить справочник
                  </button>
                  <button type="button" className="btn-secondary" disabled={busy || !ruleId} onClick={() => void handleValidate()}>
                    Проверить
                  </button>
                  <button type="button" className="btn" disabled={!canGoStep2} onClick={() => setStep(2)}>
                    Далее: перечень показателей
                  </button>
                </div>
              </div>
            )}
            {showStep2 && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Перечень показателей в документе</h2>
          <div
            style={{
              marginBottom: 16,
              padding: 12,
              background: "#f0f9ff",
              border: "1px solid #bae6fd",
              borderRadius: 8,
              lineHeight: 1.55,
              color: "#0c4a6e",
              fontSize: 14,
            }}
          >
            <strong>О каком «файле» речь.</strong> Это ваш исходный сопроводительный документ (сертификат, приложение к декларации, акт анализа,
            таблица из Excel и т.д.): тот, из которого в системе получают <strong>нормализованный JSON</strong> (один объект на документ).
            <br />
            <br />
            <strong>Что вводить в полях ниже.</strong> Не содержимое ячеек, а <strong>имена раздела и столбцов именно в этом JSON</strong>,
            так, как их задаёт ваш этап нормализации (или договорённость с тем, кто настраивает конвертацию). Тогда правила проверки и классификации
            совпадут с полями в данных. В каждой строке таблицы в JSON обычно лежит: текст показателя (как в документе) и число (процент, доля,
            г/кг в тех единицах, что в файле).
            <br />
            <br />
            <strong>Пример.</strong> Если после нормализации структура выглядит так, оставьте значения по умолчанию{" "}
            <code style={{ fontSize: 12 }}>показатели</code>, <code style={{ fontSize: 12 }}>наименование</code>,{" "}
            <code style={{ fontSize: 12 }}>значение</code>:
            <pre
              style={{
                margin: "8px 0 0 0",
                padding: 10,
                background: "#fff",
                borderRadius: 6,
                fontSize: 12,
                overflow: "auto",
                border: "1px solid #e0f2fe",
              }}
            >
              {`{
  "показатели": [
    { "наименование": "Массовая доля азота", "значение": 12.5 }
  ]
}`}
            </pre>
            Если в вашем JSON ключи другие (например,{" "}
            <code style={{ fontSize: 12 }}>indicators</code>, <code style={{ fontSize: 12 }}>name</code>,{" "}
            <code style={{ fontSize: 12 }}>val</code>): впишите их сюда вместо подсказок.
          </div>
          <label style={{ display: "block", marginBottom: 8 }}>
            <span style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>
              Ключ массива строк таблицы в нормализованном JSON
            </span>
            <span style={{ display: "block", fontSize: 13, color: "#64748b", marginBottom: 6 }}>
              Имя поля верхнего уровня, в котором лежит массив строк «показатель, число» (часто совпадает с заголовком раздела в документе, если
              так договорено при нормализации).
            </span>
            <input
              style={{ width: "100%", maxWidth: "100%", padding: 8, borderRadius: 8, border: "1px solid #cbd5e1" }}
              value={draft.mainSectionTitle}
              onChange={(e) => patchDraft({ mainSectionTitle: e.target.value })}
              placeholder="например: показатели"
            />
          </label>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 12 }}>
            <label>
              <span style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>Ключ текста показателя в каждой строке JSON</span>
              <span style={{ display: "block", fontSize: 13, color: "#64748b", marginBottom: 6 }}>
                Поле объекта строки, где хранится наименование из таблицы в документе.
              </span>
              <input
                style={{ width: 220, padding: 8, borderRadius: 8, border: "1px solid #cbd5e1" }}
                value={draft.codeColumnTitle}
                onChange={(e) => patchDraft({ codeColumnTitle: e.target.value })}
                placeholder="например: наименование"
              />
            </label>
            <label>
              <span style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>Ключ числового значения в каждой строке JSON</span>
              <span style={{ display: "block", fontSize: 13, color: "#64748b", marginBottom: 6 }}>
                Поле объекта строки с числом (в тех же единицах, что в исходной таблице).
              </span>
              <input
                style={{ width: 220, padding: 8, borderRadius: 8, border: "1px solid #cbd5e1" }}
                value={draft.valueColumnTitle}
                onChange={(e) => patchDraft({ valueColumnTitle: e.target.value })}
                placeholder="например: значение"
              />
            </label>
          </div>
          <h3>Перечень допустимых наименований в поле «{draft.codeColumnTitle || "…"}»</h3>
          <p>
            Сюда внесите все варианты текста показателя <strong>в точности как они должны попадать в JSON</strong> (как в документе: регистр, пробелы,
            «P2O5», «массовая доля азота» и т.д.). Это не код ТН ВЭД и не внутренний код системы, а текст в том поле строки таблицы, которое вы
            назвали выше.
          </p>
          {draft.indicators.map((ind, idx) => (
            <div
              key={idx}
              style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: 12, marginBottom: 8, background: "#fff" }}
            >
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", width: "100%" }}>
                <label style={{ flex: "1 1 12rem", minWidth: 0 }}>
                  Наименование в документе
                  <input
                    style={{ marginLeft: 6, padding: 6, width: "100%", maxWidth: 280 }}
                    value={ind.id}
                    onChange={(e) => patchDraft({ indicators: updateIndicator(draft.indicators, idx, { id: e.target.value }) })}
                    placeholder="как в столбце таблицы"
                  />
                </label>
                <button
                  type="button"
                  className="btn-danger btn-align-end"
                  onClick={() => patchDraft({ indicators: removeIndicator(draft.indicators, idx) })}
                >
                  Убрать из перечня
                </button>
              </div>
            </div>
          ))}
          <button
            type="button"
            className="btn"
            style={{ marginBottom: 16 }}
            onClick={() => patchDraft({ indicators: [...draft.indicators, { id: "" }] })}
          >
            + Добавить показатель
          </button>
          <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <input
              type="checkbox"
              checked={draft.includeMiscSection}
              onChange={(e) => patchDraft({ includeMiscSection: e.target.checked })}
            />
            В документе есть блок <strong>прочих сведений о товаре</strong> (масса нетто, страна происхождения, маркировка и т.п.); для него
            задаём только общий вид полей, без жёстких допусков по каждому пункту
          </label>
          {draft.includeMiscSection ? (
            <label style={{ display: "block", marginBottom: 16 }}>
              Как в файле называется раздел с прочими сведениями?
              <input
                style={{ marginLeft: 8, padding: 6, width: 200 }}
                value={draft.miscSectionTitle}
                onChange={(e) => patchDraft({ miscSectionTitle: e.target.value })}
              />
            </label>
          ) : null}
          <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
            <input
              type="checkbox"
              checked={draft.requireBothSectionsPresent}
              disabled={!draft.includeMiscSection}
              onChange={(e) => patchDraft({ requireBothSectionsPresent: e.target.checked })}
            />
            В одном документе должны быть и таблица показателей, и прочие сведения о товаре
          </label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <button type="button" className="btn" disabled={busy} onClick={() => void handleSave()}>
              Сохранить справочник
            </button>
            <button type="button" className="btn-secondary" disabled={busy || !ruleId} onClick={() => void handleValidate()}>
              Проверить
            </button>
            <button type="button" className="btn-secondary" onClick={() => setStep(1)}>
              Назад
            </button>
            {integration?.segment === "structure" ? (
              <p style={{ margin: 0, fontSize: 14, color: "#475569" }}>
                Когда заполните перечень, перейдите к следующему шагу справочника кнопкой внизу страницы («Правила и классификация»).
              </p>
            ) : (
              <button type="button" className="btn" disabled={!canGoStep3} onClick={() => setStep(3)}>
                Далее: классы и сумма
              </button>
            )}
          </div>
        </div>
      )}

      {showStep3 && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Классы и правила отнесения</h2>
          <p style={{ maxWidth: "min(45rem, 100%)", lineHeight: 1.55, color: "#475569" }}>
            Сначала перечислите <strong>классы</strong> (типы документа или сценария). Внутри каждого класса одно или несколько{" "}
            <strong>правил</strong>: когда все условия правила выполняются, документ относится к этому классу. Допустимые числа по показателям для
            проверки таблицы задаются в каждой карточке правила; границы по всем правилам объединяются в общую схему.
          </p>

          <details style={{ marginBottom: 20, padding: 12, background: "#f1f5f9", borderRadius: 8, border: "1px solid #e2e8f0" }}>
            <summary style={{ cursor: "pointer", fontWeight: 600, color: "#334155" }}>
              Дополнительно: сумма по таблице и обязательные разделы
            </summary>
            <p style={{ fontSize: 14, color: "#64748b", marginTop: 10, marginBottom: 10 }}>
              Обычно это уже задано на шаге с перечнем показателей. Здесь можно включить жёсткую проверку суммы чисел в столбце значений.
            </p>
            <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <input
                type="checkbox"
                checked={draft.enforceSumOfShares}
                onChange={(e) => patchDraft({ enforceSumOfShares: e.target.checked })}
              />
              Сумма значений по всем строкам перечня должна совпадать с заданной величиной (например, 100 % по составу)
            </label>
            {draft.enforceSumOfShares ? (
              <label>
                Сумма должна быть (в тех же единицах, что в таблице)
                <input
                  type="number"
                  step="any"
                  style={{ marginLeft: 8, padding: 6, width: 120 }}
                  value={draft.sumOfSharesTarget}
                  onChange={(e) => patchDraft({ sumOfSharesTarget: Number(e.target.value) })}
                />
              </label>
            ) : null}
          </details>

          {draft.classRules.length === 0 ? (
            <p style={{ color: "#64748b", marginBottom: 16 }}>
              Пока нет классов. Нажмите «Добавить класс»: появится блок с именем класса и первым правилом.
            </p>
          ) : null}

          {groupClassRuleIndices(draft.classRules).map(({ key, indices }, classIndex) => (
            <div
              key={key === "__unset__" ? `unset-${indices.join("-")}` : key}
              style={{
                border: "1px solid #cbd5e1",
                borderRadius: 10,
                padding: 14,
                marginBottom: 14,
                background: "#fff",
              }}
            >
              <div style={{ display: "flex", gap: 12, alignItems: "flex-start", marginBottom: 12, width: "100%" }}>
                <div
                  style={{
                    flex: "0 0 auto",
                    minWidth: 32,
                    height: 32,
                    borderRadius: 999,
                    background: "#e2e8f0",
                    color: "#0f172a",
                    fontWeight: 700,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    marginTop: 2,
                  }}
                  aria-label={`Класс ${classIndex + 1}`}
                  title={`Класс ${classIndex + 1}`}
                >
                  {classIndex + 1}
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", width: "100%" }}>
                <label style={{ flex: "1 1 220px", minWidth: 0 }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 700, fontSize: 18, color: "#0f172a", marginBottom: 4 }}>
                    <span>{key === "__unset__" ? "Новый класс" : key}</span>
                    <button
                      type="button"
                      onClick={() => setEditingClassKey(key)}
                      style={{
                        border: "1px solid #cbd5e1",
                        background: "#fff",
                        borderRadius: 6,
                        width: 28,
                        height: 28,
                        cursor: "pointer",
                        color: "#334155",
                      }}
                      aria-label={`Редактировать название класса ${classIndex + 1}`}
                      title="Редактировать название"
                    >
                      ✎
                    </button>
                  </span>
                  {editingClassKey === key ? (
                    <input
                      autoFocus
                      key={key === "__unset__" ? "unset-expert" : key}
                      style={{ width: "100%", padding: 8, borderRadius: 8, border: "1px solid #cbd5e1" }}
                      defaultValue={key === "__unset__" ? "" : key}
                      placeholder="например: органическое удобрение"
                      onChange={(e) => {
                        const el = e.currentTarget;
                        const lo = el.value.toLowerCase();
                        if (lo !== el.value) el.value = lo;
                      }}
                      onBlur={(e) => {
                        const t = e.target.value.trim().toLowerCase();
                        if (key === "__unset__") {
                          if (t) {
                            patchDraft({
                              classRules: draft.classRules.map((r) => (!r.classId.trim() ? { ...r, classId: t } : r)),
                            });
                          }
                          setEditingClassKey((prev) => (prev === key ? null : prev));
                          return;
                        }
                        if (t) {
                          patchDraft({
                            classRules: draft.classRules.map((r) =>
                              r.classId.trim().toLowerCase() === key ? { ...r, classId: t } : r,
                            ),
                          });
                        }
                        setEditingClassKey((prev) => (prev === key ? null : prev));
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.currentTarget.blur();
                        }
                      }}
                    />
                  ) : null}
                </label>
                <button
                  type="button"
                  className="btn-danger btn-align-end"
                  onClick={() => {
                    if (key === "__unset__") {
                      patchDraft({ classRules: draft.classRules.filter((r) => r.classId.trim()) });
                    } else {
                      patchDraft({ classRules: draft.classRules.filter((r) => r.classId.trim() !== key) });
                    }
                  }}
                >
                  Удалить класс и все правила
                </button>
                </div>
              </div>

              {indices.length ? (
                <div style={{ marginBottom: 12 }}>
                  <TnVedGroupTreePicker
                    value={draft.classRules[indices[0]!]?.tnVedGroupCode ?? ""}
                    onChange={(code) =>
                      patchDraft({
                        classRules: draft.classRules.map((r, i) => {
                          if (!indices.includes(i)) return r;
                          const next = { ...r, tnVedGroupCode: code };
                          if (shouldAutofillClassIdFromClassifier(r.classId)) {
                            const def = getTnVedClassifierTitleForCode(code);
                            if (def && !isTnVedGenericProchieTitle(def)) {
                              next.classId = classIdFromTnVedClassifierTitle(def);
                            }
                          }
                          return next;
                        }),
                      })
                    }
                  />
                </div>
              ) : null}

              {indices.map((ri) => {
                const rule = draft.classRules[ri];
                if (!rule) return null;
                return (
            <div
              key={ri}
              style={{ border: "1px dashed #94a3b8", borderRadius: 8, padding: 12, marginBottom: 10, background: "#f8fafc" }}
            >
              <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end", marginBottom: 10, width: "100%" }}>
                <label>
                  <span style={{ display: "block", fontWeight: 600, marginBottom: 4, fontSize: 13 }}>Заметка к правилу (необязательно)</span>
                  <input
                    style={{ width: 220, padding: 6, borderRadius: 8, border: "1px solid #cbd5e1" }}
                    value={rule.title}
                    onChange={(e) =>
                      patchDraft({ classRules: updateClassRule(draft.classRules, ri, { title: e.target.value }) })
                    }
                    placeholder="для себя и коллег"
                  />
                </label>
                <label>
                  <span style={{ display: "block", fontWeight: 600, marginBottom: 4, fontSize: 13 }}>Порядок проверки (меньше, раньше)</span>
                  <input
                    type="number"
                    style={{ width: 100, padding: 6, borderRadius: 8, border: "1px solid #cbd5e1" }}
                    value={rule.priority}
                    onChange={(e) =>
                      patchDraft({
                        classRules: updateClassRule(draft.classRules, ri, { priority: Number(e.target.value) || 0 }),
                      })
                    }
                  />
                </label>
                <button
                  type="button"
                  className="btn-danger btn-align-end"
                  onClick={() => patchDraft({ classRules: removeClassRule(draft.classRules, ri) })}
                >
                  Удалить это правило
                </button>
              </div>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>Допустимые значения показателя в документе</div>
              <p style={{ fontSize: 14, color: "#64748b", marginTop: 0, marginBottom: 8 }}>
                Для строк перечня укажите, в каких пределах может лежать число в столбце значения (те же единицы, что в файле). Это нужно для
                проверки структуры данных; границы по всем классам объединяются.
              </p>
              {!draft.indicators.some((i) => i.id.trim()) ? (
                <p style={{ color: "#b45309", fontSize: 14 }}>Сначала задайте наименования показателей на шаге 2.</p>
              ) : null}
              {(rule.indicatorBounds ?? []).map((bound, bi) => (
                <div key={bi} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 8, width: "100%" }}>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4, flex: "1 1 12rem", minWidth: 0, maxWidth: "100%" }}>
                    <span>Показатель</span>
                    <select
                      style={{ padding: 6, width: "100%", maxWidth: "100%", minWidth: 0 }}
                      value={bound.indicatorName}
                      onChange={(e) => {
                        const next = (rule.indicatorBounds ?? []).slice();
                        next[bi] = { ...next[bi], indicatorName: e.target.value };
                        patchDraft({ classRules: updateClassRule(draft.classRules, ri, { indicatorBounds: next }) });
                      }}
                    >
                      <option value="">(выберите)</option>
                      {draft.indicators
                        .filter((i) => i.id.trim())
                        .map((i) => (
                          <option key={i.id} value={i.id.trim()}>
                            {i.id.trim()}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label>
                    не меньше
                    <input
                      type="number"
                      step="any"
                      style={{ marginLeft: 6, width: 88, padding: 6 }}
                      value={bound.min ?? ""}
                      onChange={(e) => {
                        const next = (rule.indicatorBounds ?? []).slice();
                        const v = e.target.value === "" ? undefined : Number(e.target.value);
                        next[bi] = { ...next[bi], min: v };
                        patchDraft({ classRules: updateClassRule(draft.classRules, ri, { indicatorBounds: next }) });
                      }}
                    />
                  </label>
                  <label>
                    не больше
                    <input
                      type="number"
                      step="any"
                      style={{ marginLeft: 6, width: 88, padding: 6 }}
                      value={bound.max ?? ""}
                      onChange={(e) => {
                        const next = (rule.indicatorBounds ?? []).slice();
                        const v = e.target.value === "" ? undefined : Number(e.target.value);
                        next[bi] = { ...next[bi], max: v };
                        patchDraft({ classRules: updateClassRule(draft.classRules, ri, { indicatorBounds: next }) });
                      }}
                    />
                  </label>
                  <button
                    type="button"
                    className="btn-danger btn-align-end"
                    onClick={() => {
                      const next = (rule.indicatorBounds ?? []).filter((_, j) => j !== bi);
                      patchDraft({ classRules: updateClassRule(draft.classRules, ri, { indicatorBounds: next }) });
                    }}
                  >
                    Убрать
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="btn"
                style={{ marginBottom: 12 }}
                onClick={() => {
                  const first = draft.indicators.find((i) => i.id.trim())?.id.trim() ?? "";
                  patchDraft({
                    classRules: updateClassRule(draft.classRules, ri, {
                      indicatorBounds: [...(rule.indicatorBounds ?? []), { indicatorName: first } as ExpertClassIndicatorBounds],
                    }),
                  });
                }}
              >
                + Показатель и допустимый диапазон
              </button>
              <div
                style={{ fontWeight: 600, marginBottom: 8 }}
                title="Для срабатывания правила учитываются только условия с галкой «Основное условие». Остальные не обязательны и используются для уточнения классификации при выполнении основных."
              >
                Когда документ относится к этому классу
              </div>
              {!draft.indicators.some((i) => i.id.trim()) ? (
                <p style={{ color: "#b45309", fontSize: 14 }}>Сначала задайте наименования показателей на шаге 2.</p>
              ) : null}
              {rule.conditions.map((cond, ci) => (
                <React.Fragment key={ci}>
                  {ci > 0 ? (
                    <div style={{ display: "flex", justifyContent: "center", margin: "2px 0 8px", width: "100%" }}>
                      <select
                        aria-label="Связка с предыдущим условием"
                        style={{
                          padding: "4px 10px",
                          borderRadius: 999,
                          border: "1px solid #cbd5e1",
                          background: "#f8fafc",
                          color: "#334155",
                          fontSize: 12,
                          fontWeight: 700,
                        }}
                        value={cond.conjunction === "or" ? "or" : "and"}
                        onChange={(e) => {
                          const next = rule.conditions.slice();
                          next[ci] = { ...next[ci], conjunction: e.target.value as "and" | "or" };
                          patchDraft({ classRules: updateClassRule(draft.classRules, ri, { conditions: next }) });
                        }}
                      >
                        <option value="and">И</option>
                        <option value="or">ИЛИ</option>
                      </select>
                    </div>
                  ) : null}
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 8,
                    alignItems: "flex-start",
                    marginBottom: 10,
                    width: "100%",
                    borderBottom: "1px solid #e2e8f0",
                    paddingBottom: 10,
                  }}
                >
                  <label
                    title="Должно выполняться, чтобы по декларации можно было подтвердить класс. Без галки условие необязательно и служит для уточнения классификации при выполнении основных."
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 8,
                      cursor: "pointer",
                      flex: "1 1 100%",
                      maxWidth: "100%",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={cond.primary !== false}
                      onChange={(e) => {
                        const next = rule.conditions.slice();
                        next[ci] = { ...next[ci], primary: e.target.checked ? true : false };
                        patchDraft({ classRules: updateClassRule(draft.classRules, ri, { conditions: next }) });
                      }}
                      style={{ marginTop: 0, flexShrink: 0 }}
                    />
                    <span style={{ fontSize: 13, lineHeight: 1.35, color: "#334155" }}>
                      <strong>Основное условие</strong>
                    </span>
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4, flex: "1 1 12rem", minWidth: 0, maxWidth: "100%" }}>
                    <span>Показатель в документе</span>
                    <select
                      style={{ padding: 6, width: "100%", maxWidth: "100%", minWidth: 0 }}
                      value={cond.indicatorName}
                      onChange={(e) => {
                        const next = rule.conditions.slice();
                        next[ci] = { ...next[ci], indicatorName: e.target.value };
                        patchDraft({ classRules: updateClassRule(draft.classRules, ri, { conditions: next }) });
                      }}
                    >
                      <option value="">(выберите)</option>
                      {draft.indicators
                        .filter((i) => i.id.trim())
                        .map((i) => (
                          <option key={i.id} value={i.id.trim()}>
                            {i.id.trim()}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label>
                    Условие
                    <select
                      style={{ marginLeft: 6, padding: 6 }}
                      value={cond.op}
                      onChange={(e) => {
                        const next = rule.conditions.slice();
                        next[ci] = { ...next[ci], op: e.target.value as ExpertClassConditionOp };
                        patchDraft({ classRules: updateClassRule(draft.classRules, ri, { conditions: next }) });
                      }}
                    >
                      {Object.entries(CONDITION_OP_LABELS).map(([k, lab]) => (
                        <option key={k} value={k}>
                          {lab}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Порог
                    <input
                      type="number"
                      step="any"
                      style={{ marginLeft: 6, width: 100, padding: 6 }}
                      value={cond.value}
                      onChange={(e) => {
                        const next = rule.conditions.slice();
                        next[ci] = { ...next[ci], value: Number(e.target.value) };
                        patchDraft({ classRules: updateClassRule(draft.classRules, ri, { conditions: next }) });
                      }}
                    />
                  </label>
                  <button
                    type="button"
                    className="btn-danger btn-align-end"
                    onClick={() => {
                      const next = rule.conditions.filter((_, j) => j !== ci);
                      patchDraft({ classRules: updateClassRule(draft.classRules, ri, { conditions: next }) });
                    }}
                  >
                    Убрать условие
                  </button>
                </div>
                </React.Fragment>
              ))}
              <button
                type="button"
                className="btn"
                onClick={() => {
                  const first = draft.indicators.find((i) => i.id.trim())?.id.trim() ?? "";
                  patchDraft({
                    classRules: updateClassRule(draft.classRules, ri, {
                      conditions: [...rule.conditions, { indicatorName: first, op: "gte", value: 0, conjunction: "and", primary: true }],
                    }),
                  });
                }}
              >
                + Условие: показатель в таблице и порог
              </button>
            </div>
                );
              })}

              <button
                type="button"
                className="btn"
                style={{ marginTop: 4 }}
                onClick={() => {
                  const cid = key === "__unset__" ? "" : key;
                  const inheritTn = draft.classRules[indices[0]!]?.tnVedGroupCode ?? "";
                  const minP = draft.classRules.length
                    ? Math.min(...draft.classRules.map((r) => r.priority))
                    : 0;
                  patchDraft({
                    classRules: [
                      ...draft.classRules,
                      {
                        classId: cid,
                        tnVedGroupCode: inheritTn,
                        title: "",
                        priority: minP - 10,
                        indicatorBounds: [],
                        conditions: [],
                      },
                    ],
                  });
                }}
              >
                + Добавить правило в этот класс
              </button>
            </div>
          ))}

          <button
            type="button"
            className="btn"
            style={{ marginBottom: 16 }}
            onClick={() => {
              const id = suggestNewExpertClassId(draft.classRules);
              const minP = draft.classRules.length
                ? Math.min(...draft.classRules.map((r) => r.priority))
                : 0;
              patchDraft({
                classRules: [
                  ...draft.classRules,
                  {
                    classId: id,
                    tnVedGroupCode: "",
                    title: "",
                    priority: minP - 10,
                    indicatorBounds: [],
                    conditions: [],
                  },
                ],
              });
            }}
          >
            + Добавить класс
          </button>

          <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap", alignItems: "center" }}>
            <button type="button" className="btn" disabled={busy} onClick={() => void handleSave()}>
              Сохранить справочник
            </button>
            <button type="button" className="btn-secondary" disabled={busy || !ruleId} onClick={() => void handleValidate()}>
              Проверить
            </button>
            {integration?.segment === "classification" ? (
              <p style={{ margin: 0, fontSize: 14, color: "#475569" }}>
                Проверка JSON и черновик данных — также на шаге 4 полного мастера или кнопкой «Проверить» после сохранения.
              </p>
            ) : (
              <>
                <button type="button" className="btn-secondary" onClick={() => setStep(2)}>
                  Назад
                </button>
                <button type="button" className="btn" onClick={() => setStep(4)}>
                  Далее: проверка и сохранение
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {showStep4 && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Сохранение и пробная проверка</h2>
          <p>
            «Подставить черновик данных» подставит тестовое заполнение по вашему перечню показателей, чтобы сразу нажать «Проверить».
            Замените цифры на реальные из документа при необходимости.
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
            <button type="button" className="btn-secondary" disabled={busy} onClick={fillSampleFromDraft}>
              Подставить черновик данных
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => void handleSave()}>
              Сохранить справочник
            </button>
            <button type="button" className="btn" disabled={busy || !ruleId} onClick={() => void handleValidate()}>
              Проверить по сохранённому справочнику
            </button>
          </div>
          {ruleId ? (
            <p style={{ fontSize: 14, color: "#15803d" }}>Сохранено. Номер справочника для связи с системой: {ruleId}</p>
          ) : (
            <p style={{ fontSize: 14, color: "#64748b" }}>После первого сохранения станет доступна проверка.</p>
          )}
          <textarea
            className="fe-textarea-code"
            style={{ width: "100%", minHeight: 160, padding: 8, borderRadius: 8 }}
            value={dataJson}
            onChange={(e) => setDataJson(e.target.value)}
          />
          {validateResult ? (
            <pre style={{ marginTop: 12, padding: 12, background: "#f1f5f9", borderRadius: 8, overflow: "auto" }}>
              {JSON.stringify(validateResult, null, 2)}
            </pre>
          ) : null}
          <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
            <button type="button" className="btn-secondary" onClick={() => setStep(3)}>
              Назад
            </button>
          </div>
        </div>
      )}
          </div>
          <aside
            style={{
              flex: "1 1 min(22rem, 100%)",
              minWidth: 0,
              width: "100%",
              maxWidth: "100%",
              position: "sticky",
              top: 12,
              alignSelf: "flex-start",
            }}
          >
            <div
              className="card"
              style={{
                marginTop: 0,
                padding: 12,
                maxHeight: "min(82vh, 920px)",
                display: "flex",
                flexDirection: "column",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  marginBottom: 8,
                  flexWrap: "wrap",
                }}
              >
                <h3 style={{ margin: 0, fontSize: 16 }}>
                  {seg === "classification" ? "Правила внутри JSON" : "Схема и правило целиком"}
                </h3>
                <button
                  type="button"
                  className="btn-secondary"
                  style={{ fontSize: 13, padding: "4px 10px" }}
                  onClick={() => {
                    void navigator.clipboard?.writeText(schemaPreviewJson).then(
                      () => {},
                      () => {},
                    );
                  }}
                >
                  Копировать
                </button>
              </div>
              <p style={{ margin: "0 0 8px 0", fontSize: 13, color: "#64748b", lineHeight: 1.4 }}>
                {seg === "classification" ? (
                  <>
                    Полный черновик правила при сохранении. Блоки <code style={{ fontSize: 12 }}>classification</code> (классы и условия) и{" "}
                    <code style={{ fontSize: 12 }}>cross_rules</code> (сумма, обязательные поля) обновляются при правках слева. Состояние мастера
                    в <code style={{ fontSize: 12 }}>meta.expert_draft</code>.
                  </>
                ) : (
                  <>
                    То, что уйдёт в правило при сохранении: схема документа, дополнительные проверки и классификация. Меняется при каждом шаге
                    слева. Черновик формы в <code style={{ fontSize: 12 }}>meta.expert_draft</code>.
                  </>
                )}
              </p>
              <pre
                style={{
                  margin: 0,
                  padding: 10,
                  background: "#f8fafc",
                  border: "1px solid #e2e8f0",
                  borderRadius: 8,
                  fontSize: 11,
                  lineHeight: 1.45,
                  overflow: "auto",
                  flex: 1,
                  minHeight: 200,
                }}
              >
                {schemaPreviewJson}
              </pre>
            </div>
          </aside>
        </div>
      )}

      {showChrome && onOpenAdvanced ? (
        <p style={{ marginTop: 24, fontSize: 14, color: "#64748b" }}>
          Нужен импорт готового JSON или своя иерархия полей?{" "}
          <button type="button" className="btn-secondary" onClick={onOpenAdvanced}>
            Расширенный режим
          </button>
        </p>
      ) : null}
    </div>
  );
}
