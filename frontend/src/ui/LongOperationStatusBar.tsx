import { formatElapsedSec } from "../hooks/useElapsedSeconds";

export type LongOperationStatusBarProps = {
  /** Показывать панель */
  visible: boolean;
  /** Краткий заголовок операции */
  title: string;
  /** Пояснение под заголовком (необязательно) */
  detail?: string;
  /** Текущий этап / что происходит (обновляется во время длительной операции) */
  phaseHint?: string | null;
  /** Секунды с начала (из useElapsedSeconds) */
  elapsedSec: number;
  /** Прогресс по шагам/примерам: «обработано done из total» */
  progress?: { done: number; total: number } | null;
  /** Подпись к счётчику прогресса (по умолчанию «Обработано») */
  progressLabel?: string;
  /** z-index поверх модалок (по умолчанию выше TableColumnPreviewModal) */
  zIndex?: number;
};

/**
 * Фиксированная нижняя панель: длительная операция, время, при необходимости — счётчик «из скольки».
 */
export function LongOperationStatusBar({
  visible,
  title,
  detail,
  phaseHint,
  elapsedSec,
  progress,
  progressLabel = "Обработано",
  zIndex = 10060,
}: LongOperationStatusBarProps) {
  if (!visible) return null;

  const pct =
    progress && progress.total > 0 ? Math.min(100, Math.round((100 * progress.done) / progress.total)) : null;

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        left: 0,
        right: 0,
        bottom: 0,
        zIndex,
        padding: "12px 18px calc(12px + env(safe-area-inset-bottom, 0px))",
        background: "linear-gradient(180deg, rgba(248, 250, 252, 0.97) 0%, #f1f5f9 100%)",
        borderTop: "1px solid #cbd5e1",
        boxShadow: "0 -8px 24px rgba(15, 23, 42, 0.08)",
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 12,
        justifyContent: "space-between",
      }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 10, minWidth: 0 }}>
        <span className="fe-model-admin-spinner fe-model-admin-spinner--sm" aria-hidden style={{ flexShrink: 0 }} />
        <span style={{ fontWeight: 650, color: "#0f172a", fontSize: 14 }}>{title}</span>
        {progress && progress.total > 0 ? (
          <span style={{ fontSize: 14, color: "#334155", fontVariantNumeric: "tabular-nums" }}>
            {progressLabel}: <strong>{progress.done}</strong> из <strong>{progress.total}</strong>
          </span>
        ) : null}
        <span style={{ fontSize: 13, color: "#64748b", fontVariantNumeric: "tabular-nums" }}>
          прошло {formatElapsedSec(elapsedSec)}
        </span>
        {phaseHint ? (
          <span
            style={{
              flexBasis: "100%",
              fontSize: 13,
              color: "#334155",
              lineHeight: 1.45,
              marginTop: 2,
            }}
          >
            {phaseHint}
          </span>
        ) : null}
      </div>
      {detail ? (
        <span style={{ fontSize: 12, color: "#64748b", maxWidth: "min(520px, 100%)" }}>{detail}</span>
      ) : null}
      {pct != null ? (
        <div
          style={{
            width: "min(420px, 100%)",
            height: 6,
            borderRadius: 4,
            background: "#e2e8f0",
            overflow: "hidden",
            flex: "1 1 200px",
          }}
        >
          <div
            style={{
              height: "100%",
              width: `${pct}%`,
              background: "linear-gradient(90deg, #3b82f6, #6366f1)",
              borderRadius: 4,
              transition: "width 0.2s ease-out",
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
