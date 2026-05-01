type ModalCloseButtonProps = {
  onClick: () => void;
  /** Подпись для скринридеров и подсказки */
  ariaLabel?: string;
};

/**
 * Кнопка закрытия модального окна: крестик без фона «кнопки», лёгкая подсветка при наведении.
 */
export function ModalCloseButton({ onClick, ariaLabel = "Закрыть" }: ModalCloseButtonProps) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      title={ariaLabel}
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 36,
        height: 36,
        margin: 0,
        padding: 0,
        border: "none",
        background: "transparent",
        cursor: "pointer",
        color: "#64748b",
        borderRadius: 8,
        flexShrink: 0,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.color = "#0f172a";
        e.currentTarget.style.background = "rgba(241, 245, 249, 0.95)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = "#64748b";
        e.currentTarget.style.background = "transparent";
      }}
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
        <path d="M18 6L6 18M6 6l12 12" />
      </svg>
    </button>
  );
}
