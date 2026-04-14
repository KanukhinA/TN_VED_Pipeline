import React from "react";

type Props = {
  title: string;
  subtitle?: string;
  text: string;
  emptyHint?: string;
  /** Редактируемый JSON вместо только просмотра */
  editable?: boolean;
  onTextChange?: (next: string) => void;
  errorHint?: string | null;
  /**
   * Колонка тянется по высоте окна (шаг с двумя колонками): карточка и поле JSON заполняют доступную высоту.
   * `viewportOffsetPx` — запас под шапку мастера, карточку ТН ВЭД и нижние кнопки.
   */
  fillViewportHeight?: boolean;
  viewportOffsetPx?: number;
};

const preBox: React.CSSProperties = {
  margin: 0,
  padding: "6px 10px",
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  fontSize: 11,
  lineHeight: 1.45,
  overflow: "auto",
  flex: 1,
  minHeight: 200,
};

function textareaBoxStyle(fillHeight: boolean): React.CSSProperties {
  return {
    ...preBox,
    resize: fillHeight ? "none" : "vertical",
    width: "100%",
    boxSizing: "border-box",
    display: "block",
    minHeight: fillHeight ? 0 : preBox.minHeight,
  };
}

/**
 * Правая колонка: схема или фрагмент DSL с копированием (липкая при прокрутке).
 */
export default function JsonSchemaPreviewAside({
  title,
  subtitle,
  text,
  emptyHint,
  editable,
  onTextChange,
  errorHint,
  fillViewportHeight = false,
  viewportOffsetPx = 260,
}: Props) {
  const display = text.trim() || emptyHint || "…";
  const fillOffset = Math.max(120, viewportOffsetPx);
  const asideMinH = fillViewportHeight ? `calc(100vh - ${fillOffset}px)` : undefined;

  return (
    <aside
      style={{
        flex: "1 1 min(22rem, 100%)",
        minWidth: 0,
        width: "100%",
        maxWidth: "100%",
        ...(fillViewportHeight
          ? {
              alignSelf: "stretch",
              display: "flex",
              flexDirection: "column",
              minHeight: asideMinH,
              position: "relative",
            }
          : {
              position: "sticky",
              top: 12,
              alignSelf: "flex-start",
            }),
      }}
    >
      <div
        className="card"
        style={{
          marginTop: 0,
          padding: "10px 12px",
          maxHeight: fillViewportHeight ? "none" : "min(82vh, 920px)",
          minHeight: fillViewportHeight ? 0 : undefined,
          flex: fillViewportHeight ? 1 : undefined,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            marginBottom: 8,
            flexWrap: "wrap",
          }}
        >
          <h3 style={{ margin: 0, fontSize: 16 }}>{title}</h3>
          <button
            type="button"
            className="btn-secondary"
            style={{ fontSize: 13, padding: "4px 10px" }}
            onClick={() => {
              void navigator.clipboard?.writeText(text).then(
                () => {},
                () => {},
              );
            }}
            title="Скопировать в буфер обмена"
          >
            Копировать
          </button>
        </div>
        {subtitle ? (
          <p style={{ margin: "0 0 8px 0", fontSize: 13, color: "#64748b", lineHeight: 1.45 }}>{subtitle}</p>
        ) : null}
        {errorHint ? (
          <p style={{ margin: "0 0 8px 0", fontSize: 12, color: "#b91c1c", lineHeight: 1.45 }}>{errorHint}</p>
        ) : null}
        {editable && onTextChange ? (
          <textarea
            className="fe-textarea-code"
            style={textareaBoxStyle(fillViewportHeight)}
            value={text}
            onChange={(e) => onTextChange(e.target.value)}
            spellCheck={false}
            aria-label={title}
          />
        ) : (
          <pre style={{ ...preBox, ...(fillViewportHeight ? { minHeight: 0 } : {}) }}>{display}</pre>
        )}
      </div>
    </aside>
  );
}

export const splitRowStyle: React.CSSProperties = {
  display: "flex",
  gap: 20,
  alignItems: "flex-start",
  flexWrap: "wrap",
  width: "100%",
};

export const splitMainColumnStyle: React.CSSProperties = {
  flex: "1 1 min(24rem, 100%)",
  minWidth: 0,
  maxWidth: "100%",
};
