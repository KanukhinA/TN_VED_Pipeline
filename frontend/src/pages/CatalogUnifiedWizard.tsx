/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  archiveRule,
  cloneRule,
  deleteRule,
  getPrimaryCatalogSettings,
  getRule,
  listRules,
  saveRule,
  unarchiveRule,
  validateRule,
} from "../api/client";
import CatalogListSection from "../ui/CatalogListSection";
import ClassificationRulesPanel, {
  classificationHasTnVedForAllRules,
  classificationToDslPayload,
  parseClassificationFromDsl,
  type UiClassification,
} from "../ui/ClassificationRulesPanel";
import { generateSampleJson, loadDraftFromDslResponse, suggestModelId } from "../expert/expertDraft";
import {
  buildStructureRowDescriptors,
  defaultNumericCharacteristicsDraft,
  formatNumericCharacteristicsSampleJson,
  generateNumericCharacteristicsSampleJson,
  normalizeNumericCharacteristicsDraft,
  numericCharacteristicsToDsl,
  parseNumericCharacteristicsDraft,
  serializeNumericCharacteristicsDraft,
  type NumericCharacteristicsDraft,
} from "../expert/numericCharacteristicsDraft";
import JsonSchemaPreviewAside, { splitMainColumnStyle, splitRowStyle } from "../ui/JsonSchemaPreviewAside";
import NumericCharacteristicsForm from "../ui/NumericCharacteristicsForm";
import TnVedGroupSelect from "../ui/TnVedGroupSelect";
import { normalizeTnVedChapterMeta, normalizeTnVedGroupCode } from "../catalog/tnVedCode";
import { resolveTnVedCodeLabel } from "../catalog/tnVedEaeuTree";

type FlowStep = 1 | 2 | 3;
type SavedSource = "numericCharacteristics" | null;

function emptyDsl(): any {
  return {
    model_id: "",
    schema: { type: "object", properties: [], required: [], additional_properties: false },
    cross_rules: [],
    meta: {},
  };
}

export default function CatalogUnifiedWizard() {
  const [flowStep, setFlowStep] = useState<FlowStep>(1);
  const [numericCharsDraft, setNumericCharsDraft] = useState<NumericCharacteristicsDraft>(() => defaultNumericCharacteristicsDraft());
  const [dsl, setDsl] = useState<any>(() => emptyDsl());
  const [classificationUi, setClassificationUiState] = useState<UiClassification>(() => parseClassificationFromDsl(undefined));
  const [savedSource, setSavedSource] = useState<SavedSource>(null);

  const [ruleId, setRuleId] = useState<string | null>(null);
  const [dataJson, setDataJson] = useState("{}");
  const [validateResult, setValidateResult] = useState<any>(null);
  const [classificationJsonText, setClassificationJsonText] = useState("");
  const [classificationJsonError, setClassificationJsonError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [catalogs, setCatalogs] = useState<any[]>([]);
  /** Эффективный основной справочник по коду группы ТН ВЭД (с сервера). */
  const [primaryByGroup, setPrimaryByGroup] = useState<Record<string, string> | null>(null);
  const [catalogQuery, setCatalogQuery] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [tnVedGroupCode, setTnVedGroupCode] = useState("");
  /** Не перезаписывать textarea из dsl сразу после успешного ввода JSON (сохраняем фокус/курсор). */
  const classificationJsonSkipSyncRef = useRef(false);
  /** Пользователь менял JSON проверки на шаге 3 — не подставлять автопример при возврате со шага 2. */
  const dataJsonTouchedRef = useRef(false);
  /** Нормализованный черновик структуры, для которого последний раз сгенерирован пример в поле проверки. */
  const dataJsonAutoDraftKeyRef = useRef<string>("");
  const prevFlowStepRef = useRef<FlowStep>(flowStep);

  const refreshCatalogs = useCallback(async () => {
    try {
      const [list, primaryCfg] = await Promise.all([
        listRules({
          q: catalogQuery.trim() || undefined,
          include_archived: includeArchived,
        }),
        getPrimaryCatalogSettings().catch(() => null),
      ]);
      setCatalogs(Array.isArray(list) ? list : []);
      const raw = primaryCfg?.by_group_code;
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        setPrimaryByGroup(raw as Record<string, string>);
      } else {
        setPrimaryByGroup(null);
      }
    } catch {
      setCatalogs([]);
      setPrimaryByGroup(null);
    }
  }, [catalogQuery, includeArchived]);

  useEffect(() => {
    const t = window.setTimeout(() => void refreshCatalogs(), 200);
    return () => window.clearTimeout(t);
  }, [refreshCatalogs]);

  const setClassificationUi = useCallback((next: UiClassification) => {
    setClassificationUiState(next);
    const payload = classificationToDslPayload(next);
    setDsl((prev: any) => {
      const n = { ...prev };
      if (payload) n.classification = payload;
      else delete n.classification;
      return n;
    });
  }, []);

  useEffect(() => {
    if (flowStep !== 2) return;
    setClassificationUiState(parseClassificationFromDsl(dsl?.classification));
  }, [flowStep, ruleId, savedSource]);

  useEffect(() => {
    if (flowStep !== 2) return;
    if (classificationJsonSkipSyncRef.current) {
      classificationJsonSkipSyncRef.current = false;
      return;
    }
    try {
      setClassificationJsonText(JSON.stringify({ classification: dsl.classification ?? null }, null, 2));
      setClassificationJsonError(null);
    } catch {
      setClassificationJsonText("{}");
    }
  }, [flowStep, dsl.classification]);

  useEffect(() => {
    if (flowStep !== 3 || !savedSource) {
      prevFlowStepRef.current = flowStep;
      return;
    }

    const prev = prevFlowStepRef.current;
    prevFlowStepRef.current = flowStep;

    let draftKey = "";
    try {
      draftKey = JSON.stringify(normalizeNumericCharacteristicsDraft(numericCharsDraft));
    } catch {
      draftKey = "";
    }
    const draftChanged = draftKey !== dataJsonAutoDraftKeyRef.current;

    const shouldSeed =
      prev === 1 || draftChanged || (prev === 2 && !dataJsonTouchedRef.current);

    if (!shouldSeed) return;

    try {
      const normalized = normalizeNumericCharacteristicsDraft(numericCharsDraft);
      const next = JSON.stringify(generateNumericCharacteristicsSampleJson(normalized), null, 2);
      setDataJson(next);
      dataJsonAutoDraftKeyRef.current = draftKey;
      dataJsonTouchedRef.current = false;
    } catch {
      setDataJson("{}");
      dataJsonAutoDraftKeyRef.current = "";
      dataJsonTouchedRef.current = false;
    }
  }, [flowStep, savedSource, numericCharsDraft]);

  const numericStructureSampleJsonPreview = useMemo(
    () => formatNumericCharacteristicsSampleJson(numericCharsDraft),
    [numericCharsDraft],
  );

  const structureRowDescriptors = useMemo(() => buildStructureRowDescriptors(numericCharsDraft), [numericCharsDraft]);

  const handleClassificationJsonEdit = useCallback(
    (next: string) => {
      setClassificationJsonText(next);
      try {
        const parsed: unknown = JSON.parse(next);
        let raw: unknown = parsed;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "classification" in parsed) {
          raw = (parsed as { classification: unknown }).classification;
        }
        classificationJsonSkipSyncRef.current = true;
        setClassificationUi(parseClassificationFromDsl(raw));
        setClassificationJsonError(null);
      } catch (e: unknown) {
        setClassificationJsonError(e instanceof Error ? e.message : "Неверный JSON");
      }
    },
    [setClassificationUi],
  );

  function canCompleteStructure(): boolean {
    if (!normalizeTnVedGroupCode(tnVedGroupCode)) return false;
    if (!numericCharsDraft.catalogName.trim()) return false;
    const n = normalizeNumericCharacteristicsDraft(numericCharsDraft);
    const hasNumeric = n.characteristics.some((c) =>
      c.layout === "scalar"
        ? !!c.characteristicKey.trim()
        : !!(c.characteristicKey.trim() && c.componentColumnKey.trim()),
    );
    const hasProchee = n.procheeEnabled;
    const hasTextArray = (n.textArrayFields ?? []).some((t) => t.fieldKey.trim());
    const hasTextScalar = (n.textScalarFields ?? []).some((t) => t.fieldKey.trim());
    const hasText = hasTextArray || hasTextScalar;
    return hasNumeric || hasProchee || hasText;
  }

  function goToRulesStep() {
    if (!canCompleteStructure()) {
      window.alert(
        "Укажите главу ТН ВЭД, название справочника и хотя бы одну структуру: числовое поле, текстовое поле, массив из допустимых значений или блок «прочее».",
      );
      return;
    }
    try {
      const tnCode = normalizeTnVedGroupCode(tnVedGroupCode);
      if (!tnCode) {
        window.alert("Выберите главу ТН ВЭД (двузначная группа 01–97).");
        return;
      }
      {
        const modelId =
          numericCharsDraft.modelId.trim() ||
          suggestModelId(numericCharsDraft.catalogName || "spravochnik");
        const normalized = normalizeNumericCharacteristicsDraft({ ...numericCharsDraft, modelId });
        setNumericCharsDraft(normalized);
        const next = numericCharacteristicsToDsl(normalized);
        setDsl((prev: any) => {
          const prevMid = typeof prev?.model_id === "string" ? prev.model_id.trim() : "";
          return {
            ...next,
            model_id: prevMid || next.model_id,
            classification: prev?.classification,
            cross_rules: [],
            meta: {
              ...(prev?.meta ?? {}),
              ...(next.meta ?? {}),
              tn_ved_group_code: tnCode,
              numeric_characteristics_draft: next.meta?.numeric_characteristics_draft,
            },
          };
        });
        setSavedSource("numericCharacteristics");
      }
      setFlowStep(2);
      setValidateResult(null);
    } catch (e: any) {
      window.alert(e?.message ?? String(e));
    }
  }

  async function handleSave() {
    const tnCode = normalizeTnVedGroupCode(tnVedGroupCode);
    if (!tnCode) {
      window.alert("Укажите главу ТН ВЭД на шаге 1. Поле обязательно для сохранения.");
      return;
    }
    const normalizedDraft = normalizeNumericCharacteristicsDraft(numericCharsDraft);
    const rebuilt = numericCharacteristicsToDsl(normalizedDraft);
    const modelId = (dsl.model_id?.trim() || rebuilt.model_id || "").trim();
    if (!modelId) {
      window.alert("Не удалось сформировать идентификатор модели (model_id). Проверьте название справочника на шаге 1.");
      return;
    }
    if (!classificationHasTnVedForAllRules(classificationUi)) {
      window.alert("Для каждого класса с идентификатором укажите код ТН ВЭД ЕАЭС на шаге «Классы».");
      return;
    }
    setBusy(true);
    try {
      setNumericCharsDraft(normalizedDraft);
      const payload = {
        ...dsl,
        model_id: modelId,
        schema: rebuilt.schema,
        cross_rules: [],
        meta: {
          ...(dsl.meta ?? {}),
          ...(rebuilt.meta ?? {}),
          tn_ved_group_code: tnCode,
          numeric_characteristics_draft: rebuilt.meta?.numeric_characteristics_draft,
        },
      };
      const res = await saveRule(payload, ruleId);
      setDsl(payload);
      setRuleId(res.rule_id);
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

  async function openCatalog(id: string, target: FlowStep) {
    setBusy(true);
    try {
      const full = await getRule(id);
      const numericFromMeta = parseNumericCharacteristicsDraft(full.dsl?.meta?.numeric_characteristics_draft);
      if (!numericFromMeta) {
        window.alert(
          "Этот справочник создан не в режиме «числовые характеристики». Откройте его в мастере товароведа или в расширенном редакторе.",
        );
        return;
      }
      const d = { ...numericFromMeta, modelId: full.model_id ?? numericFromMeta.modelId };
      setNumericCharsDraft(d);
      setSavedSource("numericCharacteristics");
      setDsl({ ...full.dsl, cross_rules: [] });
      const rawTn = full.dsl?.meta?.tn_ved_group_code;
      setTnVedGroupCode(
        rawTn != null && String(rawTn).trim() !== "" ? normalizeTnVedChapterMeta(String(rawTn)) ?? "" : "",
      );
      setRuleId(full.rule_id);
      setFlowStep(target);
      setValidateResult(null);
      dataJsonTouchedRef.current = false;
      dataJsonAutoDraftKeyRef.current = "";
    } catch (e: any) {
      window.alert(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  function newCatalog() {
    setFlowStep(1);
    setNumericCharsDraft(defaultNumericCharacteristicsDraft());
    setDsl(emptyDsl());
    setTnVedGroupCode("");
    setSavedSource(null);
    setRuleId(null);
    setDataJson("{}");
    setValidateResult(null);
    dataJsonTouchedRef.current = false;
    dataJsonAutoDraftKeyRef.current = "";
  }

  async function cloneCatalog(id: string) {
    setBusy(true);
    try {
      const cloned = await cloneRule(id);
      const numericFromMeta = parseNumericCharacteristicsDraft(cloned.dsl?.meta?.numeric_characteristics_draft);
      if (!numericFromMeta) {
        window.alert("Клон не в формате «числовые характеристики». Откройте его в другом разделе.");
        return;
      }
      setNumericCharsDraft({ ...numericFromMeta, modelId: cloned.dsl?.model_id ?? numericFromMeta.modelId });
      setSavedSource("numericCharacteristics");
      setDsl({ ...cloned.dsl, cross_rules: [] });
      const rawTn = cloned.dsl?.meta?.tn_ved_group_code;
      setTnVedGroupCode(
        rawTn != null && String(rawTn).trim() !== "" ? normalizeTnVedChapterMeta(String(rawTn)) ?? "" : "",
      );
      setRuleId(String(cloned.rule_id));
      dataJsonTouchedRef.current = false;
      dataJsonAutoDraftKeyRef.current = "";
      await refreshCatalogs();
    } catch (e: any) {
      window.alert(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onArchiveCatalog(id: string) {
    if (!window.confirm("Отправить справочник в архив?")) return;
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

  const flowTitle =
    flowStep === 1 ? "Шаг 1. Структура" : flowStep === 2 ? "Шаг 2. Классы" : "Шаг 3. Сохранение";

  const tnVedCodeResolved = useMemo(() => {
    const fromState = normalizeTnVedGroupCode(tnVedGroupCode);
    if (fromState) return fromState;
    const raw = dsl?.meta?.tn_ved_group_code;
    if (raw == null || String(raw).trim() === "") return "";
    return normalizeTnVedChapterMeta(String(raw)) ?? "";
  }, [tnVedGroupCode, dsl?.meta?.tn_ved_group_code]);

  const tnVedSummaryLine = useMemo(() => {
    if (!tnVedCodeResolved) return "не выбран";
    return resolveTnVedCodeLabel(tnVedCodeResolved);
  }, [tnVedCodeResolved]);

  const isNewCatalogPristine = useMemo(() => {
    const normalized = normalizeNumericCharacteristicsDraft(numericCharsDraft);
    const hasCatalogName = normalized.catalogName.trim().length > 0;
    const hasTnVed = (normalizeTnVedGroupCode(tnVedGroupCode) ?? "").length > 0;
    const hasNumeric = normalized.characteristics.some((c) =>
      c.layout === "scalar"
        ? !!c.characteristicKey.trim()
        : !!(c.characteristicKey.trim() && c.componentColumnKey.trim()),
    );
    const hasTextArray = (normalized.textArrayFields ?? []).some((t) => t.fieldKey.trim());
    const hasTextScalar = (normalized.textScalarFields ?? []).some((t) => t.fieldKey.trim());
    const hasText = hasTextArray || hasTextScalar;
    const hasMisc = normalized.procheeEnabled;
    return flowStep === 1 && !ruleId && !hasCatalogName && !hasTnVed && !hasNumeric && !hasText && !hasMisc;
  }, [flowStep, ruleId, numericCharsDraft, tnVedGroupCode]);

  return (
    <div className="container">
      {flowStep === 1 ? (
        <>
          <h1 style={{ marginTop: 0, marginBottom: 8 }}>Создание справочника</h1>

          <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
            <button type="button" className="btn-secondary" onClick={newCatalog} disabled={isNewCatalogPristine}>
              Новый справочник
            </button>
          </div>

          <CatalogListSection
            catalogs={catalogs}
            primaryByGroup={primaryByGroup}
            catalogQuery={catalogQuery}
            onCatalogQueryChange={setCatalogQuery}
            includeArchived={includeArchived}
            onIncludeArchivedChange={setIncludeArchived}
            busy={busy}
            onOpenPrimary={(id) => void openCatalog(id, 1)}
            onClone={(id) => void cloneCatalog(id)}
            onArchive={(id) => void onArchiveCatalog(id)}
            onUnarchive={(id) => void onUnarchiveCatalog(id)}
            onDelete={(id) => void onDeleteCatalog(id)}
            openPrimaryLabel="Редактировать"
          />
        </>
      ) : null}

      <div style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "center", flexWrap: "wrap" }}>
        {([1, 2, 3] as const).map((n) => (
          <button
            key={n}
            type="button"
            className={flowStep === n ? "btn" : "btn-secondary"}
            onClick={() => {
              if (n === 1) setFlowStep(1);
              if (n === 2 && savedSource) setFlowStep(2);
              if (n === 3 && savedSource) setFlowStep(3);
            }}
            disabled={n > 1 && !savedSource}
          >
            {n}
          </button>
        ))}
        <span style={{ color: "#64748b", marginLeft: 8 }}>{flowTitle}</span>
      </div>

      {flowStep > 1 && savedSource ? (
        <div
          className="card"
          style={{
            marginBottom: 16,
            padding: "14px 16px",
            background: "linear-gradient(180deg, #f8fafc 0%, #fff 100%)",
            border: "1px solid #e2e8f0",
          }}
        >
          <div style={{ fontSize: 13, color: "#64748b", marginBottom: 6 }}>
            <strong style={{ color: "#475569" }}>ТН ВЭД</strong>{" "}
            <span style={{ color: "#0f172a" }}>{tnVedSummaryLine}</span>
          </div>
          <div style={{ fontSize: 17, fontWeight: 700, color: "#0f172a", lineHeight: 1.35 }}>
            {numericCharsDraft.catalogName.trim() || "(без названия)"}
          </div>
        </div>
      ) : null}

      {flowStep === 1 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h2 style={{ marginTop: 0 }}>Структура</h2>
          <div style={{ marginBottom: 20 }}>
            <TnVedGroupSelect
              id="unified-tn-ved"
              value={tnVedGroupCode}
              onChange={setTnVedGroupCode}
              disabled={busy}
            />
          </div>

          <div style={splitRowStyle}>
            <div style={splitMainColumnStyle}>
              <NumericCharacteristicsForm
                hideInlinePreview
                draft={numericCharsDraft}
                onChange={setNumericCharsDraft}
              />
            </div>
            <JsonSchemaPreviewAside title="Пример JSON" text={numericStructureSampleJsonPreview} emptyHint="{}" />
          </div>

          <div
            style={{
              marginTop: 20,
              paddingTop: 16,
              borderTop: "1px solid #e2e8f0",
              display: "flex",
              gap: 8,
              flexWrap: "wrap",
              alignItems: "center",
            }}
          >
            <button type="button" className="btn" disabled={busy} onClick={() => void handleSave()}>
              Сохранить справочник
            </button>
            <button type="button" className="btn" disabled={!canCompleteStructure()} onClick={goToRulesStep}>
              Далее
            </button>
          </div>
        </div>
      )}

      {flowStep === 2 && savedSource && (
        <div>
          <div style={{ ...splitRowStyle, alignItems: "stretch" }}>
            <div style={splitMainColumnStyle}>
              <div className="card" style={{ marginBottom: 16 }}>
                <h2 style={{ marginTop: 0 }}>Классы</h2>
                <ClassificationRulesPanel
                  value={classificationUi}
                  onChange={setClassificationUi}
                  structureRowDescriptors={structureRowDescriptors}
                />
              </div>
            </div>
            <JsonSchemaPreviewAside
              title="Классификация в JSON"
              text={classificationJsonText}
              editable
              onTextChange={handleClassificationJsonEdit}
              errorHint={classificationJsonError}
              fillViewportHeight
            />
          </div>

          <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap", alignItems: "center" }}>
            <button type="button" className="btn" disabled={busy} onClick={() => void handleSave()}>
              Сохранить справочник
            </button>
            <button type="button" className="btn-secondary" onClick={() => setFlowStep(1)}>
              Назад
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                if (!classificationHasTnVedForAllRules(classificationUi)) {
                  window.alert("Для каждого класса с идентификатором укажите код ТН ВЭД ЕАЭС.");
                  return;
                }
                setFlowStep(3);
              }}
            >
              Далее
            </button>
          </div>
        </div>
      )}

      {flowStep === 3 && savedSource && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Сохранение и проверка</h2>
          {ruleId ? <p style={{ color: "#15803d" }}>{ruleId}</p> : null}
          <textarea
            className="fe-textarea-code"
            style={{ width: "100%", minHeight: 180, padding: 8, borderRadius: 8 }}
            value={dataJson}
            onChange={(e) => {
              dataJsonTouchedRef.current = true;
              setDataJson(e.target.value);
            }}
          />
          {validateResult ? (
            <pre style={{ marginTop: 12, padding: 12, background: "#f1f5f9", borderRadius: 8, overflow: "auto" }}>
              {JSON.stringify(validateResult, null, 2)}
            </pre>
          ) : null}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 16, alignItems: "center" }}>
            <button type="button" className="btn" disabled={busy} onClick={() => void handleSave()}>
              Сохранить справочник
            </button>
            <button type="button" className="btn-secondary" disabled={busy || !ruleId} onClick={() => void handleValidate()}>
              Проверить
            </button>
            <button type="button" className="btn-secondary" onClick={() => setFlowStep(2)}>
              Назад
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
