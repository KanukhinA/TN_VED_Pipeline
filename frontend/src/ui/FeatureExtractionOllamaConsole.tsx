import React from "react";

/** Результат последней операции deploy (pull / warm) или текст ошибки API. */
export type OllamaOperationLogState = {
  model: string;
  log: string;
  durationSec?: number;
  ok: boolean;
} | null;

type Props = {
  mergedText: string;
  terminal: OllamaOperationLogState;
  onRefreshLogs: () => void | Promise<void>;
  /** Свернуть блок по умолчанию (состояние хранится в sessionStorage). */
  storageKey?: string;
};

/**
 * Единая «консоль» как в админке моделей: заголовок-карточка, тёмный pre, моноширинный текст.
 * Рендерится на уровне страницы настроек извлечения, чтобы не теряться при смене маршрута.
 */
export default function FeatureExtractionOllamaConsole({
  mergedText,
  terminal,
  onRefreshLogs,
  storageKey = "fe_ollama_console_expanded",
}: Props) {
  const preRef = React.useRef<HTMLPreElement | null>(null);
  /** Пока пользователь у нижнего края — подгрузки листают вниз; если прокрутил вверх — не трогаем позицию. */
  const stickToBottomRef = React.useRef(true);
  const [expanded, setExpanded] = React.useState(() => {
    try {
      return sessionStorage.getItem(storageKey) !== "0";
    } catch {
      return true;
    }
  });

  React.useEffect(() => {
    try {
      sessionStorage.setItem(storageKey, expanded ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [expanded, storageKey]);

  const BOTTOM_THRESHOLD_PX = 90;

  const scrollPanelToBottom = React.useCallback(() => {
    const el = preRef.current;
    if (!el) return;
    stickToBottomRef.current = true;
    el.scrollTop = el.scrollHeight;
  }, []);

  React.useEffect(() => {
    const el = preRef.current;
    if (!el) return;
    if (!stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [mergedText]);

  /** После «Развернуть» синхронизировать позицию с прилипанием к низу. */
  React.useEffect(() => {
    if (!expanded) return;
    requestAnimationFrame(() => {
      const el = preRef.current;
      if (!el || !stickToBottomRef.current) return;
      el.scrollTop = el.scrollHeight;
    });
  }, [expanded]);

  const handlePreScroll = React.useCallback(() => {
    const el = preRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = dist <= BOTTOM_THRESHOLD_PX;
  }, []);

  const isError = Boolean(terminal && !terminal.ok);

  return (
    <section
      className="card fe-ollama-console"
      style={{
        marginTop: 20,
        padding: 0,
        overflow: "hidden",
        border: "1px solid #e2e8f0",
        boxShadow: "0 1px 2px rgba(15, 23, 42, 0.06)",
      }}
    >
      <div
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid #e2e8f0",
          background: "linear-gradient(180deg, #f8fafc 0%, #fff 100%)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 10,
        }}
      >
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: "#0f172a" }}>Консоль Ollama</h2>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            className="btn-secondary"
            style={{ fontSize: 13 }}
            onClick={scrollPanelToBottom}
            title="Прокрутить терминал к последним строкам"
          >
            В конец
          </button>
          <button
            type="button"
            className="btn-secondary"
            style={{ fontSize: 13 }}
            onClick={() => void onRefreshLogs()}
            title="Подтянуть логи с сервера (большой хвост, можно листать внутри области)"
          >
            Обновить логи
          </button>
          <button
            type="button"
            className="btn-secondary"
            style={{ fontSize: 13 }}
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
          >
            {expanded ? "Свернуть" : "Развернуть"}
          </button>
        </div>
      </div>
      {expanded ? (
        <pre
          ref={preRef}
          role="log"
          aria-label="Результат операций и логи контейнера Ollama"
          className="fe-ollama-console__pre"
          onScroll={handlePreScroll}
          style={{
            margin: 0,
            minHeight: 320,
            maxHeight: "min(55vh, 600px)",
            overflowX: "auto",
            overflowY: "scroll",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            background: isError ? "#450a0a" : "#0f172a",
            color: "#e2e8f0",
            padding: "14px 16px",
            fontSize: 12,
            fontFamily: 'ui-monospace, "Cascadia Code", "Consolas", monospace',
            lineHeight: 1.5,
            border: isError ? "1px solid #991b1b" : "none",
            borderRadius: 0,
          }}
        >
          {mergedText}
        </pre>
      ) : null}
    </section>
  );
}
