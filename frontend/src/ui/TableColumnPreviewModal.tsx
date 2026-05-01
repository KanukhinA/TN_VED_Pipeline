import React, { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { ModalCloseButton } from "./ModalCloseButton";

export type TablePreviewData = {
  columns: string[];
  rows: string[][];
};

export type TableColumnPreviewModalProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Текст под заголовком (строка или произвольная разметка) */
  subtitle?: React.ReactNode;
  table: TablePreviewData;
  selectedColumnIndex: number;
  onSelectColumn: (columnIndex: number) => void;
  /** Ограничить число строк в таблице (для тяжёлых файлов); без ограничения — все строки */
  previewRowLimit?: number;
  /** Поля над таблицей (например выбор из списка и диапазон строк) */
  controls?: React.ReactNode;
  /** Нижняя панель (кнопки, сводка) */
  footer: React.ReactNode;
  ariaTitleId?: string;
  /** z-index поверх вложенных диалогов (few-shot и т.п.) */
  overlayZIndex?: number;
  /** Вторая выделенная колонка (например JSON рядом с текстом описания). */
  secondarySelectedColumnIndex?: number | null;
};

/**
 * Единый шаблон модального предпросмотра таблицы и выбора колонки:
 * few-shot ассистент и пакетный тест используют один и тот же интерфейс.
 */
export function TableColumnPreviewModal({
  open,
  onClose,
  title,
  subtitle,
  table,
  selectedColumnIndex,
  onSelectColumn,
  previewRowLimit,
  controls,
  footer,
  ariaTitleId,
  overlayZIndex = 10050,
  secondarySelectedColumnIndex = null,
}: TableColumnPreviewModalProps) {
  const [hoveredColumnIndex, setHoveredColumnIndex] = useState<number | null>(null);

  const activeCol = useMemo(() => {
    const n = table.columns.length;
    if (n === 0) return 0;
    return selectedColumnIndex >= 0 && selectedColumnIndex < n ? selectedColumnIndex : 0;
  }, [table.columns.length, selectedColumnIndex]);

  const secondaryCol = useMemo(() => {
    const n = table.columns.length;
    if (n === 0) return -1;
    if (secondarySelectedColumnIndex == null || secondarySelectedColumnIndex < 0) return -1;
    return secondarySelectedColumnIndex < n ? secondarySelectedColumnIndex : -1;
  }, [table.columns.length, secondarySelectedColumnIndex]);

  const displayRows = useMemo(() => {
    if (previewRowLimit == null) return table.rows;
    return table.rows.slice(0, previewRowLimit);
  }, [table.rows, previewRowLimit]);

  if (!open || table.columns.length === 0) return null;

  const minTableWidth = Math.max(480, (table.columns.length + 1) * 120);

  const dialog = (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={ariaTitleId}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.35)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: overlayZIndex,
        padding: 16,
      }}
    >
      <div
        style={{
          width: "min(1400px, 98vw)",
          height: "min(92vh, 900px)",
          maxHeight: "min(92vh, 900px)",
          display: "flex",
          flexDirection: "column",
          gap: 10,
          background: "#fff",
          borderRadius: 12,
          border: "1px solid #e2e8f0",
          boxShadow: "0 20px 50px rgba(15, 23, 42, 0.18)",
          padding: 14,
          overflow: "hidden",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10, flexShrink: 0 }}>
          <div>
            <div id={ariaTitleId} style={{ fontWeight: 700, color: "#0f172a", fontSize: 16 }}>
              {title}
            </div>
            {subtitle != null && subtitle !== "" ? (
              <div style={{ margin: "6px 0 0 0", fontSize: 13, color: "#64748b", lineHeight: 1.45, maxWidth: 720 }}>
                {subtitle}
              </div>
            ) : null}
          </div>
          <ModalCloseButton onClick={onClose} />
        </div>

        {controls != null ? (
          <div style={{ display: "grid", gap: 10, flexShrink: 0 }}>{controls}</div>
        ) : null}

        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflow: "auto",
            overflowX: "auto",
            border: "1px solid #e2e8f0",
            borderRadius: 8,
            WebkitOverflowScrolling: "touch",
          }}
        >
          <table
            style={{
              borderCollapse: "collapse",
              width: "100%",
              minWidth: minTableWidth,
              fontSize: 12,
            }}
          >
            <thead>
              <tr>
                <th
                  style={{
                    position: "sticky",
                    top: 0,
                    left: 0,
                    zIndex: 3,
                    width: 48,
                    textAlign: "right",
                    padding: "10px 12px",
                    borderBottom: "2px solid #cbd5e1",
                    color: "#64748b",
                    fontWeight: 600,
                    background: "#f1f5f9",
                    boxShadow: "inset 0 -1px 0 #cbd5e1",
                  }}
                >
                  №
                </th>
                {table.columns.map((c, ci) => {
                  const isPrimary = ci === activeCol;
                  const isSecondary = secondaryCol >= 0 && ci === secondaryCol && ci !== activeCol;
                  return (
                    <th
                      key={`hdr-${ci}-${c}`}
                      onClick={() => onSelectColumn(ci)}
                      onMouseEnter={() => setHoveredColumnIndex(ci)}
                      onMouseLeave={() => setHoveredColumnIndex(null)}
                      title="Выбрать колонку (описание)"
                      style={{
                        position: "sticky",
                        top: 0,
                        zIndex: 2,
                        textAlign: "left",
                        padding: "10px 12px",
                        borderBottom: "2px solid #cbd5e1",
                        background: isPrimary
                          ? "#bfdbfe"
                          : isSecondary
                            ? "#d1fae5"
                            : hoveredColumnIndex === ci
                              ? "#e2e8f0"
                              : "#f1f5f9",
                        color: "#0f172a",
                        cursor: "pointer",
                        userSelect: "none",
                        whiteSpace: "nowrap",
                        maxWidth: 320,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        boxShadow: isPrimary
                          ? "inset 0 0 0 2px #2563eb"
                          : isSecondary
                            ? "inset 0 0 0 2px #059669"
                            : undefined,
                      }}
                    >
                      {c}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {displayRows.map((row, idx) => {
                const rowNum = idx + 1;
                return (
                  <tr key={`row-${idx}`}>
                    <td
                      style={{
                        padding: "8px 12px",
                        borderBottom: "1px solid #f1f5f9",
                        textAlign: "right",
                        color: "#64748b",
                        fontVariantNumeric: "tabular-nums",
                        verticalAlign: "top",
                        background: "#fafafa",
                      }}
                    >
                      {rowNum}
                    </td>
                    {table.columns.map((_, ci) => {
                      const isPrimary = ci === activeCol;
                      const isSecondary = secondaryCol >= 0 && ci === secondaryCol && ci !== activeCol;
                      return (
                        <td
                          key={`cell-${idx}-${ci}`}
                          onClick={() => onSelectColumn(ci)}
                          onMouseEnter={() => setHoveredColumnIndex(ci)}
                          onMouseLeave={() => setHoveredColumnIndex(null)}
                          style={{
                            padding: "8px 12px",
                            borderBottom: "1px solid #f1f5f9",
                            verticalAlign: "top",
                            background: isPrimary
                              ? "#eff6ff"
                              : isSecondary
                                ? "#ecfdf5"
                                : hoveredColumnIndex === ci
                                  ? "#f8fafc"
                                  : undefined,
                            cursor: "pointer",
                            maxWidth: 360,
                            wordBreak: "break-word",
                          }}
                        >
                          {row[ci]}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {previewRowLimit != null && table.rows.length > previewRowLimit ? (
          <div style={{ fontSize: 12, color: "#64748b", flexShrink: 0 }}>
            Показаны первые {previewRowLimit} из {table.rows.length} строк.
          </div>
        ) : null}

        <div
          style={{
            flexShrink: 0,
            paddingTop: 4,
            borderTop: "1px solid #e2e8f0",
          }}
        >
          {footer}
        </div>
      </div>
    </div>
  );

  if (typeof document === "undefined") return null;
  return createPortal(dialog, document.body);
}
