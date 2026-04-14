/* eslint-disable @typescript-eslint/no-explicit-any */
import React from "react";
import {
  deleteFeatureExtractionModel,
  deployFeatureExtractionModel,
  getFeatureExtractionModelSettings,
  listFeatureExtractionModels,
  pauseFeatureExtractionModel,
  saveFeatureExtractionModelSettings,
} from "../api/client";
import type { OllamaOperationLogState } from "./FeatureExtractionOllamaConsole";

type Props = {
  /** Список сейчас запущенных в Ollama моделей (для экрана «Справочники»). */
  onRunningModelsChange?: (runningModels: string[]) => void;
  /** Состояние консоли вынесено на страницу — не пропадает при смене вкладки. */
  ollamaTerminal: OllamaOperationLogState;
  setOllamaTerminal: React.Dispatch<React.SetStateAction<OllamaOperationLogState>>;
};

const defaultJson = {
  models: {
    "gemma2:2b-instruct-q4_K_M": {
      num_ctx: 8192,
      max_new_tokens: 3904,
      repetition_penalty: 1.0,
      max_length: 4096,
      enable_thinking: false,
      temperature: 0.0,
    },
    "qwen2.5:3b-instruct-q4_K_M": {
      num_ctx: 8192,
      max_new_tokens: 3904,
      repetition_penalty: 1.0,
      max_length: 4096,
      enable_thinking: false,
      temperature: 0.0,
    },
    "qwen3:4b-q4_K_M": {
      num_ctx: 8192,
      max_new_tokens: 3904,
      repetition_penalty: 1.0,
      max_length: 4096,
      enable_thinking: false,
      temperature: 0.0,
    },
    "qwen3:8b-q4_K_M": {
      num_ctx: 8192,
      max_new_tokens: 3904,
      repetition_penalty: 1.0,
      max_length: 4096,
      enable_thinking: false,
      temperature: 0.0,
    },
    "qwen3:14b-q4_K_M": {
      num_ctx: 8192,
      max_new_tokens: 3904,
      repetition_penalty: 1.0,
      max_length: 4096,
      enable_thinking: false,
      temperature: 0.0,
    },
    "gemma3:4b-it-q4_K_M": {
      num_ctx: 8192,
      max_new_tokens: 3904,
      repetition_penalty: 1.0,
      max_length: 4096,
      enable_thinking: false,
      temperature: 0.0,
    },
    "codegemma:7b-instruct-q4_K_M": {
      num_ctx: 8192,
      max_new_tokens: 3904,
      repetition_penalty: 1.0,
      max_length: 4096,
      enable_thinking: false,
      temperature: 0.0,
    },
    "gemma3:12b-it-q4_K_M": {
      num_ctx: 8192,
      max_new_tokens: 3904,
      repetition_penalty: 1.0,
      max_length: 4096,
      enable_thinking: false,
      temperature: 0.0,
    },
    "ministral-3:8b-instruct-2512-q4_K_M": {
      num_ctx: 8192,
      max_new_tokens: 3904,
      repetition_penalty: 1.0,
      max_length: 4096,
      enable_thinking: false,
      temperature: 0.0,
    },
    "ministral-3:14b-instruct-2512-q4_K_M": {
      num_ctx: 8192,
      max_new_tokens: 3904,
      repetition_penalty: 1.0,
      max_length: 4096,
      enable_thinking: false,
      temperature: 0.0,
    },
    "ministral-3:3b-instruct-2512-q4_K_M": {
      num_ctx: 8192,
      max_new_tokens: 3904,
      repetition_penalty: 1.0,
      max_length: 4096,
      enable_thinking: false,
      temperature: 0.0,
    },
    "forzer/GigaChat3-10B-A1.8B": {
      num_ctx: 8192,
      max_new_tokens: 3904,
      repetition_penalty: 1.0,
      max_length: 4096,
      enable_thinking: false,
      temperature: 0.0,
    },
    "gigachat-20b-a3b-instruct-v1.5:q4_K_M": {
      num_ctx: 8192,
      max_new_tokens: 3904,
      repetition_penalty: 1.0,
      max_length: 4096,
      enable_thinking: false,
      temperature: 0.0,
    },
  },
};

function IconPlay() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function IconStop() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M6 6h12v12H6z" />
    </svg>
  );
}

function IconTrash() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14zM10 11v6M14 11v6" />
    </svg>
  );
}

const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 14,
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  overflow: "hidden",
};

const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "10px 12px",
  background: "#f1f5f9",
  color: "#475569",
  fontWeight: 600,
  borderBottom: "1px solid #e2e8f0",
};

const tdStyle: React.CSSProperties = {
  padding: "10px 12px",
  borderBottom: "1px solid #f1f5f9",
  verticalAlign: "middle",
};

const badge = (ok: boolean, okText: string, noText: string): React.ReactNode => (
  <span
    style={{
      display: "inline-block",
      padding: "2px 8px",
      borderRadius: 999,
      fontSize: 12,
      fontWeight: 600,
      background: ok ? "#dcfce7" : "#f1f5f9",
      color: ok ? "#166534" : "#64748b",
    }}
  >
    {ok ? okText : noText}
  </span>
);

const iconBtnStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 36,
  height: 36,
  padding: 0,
  borderRadius: 8,
  border: "1px solid #cbd5e1",
  background: "#fff",
  cursor: "pointer",
  color: "#334155",
};

function formatDeployElapsed(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

export default function FeatureExtractionModelAdmin({
  onRunningModelsChange,
  ollamaTerminal,
  setOllamaTerminal,
}: Props) {
  const [settingsText, setSettingsText] = React.useState(JSON.stringify(defaultJson, null, 2));
  const [installedModels, setInstalledModels] = React.useState<string[]>([]);
  const [runningModels, setRunningModels] = React.useState<string[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [action, setAction] = React.useState<{ model: string; kind: "deploy" | "pause" | "delete" } | null>(null);
  /** Ошибки сохранения JSON / загрузки настроек / refresh без привязки к строке модели. */
  const [settingsError, setSettingsError] = React.useState<string | null>(null);
  const [settingsStatus, setSettingsStatus] = React.useState<string | null>(null);
  /** Сообщения по конкретной модели: ошибка pull/pause/delete или краткий успех. */
  const [modelFeedback, setModelFeedback] = React.useState<
    Record<string, { kind: "error" | "success"; text: string }>
  >({});
  /** Текущая длительная операция (pull / pause / delete / refresh / save). */
  const [activityLine, setActivityLine] = React.useState<string | null>(null);
  /** Секунды с начала текущего deploy (для отображения рядом со строкой). */
  const [deployElapsedSec, setDeployElapsedSec] = React.useState(0);
  const clearModelFeedback = React.useCallback((model: string) => {
    setModelFeedback((prev) => {
      if (!(model in prev)) return prev;
      const next = { ...prev };
      delete next[model];
      return next;
    });
  }, []);

  const showGlobalActivityBanner = Boolean((activityLine || busy) && !action);

  React.useEffect(() => {
    if (action?.kind !== "deploy") {
      setDeployElapsedSec(0);
      return;
    }
    const t0 = Date.now();
    setDeployElapsedSec(0);
    const id = window.setInterval(() => {
      setDeployElapsedSec(Math.floor((Date.now() - t0) / 1000));
    }, 400);
    return () => window.clearInterval(id);
  }, [action]);

  const parsed = React.useMemo(() => {
    try {
      return JSON.parse(settingsText);
    } catch {
      return null;
    }
  }, [settingsText]);

  const modelKeys = React.useMemo(() => {
    const m = parsed?.models;
    if (!m || typeof m !== "object") return [] as string[];
    return Object.keys(m).sort();
  }, [parsed]);

  const refresh = React.useCallback(
    async (hint?: string) => {
      setBusy(true);
      setSettingsError(null);
      setActivityLine(hint ?? "Обновление состояния Ollama…");
      try {
        const [settings, available] = await Promise.all([
          getFeatureExtractionModelSettings(),
          listFeatureExtractionModels(),
        ]);
        const onlyModels = {
          models: settings.models && typeof settings.models === "object" ? settings.models : {},
        };
        const running = available.running_models ?? [];
        setInstalledModels(available.installed_models);
        setRunningModels(running);
        onRunningModelsChange?.(running);
        setSettingsText(JSON.stringify(onlyModels, null, 2));
      } catch (e: any) {
        setSettingsError(e?.message ?? "Не удалось загрузить настройки моделей");
      } finally {
        setBusy(false);
        setActivityLine(null);
      }
    },
    [onRunningModelsChange],
  );

  React.useEffect(() => {
    void refresh();
    // Начальная загрузка; избегаем зависимости от нестабильных колбэков родителя
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function saveSettings() {
    if (!parsed || typeof parsed !== "object") {
      setSettingsError("JSON некорректен");
      return;
    }
    const payload = {
      models: (parsed as any).models && typeof (parsed as any).models === "object" ? (parsed as any).models : {},
    };
    setBusy(true);
    setSettingsError(null);
    setActivityLine("Сохранение настроек в базе…");
    try {
      const saved = await saveFeatureExtractionModelSettings(payload);
      const onlyModels = { models: saved.models && typeof saved.models === "object" ? saved.models : {} };
      setSettingsText(JSON.stringify(onlyModels, null, 2));
      setSettingsStatus("Настройки сохранены в базе");
      window.setTimeout(() => setSettingsStatus(null), 3000);
    } catch (e: any) {
      setSettingsError(e?.message ?? "Не удалось сохранить настройки");
    } finally {
      setBusy(false);
      setActivityLine(null);
    }
  }

  async function runDeploy(model: string) {
    setAction({ model, kind: "deploy" });
    setOllamaTerminal(null);
    clearModelFeedback(model);
    try {
      setActivityLine(
        runningModels.some((r) => r !== model) ? `Остановка других запущенных моделей…` : `Подготовка к запуску «${model}»…`,
      );
      for (const r of runningModels) {
        if (r !== model) {
          await pauseFeatureExtractionModel(r);
        }
      }
      setActivityLine(
        installedSet.has(model)
          ? `Запуск «${model}» в Ollama…`
          : `Подкачка образа «${model}», затем запуск…`,
      );
      const result = await deployFeatureExtractionModel(model);
      const pullConsole = Array.isArray((result as any)?.pull_console_lines)
        ? (result as any).pull_console_lines.join("\n")
        : "";
      const pullLog = Array.isArray((result as any)?.pull_log) ? (result as any).pull_log.join("\n") : "";
      const warm = (result as any)?.warm_load;
      const warmBlock =
        warm && typeof warm === "object" ? `--- запуск в памяти (generate) ---\n${JSON.stringify(warm, null, 2)}` : "";
      const combinedLog = [
        pullConsole.trim()
          ? `=== События подкачки (как в консоли preprocessing) ===\n${pullConsole}`
          : null,
        pullLog.trim() ? `=== Сырой поток Ollama (NDJSON) ===\n${pullLog}` : null,
        warmBlock || null,
      ]
        .filter(Boolean)
        .join("\n\n");
      const durationSec = typeof (result as any)?.duration_sec === "number" ? (result as any).duration_sec : undefined;
      setOllamaTerminal({
        model,
        log:
          combinedLog.trim() ||
          "(нет лога: проверьте тег модели и доступ к Ollama)",
        durationSec,
        ok: true,
      });
      await refresh("Синхронизация состояния после загрузки…");
      setModelFeedback((prev) => ({
        ...prev,
        [model]: { kind: "success", text: "Модель запущена в Ollama" },
      }));
      window.setTimeout(() => clearModelFeedback(model), 4000);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setOllamaTerminal({ model, log: msg, ok: false });
      setModelFeedback((prev) => ({
        ...prev,
        [model]: { kind: "error", text: msg || "Не удалось запустить модель" },
      }));
    } finally {
      setAction(null);
      setActivityLine(null);
    }
  }

  async function runPause(model: string) {
    setAction({ model, kind: "pause" });
    clearModelFeedback(model);
    setActivityLine(`Остановка «${model}»…`);
    try {
      await pauseFeatureExtractionModel(model);
      await refresh("Обновление списка после выгрузки…");
      setModelFeedback((prev) => ({
        ...prev,
        [model]: { kind: "success", text: "Запуск остановлен" },
      }));
      window.setTimeout(() => clearModelFeedback(model), 4000);
    } catch (e: any) {
      setModelFeedback((prev) => ({
        ...prev,
        [model]: { kind: "error", text: e?.message ?? "Не удалось остановить запуск модели" },
      }));
    } finally {
      setAction(null);
      setActivityLine(null);
    }
  }

  async function runDelete(model: string) {
    if (!window.confirm(`Удалить модель ${model} из Ollama с диска?`)) return;
    setAction({ model, kind: "delete" });
    clearModelFeedback(model);
    setActivityLine(`Удаление образа «${model}» с диска…`);
    try {
      await deleteFeatureExtractionModel(model);
      await refresh("Обновление списка после удаления…");
      setModelFeedback((prev) => ({
        ...prev,
        [model]: { kind: "success", text: "Образ удалён с диска" },
      }));
      window.setTimeout(() => clearModelFeedback(model), 4000);
    } catch (e: any) {
      setModelFeedback((prev) => ({
        ...prev,
        [model]: { kind: "error", text: e?.message ?? "Не удалось удалить образ" },
      }));
    } finally {
      setAction(null);
      setActivityLine(null);
    }
  }

  const installedSet = React.useMemo(() => new Set(installedModels), [installedModels]);
  const runningSet = React.useMemo(() => new Set(runningModels), [runningModels]);

  const isBusy = (m: string, k: "deploy" | "pause" | "delete") => action?.model === m && action?.kind === k;

  return (
    <div className="card" style={{ padding: 0, overflow: "hidden" }}>
      <div
        style={{
          padding: "16px 18px",
          borderBottom: "1px solid #e2e8f0",
          background: "linear-gradient(180deg, #f8fafc 0%, #fff 100%)",
        }}
      >
        <h2 style={{ margin: 0, fontSize: 18 }}>Администрирование моделей</h2>
      </div>

      <div style={{ padding: "16px 18px", display: "grid", gap: 16 }}>
        {showGlobalActivityBanner ? (
          <div
            role="status"
            aria-live="polite"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "12px 14px",
              background: "#eff6ff",
              border: "1px solid #93c5fd",
              borderRadius: 8,
              fontSize: 14,
              color: "#1e3a5f",
            }}
          >
            <span className="fe-model-admin-spinner" aria-hidden />
            <span style={{ fontWeight: 600 }}>{activityLine ?? (busy ? "Подождите…" : "")}</span>
          </div>
        ) : null}

        <div
          style={{
            padding: "10px 12px",
            background: runningModels.length > 0 ? "#eff6ff" : "#f8fafc",
            border: "1px solid #e2e8f0",
            borderRadius: 8,
            fontSize: 13,
            color: "#334155",
          }}
        >
          <span style={{ fontWeight: 600 }}>Запущенные модели (Ollama): </span>
          {runningModels.length === 0 ? (
            <span style={{ color: "#64748b" }}>нет запущенных (см. колонку «Запущена» ниже).</span>
          ) : (
            <span>
              {runningModels.map((m) => (
                <code key={m} style={{ marginRight: 8, fontSize: 13 }}>
                  {m}
                </code>
              ))}
            </span>
          )}
        </div>

        <div style={{ overflowX: "auto" }}>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Тег модели (Ollama)</th>
                <th style={{ ...thStyle, width: 120 }}>Образ</th>
                <th style={{ ...thStyle, width: 120 }}>Запущена</th>
                <th style={{ ...thStyle, width: 200, textAlign: "right" }}>Действия</th>
              </tr>
            </thead>
            <tbody>
              {modelKeys.length === 0 ? (
                <tr>
                  <td colSpan={4} style={{ ...tdStyle, color: "#64748b" }}>
                    Нет записей в <code>models</code>. Отредактируйте JSON ниже.
                  </td>
                </tr>
              ) : (
                modelKeys.map((m) => {
                  const onDisk = installedSet.has(m);
                  const inMem = runningSet.has(m);
                  const deployingThis = Boolean(action?.model === m && action?.kind === "deploy");
                  /** Пока идёт запуск, статус уже может быть «запущена» — всё равно показываем только кнопку запуска. */
                  const showStopNotPlay = inMem && !deployingThis;
                  const rowOtherBusy = Boolean(action && action.model !== m);
                  const rowSelfBusy = Boolean(action && action.model === m);
                  return (
                    <tr
                      key={m}
                      style={{
                        background: action?.model === m ? "rgba(37, 99, 235, 0.06)" : undefined,
                        transition: "background 0.2s ease",
                      }}
                    >
                      <td style={tdStyle}>
                        <code style={{ fontSize: 13 }}>{m}</code>
                        {action?.model === m && activityLine ? (
                          <div
                            role="status"
                            aria-live="polite"
                            style={{
                              marginTop: 8,
                              display: "flex",
                              alignItems: "flex-start",
                              gap: 8,
                              flexWrap: "wrap",
                              fontSize: 12,
                              fontWeight: 600,
                              color: "#1e40af",
                              lineHeight: 1.4,
                            }}
                          >
                            <span className="fe-model-admin-spinner fe-model-admin-spinner--sm" aria-hidden />
                            <span style={{ flex: "1 1 120px" }}>{activityLine}</span>
                            {action.kind === "deploy" ? (
                              <span
                                style={{
                                  fontVariantNumeric: "tabular-nums",
                                  color: "#64748b",
                                  fontWeight: 600,
                                }}
                                title="Время с начала операции запуска"
                              >
                                {formatDeployElapsed(deployElapsedSec)}
                              </span>
                            ) : null}
                          </div>
                        ) : null}
                        {modelFeedback[m] ? (
                          <div
                            style={{
                              marginTop: 8,
                              fontSize: 12,
                              fontWeight: 600,
                              lineHeight: 1.4,
                              color: modelFeedback[m].kind === "error" ? "#b91c1c" : "#166534",
                            }}
                          >
                            {modelFeedback[m].text}
                          </div>
                        ) : null}
                      </td>
                      <td style={tdStyle}>{badge(onDisk, "На диске", "Нет образа")}</td>
                      <td style={tdStyle}>{badge(inMem, "Да", "Нет")}</td>
                      <td style={{ ...tdStyle, textAlign: "right" }}>
                        <div style={{ display: "inline-flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
                          {showStopNotPlay ? (
                            <button
                              type="button"
                              style={{
                                ...iconBtnStyle,
                                borderColor: "#64748b",
                              }}
                              title="Остановить запуск модели (keep_alive=0)"
                              aria-label="Остановить запуск модели"
                              disabled={busy || rowOtherBusy || rowSelfBusy}
                              onClick={() => void runPause(m)}
                            >
                              {isBusy(m, "pause") ? (
                                <span className="fe-model-admin-spinner fe-model-admin-spinner--sm" aria-label="Выгрузка" />
                              ) : (
                                <IconStop />
                              )}
                            </button>
                          ) : (
                            <button
                              type="button"
                              style={{
                                ...iconBtnStyle,
                                borderColor: "#2563eb",
                                color: "#2563eb",
                              }}
                              title="Запустить модель в Ollama (при отсутствии образа — подкачать, затем запустить инференс)"
                              aria-label="Запустить модель"
                              disabled={busy || rowOtherBusy || rowSelfBusy}
                              onClick={() => void runDeploy(m)}
                            >
                              {isBusy(m, "deploy") ? (
                                <span className="fe-model-admin-spinner fe-model-admin-spinner--sm" aria-label="Загрузка" />
                              ) : (
                                <IconPlay />
                              )}
                            </button>
                          )}
                          <button
                            type="button"
                            style={{
                              ...iconBtnStyle,
                              borderColor: "#b91c1c",
                              color: "#b91c1c",
                            }}
                            title="Удалить образ с диска"
                            aria-label="Удалить образ"
                            disabled={busy || rowOtherBusy || rowSelfBusy}
                            onClick={() => void runDelete(m)}
                          >
                            {isBusy(m, "delete") ? (
                              <span className="fe-model-admin-spinner fe-model-admin-spinner--sm" aria-label="Удаление" />
                            ) : (
                              <IconTrash />
                            )}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <label style={{ display: "grid", gap: 6 }}>
          <span style={{ fontWeight: 600 }}>JSON настроек</span>
          <textarea
            className="fe-textarea-code"
            value={settingsText}
            onChange={(e) => setSettingsText(e.target.value)}
            style={{ minHeight: 280 }}
            disabled={busy}
          />
        </label>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <button type="button" className="btn" onClick={() => void saveSettings()} disabled={busy || !parsed}>
            {busy ? "Сохранение..." : "Сохранить в базу"}
          </button>
        </div>

        {settingsStatus ? (
          <div style={{ color: "#166534", fontWeight: 600, fontSize: 14 }}>{settingsStatus}</div>
        ) : null}
        {settingsError ? (
          <div style={{ color: "#b91c1c", fontWeight: 600, fontSize: 14 }}>{settingsError}</div>
        ) : null}
      </div>
    </div>
  );
}
