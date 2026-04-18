/**
 * Имена полей и путей API инференса, заданные бэкендом.
 * Собраны здесь, чтобы остальной фронтенд не ссылался на конкретные строки-ключи.
 */

export const INFERENCE_OPTIONS_BODY_KEY = "ollama" as const;

export const EXTRACTION_TEST_INFER_DURATION_FIELD = "ollama_compute_duration_sec" as const;

export const FEATURE_EXTRACTION_LLM_CONTAINER_LOGS_PATH = "feature-extraction/ollama-container-logs" as const;
