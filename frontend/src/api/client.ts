/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  EXTRACTION_TEST_INFER_DURATION_FIELD,
  FEATURE_EXTRACTION_LLM_CONTAINER_LOGS_PATH,
  INFERENCE_OPTIONS_BODY_KEY,
} from "./backendInferenceKeys";

const API_BASE = (import.meta as any).env?.VITE_API_BASE ?? "/api";
const RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 350;

async function parseJsonSafe(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

/** Текст ошибки FastAPI: detail строка, массив validation errors или объект. */
function formatFastApiDetail(detail: unknown): string {
  if (detail == null) return "";
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((x: any) => (x && typeof x === "object" && x.msg != null ? String(x.msg) : JSON.stringify(x)))
      .filter(Boolean)
      .join("; ");
  }
  if (typeof detail === "object") return JSON.stringify(detail);
  return String(detail);
}

/** Читает тело ответа один раз; при ошибке HTTP бросает Error с detail или сырой текст. */
async function readJsonOrThrow(res: Response, fallbackError: string): Promise<any> {
  const text = await res.text();
  let body: any = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      if (!res.ok) {
        throw new Error(text.trim().slice(0, 4000) || `${fallbackError} (HTTP ${res.status})`);
      }
      throw new Error(`${fallbackError}: ответ сервера не JSON`);
    }
  } else if (!res.ok) {
    throw new Error(`${fallbackError} (HTTP ${res.status})`);
  }
  if (!res.ok) {
    const d = formatFastApiDetail(body?.detail);
    throw new Error(d || text.trim().slice(0, 4000) || `HTTP ${res.status}`);
  }
  return body ?? {};
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function shouldRetryStatus(status: number): boolean {
  return status >= 500 || status === 429;
}

async function fetchWithRetry(input: RequestInfo | URL, init?: RequestInit, attempts = RETRY_ATTEMPTS): Promise<Response> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const res = await fetch(input, init);
      if (shouldRetryStatus(res.status) && attempt < attempts - 1) {
        await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
        continue;
      }
      return res;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      lastError = err;
      if (attempt < attempts - 1) {
        await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
        continue;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Network request failed");
}

export async function saveRule(dsl: any, ruleId?: string | null): Promise<any> {
  if (!ruleId) {
    const res = await fetchWithRetry(`${API_BASE}/rules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(dsl),
    });
    const json = await parseJsonSafe(res);
    if (!res.ok) throw new Error(json?.detail ?? "Failed to save rule");
    return json;
  }

  // New backend path (preferred)
  let res = await fetchWithRetry(`${API_BASE}/rules/${ruleId}/save`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(dsl),
  });
  let json = await parseJsonSafe(res);
  if (res.ok) return json;

  // Backward compatibility for deployments with PUT /rules/{id}
  if (res.status === 404 || res.status === 405) {
    res = await fetchWithRetry(`${API_BASE}/rules/${ruleId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(dsl),
    });
    json = await parseJsonSafe(res);
    if (res.ok) return json;
  }

  if (res.status === 404 || res.status === 405) {
    throw new Error("Обновление недоступно на текущем backend (пересоберите и перезапустите backend).");
  }
  throw new Error(json?.detail ?? "Failed to save rule");
}

export async function validateRule(ruleId: string, data: any): Promise<any> {
  const res = await fetchWithRetry(`${API_BASE}/rules/${ruleId}/validate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data }),
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(json?.detail ?? "Failed to validate");
  }
  return json;
}

export async function listReferenceExamples(ruleId: string): Promise<{ examples: any[] }> {
  const res = await fetchWithRetry(`${API_BASE}/rules/${encodeURIComponent(ruleId)}/reference-examples`, {
    method: "GET",
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json?.detail ?? "Не удалось загрузить эталонные примеры");
  return json;
}

export async function bulkSaveReferenceExamples(
  ruleId: string,
  items: { description_text: string; data: unknown }[],
): Promise<{ inserted: number; skipped: any[] }> {
  const res = await fetchWithRetry(`${API_BASE}/rules/${encodeURIComponent(ruleId)}/reference-examples/bulk`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json?.detail ?? "Не удалось сохранить примеры");
  return json;
}

export async function deleteReferenceExample(ruleId: string, exampleId: string): Promise<void> {
  const res = await fetchWithRetry(
    `${API_BASE}/rules/${encodeURIComponent(ruleId)}/reference-examples/${encodeURIComponent(exampleId)}`,
    { method: "DELETE" },
  );
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.detail ?? "Не удалось удалить пример");
}

export async function listRules(params?: { q?: string; include_archived?: boolean }): Promise<any[]> {
  const sp = new URLSearchParams();
  if (params?.q?.trim()) sp.set("q", params.q.trim());
  if (params?.include_archived) sp.set("include_archived", "true");
  const qs = sp.toString();
  const res = await fetchWithRetry(`${API_BASE}/rules${qs ? `?${qs}` : ""}`, {
    method: "GET",
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(json?.detail ?? "Failed to list rules");
  }
  return Array.isArray(json) ? json : [];
}

export async function getRule(ruleId: string): Promise<any> {
  const res = await fetchWithRetry(`${API_BASE}/rules/${ruleId}`, { method: "GET" });
  const json = await res.json();
  if (!res.ok) throw new Error(json?.detail ?? "Failed to get rule");
  return json;
}

export async function cloneRule(ruleId: string, payload?: { name?: string; model_id?: string }): Promise<any> {
  const res = await fetchWithRetry(`${API_BASE}/rules/${ruleId}/clone`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json?.detail ?? "Failed to clone rule");
  return json;
}

export async function archiveRule(ruleId: string): Promise<void> {
  const res = await fetchWithRetry(`${API_BASE}/rules/${ruleId}/archive`, { method: "POST" });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.detail ?? "Не удалось отправить в архив");
}

export async function unarchiveRule(ruleId: string): Promise<void> {
  const res = await fetchWithRetry(`${API_BASE}/rules/${ruleId}/unarchive`, { method: "POST" });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.detail ?? "Не удалось восстановить из архива");
}

export async function deleteRule(ruleId: string): Promise<void> {
  const res = await fetchWithRetry(`${API_BASE}/rules/${ruleId}`, { method: "DELETE" });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.detail ?? "Не удалось удалить справочник");
}

export type OfficerValidationPayload = {
  graph31: string;
  graph33: string;
  graph35: number;
  graph38: number;
  graph42: number;
  /** Если задан — сервер пропускает вызов модели извлечения и использует этот JSON. */
  extracted_features_override?: Record<string, unknown> | null;
};

export async function validateDeclarationByOfficer(
  payload: OfficerValidationPayload,
  options?: { signal?: AbortSignal },
): Promise<any> {
  const body: Record<string, unknown> = {
    declaration_id: `OFFICER-${Date.now()}`,
    description: payload.graph31,
    tnved_code: payload.graph33,
    gross_weight_kg: payload.graph35,
    net_weight_kg: payload.graph38,
    price: payload.graph42,
  };
  if (payload.extracted_features_override != null) {
    body.extracted_features_override = payload.extracted_features_override;
  }
  const res = await fetchWithRetry(`${API_BASE}/validate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: options?.signal,
  });
  const json = await parseJsonSafe(res);
  if (!res.ok) {
    throw new Error(json?.detail ?? "Не удалось запустить проверку декларации");
  }
  return json;
}

export async function getPrimaryCatalogSettings(): Promise<{ by_group_code: Record<string, string> }> {
  const res = await fetchWithRetry(`${API_BASE}/feature-extraction/primary-catalog-settings`, {
    method: "GET",
  });
  const json = await parseJsonSafe(res);
  if (!res.ok) {
    throw new Error(formatFastApiDetail(json?.detail) ?? "Не удалось загрузить основной справочник по категориям");
  }
  const raw = json?.by_group_code;
  return {
    by_group_code:
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, string>)
        : {},
  };
}

export async function putPrimaryCatalogSettings(
  by_group_code: Record<string, string>,
): Promise<{ by_group_code: Record<string, string> }> {
  const res = await fetchWithRetry(`${API_BASE}/feature-extraction/primary-catalog-settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ by_group_code }),
  });
  const json = await parseJsonSafe(res);
  if (!res.ok) {
    throw new Error(formatFastApiDetail(json?.detail) ?? "Не удалось сохранить основной справочник");
  }
  return json;
}

export async function getPipelineConfig(): Promise<any> {
  const res = await fetchWithRetry(`${API_BASE}/admin/pipeline-config`, { method: "GET" });
  const json = await parseJsonSafe(res);
  if (!res.ok) {
    throw new Error(json?.detail ?? "Не удалось загрузить конфигурацию пайплайна");
  }
  return json;
}

export async function savePipelineConfig(body: { semantic_similarity_threshold?: number }): Promise<any> {
  const res = await fetchWithRetry(`${API_BASE}/admin/pipeline-config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await parseJsonSafe(res);
  if (!res.ok) {
    throw new Error(json?.detail ?? "Не удалось сохранить конфигурацию пайплайна");
  }
  return json;
}

export async function submitExpertClassNameDecision(body: {
  declaration_id: string;
  rule_id?: string | null;
  suggested_class_name: string;
  decision: "approve" | "reject";
  note?: string | null;
}): Promise<any> {
  const res = await fetchWithRetry(`${API_BASE}/expert/class-name-decision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await parseJsonSafe(res);
  if (!res.ok) {
    throw new Error(json?.detail ?? "Не удалось записать решение эксперта");
  }
  return json;
}

/** Опции инференса для теста извлечения (в теле API передаются под ключом, ожидаемым бэкендом). */
export type LlmInferenceOptions = {
  model?: string;
  num_ctx?: number;
  max_new_tokens?: number;
  repetition_penalty?: number;
  max_length?: number;
  enable_thinking?: boolean;
};

export type FeatureExtractionTestPayload = {
  model: string;
  prompt: string;
  sample_text?: string;
  raw_llm_output?: string;
  llm_inference_options?: LlmInferenceOptions;
  runtime?: {
    structured_output?: boolean;
    use_guidance?: boolean;
  };
  rules_preview?: string;
};

export async function testFeatureExtractionPrompt(payload: FeatureExtractionTestPayload): Promise<any> {
  const { llm_inference_options, ...rest } = payload;
  const body: Record<string, unknown> = { ...rest };
  if (llm_inference_options != null) {
    body[INFERENCE_OPTIONS_BODY_KEY] = llm_inference_options;
  }
  const res = await fetchWithRetry(`${API_BASE}/feature-extraction/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await parseJsonSafe(res);
  if (!res.ok) {
    throw new Error(json?.detail ?? "Не удалось выполнить тест извлечения признаков");
  }
  return json;
}

export type FewShotAssistPayload = {
  model: string;
  prompt: string;
  rules_preview?: string;
  unlabeled_texts: string[];
  labeled_texts?: string[];
  k?: number;
  temperature?: number;
  top_p?: number;
  alpha?: number;
  beta?: number;
  gamma?: number;
  num_ctx?: number;
  max_new_tokens?: number;
  repetition_penalty?: number;
  max_candidates?: number;
  enable_thinking?: boolean;
  top_n?: number;
  candidate_strategy?: "simple" | "few_shot_extractor";
  n_clusters?: number;
  outlier_k?: number;
  outlier_percentile?: number | null;
};

/** Долгий запрос: без повторов retry, одна попытка (как deploy). */
export async function runFewShotAssist(payload: FewShotAssistPayload): Promise<any> {
  const res = await fetch(`${API_BASE}/feature-extraction/few-shot-assist`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return readJsonOrThrow(res, "Не удалось выполнить оценку few-shot");
}

export async function saveFewShotAssistRun(ruleId: string, result: Record<string, unknown>): Promise<any> {
  const res = await fetchWithRetry(`${API_BASE}/feature-extraction/few-shot-runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rule_id: ruleId, result }),
  });
  return readJsonOrThrow(res, "Не удалось сохранить прогон few-shot");
}

export async function listFewShotAssistRuns(ruleId: string): Promise<{ runs: any[] }> {
  const qs = new URLSearchParams({ rule_id: ruleId });
  const res = await fetchWithRetry(`${API_BASE}/feature-extraction/few-shot-runs?${qs.toString()}`, {
    method: "GET",
  });
  return readJsonOrThrow(res, "Не удалось загрузить историю few-shot");
}

export async function deleteFewShotAssistRun(runId: string): Promise<any> {
  const res = await fetchWithRetry(`${API_BASE}/feature-extraction/few-shot-runs/${encodeURIComponent(runId)}`, {
    method: "DELETE",
  });
  return readJsonOrThrow(res, "Не удалось удалить прогон few-shot");
}

/** Дефолты на шлюзе совпадают с инференсом извлечения (ctx, max_new_tokens, repeat_penalty), температура выше нуля. */
export type GenerateExtractionPromptPayload = {
  model: string;
  prompt: string;
  num_ctx?: number;
  max_new_tokens?: number;
  temperature?: number;
  top_p?: number | null;
  repetition_penalty?: number;
  enable_thinking?: boolean;
};

/** Генерация системного промпта извлечения признаков через LLM (мета-промпт + данные справочника). */
export async function generateFeatureExtractionSystemPrompt(
  payload: GenerateExtractionPromptPayload,
): Promise<any> {
  const res = await fetch(`${API_BASE}/feature-extraction/generate-prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return readJsonOrThrow(res, "Не удалось сгенерировать промпт извлечения");
}

export type FeatureExtractionModelSettingsPayload = {
  models: Record<string, Record<string, any>>;
};

export async function getFeatureExtractionModelSettings(): Promise<FeatureExtractionModelSettingsPayload> {
  const res = await fetchWithRetry(`${API_BASE}/feature-extraction/model-settings`, { method: "GET" });
  const json = await parseJsonSafe(res);
  if (!res.ok) {
    throw new Error(json?.detail ?? "Не удалось загрузить настройки моделей");
  }
  return {
    models: json?.models && typeof json.models === "object" ? json.models : {},
  };
}

export async function saveFeatureExtractionModelSettings(
  payload: FeatureExtractionModelSettingsPayload,
): Promise<FeatureExtractionModelSettingsPayload> {
  const res = await fetchWithRetry(`${API_BASE}/feature-extraction/model-settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = await parseJsonSafe(res);
  if (!res.ok) {
    throw new Error(json?.detail ?? "Не удалось сохранить настройки моделей");
  }
  return {
    models: json?.models && typeof json.models === "object" ? json.models : {},
  };
}

export async function listFeatureExtractionModels(): Promise<{
  installed_models: string[];
  configured_models: string[];
  running_models: string[];
}> {
  const res = await fetchWithRetry(`${API_BASE}/feature-extraction/models`, { method: "GET" });
  const json = await parseJsonSafe(res);
  if (!res.ok) {
    throw new Error(json?.detail ?? "Не удалось загрузить список моделей");
  }
  return {
    installed_models: Array.isArray(json?.installed_models) ? json.installed_models.map(String) : [],
    configured_models: Array.isArray(json?.configured_models) ? json.configured_models.map(String) : [],
    running_models: Array.isArray(json?.running_models) ? json.running_models.map(String) : [],
  };
}

/** Без retry: долгие операции с моделью не должны выполняться по три раза при 502. */
export async function deployFeatureExtractionModel(model: string): Promise<any> {
  const res = await fetch(`${API_BASE}/feature-extraction/deploy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model }),
  });
  return readJsonOrThrow(res, "Не удалось запустить модель на сервере");
}

export async function pauseFeatureExtractionModel(model: string): Promise<any> {
  const res = await fetch(`${API_BASE}/feature-extraction/pause`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model }),
  });
  return readJsonOrThrow(res, "Не удалось выгрузить модель из памяти");
}

export async function deleteFeatureExtractionModel(model: string): Promise<any> {
  const res = await fetch(`${API_BASE}/feature-extraction/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model }),
  });
  return readJsonOrThrow(res, "Не удалось удалить образ модели");
}

export type LlmContainerLogsResponse = {
  available?: boolean;
  container?: string;
  tail?: number;
  lines?: string;
  reason?: string;
  hint?: string;
};

/** Хвост логов контейнера с LLM (через preprocessing + docker). */
export async function fetchLlmContainerLogs(tail: number = 300): Promise<LlmContainerLogsResponse> {
  const t = Math.max(20, Math.min(tail, 5000));
  const res = await fetch(`${API_BASE}/${FEATURE_EXTRACTION_LLM_CONTAINER_LOGS_PATH}?tail=${t}`);
  const json = (await parseJsonSafe(res)) as LlmContainerLogsResponse;
  if (!res.ok) {
    throw new Error((json as { detail?: string })?.detail ?? "Не удалось получить логи контейнера с моделью");
  }
  return json;
}

