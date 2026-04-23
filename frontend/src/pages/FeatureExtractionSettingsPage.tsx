/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { EXTRACTION_TEST_INFER_DURATION_FIELD } from "../api/backendInferenceKeys";
import {
  fetchFeatureExtractionModelOperationHistory,
  fetchLlmContainerLogs,
  generateFeatureExtractionSystemPrompt,
  getRule,
  listFeatureExtractionModels,
  listRules,
  saveRule,
  testFeatureExtractionPrompt,
  type ModelOperationHistoryEvent,
} from "../api/client";
import { buildFeatureExtractionPromptGeneratorRequest } from "../expert/featureExtractionPromptGenerator";
import SemanticFallbackSettingsPage from "./SemanticFallbackSettingsPage";
import FeatureExtractionModelAdmin from "../ui/FeatureExtractionModelAdmin";
import FeatureExtractionLlmConsole, { type LlmOperationLogState } from "../ui/FeatureExtractionLlmConsole";
import FewShotPromptAssistant from "../ui/FewShotPromptAssistant";
import DatasetImportPanel from "../ui/DatasetImportPanel";
import { LongOperationStatusBar } from "../ui/LongOperationStatusBar";
import { ModalCloseButton } from "../ui/ModalCloseButton";
import { TableColumnPreviewModal } from "../ui/TableColumnPreviewModal";
import { formatElapsedSec, useElapsedSeconds } from "../hooks/useElapsedSeconds";
import { finalizeRowInput, rowRangeBounds, type RowInputValue } from "../utils/rowRangeNumericInput";
import { normalizeCell, parseUploadedTableFile, type ParsedTable } from "../utils/tableFileParse";

type RuleListItem = {
  rule_id: string;
  name?: string | null;
  model_id?: string | null;
  tn_ved_group_code?: string | null;
};

type BatchPromptTestRow = {
  /** Номер строки в загруженных данных (1 = первая строка после заголовка в CSV/XLSX). */
  rowNumber: number;
  text: string;
  ok: boolean;
  parsedText: string;
  raw?: any;
  error?: string;
  timing?: string;
};

const MODEL_OPTIONS = [
  "llama3.1:8b",
  "gemma2:2b",
  "codegemma:7b",
  "qwen2.5:3b-instruct",
  "qwen3:4b-q4_K_M",
  "qwen3:8b-q4_K_M",
  "qwen3.5:4b",
  "qwen3.5:9b",
  "ministral:3b-reasoning",
  "ministral:8b-instruct",
  "ministral:14b-instruct",
];

type FeatureExtractionConfig = {
  id: string;
  name: string;
  selected_models: string[];
  /**
   * Если одна и та же LLM отмечена в нескольких конфигурациях — ровно одна должна быть основной
   * (сохраняется как feature_extraction_primary в DSL; пайплайн выбирает её для извлечения).
   */
  feature_extraction_primary: boolean;
  /** Один промпт на всю конфигурацию; в DSL дублируется в `prompts_by_model` для каждой выбранной модели (совместимость). */
  prompt: string;
  /**
   * Только constrained decoding (llguidance). Текст промпта — в `prompt`, не из «шаблонов».
   * В meta пишем structured_output + use_guidance (см. extractionRuntimeToDsl).
   */
  extraction_runtime: {
    constrained_decoding: boolean;
  };
};

function defaultExtractionRuntime(): FeatureExtractionConfig["extraction_runtime"] {
  return {
    constrained_decoding: false,
  };
}

/** Сериализация в meta DSL / вызов теста: structured JSON + constrained decoding через guidance. */
function extractionRuntimeToDsl(ui: FeatureExtractionConfig["extraction_runtime"]): {
  structured_output: boolean;
  use_guidance: boolean;
} {
  const use_guidance = Boolean(ui.constrained_decoding);
  return {
    structured_output: true,
    use_guidance,
  };
}

/** Из сохранённого DSL: use_guidance и legacy Outlines → одна галка в UI. */
function extractionRuntimeFromStored(c: any): FeatureExtractionConfig["extraction_runtime"] {
  const er = c?.extraction_runtime ?? {};
  const legacyConstrained = Boolean(er.use_outlines) || Boolean(er.pydantic_outlines);
  return {
    constrained_decoding: Boolean(er.use_guidance) || legacyConstrained,
  };
}

function buildRulesPreviewFromDsl(dsl: any): string {
  const lines: string[] = [];
  const modelId = String(dsl?.model_id ?? "").trim();
  const tnved = String(dsl?.meta?.tn_ved_group_code ?? "").trim();
  const schemaProps: any[] = Array.isArray(dsl?.schema?.properties) ? dsl.schema.properties : [];
  const ncDraft = dsl?.meta?.numeric_characteristics_draft;
  const draftChars: any[] = Array.isArray(ncDraft?.characteristics) ? ncDraft.characteristics : [];

  lines.push("AUTO RULES FROM CATALOG");
  if (modelId) lines.push(`model_id: ${modelId}`);
  if (tnved) lines.push(`tn_ved_group_code: ${tnved}`);
  lines.push("");
  lines.push("Extract numeric features:");

  if (draftChars.length > 0) {
    for (const ch of draftChars) {
      const key = String(ch?.characteristicKey ?? "").trim();
      const col = String(ch?.componentColumnKey ?? "").trim();
      const unit = String(ch?.unit ?? "").trim();
      if (!key) continue;
      lines.push(`- ${key}${unit ? ` [${unit}]` : ""}${col ? ` -> ${col}` : ""}`);
    }
  } else if (schemaProps.length > 0) {
    for (const p of schemaProps) {
      const key = String(p?.name ?? "").trim();
      const type = String(p?.type ?? "").trim();
      if (!key) continue;
      lines.push(`- ${key}${type ? ` (${type})` : ""}`);
    }
  } else {
    lines.push("- В описании справочника не заданы явные числовые характеристики");
  }

  lines.push("");
  lines.push("Output format:");
  lines.push("- Return strict JSON object only");
  lines.push('- Use key "numeric_features"');
  lines.push("- Keep numeric values normalized (dot as decimal separator)");

  return lines.join("\n");
}

/** Распарсенная полезная нагрузка из ответа теста извлечения. */
function getExtractionParsedPayload(res: any): unknown {
  if (!res || typeof res !== "object") return undefined;
  return res.parsed_from_model ?? res.parsed_from_raw_input ?? res.json_recovery?.parsed;
}

/** JSON с отступами (как раньше). */
function formatParsedExtractionResult(res: any): string {
  const p = getExtractionParsedPayload(res);
  if (p === undefined || p === null) return "—";
  if (typeof p === "string") return p;
  try {
    return JSON.stringify(p, null, 2);
  } catch {
    return String(p);
  }
}

function isPlainRecord(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

function formatScalarRu(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "—";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return String(v);
}

const IND = "  ";

/** Пара [a,b] чисел/null — диапазон «от … до …». */
function formatPairAsRange(arr: unknown[]): string | null {
  if (arr.length !== 2) return null;
  const [a, b] = arr;
  const isNumOrNull = (x: unknown) =>
    x === null || x === undefined || (typeof x === "number" && Number.isFinite(x));
  if (!isNumOrNull(a) || !isNumOrNull(b)) return null;
  const fa = a === null || a === undefined ? "—" : String(a);
  const fb = b === null || b === undefined ? "—" : String(b);
  return `от ${fa} до ${fb}`;
}

/** Человекочитаемый итог: диапазоны, блоки массовая доля/прочее, без лишних переносов. */
function formatParsedExtractionReadable(res: any): string {
  const p = getExtractionParsedPayload(res);
  if (p === undefined) return "—";
  if (p === null) return "null";
  if (typeof p === "string") return p;
  if (typeof p === "number" || typeof p === "boolean") return String(p);
  if (Array.isArray(p)) return formatReadableArray(p, 0);
  if (
    isPlainRecord(p) &&
    (Object.prototype.hasOwnProperty.call(p, "массовая доля") ||
      Object.prototype.hasOwnProperty.call(p, "прочее"))
  ) {
    return formatMassFractionStylePayload(p);
  }
  if (isPlainRecord(p)) return formatReadableObject(p, 0);
  return String(p);
}

function formatNestedMassDoliaValue(v: unknown, depth: number): string[] {
  const ind = IND.repeat(depth);
  const indBullet = IND.repeat(depth + 1);
  if (typeof v === "number") return [`${ind}массовая доля: ${v}`];
  if (Array.isArray(v)) {
    const range = formatPairAsRange(v);
    if (range) return [`${ind}массовая доля: ${range}`];
    if (v.length === 0) return [`${ind}массовая доля: —`];
    const lines = [`${ind}массовая доля:`];
    v.forEach((el, idx) => {
      lines.push(`${indBullet}${idx + 1}) ${formatScalarRu(el)}`);
    });
    return lines;
  }
  if (isPlainRecord(v)) {
    const lines: string[] = [`${ind}массовая доля:`];
    for (const [k, val] of Object.entries(v)) {
      lines.push(...formatReadableKeyValue(k, val, depth + 1));
    }
    return lines;
  }
  return [`${ind}массовая доля: ${formatScalarRu(v)}`];
}

function formatMassFractionItemBlock(item: unknown, depthBase: number): string[] {
  const out: string[] = [];
  if (!isPlainRecord(item)) {
    out.push(`${IND.repeat(depthBase)}${formatScalarRu(item)}`);
    return out;
  }
  const o = item;
  if ("вещество" in o) {
    out.push(`${IND.repeat(depthBase)}вещество: ${formatScalarRu(o["вещество"])}`);
  }
  if ("массовая доля" in o) {
    out.push(...formatNestedMassDoliaValue(o["массовая доля"], depthBase));
  }
  for (const [k, v] of Object.entries(o)) {
    if (k === "вещество" || k === "массовая доля") continue;
    out.push(...formatReadableKeyValue(k, v, depthBase));
  }
  return out;
}

function formatProcheeItemBlock(item: unknown, depthBase: number): string[] {
  if (!isPlainRecord(item)) {
    return [`${IND.repeat(depthBase)}${formatScalarRu(item)}`];
  }
  const keys = Object.keys(item);
  keys.sort((a, b) => {
    if (a === "параметр") return -1;
    if (b === "параметр") return 1;
    return a.localeCompare(b, "ru");
  });
  const lines: string[] = [];
  for (const k of keys) {
    lines.push(...formatReadableKeyValue(k, item[k], depthBase));
  }
  return lines;
}

function formatMassFractionStylePayload(o: Record<string, unknown>): string {
  const lines: string[] = [];
  const keys = Object.keys(o);
  const order = ["массовая доля", "прочее"];
  const ordered = order.filter((k) => keys.includes(k));
  const rest = keys.filter((k) => !ordered.includes(k)).sort((a, b) => a.localeCompare(b, "ru"));

  for (const key of ordered) {
    const val = o[key];
    if (key === "массовая доля" && Array.isArray(val)) {
      lines.push("массовая доля:");
      val.forEach((item, idx) => {
        lines.push(`${IND}${idx + 1})`);
        lines.push(...formatMassFractionItemBlock(item, 2));
      });
      continue;
    }
    if (key === "прочее" && Array.isArray(val)) {
      lines.push("прочее:");
      val.forEach((item, idx) => {
        lines.push(`${IND}${idx + 1})`);
        lines.push(...formatProcheeItemBlock(item, 2));
      });
      continue;
    }
    lines.push(...formatReadableKeyValue(key, val, 0));
  }

  for (const key of rest) {
    lines.push(...formatReadableKeyValue(key, o[key], 0));
  }

  return lines.join("\n").trim();
}

function formatReadableKeyValue(key: string, val: unknown, depth: number): string[] {
  const ind = IND.repeat(depth);
  if (
    val === null ||
    val === undefined ||
    typeof val === "string" ||
    typeof val === "number" ||
    typeof val === "boolean"
  ) {
    return [`${ind}${key}: ${formatScalarRu(val)}`];
  }
  if (Array.isArray(val)) {
    const range = formatPairAsRange(val);
    if (range) return [`${ind}${key}: ${range}`];
    if (val.length === 0) return [`${ind}${key}: —`];
    const lines: string[] = [`${ind}${key}:`];
    val.forEach((el, idx) => {
      if (isPlainRecord(el)) {
        lines.push(`${IND.repeat(depth + 1)}${idx + 1})`);
        lines.push(formatReadableObject(el, depth + 2));
      } else {
        const r = Array.isArray(el) ? formatPairAsRange(el) : null;
        lines.push(`${IND.repeat(depth + 1)}${idx + 1}) ${r ?? formatScalarRu(el)}`);
      }
    });
    return lines;
  }
  if (isPlainRecord(val)) {
    const sub = formatReadableObject(val, depth + 1);
    if (!sub.includes("\n")) return [`${ind}${key}: ${sub}`];
    return [`${ind}${key}:`, sub];
  }
  return [`${ind}${key}: ${formatScalarRu(val)}`];
}

function formatReadableObject(o: Record<string, unknown>, depth: number): string {
  const keys = Object.keys(o);
  if (keys.length === 0) return `${IND.repeat(depth)}—`;
  keys.sort((a, b) => a.localeCompare(b, "ru"));
  return keys
    .map((k) => formatReadableKeyValue(k, o[k], depth).join("\n"))
    .join("\n");
}

function formatReadableArray(x: unknown[], depth: number): string {
  if (x.length === 0) return `${IND.repeat(depth)}—`;
  const range = formatPairAsRange(x);
  if (range) return range;
  return x
    .map((item, idx) => {
      if (isPlainRecord(item)) {
        return [`${IND.repeat(depth)}${idx + 1})`, formatReadableObject(item, depth + 1)].join("\n");
      }
      const r = Array.isArray(item) ? formatPairAsRange(item) : null;
      return `${IND.repeat(depth)}${idx + 1}) ${r ?? formatScalarRu(item)}`;
    })
    .join("\n");
}

/** Длительность извлечения из ответа `/api/feature-extraction/test`. */
function formatExtractionTiming(res: any): string | null {
  if (!res || typeof res !== "object") return null;
  const wall = res.extraction_request_duration_sec;
  const inferRaw = (res as Record<string, unknown>)[EXTRACTION_TEST_INFER_DURATION_FIELD];
  const inferSec = typeof inferRaw === "number" ? inferRaw : undefined;
  const parseOnly = res.parse_only_duration_sec;
  const parts: string[] = [];
  if (typeof wall === "number") parts.push(`запрос извлечения: ${wall} с`);
  if (typeof inferSec === "number") parts.push(`инференс модели: ${inferSec} с`);
  if (typeof parseOnly === "number" && parts.length === 0) parts.push(`разбор без вызова модели: ${parseOnly} с`);
  return parts.length ? parts.join(" · ") : null;
}

function newConfigId(): string {
  return `cfg-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

/** Убираем из meta устаревшие поля (не должны снова попадать в JSON при сохранении). */
function stripLegacyMetaFields(meta: unknown): Record<string, unknown> {
  if (!meta || typeof meta !== "object") return {};
  const m = { ...(meta as Record<string, unknown>) };
  delete m.feature_extraction_model;
  delete m.feature_extraction_prompt;
  delete m.selected_model;
  return m;
}

/** Из сохранённого meta: приоритет поля `prompt`, иначе первое непустое из `prompts_by_model`. */
function promptFromStoredConfig(c: any, selected_models: string[]): string {
  if (typeof c?.prompt === "string") return c.prompt;
  const pbm = c?.prompts_by_model;
  if (pbm && typeof pbm === "object" && !Array.isArray(pbm)) {
    for (const m of selected_models) {
      const v = (pbm as Record<string, unknown>)[m];
      if (v != null && String(v).trim()) return String(v);
    }
    for (const v of Object.values(pbm as Record<string, unknown>)) {
      if (v != null && String(v).trim()) return String(v);
    }
  }
  return "";
}

function promptsByModelForDsl(prompt: string, selected_models: string[]): Record<string, string> {
  const text = String(prompt ?? "");
  return Object.fromEntries(selected_models.map((m) => [m, text]));
}

function defaultConfig(name: string, initialTag: string): FeatureExtractionConfig {
  const tag = initialTag || MODEL_OPTIONS[0];
  return {
    id: newConfigId(),
    name,
    selected_models: [tag],
    feature_extraction_primary: false,
    prompt: "",
    extraction_runtime: defaultExtractionRuntime(),
  };
}

/** Одна и та же модель отмечена в двух и более конфигурациях (по разным id). */
function modelsSharedAcrossConfigs(configs: FeatureExtractionConfig[]): boolean {
  const modelToCfgIds = new Map<string, Set<string>>();
  for (const c of configs) {
    for (const m of c.selected_models) {
      if (!m) continue;
      let set = modelToCfgIds.get(m);
      if (!set) {
        set = new Set();
        modelToCfgIds.set(m, set);
      }
      set.add(c.id);
    }
  }
  for (const set of modelToCfgIds.values()) {
    if (set.size > 1) return true;
  }
  return false;
}

/** Проверка статуса «основная» при дублировании моделей между конфигурациями. */
function validateFeatureExtractionPrimary(configs: FeatureExtractionConfig[]): string | null {
  const primaryCount = configs.filter((c) => c.feature_extraction_primary).length;
  if (primaryCount > 1) {
    return "Может быть только одна конфигурация со статусом «Основная конфигурация».";
  }
  if (modelsSharedAcrossConfigs(configs) && primaryCount !== 1) {
    return "Модель отмечена в нескольких конфигурациях — отметьте ровно одну как «Основная конфигурация».";
  }
  return null;
}

function RunningModelsBanner({ runningModels }: { runningModels: string[] }) {
  return (
    <div
      style={{
        marginBottom: 14,
        padding: "8px 14px",
        background: runningModels.length > 0 ? "#eff6ff" : "#f8fafc",
        border: "1px solid #e2e8f0",
        borderRadius: 8,
        fontSize: 13,
        color: "#334155",
      }}
    >
      <span style={{ fontWeight: 600 }}>Запущенные модели: </span>
      {runningModels.length === 0 ? (
        <span style={{ color: "#64748b" }}>нет запущенных.</span>
      ) : (
        <>
          {runningModels.map((m) => (
            <code key={m} style={{ marginRight: 8, fontSize: 13 }}>
              {m}
            </code>
          ))}
        </>
      )}
    </div>
  );
}

/** Подстраницы настроек извлечения: каталог → промпты; models и SimCheck — отдельные вкладки. */
function featureExtractionSubpage(pathname: string): "catalog" | "prompts" | "dataset" | "models" | "simcheck" {
  if (pathname.endsWith("/simcheck")) return "simcheck";
  if (pathname.endsWith("/models")) return "models";
  if (pathname.endsWith("/dataset")) return "dataset";
  if (pathname.endsWith("/prompts") || pathname.endsWith("/test")) return "prompts";
  return "catalog";
}

export default function FeatureExtractionSettingsPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const featureBasePath = location.pathname.startsWith("/expert/") ? "/expert/feature-extraction" : "/feature-extraction";
  const subpage = featureExtractionSubpage(location.pathname);
  const featurePageH1 =
    subpage === "models"
      ? "Администрирование моделей"
      : subpage === "simcheck"
        ? "Другие настройки сервисов"
        : subpage === "prompts"
          ? "2. Конфигурация и промпты"
          : subpage === "dataset"
            ? "3. Подгрузить датасет"
            : "1. Справочник";
  const isModelAdminPage = subpage === "models";
  /** Верхняя «Настройки по справочникам» — только ветка каталог/промпты, не simcheck и не models. */
  const isCatalogSettingsTopTab = subpage === "catalog" || subpage === "prompts" || subpage === "dataset";
  const [runningModels, setRunningModels] = useState<string[]>([]);
  /** Состояние консоли модели: показ только на вкладке «Администрирование моделей», при повторном входе текст сохраняется. */
  const [llmConsole, setLlmConsole] = useState<LlmOperationLogState>(null);
  const [llmContainerLogs, setLlmContainerLogs] = useState<string | null>(null);
  /** Журнал deploy/pause/delete с api-gateway (память процесса шлюза). */
  const [modelOpHistory, setModelOpHistory] = useState<ModelOperationHistoryEvent[]>([]);
  const [modelOpHistoryError, setModelOpHistoryError] = useState<string | null>(null);
  /** Ключи из JSON админки «Администрирование моделей» (объект models в БД). */
  const [adminModelTags, setAdminModelTags] = useState<string[]>([]);

  const [catalogs, setCatalogs] = useState<RuleListItem[]>([]);
  const [busy, setBusy] = useState(false);
  /** Чем занят `busy`: загрузка справочника или сохранение настроек — для текста в статус-баре. */
  const [catalogBusyReason, setCatalogBusyReason] = useState<"load" | "save" | null>(null);
  /** Прогресс по шагам для генерации промпта и тестов (N из M). */
  const [llmOpProgress, setLlmOpProgress] = useState<{ done: number; total: number } | null>(null);
  const [selectedRuleId, setSelectedRuleId] = useState("");
  const [catalogName, setCatalogName] = useState("");
  const [configs, setConfigs] = useState<FeatureExtractionConfig[]>([]);
  const [activeConfigId, setActiveConfigId] = useState("");
  const [loadedDsl, setLoadedDsl] = useState<any>(null);
  const [loadedModelId, setLoadedModelId] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** Ошибки ввода/проверки внутри модальных окон: показываются поверх всех окон. */
  const [popupError, setPopupError] = useState<string | null>(null);
  const [testBusy, setTestBusy] = useState(false);
  const [promptGenBusy, setPromptGenBusy] = useState(false);
  const [promptGenModel, setPromptGenModel] = useState("");
  /** Несколько полей «Текст для извлечения» в окне проверки; каждое непустое — отдельный запрос к модели. */
  const [sampleTexts, setSampleTexts] = useState<string[]>([""]);
  /** Результаты последнего прогона «Проверить» по одному/нескольким примерам. */
  const [singlePromptTestResults, setSinglePromptTestResults] = useState<{ sample: string; result: any }[] | null>(null);
  const [testDetailsExpanded, setTestDetailsExpanded] = useState(false);
  const [testModel, setTestModel] = useState("");
  const [testMode, setTestMode] = useState<"single" | "batch">("single");
  const [batchTable, setBatchTable] = useState<ParsedTable>({ columns: [], rows: [] });
  const [batchTextColumn, setBatchTextColumn] = useState("");
  /** Включительно, номера строк данных (1-based). */
  const [batchDataRowStart, setBatchDataRowStart] = useState<RowInputValue>(1);
  const [batchDataRowEnd, setBatchDataRowEnd] = useState<RowInputValue>(1);
  const [batchResults, setBatchResults] = useState<BatchPromptTestRow[]>([]);
  const [batchSummary, setBatchSummary] = useState<string>("");
  const [batchPickerOpen, setBatchPickerOpen] = useState(false);
  const [batchColumnDraft, setBatchColumnDraft] = useState("");
  const [singleTestModalOpen, setSingleTestModalOpen] = useState(false);
  const [batchTestModalOpen, setBatchTestModalOpen] = useState(false);
  const [fewShotExpanded, setFewShotExpanded] = useState(false);
  const modelStripRef = useRef<HTMLDivElement | null>(null);

  const elapsedPromptGen = useElapsedSeconds(promptGenBusy);
  const elapsedTest = useElapsedSeconds(testBusy);
  /** Загрузка/сохранение справочника (без параллельной генерации промпта и теста). */
  const elapsedCatalogOps = useElapsedSeconds(busy && !promptGenBusy && !testBusy);

  /** Лента чекбоксов: каталог из админки + теги, уже отмеченные в конфигах этого справочника (чтобы не терять устаревшие привязки). */
  const availableModels = useMemo(() => {
    const fromAdmin = adminModelTags.length > 0 ? adminModelTags : MODEL_OPTIONS;
    const set = new Set<string>(fromAdmin);
    for (const c of configs) {
      for (const m of c.selected_models) {
        if (m) set.add(m);
      }
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [adminModelTags, configs]);

  /** Технический тег для инициализации пустой конфигурации (подстановка в форме, не отдельная сущность в продукте). */
  const bootstrapDefaultModelTag = useMemo(() => {
    if (runningModels.length === 1) return runningModels[0];
    if (adminModelTags.length > 0) return adminModelTags[0];
    return MODEL_OPTIONS[0];
  }, [runningModels, adminModelTags]);

  const activeConfig = useMemo(
    () => configs.find((c) => c.id === activeConfigId) ?? null,
    [configs, activeConfigId],
  );

  const extractionModelsShared = useMemo(() => modelsSharedAcrossConfigs(configs), [configs]);

  /** Модель для теста: только из отмеченных для активной конфигурации (шаг 2). */
  const testModelResolved = useMemo(() => {
    if (!activeConfig?.selected_models?.length) return "";
    const sm = activeConfig.selected_models;
    return sm.includes(testModel) ? testModel : sm[0];
  }, [activeConfig, testModel]);

  useEffect(() => {
    if (!activeConfig) return;
    if (!testModel || !activeConfig.selected_models.includes(testModel)) {
      setTestModel(activeConfig.selected_models[0] ?? "");
    }
  }, [activeConfigId, activeConfig, testModel]);

  /** Модель для LLM-генератора системного промпта: из отмеченных для конфигурации, по умолчанию первая запущенная. */
  useEffect(() => {
    if (!activeConfig) {
      setPromptGenModel("");
      return;
    }
    const sm = activeConfig.selected_models;
    const pick = sm.find((m) => runningModels.includes(m)) ?? sm[0] ?? "";
    setPromptGenModel((prev) => (sm.includes(prev) ? prev : pick));
  }, [activeConfig, activeConfigId, runningModels]);

  /** Модель для теста должна быть уже запущена на сервере (список из админки); иначе тест не вызывает инференс — не поднимаем модель с этой страницы. */
  const isTestModelRunning = useMemo(() => {
    const m = testModelResolved.trim();
    if (!m) return false;
    return runningModels.includes(m);
  }, [testModelResolved, runningModels]);

  const catalogSelected = Boolean(selectedRuleId);
  const editorReady = catalogSelected && !busy && Boolean(loadedDsl) && Boolean(activeConfig);

  const canRunPromptTest = useMemo(() => {
    if (!activeConfig) return false;
    const hasSample = sampleTexts.some((s) => s.trim().length > 0);
    const hasPrompt = String(activeConfig.prompt ?? "").trim().length > 0;
    return hasSample && hasPrompt && isTestModelRunning;
  }, [activeConfig, sampleTexts, isTestModelRunning]);

  const singleSamplesNonEmptyCount = useMemo(
    () => sampleTexts.filter((s) => s.trim().length > 0).length,
    [sampleTexts],
  );
  const singleSamplesTotalChars = useMemo(
    () => sampleTexts.reduce((acc, s) => acc + s.trim().length, 0),
    [sampleTexts],
  );

  const batchColumnIndex = useMemo(
    () => batchTable.columns.findIndex((c) => c === batchTextColumn),
    [batchTable.columns, batchTextColumn],
  );

  const batchColumnDraftIndex = useMemo(() => {
    const i = batchTable.columns.findIndex((c) => c === batchColumnDraft);
    return i >= 0 ? i : 0;
  }, [batchTable.columns, batchColumnDraft]);

  const batchRowRange = useMemo(() => {
    const n = batchTable.rows.length;
    if (batchColumnIndex < 0 || n === 0) {
      return {
        items: [] as { rowNumber: number; text: string }[],
        start: 1,
        end: 0,
        rowCount: 0,
        incomplete: false,
      };
    }
    const { s0, e0, incomplete } = rowRangeBounds(batchDataRowStart, batchDataRowEnd, n);
    let lo = Math.min(Math.max(1, Math.floor(s0)), n);
    let hi = Math.min(Math.max(1, Math.floor(e0)), n);
    if (lo > hi) [lo, hi] = [hi, lo];
    const items: { rowNumber: number; text: string }[] = [];
    for (let i = lo - 1; i <= hi - 1; i += 1) {
      items.push({
        rowNumber: i + 1,
        text: normalizeCell(batchTable.rows[i][batchColumnIndex]),
      });
    }
    return { items, start: lo, end: hi, rowCount: n, incomplete };
  }, [batchTable.rows, batchColumnIndex, batchDataRowStart, batchDataRowEnd]);

  /** Название/ТН ВЭД выбранного справочника (если строка есть в `catalogs`). */
  const selectedCatalogSummaryLine = useMemo(() => {
    if (!selectedRuleId) return "";
    const c = catalogs.find((x) => String(x.rule_id) === String(selectedRuleId));
    if (!c) return "";
    return `${c.name?.trim() || c.model_id || "Без названия"}${c.tn_ved_group_code ? ` · ТН ВЭД: ${c.tn_ved_group_code}` : ""}`;
  }, [selectedRuleId, catalogs]);

  const refreshAvailableModels = useCallback(async () => {
    try {
      const data = await listFeatureExtractionModels();
      setAdminModelTags(
        Array.isArray(data.configured_models) ? data.configured_models.map((x) => String(x).trim()).filter(Boolean) : [],
      );
      setRunningModels(Array.isArray(data.running_models) ? data.running_models.map(String) : []);
    } catch {
      setAdminModelTags([]);
      setRunningModels([]);
    }
  }, []);

  const loadLlmContainerLogs = useCallback(async () => {
    try {
      const data = await fetchLlmContainerLogs(4000);
      setLlmContainerLogs(typeof data.lines === "string" ? data.lines : "");
    } catch (e: any) {
      setLlmContainerLogs(e?.message ?? "Ошибка загрузки логов");
    }
  }, []);

  const loadModelOpHistory = useCallback(async () => {
    try {
      const data = await fetchFeatureExtractionModelOperationHistory();
      setModelOpHistory(data.events);
      setModelOpHistoryError(null);
    } catch (e: any) {
      setModelOpHistoryError(e?.message ?? "Не удалось загрузить журнал операций");
    }
  }, []);

  const mergedLlmConsoleText = useMemo(() => {
    const journalHeader =
      "=== Журнал операций с моделями (API gateway, память процесса) ===\n" +
      "События deploy/pause/delete и авто-детект runtime-start/runtime-stop/runtime-error; история доступна, пока контейнер api-gateway не перезапущен.\n";
    let journalBlock: string;
    if (modelOpHistoryError) {
      journalBlock = `${journalHeader}\nОшибка загрузки журнала: ${modelOpHistoryError}\n`;
    } else if (modelOpHistory.length === 0) {
      journalBlock = `${journalHeader}\n(записей пока нет)\n`;
    } else {
      const lines = modelOpHistory.map((ev) => {
        const st = ev.ok ? "OK" : "FAIL";
        const detail = ev.detail.trim() ? ` | ${ev.detail.replace(/\s+/g, " ").trim()}` : "";
        return `${ev.ts_iso}  ${ev.kind}  ${ev.model}  ${st}  http=${ev.http_status}${detail}`;
      });
      journalBlock = `${journalHeader}\n${lines.join("\n")}\n`;
    }

    const docker = llmContainerLogs ?? "Загрузка…";
    if (!llmConsole) {
      return [
        journalBlock,
        "",
        "=== Хвост логов контейнера (docker logs) ===",
        "",
        docker,
      ].join("\n");
    }
    const title =
      `Операция с моделью ${llmConsole.model}` +
      (llmConsole.durationSec != null && llmConsole.ok ? ` · ${llmConsole.durationSec} с (сервер)` : "") +
      (!llmConsole.ok ? " · ошибка" : "");
    return [
      journalBlock,
      "",
      "=== Хвост логов контейнера (docker logs) ===",
      "",
      docker,
      "",
      "=== Результат последней операции (API) ===",
      title,
      "",
      llmConsole.log,
    ].join("\n");
  }, [llmConsole, llmContainerLogs, modelOpHistory, modelOpHistoryError]);

  useEffect(() => {
    if (!isModelAdminPage) return;
    void loadLlmContainerLogs();
    void loadModelOpHistory();
    const id = window.setInterval(() => {
      void loadLlmContainerLogs();
      void loadModelOpHistory();
    }, 2000);
    return () => window.clearInterval(id);
  }, [loadLlmContainerLogs, loadModelOpHistory, isModelAdminPage]);

  async function refreshCatalogs() {
    try {
      const data = await listRules();
      setCatalogs(Array.isArray(data) ? data : []);
    } catch (e: any) {
      setError(e?.message ?? "Не удалось загрузить справочники");
      setCatalogs([]);
    }
  }

  useEffect(() => {
    void refreshCatalogs();
    void refreshAvailableModels();
  }, [refreshAvailableModels]);

  /** После возврата с вкладки «Модели» или при переключении на промпты/тест — подтянуть актуальный каталог из админки. */
  useEffect(() => {
    const p = location.pathname.replace(/\/$/, "");
    if (p.endsWith("/test")) {
      navigate(`${featureBasePath}/prompts`, { replace: true });
    }
  }, [location.pathname, navigate, featureBasePath]);

  useEffect(() => {
    if (subpage === "prompts") {
      void refreshAvailableModels();
    }
  }, [subpage, refreshAvailableModels]);

  async function loadRule(ruleId: string) {
    if (!ruleId) {
      setLoadedDsl(null);
      setLoadedModelId("");
      setCatalogName("");
      setConfigs([]);
      setActiveConfigId("");
      setTestModel("");
      setSinglePromptTestResults(null);
      setSampleTexts([""]);
      setTestDetailsExpanded(false);
      setError(null);
      return;
    }
    setBusy(true);
    setCatalogBusyReason("load");
    setError(null);
    setSinglePromptTestResults(null);
    setTestDetailsExpanded(false);
    try {
      const full = await getRule(ruleId);
      const dsl = full?.dsl ?? {};
      const meta = dsl?.meta ?? {};
      const rawConfigs: any[] = Array.isArray(meta.feature_extraction_configs) ? meta.feature_extraction_configs : [];
      const parsedConfigs: FeatureExtractionConfig[] = rawConfigs
        .map((c) => {
          const selected_models =
            Array.isArray(c?.selected_models) && c.selected_models.length > 0
              ? c.selected_models.map((x: any) => String(x).trim()).filter(Boolean)
              : [String(c?.model ?? bootstrapDefaultModelTag).trim() || bootstrapDefaultModelTag];
          const prompt = promptFromStoredConfig(c, selected_models);
          return {
            id: String(c?.id ?? "").trim(),
            name: String(c?.name ?? "").trim(),
            selected_models,
            feature_extraction_primary: Boolean(c?.feature_extraction_primary),
            prompt,
            extraction_runtime: extractionRuntimeFromStored(c),
          };
        })
        .filter((c) => c.id && c.name);
      const migratedFromLegacy =
        parsedConfigs.length === 0 && (meta.feature_extraction_model || meta.feature_extraction_prompt)
          ? (() => {
              const leg = String(meta.feature_extraction_model ?? bootstrapDefaultModelTag).trim() || bootstrapDefaultModelTag;
              return [
                {
                  id: newConfigId(),
                  name: "Основная конфигурация",
                  selected_models: [leg],
                  feature_extraction_primary: true,
                  prompt: String(meta.feature_extraction_prompt || ""),
                  extraction_runtime: defaultExtractionRuntime(),
                },
              ];
            })()
          : [];
      let nextConfigs =
        parsedConfigs.length > 0
          ? parsedConfigs
          : migratedFromLegacy.length > 0
            ? migratedFromLegacy
            : [defaultConfig("Конфигурация 1", bootstrapDefaultModelTag)];
      const requestedActive = String(meta.feature_extraction_active_config_id || "").trim();
      const nextActive = nextConfigs.some((c) => c.id === requestedActive) ? requestedActive : nextConfigs[0].id;

      setLoadedDsl({
        ...dsl,
        meta: stripLegacyMetaFields(dsl.meta) as any,
      });
      setLoadedModelId((full?.model_id ?? dsl?.model_id ?? "").trim());
      setCatalogName(String(full?.name ?? dsl?.meta?.name ?? "").trim());
      setConfigs(nextConfigs);
      setActiveConfigId(nextActive);
      const active = nextConfigs.find((c) => c.id === nextActive) ?? nextConfigs[0];
      setTestModel(active?.selected_models?.[0] ?? "");
      const primaryErr = validateFeatureExtractionPrimary(nextConfigs);
      if (primaryErr) setError(primaryErr);
    } catch (e: any) {
      setError(e?.message ?? "Не удалось загрузить справочник");
      setLoadedDsl(null);
      setLoadedModelId("");
      setCatalogName("");
      setConfigs([]);
      setActiveConfigId("");
    } finally {
      setBusy(false);
      setCatalogBusyReason(null);
    }
  }

  async function savePromptSettings() {
    if (!selectedRuleId || !loadedDsl) return;
    if (!activeConfig) {
      setError("Выберите активную конфигурацию.");
      return;
    }
    if (!activeConfig.selected_models.length) {
      setError("Отметьте хотя бы одну модель для конфигурации.");
      return;
    }
    if (!String(activeConfig.prompt ?? "").trim()) {
      setError("Задайте промпт конфигурации.");
      return;
    }

    const primaryErr = validateFeatureExtractionPrimary(configs);
    if (primaryErr) {
      setError(primaryErr);
      return;
    }

    setBusy(true);
    setCatalogBusyReason("save");
    setError(null);
    try {
      const payload = {
        ...loadedDsl,
        model_id: loadedModelId || loadedDsl?.model_id,
        meta: {
          ...stripLegacyMetaFields(loadedDsl?.meta),
          name: catalogName.trim() || undefined,
          feature_extraction_configs: configs.map((c) => ({
            id: c.id,
            name: c.name.trim() || "Без названия",
            selected_models: c.selected_models,
            feature_extraction_primary: c.feature_extraction_primary,
            prompt: c.prompt,
            prompts_by_model: promptsByModelForDsl(c.prompt, c.selected_models),
            extraction_runtime: extractionRuntimeToDsl(c.extraction_runtime),
            extraction_rules_preview: buildRulesPreviewFromDsl(loadedDsl),
          })),
          feature_extraction_active_config_id: activeConfigId,
        },
      };
      await saveRule(payload, selectedRuleId);
      setLoadedDsl(payload);
      await refreshCatalogs();
    } catch (e: any) {
      setError(e?.message ?? "Не удалось сохранить настройки.");
    } finally {
      setBusy(false);
      setCatalogBusyReason(null);
    }
  }

  function updateActiveConfig(nextPatch: Partial<FeatureExtractionConfig>) {
    if (!activeConfig) return;
    setConfigs((prev) => prev.map((c) => (c.id === activeConfig.id ? { ...c, ...nextPatch } : c)));
  }

  function addConfig() {
    const pool = availableModels.length > 0 ? availableModels : MODEL_OPTIONS;
    const firstTag = pool[0] ?? MODEL_OPTIONS[0];
    const next = defaultConfig(`Конфигурация ${configs.length + 1}`, firstTag);
    setConfigs((prev) => [...prev, next]);
    setActiveConfigId(next.id);
    setTestModel(next.selected_models[0] || "");
    setError(null);
  }

  function removeActiveConfig() {
    if (!activeConfig) return;
    if (configs.length <= 1) {
      setError("Должна остаться хотя бы одна конфигурация.");
      return;
    }
    const nextList = configs.filter((c) => c.id !== activeConfig.id);
    setConfigs(nextList);
    setActiveConfigId(nextList[0].id);
    setTestModel(nextList[0].selected_models[0] || "");
    setError(null);
  }

  async function runGenerateExtractionPrompt() {
    if (!loadedDsl || !activeConfig) {
      setError("Нет данных справочника или конфигурации.");
      return;
    }
    const built = buildFeatureExtractionPromptGeneratorRequest(loadedDsl);
    if (!built.ok) {
      setError(built.message);
      return;
    }
    const model = promptGenModel.trim();
    if (!model) {
      setError("Выберите модель для генерации промпта.");
      return;
    }
    if (!activeConfig.selected_models.includes(model)) {
      setError("Модель должна быть отмечена для этой конфигурации.");
      return;
    }
    if (!runningModels.includes(model)) {
      setError(
        "Выбранная модель не запущена. Запустите её в разделе «Администрирование моделей», затем обновите список или снова откройте этот шаг.",
      );
      return;
    }
    setLlmOpProgress({ done: 0, total: 1 });
    setPromptGenBusy(true);
    setError(null);
    try {
      const res = await generateFeatureExtractionSystemPrompt({
        model,
        prompt: built.generatorPrompt,
      });
      const text = String(res.generated_prompt ?? "").trim();
      if (!text) {
        throw new Error("Модель вернула пустой ответ.");
      }
      updateActiveConfig({ prompt: text });
      setLlmOpProgress({ done: 1, total: 1 });
    } catch (e: any) {
      setError(e?.message ?? "Не удалось сгенерировать промпт.");
    } finally {
      setPromptGenBusy(false);
      setLlmOpProgress(null);
    }
  }

  async function runPromptTest() {
    const reportInputModalError = (message: string) => {
      if (singleTestModalOpen || batchTestModalOpen) {
        setPopupError(message);
        return;
      }
      setError(message);
    };
    if (!activeConfig) {
      reportInputModalError("Выберите активную конфигурацию.");
      return;
    }
    const primaryErr = validateFeatureExtractionPrimary(configs);
    if (primaryErr) {
      reportInputModalError(primaryErr);
      return;
    }
    const effectiveModel = testModelResolved;
    const effectivePrompt = String(activeConfig.prompt ?? "");
    if (!effectivePrompt.trim()) {
      reportInputModalError("Задайте промпт на шаге «Конфигурация и промпты».");
      return;
    }
    const samples = sampleTexts.map((s) => s.trim()).filter(Boolean);
    if (!samples.length) {
      reportInputModalError("Введите хотя бы один текст для извлечения.");
      return;
    }
    if (!effectiveModel.trim()) {
      reportInputModalError("Выберите модель для теста.");
      return;
    }
    if (!runningModels.includes(effectiveModel)) {
      reportInputModalError(
        "Выбранная модель не запущена на сервере. Загрузите и запустите её в разделе «Администрирование моделей» — на этой странице нельзя управлять запуском и остановкой моделей.",
      );
      return;
    }
    const total = samples.length;
    setLlmOpProgress({ done: 0, total });
    setTestBusy(true);
    setError(null);
    setPopupError(null);
    setTestDetailsExpanded(false);
    try {
      const rows: { sample: string; result: any }[] = [];
      const rules_preview = loadedDsl ? buildRulesPreviewFromDsl(loadedDsl) : undefined;
      const runtime = extractionRuntimeToDsl(activeConfig.extraction_runtime);
      for (let i = 0; i < samples.length; i += 1) {
        setLlmOpProgress({ done: i, total });
        const res = await testFeatureExtractionPrompt({
          model: effectiveModel,
          prompt: effectivePrompt,
          sample_text: samples[i],
          runtime,
          rules_preview,
        });
        rows.push({ sample: samples[i], result: res });
      }
      setSinglePromptTestResults(rows);
      setLlmOpProgress({ done: total, total });
    } catch (e: any) {
      reportInputModalError(e?.message ?? "Ошибка тестирования промпта.");
      setSinglePromptTestResults(null);
    } finally {
      setTestBusy(false);
      setLlmOpProgress(null);
    }
  }

  async function runBatchPromptTest() {
    const reportInputModalError = (message: string) => {
      if (singleTestModalOpen || batchTestModalOpen) {
        setPopupError(message);
        return;
      }
      setError(message);
    };
    if (!activeConfig) {
      reportInputModalError("Выберите активную конфигурацию.");
      return;
    }
    const primaryErr = validateFeatureExtractionPrimary(configs);
    if (primaryErr) {
      reportInputModalError(primaryErr);
      return;
    }
    const effectiveModel = testModelResolved;
    const effectivePrompt = String(activeConfig.prompt ?? "");
    if (!effectivePrompt.trim()) {
      reportInputModalError("Задайте промпт на шаге «Конфигурация и промпты».");
      return;
    }
    if (!effectiveModel.trim()) {
      reportInputModalError("Выберите модель для теста.");
      return;
    }
    if (!runningModels.includes(effectiveModel)) {
      reportInputModalError("Выбранная модель не запущена на сервере.");
      return;
    }
    if (!batchRowRange.items.length) {
      reportInputModalError("Загрузите файл, выберите колонку и задайте диапазон строк.");
      return;
    }
    const selected = batchRowRange.items;
    const totalRows = selected.length;
    setLlmOpProgress({ done: 0, total: totalRows });
    setTestBusy(true);
    setError(null);
    setPopupError(null);
    setTestDetailsExpanded(false);
    setBatchResults([]);
    setBatchSummary("");
    const rows: BatchPromptTestRow[] = [];
    for (let i = 0; i < selected.length; i += 1) {
      const { rowNumber, text } = selected[i];
      if (!String(text).trim()) {
        rows.push({
          rowNumber,
          text,
          ok: false,
          parsedText: "—",
          error: "Пустая ячейка в выбранной колонке",
        });
        setBatchResults([...rows]);
        setLlmOpProgress({ done: rows.length, total: totalRows });
        continue;
      }
      try {
        const res = await testFeatureExtractionPrompt({
          model: effectiveModel,
          prompt: effectivePrompt,
          sample_text: text,
          runtime: extractionRuntimeToDsl(activeConfig.extraction_runtime),
          rules_preview: loadedDsl ? buildRulesPreviewFromDsl(loadedDsl) : undefined,
        });
        rows.push({
          rowNumber,
          text,
          ok: true,
          parsedText: formatParsedExtractionReadable(res),
          raw: res,
          timing: formatExtractionTiming(res) || "",
        });
      } catch (e: any) {
        rows.push({
          rowNumber,
          text,
          ok: false,
          parsedText: "—",
          error: e?.message ?? "Ошибка теста",
        });
      }
      setBatchResults([...rows]);
      setLlmOpProgress({ done: rows.length, total: totalRows });
    }
    const okCount = rows.filter((r) => r.ok).length;
    setBatchSummary(`Проверено: ${rows.length}. Успешно: ${okCount}. Ошибок: ${rows.length - okCount}.`);
    setTestBusy(false);
    setLlmOpProgress(null);
  }

  const showFeLongOpBar = busy || promptGenBusy || testBusy;
  const feLongOpElapsed = busy ? elapsedCatalogOps : promptGenBusy ? elapsedPromptGen : elapsedTest;
  const feLongOpTitle = busy
    ? catalogBusyReason === "save"
      ? "Сохранение настроек справочника…"
      : "Загрузка данных справочника…"
    : promptGenBusy
      ? "Генерация промпта (запрос к LLM)…"
      : testBusy
        ? testMode === "batch"
          ? "Пакетный тест промпта…"
          : llmOpProgress && llmOpProgress.total > 1
            ? "Проверка промпта на примерах…"
            : "Проверка промпта на примере…"
        : "";
  const feLongOpDetail =
    testBusy && testMode === "batch"
      ? "Каждая обрабатываемая строка — отдельный запрос к модели; счётчик учитывает все строки диапазона."
      : promptGenBusy
        ? "Один запрос к выбранной модели."
        : testBusy
          ? "Запрос к модели для тестового текста."
          : busy
            ? catalogBusyReason === "save"
              ? "Запись в БД и обновление списка справочников."
              : "Загрузка правил и конфигураций из сервера."
            : undefined;

  return (
    <div className="container" style={{ paddingBottom: showFeLongOpBar ? 88 : undefined }}>
      <h1 style={{ marginBottom: 10 }}>{featurePageH1}</h1>
      <nav className="fe-text-nav" aria-label="Основные разделы настроек">
        <button
          type="button"
          className={`fe-text-nav__tab${isCatalogSettingsTopTab ? " fe-text-nav__tab--active" : ""}`}
          onClick={() => navigate(featureBasePath)}
        >
          Настройки по справочникам
        </button>
        <button
          type="button"
          className={`fe-text-nav__tab${isModelAdminPage ? " fe-text-nav__tab--active" : ""}`}
          onClick={() => navigate(`${featureBasePath}/models`)}
        >
          🔒 Администрирование моделей
        </button>
        <button
          type="button"
          className={`fe-text-nav__tab${subpage === "simcheck" ? " fe-text-nav__tab--active" : ""}`}
          onClick={() => navigate(`${featureBasePath}/simcheck`)}
        >
          Другие настройки сервисов
        </button>
      </nav>

      {subpage === "models" ? (
        <FeatureExtractionModelAdmin
          onRunningModelsChange={setRunningModels}
          llmConsole={llmConsole}
          setLlmConsole={setLlmConsole}
        />
      ) : subpage === "simcheck" ? (
        <SemanticFallbackSettingsPage />
      ) : (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          ...(subpage === "catalog"
            ? {}
            : { minHeight: "calc(100vh - 200px)" }),
          paddingBottom: 16,
        }}
      >
      <nav className="fe-text-nav fe-text-nav--steps" aria-label="Шаги мастера настроек">
        <button
          type="button"
          className={`fe-text-nav__tab${subpage === "catalog" ? " fe-text-nav__tab--active" : ""}`}
          onClick={() => navigate(featureBasePath)}
        >
          1. Справочник
        </button>
        <button
          type="button"
          className={`fe-text-nav__tab${subpage === "prompts" ? " fe-text-nav__tab--active" : ""}`}
          onClick={() => navigate(`${featureBasePath}/prompts`)}
        >
          2. Конфигурация и промпты
        </button>
        <button
          type="button"
          className={`fe-text-nav__tab${subpage === "dataset" ? " fe-text-nav__tab--active" : ""}`}
          onClick={() => navigate(`${featureBasePath}/dataset`)}
        >
          3. Подгрузить датасет
        </button>
      </nav>

      {error ? (
        <div
          className="card"
          style={{
            marginBottom: 14,
            border: "1px solid #fecaca",
            background: "#fef2f2",
            color: "#991b1b",
            fontSize: 14,
          }}
        >
          {error}
        </div>
      ) : null}

      {subpage === "prompts" && catalogSelected ? (
        <div
          role="status"
          style={{
            marginBottom: 16,
            padding: "10px 14px",
            background: "#f0f9ff",
            border: "1px solid #bae6fd",
            borderRadius: 8,
            fontSize: 14,
            color: "#0c4a6e",
            lineHeight: 1.45,
          }}
        >
          <span style={{ fontWeight: 600 }}>Текущий справочник: </span>
          {selectedCatalogSummaryLine ? (
            <>
              <span>{selectedCatalogSummaryLine}</span>
              <span style={{ color: "#64748b", fontSize: 13 }}> · id: </span>
            </>
          ) : null}
          <code style={{ fontSize: 13, color: "#334155" }}>{selectedRuleId}</code>
        </div>
      ) : null}

      {subpage === "catalog" && (
      <>
      <RunningModelsBanner runningModels={runningModels} />
      <div
        className="card"
        style={{
          marginBottom: 16,
          border: "1px solid #e2e8f0",
          background: "linear-gradient(180deg, #f8fafc 0%, #fff 100%)",
        }}
      >
        <h2 style={{ marginTop: 0, marginBottom: 8 }}>Выбор справочника</h2>
        <p style={{ margin: "0 0 14px 0", color: "#64748b", fontSize: 14, lineHeight: 1.45 }}>
          Сначала выберите справочник — только после загрузки появятся настройки промптов и тест.
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "flex-end" }}>
          <label style={{ display: "grid", gap: 6, flex: "1 1 280px", minWidth: 220 }}>
            <span style={{ fontWeight: 600 }}>Справочник</span>
            <select
              value={selectedRuleId}
              onChange={(e) => {
                const next = e.target.value;
                setSelectedRuleId(next);
                void loadRule(next);
              }}
              disabled={busy}
              style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #cbd5e1" }}
            >
              <option value="">— Не выбран —</option>
              {catalogs.map((c) => (
                <option key={String(c.rule_id)} value={String(c.rule_id)}>
                  {(c.name?.trim() || c.model_id || "Без названия") +
                    (c.tn_ved_group_code ? ` (ТН ВЭД: ${c.tn_ved_group_code})` : "")}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="btn-secondary" onClick={() => void refreshCatalogs()} disabled={busy}>
            Обновить список
          </button>
        </div>
      </div>

      {!catalogSelected ? (
        <div
          className="card"
          style={{
            border: "1px dashed #cbd5e1",
            background: "#f8fafc",
            color: "#475569",
            textAlign: "center",
            padding: "28px 20px",
          }}
        >
          <p style={{ margin: 0, fontSize: 15 }}>Выберите справочник выше, чтобы настроить промпты извлечения признаков.</p>
        </div>
      ) : null}

      </>
      )}

      {subpage === "prompts" && (
      <>
      <RunningModelsBanner runningModels={runningModels} />
      {!catalogSelected ? (
        <div
          className="card"
          style={{
            border: "1px dashed #cbd5e1",
            background: "#f8fafc",
            color: "#475569",
            padding: "20px 18px",
            marginBottom: 16,
          }}
        >
          <p style={{ margin: "0 0 12px 0", fontSize: 15 }}>
            Сначала выберите справочник на шаге «Справочник».
          </p>
          <button type="button" className="btn" onClick={() => navigate(featureBasePath)}>
            Перейти к выбору справочника
          </button>
        </div>
      ) : null}
      {editorReady ? (
          <div className="card">
            <h2 style={{ marginTop: 0, marginBottom: 8 }}>Конфигурация и промпты</h2>
            <p style={{ margin: "0 0 16px 0", color: "#64748b", fontSize: 14, lineHeight: 1.45 }}>
              Набор правил извлечения: на один справочник можно завести несколько конфигураций. У каждой конфигурации — один общий промпт и
              набор моделей LLM. Одну и ту же модель можно отметить в нескольких конфигурациях. Если одну и ту же LLM допускается использовать в нескольких конфигурациях - отметьте одну из конфигураций в качестве основной.
            </p>

            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 10,
                alignItems: "flex-end",
                marginBottom: 16,
                paddingBottom: 16,
                borderBottom: "1px solid #e2e8f0",
              }}
            >
              <label style={{ display: "grid", gap: 6, flex: "1 1 220px" }}>
                <span style={{ fontWeight: 600 }}>Активная конфигурация</span>
                <select
                  value={activeConfigId}
                  onChange={(e) => setActiveConfigId(e.target.value)}
                  disabled={configs.length === 0}
                  style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #cbd5e1" }}
                >
                  {configs.map((cfg) => (
                    <option key={cfg.id} value={cfg.id}>
                      {cfg.name || "Без названия"}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" className="btn-secondary" onClick={addConfig} disabled={busy}>
                + Новая конфигурация
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={removeActiveConfig}
                disabled={busy || !activeConfig || configs.length <= 1}
              >
                Удалить эту
              </button>
            </div>

            <label style={{ display: "grid", gap: 6, marginBottom: 12 }}>
              <span
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  flexWrap: "wrap",
                }}
              >
                <span style={{ fontWeight: 600 }}>Название конфигурации</span>
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "4px 8px",
                    borderRadius: 8,
                    border: activeConfig.feature_extraction_primary ? "1px solid #93c5fd" : "1px solid #e2e8f0",
                    background: activeConfig.feature_extraction_primary ? "#eff6ff" : "#f8fafc",
                    cursor: busy ? "not-allowed" : "pointer",
                    fontSize: 13,
                    color: "#0f172a",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={activeConfig.feature_extraction_primary}
                    disabled={busy}
                    onChange={(e) => {
                      const v = e.target.checked;
                      setError(null);
                      setConfigs((prev) =>
                        prev.map((c) =>
                          c.id === activeConfig.id
                            ? { ...c, feature_extraction_primary: v }
                            : v
                              ? { ...c, feature_extraction_primary: false }
                              : c,
                        ),
                      );
                    }}
                    style={{ width: 16, height: 16, margin: 0, flexShrink: 0 }}
                  />
                  <span style={{ fontWeight: 600 }}>Основная конфигурация</span>
                </span>
              </span>
              <input
                type="text"
                value={activeConfig.name}
                onChange={(e) => updateActiveConfig({ name: e.target.value })}
                disabled={busy}
                style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #cbd5e1", maxWidth: 480 }}
              />
            </label>
            {extractionModelsShared ? (
              <p style={{ margin: "0 0 14px 0", fontSize: 12, color: "#64748b", lineHeight: 1.45 }}>
                Обязательно, если одна и та же модель отмечена в нескольких конфигурациях: по отмеченной основной
                конфигурации извлечение признаков будет вызывать LLM.
              </p>
            ) : null}

            <div style={{ marginBottom: 12 }}>
              <span style={{ fontWeight: 600, display: "block", marginBottom: 8 }}>Модели LLM для этой конфигурации</span>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <button
                  type="button"
                  className="btn-secondary"
                  style={{ flex: "0 0 auto", padding: "6px 10px", minWidth: 40 }}
                  aria-label="Прокрутить влево"
                  disabled={busy}
                  onClick={() =>
                    modelStripRef.current?.scrollBy({ left: -280, behavior: "smooth" })
                  }
                >
                  ‹
                </button>
                <div
                  ref={modelStripRef}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    display: "flex",
                    gap: 8,
                    overflowX: "auto",
                    overflowY: "hidden",
                    padding: "10px 6px",
                    scrollBehavior: "smooth",
                    background: "#f8fafc",
                    borderRadius: 8,
                    border: "1px solid #e2e8f0",
                    WebkitOverflowScrolling: "touch",
                  }}
                >
                  {availableModels.map((modelName) => {
                    const checked = activeConfig.selected_models.includes(modelName);
                    return (
                      <label
                        key={modelName}
                        title={modelName}
                        style={{
                          flex: "0 0 auto",
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 6,
                          maxWidth: 220,
                          padding: "6px 10px",
                          borderRadius: 999,
                          fontSize: 12,
                          cursor: busy ? "not-allowed" : "pointer",
                          border: checked ? "2px solid #2563eb" : "1px solid #cbd5e1",
                          background: checked ? "#eff6ff" : "#fff",
                          color: "#0f172a",
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={busy}
                          onChange={(e) => {
                            setError(null);
                            const nextSelected = e.target.checked
                              ? Array.from(new Set([...activeConfig.selected_models, modelName]))
                              : activeConfig.selected_models.filter((m) => m !== modelName);
                            updateActiveConfig({ selected_models: nextSelected });
                            if (!nextSelected.includes(testModel)) setTestModel(nextSelected[0] ?? "");
                          }}
                          style={{ width: 14, height: 14, flexShrink: 0 }}
                        />
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{modelName}</span>
                      </label>
                    );
                  })}
                </div>
                <button
                  type="button"
                  className="btn-secondary"
                  style={{ flex: "0 0 auto", padding: "6px 10px", minWidth: 40 }}
                  aria-label="Прокрутить вправо"
                  disabled={busy}
                  onClick={() =>
                    modelStripRef.current?.scrollBy({ left: 280, behavior: "smooth" })
                  }
                >
                  ›
                </button>
              </div>
            </div>

            {activeConfig.selected_models.length === 0 ? (
              <p style={{ color: "#b45309", fontSize: 14 }}>Отметьте хотя бы одну модель, чтобы сохранить конфигурацию с промптом.</p>
            ) : null}

            <div style={{ marginBottom: 16, maxWidth: 720 }}>
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 10,
                  alignItems: "flex-end",
                  justifyContent: "space-between",
                  marginBottom: 8,
                }}
              >
                <span style={{ fontWeight: 600, fontSize: 15 }}>Промпт конфигурации</span>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                  {activeConfig.selected_models.length > 0 ? (
                    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#334155" }}>
                      <span>Модель для генератора</span>
                      <select
                        value={promptGenModel}
                        onChange={(e) => setPromptGenModel(e.target.value)}
                        disabled={busy || promptGenBusy}
                        style={{ padding: "6px 8px", borderRadius: 8, border: "1px solid #cbd5e1", maxWidth: 260 }}
                      >
                        {activeConfig.selected_models.map((m) => (
                          <option key={m} value={m}>
                            {m}
                            {runningModels.includes(m) ? "" : " (не запущена)"}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : (
                    <span style={{ fontSize: 13, color: "#b45309" }}>Отметьте модель выше.</span>
                  )}
                  <label
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      fontSize: 13,
                      color: "#334155",
                      cursor: busy ? "not-allowed" : "pointer",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={activeConfig.extraction_runtime.constrained_decoding}
                      disabled={busy}
                      onChange={(e) =>
                        updateActiveConfig({
                          extraction_runtime: {
                            ...activeConfig.extraction_runtime,
                            constrained_decoding: e.target.checked,
                          },
                        })
                      }
                      style={{ width: 16, height: 16, flexShrink: 0 }}
                    />
                    <span style={{ lineHeight: 1.35 }}>Включить constrained decoding (guidance)</span>
                  </label>
                  <button
                    type="button"
                    className="btn-secondary"
                    title="Нажмите кнопку выше, чтобы автоматически получить черновик промпта на основе данных выбранного справочника. После генерации отредактируйте текст вручную в поле ниже."
                    disabled={
                      busy ||
                      promptGenBusy ||
                      !activeConfig.selected_models.length ||
                      !runningModels.includes(promptGenModel.trim())
                    }
                    onClick={() => void runGenerateExtractionPrompt()}
                  >
                    {promptGenBusy ? (
                      <>
                        Генерация…{" "}
                        <span style={{ fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                          · {formatElapsedSec(elapsedPromptGen)}
                        </span>
                      </>
                    ) : (
                      "Сгенерировать основу промпта из справочника"
                    )}
                  </button>
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={busy || promptGenBusy || (!fewShotExpanded && runningModels.length === 0)}
                    title={
                      !fewShotExpanded && runningModels.length === 0
                        ? "Сначала запустите хотя бы одну языковую модель в разделе администрирования моделей."
                        : undefined
                    }
                    onClick={() => {
                      if (!fewShotExpanded && runningModels.length === 0) {
                        setError(
                          "Запустите хотя бы одну языковую модель в разделе администрирования моделей, затем откройте поиск few-shot примеров.",
                        );
                        return;
                      }
                      setFewShotExpanded((v) => !v);
                    }}
                  >
                    {fewShotExpanded ? "Закрыть окно few-shot" : "Сгенерировать few-shot примеры"}
                  </button>
                </div>
              </div>
              <textarea
                value={String(activeConfig.prompt ?? "")}
                onChange={(e) => updateActiveConfig({ prompt: e.target.value })}
                disabled={busy || promptGenBusy}
                style={{
                  minHeight: 280,
                  width: "100%",
                  maxWidth: 720,
                  minWidth: 240,
                  resize: "both",
                  padding: "6px 10px",
                  borderRadius: 8,
                  border: "1px solid #cbd5e1",
                  boxSizing: "border-box",
                }}
              />
            </div>
            <div
              style={{
                marginTop: 14,
                paddingTop: 16,
                borderTop: "1px solid #e2e8f0",
                maxWidth: 720,
              }}
            >
            <h3 style={{ marginTop: 0, marginBottom: 10, fontSize: "1.05rem", color: "#0f172a" }}>Проверка промпта</h3>
            {activeConfig.selected_models.length === 0 ? (
              <p style={{ color: "#64748b", margin: 0 }}>
                Отметьте модели выше и задайте промпт конфигурации.
              </p>
            ) : (
              <div style={{ display: "grid", gap: 12 }}>
                <label style={{ display: "grid", gap: 6 }}>
                  <span style={{ fontWeight: 600 }}>Модель для теста</span>
                  <select
                    value={testModelResolved}
                    onChange={(e) => setTestModel(e.target.value)}
                    disabled={busy || promptGenBusy || testBusy}
                    style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #cbd5e1", maxWidth: 420 }}
                  >
                    {activeConfig.selected_models.map((m) => (
                      <option key={m} value={m}>
                        {m}
                        {runningModels.includes(m) ? "" : " (не запущена)"}
                      </option>
                    ))}
                  </select>
                </label>

                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    alignItems: "center",
                    rowGap: 12,
                    columnGap: 10,
                  }}
                >
                  <button
                    type="button"
                    className={testMode === "single" ? "btn" : "btn-secondary"}
                    onClick={() => {
                      if (runningModels.length === 0) {
                        setError(
                          "Запустите хотя бы одну языковую модель в разделе администрирования моделей, затем откройте окно проверки промпта.",
                        );
                        return;
                      }
                      setTestMode("single");
                      setSingleTestModalOpen(true);
                    }}
                    disabled={busy || promptGenBusy || testBusy || runningModels.length === 0}
                    title={
                      runningModels.length === 0
                        ? "Сначала запустите хотя бы одну языковую модель в разделе администрирования моделей."
                        : undefined
                    }
                  >
                    Ввести пример для анализа
                  </button>
                  <button
                    type="button"
                    className={testMode === "batch" ? "btn" : "btn-secondary"}
                    onClick={() => {
                      if (runningModels.length === 0) {
                        setError(
                          "Запустите хотя бы одну языковую модель в разделе администрирования моделей, затем откройте окно проверки промпта.",
                        );
                        return;
                      }
                      setTestMode("batch");
                      setBatchTestModalOpen(true);
                    }}
                    disabled={busy || promptGenBusy || testBusy || runningModels.length === 0}
                    title={
                      runningModels.length === 0
                        ? "Сначала запустите хотя бы одну языковую модель в разделе администрирования моделей."
                        : undefined
                    }
                  >
                    Подгрузить примеры
                  </button>
                </div>

                {testMode === "single" ? (
                  <div style={{ fontSize: 12, color: "#64748b" }}>
                    {singleSamplesNonEmptyCount > 0
                      ? `Задано примеров: ${singleSamplesNonEmptyCount} (${singleSamplesTotalChars} символов).`
                      : "Тексты для примеров не заданы."}
                  </div>
                ) : null}

                {testMode === "single" && singleTestModalOpen ? (
                  <div
                    role="dialog"
                    aria-modal="true"
                    style={{
                      position: "fixed",
                      inset: 0,
                      background: "rgba(15, 23, 42, 0.35)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      zIndex: 1000,
                      padding: 16,
                    }}
                  >
                    <div
                      style={{
                        width: "min(1040px, 96vw)",
                        maxHeight: "90vh",
                        overflow: "hidden",
                        background: "#fff",
                        borderRadius: 12,
                        border: "1px solid #e2e8f0",
                        boxShadow: "0 20px 50px rgba(15, 23, 42, 0.18)",
                      }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div
                        style={{
                          maxHeight: "90vh",
                          overflow: "auto",
                          WebkitOverflowScrolling: "touch",
                          padding: 14,
                          display: "grid",
                          gap: 10,
                        }}
                      >
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                        <div style={{ fontWeight: 700, color: "#0f172a" }}>Примеры для анализа</div>
                        <ModalCloseButton onClick={() => setSingleTestModalOpen(false)} />
                      </div>
                      <p style={{ margin: 0, fontSize: 13, color: "#64748b", lineHeight: 1.45 }}>
                        Добавьте одно или несколько полей с текстом документа. Пустые поля при проверке игнорируются.
                      </p>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                        <button
                          type="button"
                          className="btn-secondary"
                          disabled={busy || promptGenBusy || testBusy}
                          onClick={() => setSampleTexts((prev) => [...prev, ""])}
                          title="Добавить ещё одно поле для примера"
                          aria-label="Добавить поле для примера"
                        >
                          +
                        </button>
                        <span style={{ fontSize: 12, color: "#64748b" }}>
                          {singleSamplesNonEmptyCount > 0
                            ? `Заполнено полей: ${singleSamplesNonEmptyCount} (${singleSamplesTotalChars} символов).`
                            : "Поля пока пустые."}
                        </span>
                      </div>
                      {sampleTexts.map((text, idx) => (
                        <div key={`sample-${idx}`} style={{ display: "grid", gap: 6 }}>
                          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                            <span style={{ fontWeight: 600 }}>
                              Текст для извлечения{sampleTexts.length > 1 ? ` (пример ${idx + 1})` : ""}
                            </span>
                            {sampleTexts.length > 1 ? (
                              <button
                                type="button"
                                className="btn-secondary"
                                disabled={busy || promptGenBusy || testBusy}
                                onClick={() =>
                                  setSampleTexts((prev) => (prev.length <= 1 ? prev : prev.filter((_, j) => j !== idx)))
                                }
                              >
                                Удалить поле
                              </button>
                            ) : null}
                          </div>
                          <textarea
                            value={text}
                            onChange={(e) => {
                              const v = e.target.value;
                              setSampleTexts((prev) => {
                                const next = [...prev];
                                next[idx] = v;
                                return next;
                              });
                            }}
                            style={{ minHeight: 160, padding: "6px 10px", borderRadius: 8, border: "1px solid #cbd5e1" }}
                            disabled={busy || promptGenBusy || testBusy}
                          />
                        </div>
                      ))}
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                        <button
                          type="button"
                          className="btn"
                          onClick={() => void runPromptTest()}
                          disabled={busy || promptGenBusy || testBusy || !canRunPromptTest}
                        >
                          {testBusy ? (
                            <>
                              Выполняется…{" "}
                              <span style={{ fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                                · {formatElapsedSec(elapsedTest)}
                              </span>
                            </>
                          ) : (
                            "Проверить"
                          )}
                        </button>
                        {!isTestModelRunning && testModelResolved ? (
                          <span style={{ fontSize: 12, color: "#b45309" }}>
                            Модель не в списке запущенных на сервере. Запустите её в разделе администрирования моделей.
                          </span>
                        ) : null}
                      </div>
                      </div>
                    </div>
                  </div>
                ) : null}
                {testMode === "batch" && batchTestModalOpen ? (
                  <div
                    role="dialog"
                    aria-modal="true"
                    style={{
                      position: "fixed",
                      inset: 0,
                      background: "rgba(15, 23, 42, 0.35)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      zIndex: 1000,
                      padding: 16,
                    }}
                  >
                    <div
                      style={{
                        width: "min(1180px, 96vw)",
                        maxHeight: "90vh",
                        overflow: "hidden",
                        background: "#fff",
                        borderRadius: 12,
                        border: "1px solid #e2e8f0",
                        boxShadow: "0 20px 50px rgba(15, 23, 42, 0.18)",
                      }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div
                        style={{
                          maxHeight: "90vh",
                          overflow: "auto",
                          WebkitOverflowScrolling: "touch",
                          padding: 14,
                          display: "grid",
                          gap: 10,
                        }}
                      >
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                        <div style={{ fontWeight: 700, color: "#0f172a" }}>Подгрузить примеры: файл, колонка, прогон</div>
                        <ModalCloseButton onClick={() => setBatchTestModalOpen(false)} />
                      </div>
                      <input
                        type="file"
                        accept=".txt,.csv,.xls,.xlsx"
                        disabled={busy || promptGenBusy || testBusy}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (!file) return;
                          void (async () => {
                            try {
                              setError(null);
                              const parsed = await parseUploadedTableFile(file);
                              setBatchTable(parsed);
                              const firstCol = parsed.columns[0] ?? "";
                              setBatchTextColumn(firstCol);
                              setBatchColumnDraft(firstCol);
                              const rc = parsed.rows.length;
                              setBatchDataRowStart(1);
                              setBatchDataRowEnd(Math.max(1, rc));
                              setBatchPickerOpen(Boolean(parsed.columns.length));
                            } catch (err: any) {
                              setBatchTable({ columns: [], rows: [] });
                              setBatchTextColumn("");
                              setBatchColumnDraft("");
                              setBatchDataRowStart(1);
                              setBatchDataRowEnd(1);
                              setBatchPickerOpen(false);
                              setPopupError(err?.message ?? "Не удалось прочитать файл");
                            }
                          })();
                        }}
                      />
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10 }}>
                        <div style={{ display: "grid", gap: 6, gridColumn: "1 / -1" }}>
                          <span style={{ fontWeight: 600, fontSize: 13 }}>Диапазон строк данных (включительно)</span>
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                              <span style={{ fontSize: 13, color: "#64748b" }}>С</span>
                              <input
                                type="number"
                                min={1}
                                max={Math.max(1, batchTable.rows.length)}
                                value={batchDataRowStart === "" ? "" : batchDataRowStart}
                                onChange={(e) => {
                                  const v = e.target.value;
                                  if (v === "") {
                                    setBatchDataRowStart("");
                                    return;
                                  }
                                  const n = Number(v);
                                  if (!Number.isNaN(n)) setBatchDataRowStart(n);
                                }}
                                onBlur={() =>
                                  setBatchDataRowStart((prev) => finalizeRowInput(prev, batchTable.rows.length))
                                }
                                disabled={busy || promptGenBusy || testBusy || batchTable.rows.length === 0}
                                style={{ width: 96, padding: "6px 8px", borderRadius: 8, border: "1px solid #cbd5e1" }}
                              />
                            </label>
                            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                              <span style={{ fontSize: 13, color: "#64748b" }}>По</span>
                              <input
                                type="number"
                                min={1}
                                max={Math.max(1, batchTable.rows.length)}
                                value={batchDataRowEnd === "" ? "" : batchDataRowEnd}
                                onChange={(e) => {
                                  const v = e.target.value;
                                  if (v === "") {
                                    setBatchDataRowEnd("");
                                    return;
                                  }
                                  const n = Number(v);
                                  if (!Number.isNaN(n)) setBatchDataRowEnd(n);
                                }}
                                onBlur={() =>
                                  setBatchDataRowEnd((prev) => finalizeRowInput(prev, batchTable.rows.length))
                                }
                                disabled={busy || promptGenBusy || testBusy || batchTable.rows.length === 0}
                                style={{ width: 96, padding: "6px 8px", borderRadius: 8, border: "1px solid #cbd5e1" }}
                              />
                            </label>
                          </div>
                        </div>
                        <div style={{ display: "grid", gap: 6 }}>
                          <span style={{ fontWeight: 600, fontSize: 13 }}>Колонка с описанием</span>
                          <button
                            type="button"
                            className="btn-secondary"
                            disabled={busy || promptGenBusy || testBusy || batchTable.columns.length === 0}
                            onClick={() => {
                              setBatchColumnDraft(batchTextColumn || batchTable.columns[0] || "");
                              setBatchPickerOpen(true);
                            }}
                          >
                            {batchTextColumn ? `Выбрана: ${batchTextColumn}` : "Выбрать колонку"}
                          </button>
                        </div>
                      </div>
                      {batchTable.rows.length > 0 ? (
                        <div style={{ fontSize: 12, color: "#64748b" }}>
                          Строк данных в файле: {batchTable.rows.length}. В прогоне: строки {batchRowRange.start}–{batchRowRange.end} (
                          {batchRowRange.items.length} шт.).
                        </div>
                      ) : null}
                      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                        <button
                          type="button"
                          className="btn"
                          onClick={() => void runBatchPromptTest()}
                          disabled={
                            busy ||
                            promptGenBusy ||
                            testBusy ||
                            !batchRowRange.items.length ||
                            batchRowRange.incomplete ||
                            !batchTextColumn
                          }
                        >
                          {testBusy ? (
                            <>
                              Выполняется…{" "}
                              <span style={{ fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                                · {formatElapsedSec(elapsedTest)}
                              </span>
                            </>
                          ) : (
                            "Запустить пакетный тест"
                          )}
                        </button>
                        {!isTestModelRunning && testModelResolved ? (
                          <span style={{ fontSize: 12, color: "#b45309" }}>
                            Модель не в списке запущенных на сервере. Запустите её в разделе администрирования моделей.
                          </span>
                        ) : null}
                        {batchSummary ? <span style={{ fontSize: 12, color: "#475569" }}>{batchSummary}</span> : null}
                      </div>
                      {batchResults.length > 0 ? (
                        <div style={{ display: "grid", gap: 8 }}>
                          <div style={{ fontWeight: 600, color: "#334155" }}>Результаты пакетного теста</div>
                          {batchResults.map((row, i) => (
                            <details
                              key={`batch-${row.rowNumber}-${i}`}
                              style={{
                                border: "1px solid #e2e8f0",
                                borderRadius: 8,
                                background: row.ok ? "#f8fafc" : "#fef2f2",
                                padding: "6px 10px",
                              }}
                            >
                              <summary style={{ cursor: "pointer", fontSize: 12, color: "#64748b" }}>
                                Строка {row.rowNumber} · {row.ok ? "ok" : "ошибка"} {row.timing ? `· ${row.timing}` : ""}
                              </summary>
                              <div style={{ display: "grid", gap: 6, marginTop: 6 }}>
                                <div
                                  style={{
                                    fontSize: 12,
                                    color: "#334155",
                                    whiteSpace: "pre-wrap",
                                    wordBreak: "break-word",
                                    maxHeight: "min(50vh, 360px)",
                                    overflow: "auto",
                                  }}
                                >
                                  <strong>Текст:</strong> {row.text}
                                </div>
                                {row.ok ? (
                                  <div
                                    style={{
                                      fontSize: 12,
                                      color: "#0f172a",
                                      whiteSpace: "pre-wrap",
                                      wordBreak: "break-word",
                                      maxHeight: "min(40vh, 280px)",
                                      overflow: "auto",
                                    }}
                                  >
                                    <strong>Результат:</strong> {row.parsedText}
                                  </div>
                                ) : (
                                  <div style={{ fontSize: 12, color: "#b91c1c" }}>{row.error}</div>
                                )}
                              </div>
                            </details>
                          ))}
                        </div>
                      ) : null}
                      </div>
                    </div>
                  </div>
                ) : null}

                <TableColumnPreviewModal
                  open={batchPickerOpen}
                  onClose={() => setBatchPickerOpen(false)}
                  title="Выбор колонки и предпросмотр данных"
                  table={batchTable}
                  selectedColumnIndex={batchColumnDraftIndex}
                  onSelectColumn={(ci) => setBatchColumnDraft(batchTable.columns[ci] ?? "")}
                  previewRowLimit={12}
                  controls={
                    <>
                      <label style={{ display: "grid", gap: 6, maxWidth: 420 }}>
                        <span style={{ fontWeight: 600, fontSize: 13 }}>Колонка с описанием</span>
                        <select
                          value={batchColumnDraft}
                          onChange={(e) => setBatchColumnDraft(e.target.value)}
                          disabled={busy || promptGenBusy || testBusy}
                          style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #cbd5e1" }}
                        >
                          {batchTable.columns.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                      </label>
                      <div style={{ display: "grid", gap: 6 }}>
                        <span style={{ fontWeight: 600, fontSize: 13 }}>Диапазон строк данных (включительно)</span>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                            <span style={{ fontSize: 13, color: "#64748b" }}>С</span>
                            <input
                              type="number"
                              min={1}
                              max={Math.max(1, batchTable.rows.length)}
                              value={batchDataRowStart === "" ? "" : batchDataRowStart}
                              onChange={(e) => {
                                const v = e.target.value;
                                if (v === "") {
                                  setBatchDataRowStart("");
                                  return;
                                }
                                const n = Number(v);
                                if (!Number.isNaN(n)) setBatchDataRowStart(n);
                              }}
                              onBlur={() =>
                                setBatchDataRowStart((prev) => finalizeRowInput(prev, batchTable.rows.length))
                              }
                              disabled={busy || promptGenBusy || testBusy || batchTable.rows.length === 0}
                              style={{ width: 96, padding: "6px 8px", borderRadius: 8, border: "1px solid #cbd5e1" }}
                            />
                          </label>
                          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                            <span style={{ fontSize: 13, color: "#64748b" }}>По</span>
                            <input
                              type="number"
                              min={1}
                              max={Math.max(1, batchTable.rows.length)}
                              value={batchDataRowEnd === "" ? "" : batchDataRowEnd}
                              onChange={(e) => {
                                const v = e.target.value;
                                if (v === "") {
                                  setBatchDataRowEnd("");
                                  return;
                                }
                                const n = Number(v);
                                if (!Number.isNaN(n)) setBatchDataRowEnd(n);
                              }}
                              onBlur={() =>
                                setBatchDataRowEnd((prev) => finalizeRowInput(prev, batchTable.rows.length))
                              }
                              disabled={busy || promptGenBusy || testBusy || batchTable.rows.length === 0}
                              style={{ width: 96, padding: "6px 8px", borderRadius: 8, border: "1px solid #cbd5e1" }}
                            />
                          </label>
                        </div>
                      </div>
                    </>
                  }
                  footer={
                    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
                      <button type="button" className="btn-secondary" onClick={() => setBatchPickerOpen(false)}>
                        Отмена
                      </button>
                      <button
                        type="button"
                        className="btn"
                        onClick={() => {
                          setBatchTextColumn(batchColumnDraft || batchTable.columns[0] || "");
                          setBatchPickerOpen(false);
                        }}
                      >
                        Применить
                      </button>
                    </div>
                  }
                />

                {testMode === "single" && singlePromptTestResults?.length ? (
                  <div style={{ display: "grid", gap: 10 }}>
                    {singlePromptTestResults.length > 1 ? (
                      <div style={{ fontWeight: 600, marginBottom: 2, color: "#0f172a" }}>Распознанные результаты</div>
                    ) : null}
                    {singlePromptTestResults.map((row, idx) => {
                      const testResult = row.result;
                      const timingLine = formatExtractionTiming(testResult);
                      return (
                        <div
                          key={`single-result-${idx}`}
                          style={{
                            display: "grid",
                            gap: 10,
                            ...(idx > 0
                              ? { paddingTop: 16, borderTop: "1px solid #e2e8f0" }
                              : {}),
                          }}
                        >
                          <div>
                            <div style={{ fontWeight: 600, marginBottom: 6, color: "#0f172a" }}>
                              {singlePromptTestResults.length > 1
                                ? `Пример ${idx + 1} из ${singlePromptTestResults.length}`
                                : "Распознанный результат"}
                            </div>
                            {row.sample.length ? (
                              <div
                                style={{
                                  fontSize: 12,
                                  color: "#64748b",
                                  marginBottom: 8,
                                  lineHeight: 1.45,
                                  whiteSpace: "pre-wrap",
                                  wordBreak: "break-word",
                                }}
                              >
                                <span style={{ fontWeight: 600, color: "#475569" }}>Входной текст: </span>
                                {row.sample.length > 400 ? `${row.sample.slice(0, 400)}…` : row.sample}
                              </div>
                            ) : null}
                            {timingLine ? (
                              <div style={{ fontSize: 13, color: "#64748b", marginBottom: 10, lineHeight: 1.45 }}>
                                <span style={{ fontWeight: 600, color: "#475569" }}>Время: </span>
                                {timingLine}
                              </div>
                            ) : null}
                            <div
                              style={{
                                display: "grid",
                                gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 280px), 1fr))",
                                gap: 16,
                                alignItems: "stretch",
                              }}
                            >
                              <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
                                <div style={{ fontWeight: 600, color: "#334155", fontSize: 13 }}>Итог (текстом)</div>
                                <div
                                  style={{
                                    flex: 1,
                                    minHeight: 200,
                                    maxHeight: "min(55vh, 520px)",
                                    overflow: "auto",
                                    whiteSpace: "pre-wrap",
                                    wordBreak: "break-word",
                                    background: "#f8fafc",
                                    border: "1px solid #e2e8f0",
                                    borderRadius: 8,
                                    padding: "8px 12px",
                                    fontSize: 14,
                                    lineHeight: 1.45,
                                    color: "#1e293b",
                                  }}
                                >
                                  {formatParsedExtractionReadable(testResult)}
                                </div>
                              </div>
                              <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
                                <div style={{ fontWeight: 600, color: "#334155", fontSize: 13 }}>JSON модели</div>
                                <pre
                                  className="fe-textarea-code"
                                  style={{
                                    flex: 1,
                                    margin: 0,
                                    minHeight: 200,
                                    maxHeight: "min(55vh, 520px)",
                                    overflow: "auto",
                                    whiteSpace: "pre-wrap",
                                    wordBreak: "break-word",
                                    background: "#f0fdf4",
                                    border: "1px solid #bbf7d0",
                                    borderRadius: 8,
                                    padding: "8px 12px",
                                    fontSize: 12,
                                    color: "#14532d",
                                  }}
                                >
                                  {formatParsedExtractionResult(testResult)}
                                </pre>
                              </div>
                            </div>
                          </div>
                          <div>
                            {typeof testResult.assembled_prompt_preview === "string" && testResult.assembled_prompt_preview ? (
                              <details style={{ marginBottom: 12 }} open={false}>
                                <summary style={{ cursor: "pointer", fontWeight: 600, color: "#334155", fontSize: 14 }}>
                                  Строка, отправленная в модель (полная сборка)
                                </summary>
                                <pre
                                  style={{
                                    margin: 0,
                                    whiteSpace: "pre-wrap",
                                    wordBreak: "break-word",
                                    background: "#fffbeb",
                                    border: "1px solid #fcd34d",
                                    borderRadius: 8,
                                    padding: "8px 12px",
                                    fontSize: 11,
                                    maxHeight: 360,
                                    overflow: "auto",
                                  }}
                                >
                                  {testResult.assembled_prompt_preview}
                                </pre>
                              </details>
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
                    <div>
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => setTestDetailsExpanded((v) => !v)}
                      >
                        {testDetailsExpanded ? "Свернуть полный ответ" : "Полный ответ API (raw, режим, …)"}
                      </button>
                      {testDetailsExpanded ? (
                        <pre
                          style={{
                            margin: "10px 0 0 0",
                            whiteSpace: "pre-wrap",
                            wordBreak: "break-word",
                            background: "#f8fafc",
                            border: "1px solid #e2e8f0",
                            borderRadius: 8,
                            padding: "8px 12px",
                            fontSize: 12,
                            maxHeight: 480,
                            overflow: "auto",
                          }}
                        >
                          {JSON.stringify(
                            singlePromptTestResults.map((r) => r.result),
                            null,
                            2,
                          )}
                        </pre>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
            )}
            </div>

            <div
              style={{
                marginTop: 18,
                paddingTop: 4,
                display: "flex",
                flexDirection: "column",
                gap: 16,
                maxWidth: 720,
              }}
            >
              <FewShotPromptAssistant
                selectedModels={activeConfig.selected_models}
                prompt={String(activeConfig.prompt ?? "")}
                rulesPreview={loadedDsl ? buildRulesPreviewFromDsl(loadedDsl) : ""}
                ruleId={selectedRuleId || undefined}
                disabled={busy || promptGenBusy || testBusy}
                hasRunningLlm={runningModels.length > 0}
                expanded={fewShotExpanded}
                onExpandedChange={setFewShotExpanded}
                hideToolbarButton
              />

              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", rowGap: 12, columnGap: 10 }}>
                <button
                  type="button"
                  className="btn"
                  disabled={
                    busy ||
                    !activeConfig.selected_models.length ||
                    !String(activeConfig.prompt ?? "").trim()
                  }
                  onClick={() => void savePromptSettings()}
                >
                  {busy ? (
                    <>
                      Сохранение…{" "}
                      <span style={{ fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                        · {formatElapsedSec(elapsedCatalogOps)}
                      </span>
                    </>
                  ) : (
                    "Сохранить в справочник"
                  )}
                </button>
              </div>
            </div>
          </div>
      ) : catalogSelected && !busy ? (
        <div className="card" style={{ color: "#64748b" }}>
          <p style={{ margin: 0 }}>
            Нет данных для редактирования. Вернитесь на шаг «Справочник» и выберите справочник снова.
          </p>
        </div>
      ) : null}
      </>
      )}

      {subpage === "dataset" && (
      <>
      <RunningModelsBanner runningModels={runningModels} />
      {!catalogSelected ? (
        <div
          className="card"
          style={{
            border: "1px dashed #cbd5e1",
            background: "#f8fafc",
            color: "#475569",
            padding: "20px 18px",
            marginBottom: 16,
          }}
        >
          <p style={{ margin: "0 0 12px 0", fontSize: 15 }}>
            Сначала выберите справочник на шаге «Справочник».
          </p>
          <button type="button" className="btn" onClick={() => navigate(featureBasePath)}>
            Перейти к выбору справочника
          </button>
        </div>
      ) : null}

      {catalogSelected ? (
        <div
          role="status"
          style={{
            marginBottom: 16,
            padding: "10px 14px",
            background: "#f0f9ff",
            border: "1px solid #bae6fd",
            borderRadius: 8,
            fontSize: 14,
            color: "#0c4a6e",
            lineHeight: 1.45,
          }}
        >
          <span style={{ fontWeight: 600 }}>Текущий справочник: </span>
          {selectedCatalogSummaryLine ? (
            <>
              <span>{selectedCatalogSummaryLine}</span>
              <span style={{ color: "#64748b", fontSize: 13 }}> · id: </span>
            </>
          ) : null}
          <code style={{ fontSize: 13, color: "#334155" }}>{selectedRuleId}</code>
        </div>
      ) : null}

      {catalogSelected && !busy && loadedDsl ? (
        <DatasetImportPanel ruleId={selectedRuleId} disabled={promptGenBusy || testBusy} />
      ) : null}
      {catalogSelected && !busy && !loadedDsl ? (
        <div className="card" style={{ color: "#64748b" }}>
          <p style={{ margin: 0 }}>
            Описание справочника ещё не загружено. Вернитесь на шаг «Справочник» и дождитесь загрузки.
          </p>
        </div>
      ) : null}
      </>
      )}


      <div
        style={{
          marginTop: subpage === "catalog" ? 20 : "auto",
          paddingTop: 12,
          borderTop: "1px solid #e2e8f0",
          display: "flex",
          gap: 10,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        {subpage === "prompts" ? (
          <button type="button" className="btn-secondary" onClick={() => navigate(featureBasePath)}>
            Назад
          </button>
        ) : null}
        {subpage === "dataset" ? (
          <button
            type="button"
            className="btn-secondary"
            onClick={() => navigate(`${featureBasePath}/prompts`)}
          >
            Назад
          </button>
        ) : null}
        {subpage === "catalog" ? (
          <button
            type="button"
            className={!catalogSelected ? "btn-secondary" : "btn"}
            disabled={!catalogSelected}
            onClick={() => navigate(`${featureBasePath}/prompts`)}
          >
            Далее
          </button>
        ) : null}
        {subpage === "prompts" ? (
          <button
            type="button"
            className={!catalogSelected ? "btn-secondary" : "btn"}
            disabled={!catalogSelected}
            onClick={() => navigate(`${featureBasePath}/dataset`)}
          >
            Далее: датасет
          </button>
        ) : null}
      </div>
      </div>
      )}

      {isModelAdminPage ? (
        <FeatureExtractionLlmConsole
          mergedText={mergedLlmConsoleText}
          terminal={llmConsole}
          onRefreshLogs={() => {
            void loadLlmContainerLogs();
            void loadModelOpHistory();
          }}
        />
      ) : null}

      {popupError ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Ошибка ввода данных"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15, 23, 42, 0.4)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1300,
            padding: 16,
          }}
          onClick={() => setPopupError(null)}
        >
          <div
            style={{
              width: "min(620px, 94vw)",
              background: "#fff",
              borderRadius: 12,
              border: "1px solid #fecaca",
              boxShadow: "0 20px 40px rgba(15, 23, 42, 0.18)",
              overflow: "hidden",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              style={{
                padding: "12px 14px",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
                borderBottom: "1px solid #fee2e2",
                background: "#fef2f2",
              }}
            >
              <div style={{ fontWeight: 700, color: "#991b1b" }}>Ошибка ввода</div>
              <ModalCloseButton onClick={() => setPopupError(null)} />
            </div>
            <div style={{ padding: "14px 16px", color: "#7f1d1d", lineHeight: 1.5 }}>{popupError}</div>
          </div>
        </div>
      ) : null}

      <LongOperationStatusBar
        visible={showFeLongOpBar}
        title={feLongOpTitle}
        detail={feLongOpDetail}
        elapsedSec={feLongOpElapsed}
        progress={busy ? null : llmOpProgress}
      />
    </div>
  );
}
