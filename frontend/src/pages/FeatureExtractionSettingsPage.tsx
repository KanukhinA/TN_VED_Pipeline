/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  fetchOllamaContainerLogs,
  generateFeatureExtractionSystemPrompt,
  getRule,
  listFeatureExtractionModels,
  listRules,
  saveRule,
  testFeatureExtractionPrompt,
} from "../api/client";
import { buildFeatureExtractionPromptGeneratorRequest } from "../expert/featureExtractionPromptGenerator";
import FeatureExtractionModelAdmin from "../ui/FeatureExtractionModelAdmin";
import FeatureExtractionOllamaConsole, { type OllamaOperationLogState } from "../ui/FeatureExtractionOllamaConsole";
import FewShotPromptAssistant from "../ui/FewShotPromptAssistant";

type RuleListItem = {
  rule_id: string;
  name?: string | null;
  model_id?: string | null;
  tn_ved_group_code?: string | null;
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
    lines.push("- No explicit numeric characteristics found in catalog DSL");
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
    for (const el of v) {
      lines.push(`${indBullet}• ${formatScalarRu(el)}`);
    }
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
      lines.push("");
      continue;
    }
    if (key === "прочее" && Array.isArray(val)) {
      lines.push("прочее:");
      val.forEach((item, idx) => {
        lines.push(`${IND}${idx + 1})`);
        lines.push(...formatProcheeItemBlock(item, 2));
      });
      lines.push("");
      continue;
    }
    lines.push(...formatReadableKeyValue(key, val, 0));
    lines.push("");
  }

  for (const key of rest) {
    lines.push(...formatReadableKeyValue(key, o[key], 0));
    lines.push("");
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
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
    const allPrim = val.every(
      (x) =>
        x === null ||
        x === undefined ||
        typeof x === "string" ||
        typeof x === "number" ||
        typeof x === "boolean",
    );
    if (allPrim && val.length <= 8) {
      return [`${ind}${key}: ${val.map(formatScalarRu).join(", ")}`];
    }
    const lines: string[] = [`${ind}${key}:`];
    val.forEach((el, idx) => {
      if (isPlainRecord(el)) {
        lines.push(`${IND.repeat(depth + 1)}${idx + 1})`);
        lines.push(formatReadableObject(el, depth + 2));
      } else {
        const r = Array.isArray(el) ? formatPairAsRange(el) : null;
        lines.push(`${IND.repeat(depth + 1)}• ${r ?? formatScalarRu(el)}`);
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
      return `${IND.repeat(depth)}• ${r ?? formatScalarRu(item)}`;
    })
    .join("\n");
}

/** Длительность извлечения из ответа `/api/feature-extraction/test`. */
function formatExtractionTiming(res: any): string | null {
  if (!res || typeof res !== "object") return null;
  const wall = res.extraction_request_duration_sec;
  const ollama = res.ollama_compute_duration_sec;
  const parseOnly = res.parse_only_duration_sec;
  const parts: string[] = [];
  if (typeof wall === "number") parts.push(`запрос извлечения: ${wall} с`);
  if (typeof ollama === "number") parts.push(`инференс модели (Ollama): ${ollama} с`);
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
    prompt: "",
    extraction_runtime: defaultExtractionRuntime(),
  };
}

/** Модели, уже назначенные другим конфигурациям того же справочника (исключая текущую по id). */
function modelsUsedByOtherConfigs(configs: FeatureExtractionConfig[], excludeConfigId: string): Set<string> {
  const used = new Set<string>();
  for (const c of configs) {
    if (c.id === excludeConfigId) continue;
    for (const m of c.selected_models) used.add(m);
  }
  return used;
}

/** Если одна и та же модель встречается в двух конфигурациях — возвращаем текст ошибки. */
function findModelAssignmentConflicts(configs: FeatureExtractionConfig[]): string | null {
  const modelToConfig = new Map<string, string>();
  for (const c of configs) {
    const label = (c.name || "").trim() || c.id;
    for (const m of c.selected_models) {
      if (modelToConfig.has(m)) {
        return `Модель «${m}» не может быть в двух конфигурациях сразу (уже в «${modelToConfig.get(m)}», повтор в «${label}»). Оставьте каждую модель только в одной конфигурации.`;
      }
      modelToConfig.set(m, label);
    }
  }
  return null;
}

function OllamaMemoryBanner({ runningModels }: { runningModels: string[] }) {
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
      <span style={{ fontWeight: 600 }}>Запущенные модели (Ollama): </span>
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

/** Подстраницы настроек извлечения: каталог → промпты → тест; models — отдельно. */
function featureExtractionSubpage(pathname: string): "catalog" | "prompts" | "test" | "models" {
  if (pathname.endsWith("/models")) return "models";
  if (pathname.endsWith("/prompts")) return "prompts";
  if (pathname.endsWith("/test")) return "test";
  return "catalog";
}

export default function FeatureExtractionSettingsPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const featureBasePath = location.pathname.startsWith("/expert/") ? "/expert/feature-extraction" : "/feature-extraction";
  const isModelAdminPage = location.pathname.endsWith("/models");
  const subpage = featureExtractionSubpage(location.pathname);
  const [runningModels, setRunningModels] = useState<string[]>([]);
  /** Состояние консоли Ollama: показ только на вкладке «Администрирование моделей», при повторном входе текст сохраняется. */
  const [ollamaTerminal, setOllamaTerminal] = useState<OllamaOperationLogState>(null);
  const [ollamaContainerLogs, setOllamaContainerLogs] = useState<string | null>(null);
  /** Ключи из JSON админки «Администрирование моделей» (объект models в БД). */
  const [adminModelTags, setAdminModelTags] = useState<string[]>([]);

  const [catalogs, setCatalogs] = useState<RuleListItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [selectedRuleId, setSelectedRuleId] = useState("");
  const [catalogName, setCatalogName] = useState("");
  const [configs, setConfigs] = useState<FeatureExtractionConfig[]>([]);
  const [activeConfigId, setActiveConfigId] = useState("");
  const [loadedDsl, setLoadedDsl] = useState<any>(null);
  const [loadedModelId, setLoadedModelId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [testBusy, setTestBusy] = useState(false);
  const [promptGenBusy, setPromptGenBusy] = useState(false);
  const [promptGenModel, setPromptGenModel] = useState("");
  const [sampleText, setSampleText] = useState("");
  const [testResult, setTestResult] = useState<any>(null);
  const [testDetailsExpanded, setTestDetailsExpanded] = useState(false);
  const [testModel, setTestModel] = useState("");
  const modelStripRef = useRef<HTMLDivElement | null>(null);

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
  const bootstrapOllamaTag = useMemo(() => {
    if (runningModels.length === 1) return runningModels[0];
    if (adminModelTags.length > 0) return adminModelTags[0];
    return MODEL_OPTIONS[0];
  }, [runningModels, adminModelTags]);

  const activeConfig = useMemo(
    () => configs.find((c) => c.id === activeConfigId) ?? null,
    [configs, activeConfigId],
  );

  const modelsReservedByOtherConfigs = useMemo(
    () => (activeConfigId ? modelsUsedByOtherConfigs(configs, activeConfigId) : new Set<string>()),
    [configs, activeConfigId],
  );

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
    const hasSample = sampleText.trim().length > 0;
    const hasPrompt = String(activeConfig.prompt ?? "").trim().length > 0;
    return hasSample && hasPrompt && isTestModelRunning;
  }, [activeConfig, sampleText, isTestModelRunning]);

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

  const loadOllamaContainerLogs = useCallback(async () => {
    try {
      const data = await fetchOllamaContainerLogs(4000);
      setOllamaContainerLogs(typeof data.lines === "string" ? data.lines : "");
    } catch (e: any) {
      setOllamaContainerLogs(e?.message ?? "Ошибка загрузки логов");
    }
  }, []);

  const mergedOllamaConsoleText = useMemo(() => {
    const docker = ollamaContainerLogs ?? "Загрузка…";
    if (!ollamaTerminal) return docker;
    const title =
      `Ollama — операция с моделью ${ollamaTerminal.model}` +
      (ollamaTerminal.durationSec != null && ollamaTerminal.ok ? ` · ${ollamaTerminal.durationSec} с (сервер)` : "") +
      (!ollamaTerminal.ok ? " · ошибка" : "");
    return [
      "=== Хвост логов контейнера Ollama (docker logs) ===",
      "",
      docker,
      "",
      "=== Результат последней операции (API) ===",
      title,
      "",
      ollamaTerminal.log,
    ].join("\n");
  }, [ollamaTerminal, ollamaContainerLogs]);

  useEffect(() => {
    if (!isModelAdminPage) return;
    void loadOllamaContainerLogs();
    const id = window.setInterval(() => void loadOllamaContainerLogs(), 2000);
    return () => window.clearInterval(id);
  }, [loadOllamaContainerLogs, isModelAdminPage]);

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
    if (subpage === "prompts" || subpage === "test") {
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
      setTestResult(null);
      setSampleText("");
      setTestDetailsExpanded(false);
      setError(null);
      return;
    }
    setBusy(true);
    setError(null);
    setTestResult(null);
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
              : [String(c?.model ?? bootstrapOllamaTag).trim() || bootstrapOllamaTag];
          const prompt = promptFromStoredConfig(c, selected_models);
          return {
            id: String(c?.id ?? "").trim(),
            name: String(c?.name ?? "").trim(),
            selected_models,
            prompt,
            extraction_runtime: extractionRuntimeFromStored(c),
          };
        })
        .filter((c) => c.id && c.name);
      const migratedFromLegacy =
        parsedConfigs.length === 0 && (meta.feature_extraction_model || meta.feature_extraction_prompt)
          ? (() => {
              const leg = String(meta.feature_extraction_model ?? bootstrapOllamaTag).trim() || bootstrapOllamaTag;
              return [
                {
                  id: newConfigId(),
                  name: "Основная конфигурация",
                  selected_models: [leg],
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
            : [defaultConfig("Конфигурация 1", bootstrapOllamaTag)];
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
      const overlap = findModelAssignmentConflicts(nextConfigs);
      if (overlap) setError(overlap);
    } catch (e: any) {
      setError(e?.message ?? "Не удалось загрузить справочник");
      setLoadedDsl(null);
      setLoadedModelId("");
      setCatalogName("");
      setConfigs([]);
      setActiveConfigId("");
    } finally {
      setBusy(false);
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

    const overlap = findModelAssignmentConflicts(configs);
    if (overlap) {
      setError(overlap);
      return;
    }

    setBusy(true);
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
    }
  }

  function updateActiveConfig(nextPatch: Partial<FeatureExtractionConfig>) {
    if (!activeConfig) return;
    setConfigs((prev) => prev.map((c) => (c.id === activeConfig.id ? { ...c, ...nextPatch } : c)));
  }

  function addConfig() {
    const usedElsewhere = modelsUsedByOtherConfigs(configs, "");
    const pool = availableModels.length > 0 ? availableModels : MODEL_OPTIONS;
    const firstFree = pool.find((m) => !usedElsewhere.has(m));
    if (!firstFree) {
      setError(
        "Нельзя добавить конфигурацию: все модели из списка уже назначены другим конфигурациям этого справочника. Уберите модель с другой конфигурации или расширьте список в админке моделей.",
      );
      return;
    }
    const next = defaultConfig(`Конфигурация ${configs.length + 1}`, firstFree);
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
    } catch (e: any) {
      setError(e?.message ?? "Не удалось сгенерировать промпт.");
    } finally {
      setPromptGenBusy(false);
    }
  }

  async function runPromptTest() {
    if (!activeConfig) {
      setError("Выберите активную конфигурацию.");
      return;
    }
    const overlap = findModelAssignmentConflicts(configs);
    if (overlap) {
      setError(overlap);
      return;
    }
    const effectiveModel = testModelResolved;
    const effectivePrompt = String(activeConfig.prompt ?? "");
    if (!effectivePrompt.trim()) {
      setError("Задайте промпт на шаге «Конфигурация и промпты».");
      return;
    }
    if (!sampleText.trim()) {
      setError("Введите текст для извлечения.");
      return;
    }
    if (!effectiveModel.trim()) {
      setError("Выберите модель для теста.");
      return;
    }
    if (!runningModels.includes(effectiveModel)) {
      setError(
        "Выбранная модель не запущена на сервере. Загрузите и запустите её в разделе «Администрирование моделей» — на шаге «Проверка промпта» нельзя управлять запуском и остановкой моделей.",
      );
      return;
    }
    setTestBusy(true);
    setError(null);
    setTestDetailsExpanded(false);
    try {
      const res = await testFeatureExtractionPrompt({
        model: effectiveModel,
        prompt: effectivePrompt,
        sample_text: sampleText,
        runtime: extractionRuntimeToDsl(activeConfig.extraction_runtime),
        /** Как при сохранении в DSL — иначе в шлюзе к промпту не попадало превью правил и тест расходился с реальным извлечением. */
        rules_preview: loadedDsl ? buildRulesPreviewFromDsl(loadedDsl) : undefined,
      });
      setTestResult(res);
    } catch (e: any) {
      setError(e?.message ?? "Ошибка тестирования промпта.");
      setTestResult(null);
    } finally {
      setTestBusy(false);
    }
  }

  return (
    <div className="container">
      <h1 style={{ marginBottom: 10 }}>Настройка извлечения признаков</h1>
      <nav className="fe-text-nav" aria-label="Основные разделы настроек">
        <button
          type="button"
          className={`fe-text-nav__tab${!isModelAdminPage ? " fe-text-nav__tab--active" : ""}`}
          onClick={() => navigate(featureBasePath)}
        >
          Настройки по справочникам
        </button>
        <button
          type="button"
          className={`fe-text-nav__tab${isModelAdminPage ? " fe-text-nav__tab--active" : ""}`}
          onClick={() => navigate(`${featureBasePath}/models`)}
        >
          Администрирование моделей
        </button>
      </nav>

      {isModelAdminPage ? (
        <FeatureExtractionModelAdmin
          onRunningModelsChange={setRunningModels}
          ollamaTerminal={ollamaTerminal}
          setOllamaTerminal={setOllamaTerminal}
        />
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
          className={`fe-text-nav__tab${subpage === "test" ? " fe-text-nav__tab--active" : ""}`}
          onClick={() => navigate(`${featureBasePath}/test`)}
        >
          3. Проверка промпта
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

      {(subpage === "prompts" || subpage === "test") && catalogSelected ? (
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
      <OllamaMemoryBanner runningModels={runningModels} />
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

      {catalogSelected && busy ? (
        <div className="card" style={{ color: "#475569" }}>
          <p style={{ margin: 0 }}>Загрузка данных справочника…</p>
        </div>
      ) : null}

      </>
      )}

      {subpage === "prompts" && (
      <>
      <OllamaMemoryBanner runningModels={runningModels} />
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
      {catalogSelected && busy ? (
        <div className="card" style={{ color: "#475569", marginBottom: 16 }}>
          <p style={{ margin: 0 }}>Загрузка данных справочника…</p>
        </div>
      ) : null}
      {editorReady ? (
          <div className="card">
            <h2 style={{ marginTop: 0, marginBottom: 8 }}>Конфигурация и промпты</h2>
            <p style={{ margin: "0 0 16px 0", color: "#64748b", fontSize: 14, lineHeight: 1.45 }}>
              Набор правил извлечения: на один справочник можно завести несколько конфигураций. У каждой конфигурации — один общий промпт и
              набор моделей Ollama (для теста выбирается одна из отмеченных).
            </p>

            <label style={{ display: "grid", gap: 6, marginBottom: 16 }}>
              <span style={{ fontWeight: 600 }}>Название справочника</span>
              <input
                type="text"
                value={catalogName}
                onChange={(e) => setCatalogName(e.target.value)}
                disabled={busy}
                placeholder="Например: Удобрения, массовая доля"
                style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #cbd5e1", maxWidth: 480 }}
              />
              <span style={{ fontSize: 12, color: "#64748b" }}>
                Сохранится как `meta.name` этого справочника.
              </span>
            </label>

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

            <label style={{ display: "grid", gap: 6, marginBottom: 16 }}>
              <span style={{ fontWeight: 600 }}>Название конфигурации</span>
              <input
                type="text"
                value={activeConfig.name}
                onChange={(e) => updateActiveConfig({ name: e.target.value })}
                disabled={busy}
                style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #cbd5e1", maxWidth: 480 }}
              />
            </label>

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
                    const blockedElsewhere = modelsReservedByOtherConfigs.has(modelName) && !checked;
                    return (
                      <label
                        key={modelName}
                        title={
                          blockedElsewhere
                            ? `${modelName} — уже в другой конфигурации этого справочника`
                            : modelName
                        }
                        style={{
                          flex: "0 0 auto",
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 6,
                          maxWidth: 220,
                          padding: "6px 10px",
                          borderRadius: 999,
                          fontSize: 12,
                          cursor: busy || blockedElsewhere ? "not-allowed" : "pointer",
                          border: checked ? "2px solid #2563eb" : "1px solid #cbd5e1",
                          background: checked ? "#eff6ff" : blockedElsewhere ? "#f1f5f9" : "#fff",
                          color: blockedElsewhere ? "#94a3b8" : "#0f172a",
                          opacity: blockedElsewhere ? 0.75 : 1,
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={busy || blockedElsewhere}
                          onChange={(e) => {
                            if (e.target.checked && modelsReservedByOtherConfigs.has(modelName)) {
                              setError(
                                `Модель «${modelName}» уже задана в другой конфигурации этого справочника. Снимите её там или выберите другую модель.`,
                              );
                              return;
                            }
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
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={
                      busy ||
                      promptGenBusy ||
                      !activeConfig.selected_models.length ||
                      !runningModels.includes(promptGenModel.trim())
                    }
                    onClick={() => void runGenerateExtractionPrompt()}
                  >
                    {promptGenBusy ? "Генерация…" : "Сгенерировать основу промпта из справочника"}
                  </button>
                </div>
              </div>
              <div
                style={{
                  marginBottom: 10,
                  padding: "8px 10px",
                  borderRadius: 8,
                  border: "1px solid #e2e8f0",
                  background: "#f8fafc",
                  display: "grid",
                  gap: 8,
                }}
              >
                <p style={{ margin: 0, fontSize: 12, color: "#64748b", lineHeight: 1.45 }}>
                  Нажмите кнопку выше, чтобы автоматически получить черновик промпта на основе данных выбранного справочника.
                  После генерации отредактируйте текст вручную в поле ниже.
                </p>
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

            <FewShotPromptAssistant
              selectedModels={activeConfig.selected_models}
              prompt={String(activeConfig.prompt ?? "")}
              rulesPreview={loadedDsl ? buildRulesPreviewFromDsl(loadedDsl) : ""}
              disabled={busy || promptGenBusy}
            />

            <label
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 10,
                marginTop: 4,
                marginBottom: 16,
                maxWidth: 720,
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
                style={{ width: 16, height: 16, marginTop: 2, flexShrink: 0 }}
              />
              <span style={{ fontSize: 14, lineHeight: 1.45, color: "#334155" }}>
                Включить constrained decoding (guidance)
              </span>
            </label>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
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
                {busy ? "Сохранение…" : "Сохранить в справочник"}
              </button>
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

      {subpage === "test" && (
      <>
      <OllamaMemoryBanner runningModels={runningModels} />
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
      {catalogSelected && busy ? (
        <div className="card" style={{ color: "#475569", marginBottom: 16 }}>
          <p style={{ margin: 0 }}>Загрузка данных справочника…</p>
        </div>
      ) : null}
      {editorReady ? (
          <div className="card">
            <h2 style={{ marginTop: 0, marginBottom: 8 }}>Проверка промпта</h2>
            {activeConfig.selected_models.length === 0 ? (
              <p style={{ color: "#64748b", margin: 0 }}>
                На странице «Конфигурация и промпты» отметьте модели и задайте промпт конфигурации.
              </p>
            ) : (
              <div style={{ display: "grid", gap: 12 }}>
                <label style={{ display: "grid", gap: 6 }}>
                  <span style={{ fontWeight: 600 }}>Модель для теста</span>
                  <span style={{ fontSize: 12, color: "#64748b", lineHeight: 1.45 }}>
                    Выбор только из моделей, <strong>отмеченных для этой конфигурации</strong> в разделе «Конфигурация и промпты».
                  </span>
                  <select
                    value={testModelResolved}
                    onChange={(e) => setTestModel(e.target.value)}
                    disabled={testBusy}
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

                {testModelResolved && !isTestModelRunning ? (
                  <div
                    role="status"
                    style={{
                      padding: "10px 14px",
                      background: "#fffbeb",
                      border: "1px solid #fcd34d",
                      borderRadius: 8,
                      fontSize: 14,
                      color: "#78350f",
                      lineHeight: 1.5,
                    }}
                  >
                    <strong>Модель не запущена.</strong>
                  </div>
                ) : null}

                <p style={{ margin: 0, fontSize: 13, color: "#64748b", lineHeight: 1.5 }}>
                  Системный промпт задаётся на шаге «Конфигурация и промпты» (активная конфигурация). Здесь — только{" "}
                  <strong>исходный текст документа</strong>, из которого модель извлекает признаки. Вызов API собирает одну
                  строку: превью правил справочника + промпт + этот текст с подписью «Текст для извлечения».
                </p>
                <label style={{ display: "grid", gap: 6 }}>
                  <span style={{ fontWeight: 600 }}>Текст для извлечения (документ)</span>
                  <textarea
                    value={sampleText}
                    onChange={(e) => setSampleText(e.target.value)}
                    style={{ minHeight: 120, padding: "6px 10px", borderRadius: 8, border: "1px solid #cbd5e1" }}
                    disabled={testBusy}
                  />
                </label>

                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => void runPromptTest()}
                    disabled={testBusy || !canRunPromptTest}
                  >
                    {testBusy ? "Выполняется…" : "Запустить тест"}
                  </button>
                </div>

                {testResult ? (
                  <div style={{ display: "grid", gap: 10 }}>
                    <div>
                      <div style={{ fontWeight: 600, marginBottom: 6, color: "#0f172a" }}>Распознанный результат</div>
                      {(() => {
                        const timingLine = formatExtractionTiming(testResult);
                        if (!timingLine) return null;
                        return (
                          <div style={{ fontSize: 13, color: "#64748b", marginBottom: 10, lineHeight: 1.45 }}>
                            <span style={{ fontWeight: 600, color: "#475569" }}>Время: </span>
                            {timingLine}
                          </div>
                        );
                      })()}
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
                          <p style={{ margin: "8px 0 6px", fontSize: 12, color: "#64748b" }}>
                            Поле <code>prompt_preview</code> в JSON ответа — только ваш промпт со шага 2; ниже — то, что реально
                            ушло в Ollama (правила + промпт + документ).
                          </p>
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
                          {JSON.stringify(testResult, null, 2)}
                        </pre>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
            )}
          </div>
      ) : catalogSelected && !busy ? (
        <div className="card" style={{ color: "#64748b" }}>
          <p style={{ margin: 0 }}>Нет данных для теста. Вернитесь на шаг «Справочник» и выберите справочник снова.</p>
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
        {subpage !== "catalog" ? (
          <button
            type="button"
            className="btn-secondary"
            onClick={() =>
              navigate(subpage === "test" ? `${featureBasePath}/prompts` : featureBasePath)
            }
          >
            Назад
          </button>
        ) : null}
        {subpage !== "test" ? (
          <button
            type="button"
            className={subpage === "catalog" && !catalogSelected ? "btn-secondary" : "btn"}
            disabled={subpage === "catalog" && !catalogSelected}
            onClick={() =>
              navigate(subpage === "catalog" ? `${featureBasePath}/prompts` : `${featureBasePath}/test`)
            }
          >
            Далее
          </button>
        ) : null}
      </div>
      </div>
      )}

      {isModelAdminPage ? (
        <FeatureExtractionOllamaConsole
          mergedText={mergedOllamaConsoleText}
          terminal={ollamaTerminal}
          onRefreshLogs={() => void loadOllamaContainerLogs()}
        />
      ) : null}
    </div>
  );
}
