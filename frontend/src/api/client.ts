/* eslint-disable @typescript-eslint/no-explicit-any */

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

export async function listTemplates(): Promise<any[]> {
  const res = await fetchWithRetry(`${API_BASE}/rules/templates`, { method: "GET" });
  const json = await res.json();
  if (!res.ok) throw new Error(json?.detail ?? "Failed to list templates");
  return Array.isArray(json) ? json : [];
}

export async function getTemplate(templateId: string): Promise<any> {
  const res = await fetchWithRetry(`${API_BASE}/rules/templates/${templateId}`, { method: "GET" });
  const json = await res.json();
  if (!res.ok) throw new Error(json?.detail ?? "Failed to get template");
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
};

export async function validateDeclarationByOfficer(payload: OfficerValidationPayload): Promise<any> {
  const res = await fetchWithRetry(`${API_BASE}/validate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      declaration_id: `OFFICER-${Date.now()}`,
      description: payload.graph31,
      tnved_code: payload.graph33,
      gross_weight_kg: payload.graph35,
      net_weight_kg: payload.graph38,
      price: payload.graph42,
    }),
  });
  const json = await parseJsonSafe(res);
  if (!res.ok) {
    throw new Error(json?.detail ?? "Не удалось запустить проверку декларации");
  }
  return json;
}

export type FeatureExtractionTestPayload = {
  model: string;
  prompt: string;
  sample_text?: string;
  raw_llm_output?: string;
  ollama?: {
    model?: string;
    num_ctx?: number;
    max_new_tokens?: number;
    repetition_penalty?: number;
    max_length?: number;
    enable_thinking?: boolean;
  };
  runtime?: {
    structured_output?: boolean;
    use_guidance?: boolean;
  };
  rules_preview?: string;
};

export async function testFeatureExtractionPrompt(payload: FeatureExtractionTestPayload): Promise<any> {
  const res = await fetchWithRetry(`${API_BASE}/feature-extraction/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
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

export type GenerateExtractionPromptPayload = {
  model: string;
  prompt: string;
  num_ctx?: number;
  max_new_tokens?: number;
  temperature?: number;
  top_p?: number;
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

/** Без retry: долгие операции с Ollama не должны выполняться по три раза при 502. */
export async function deployFeatureExtractionModel(model: string): Promise<any> {
  const res = await fetch(`${API_BASE}/feature-extraction/deploy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model }),
  });
  return readJsonOrThrow(res, "Не удалось запустить модель в Ollama");
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

export type OllamaContainerLogsResponse = {
  available?: boolean;
  container?: string;
  tail?: number;
  lines?: string;
  reason?: string;
  hint?: string;
};

/** Хвост `docker logs` контейнера Ollama (через preprocessing + сокет Docker на хосте). */
export async function fetchOllamaContainerLogs(tail: number = 300): Promise<OllamaContainerLogsResponse> {
  const t = Math.max(20, Math.min(tail, 5000));
  const res = await fetch(`${API_BASE}/feature-extraction/ollama-container-logs?tail=${t}`);
  const json = (await parseJsonSafe(res)) as OllamaContainerLogsResponse;
  if (!res.ok) {
    throw new Error((json as { detail?: string })?.detail ?? "Не удалось получить логи контейнера Ollama");
  }
  return json;
}

