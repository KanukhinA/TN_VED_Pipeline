import React from "react";
import { normalizeTnVedEaeuCode } from "../catalog/tnVedCode";
import { isTnVedChildrenDatasetIncomplete, resolveTnVedCodeLabel, TN_VED_CHILDREN_BUILD_INFO } from "../catalog/tnVedEaeuTree";
import TnVedEaeuTreeListbox from "./TnVedEaeuTreeListbox";

export type TnVedEaeuPickerProps = {
  value: string;
  onChange: (normalizedCode: string) => void;
  disabled?: boolean;
  /** Подпись над полями (строка или узел). Если null — блок подписи не рендерится (см. hideLabel). */
  label?: React.ReactNode | null;
  /** Не показывать верхнюю подпись (если заголовок снаружи) */
  hideLabel?: boolean;
  /** id для поля поиска/ввода кода (см. TnVedEaeuTreeListbox) */
  manualInputId?: string;
  /** Лейбл над блоком дерева в общей строке с aside */
  manualInputInlineLabel?: React.ReactNode;
  /** Контролы справа от подписи (например, заметка и приоритет класса) */
  manualInputAside?: React.ReactNode;
  /** Внешняя раскладка для строки с подписью и aside */
  manualInputRowStyle?: React.CSSProperties;
};

/**
 * Код ТН ВЭД ЕАЭС: одно поле для поиска по дереву и ввода кода цифрами; иерархический listbox (уровни «+»).
 * Полный набор позиций задаётся данными `tnVedChildren.generated.ts` (сборка из Excel, см. скрипт в репозитории).
 */
export default function TnVedEaeuPicker(props: TnVedEaeuPickerProps) {
  const { value, onChange, disabled, label, hideLabel, manualInputId, manualInputInlineLabel, manualInputAside, manualInputRowStyle } = props;
  const labelResolved =
    label === undefined ? "Код ТН ВЭД ЕАЭС для класса" : label;
  const norm = normalizeTnVedEaeuCode(value.trim()) ?? "";

  const summary = norm ? resolveTnVedCodeLabel(norm) : "";

  return (
    <div style={{ width: "100%" }}>
      {!hideLabel && labelResolved != null ? (
        <div style={{ fontWeight: 600, marginBottom: 6, fontSize: 13 }}>
          {labelResolved} <span style={{ color: "#b91c1c" }} aria-hidden="true">*</span>
        </div>
      ) : null}
      {isTnVedChildrenDatasetIncomplete() ? (
        <div
          role="status"
          style={{
            margin: "0 0 10px",
            padding: "10px 12px",
            fontSize: 12,
            lineHeight: 1.5,
            color: "#92400e",
            background: "#fffbeb",
            border: "1px solid #fcd34d",
            borderRadius: 8,
            maxWidth: "44rem",
          }}
        >
          <strong>Не полный классификатор.</strong> Сейчас в дереве только фрагмент из репозитория ({TN_VED_CHILDREN_BUILD_INFO.rowCount} кодов в
          источнике, ожидается полный файл с тысячами позиций). Чтобы в листбоксе были <strong>все коды из вашего «ТН ВЭД.xlsx»</strong>, положите
          файл в <code style={{ fontSize: 11 }}>data/ТН ВЭД.xlsx</code> и выполните из корня репозитория:{" "}
          <code style={{ fontSize: 11 }}>python scripts/build_tn_ved_tree.py</code>
          {` `}(при нескольких листах: <code style={{ fontSize: 11 }}>--sheet all</code>). Подробности — <code style={{ fontSize: 11 }}>data/README.md</code>.
        </div>
      ) : null}
      {manualInputInlineLabel || manualInputAside ? (
        <div style={{ display: "flex", gap: 12, alignItems: "flex-start", marginBottom: 6, ...manualInputRowStyle }}>
          <div style={{ flex: "1 1 auto", minWidth: 0 }}>
            {manualInputInlineLabel ? (
              <div style={{ fontWeight: 600, marginBottom: 4, fontSize: 13 }}>{manualInputInlineLabel}</div>
            ) : null}
          </div>
          {manualInputAside ? <div style={{ flex: "0 0 auto" }}>{manualInputAside}</div> : null}
        </div>
      ) : null}

      <div style={{ marginBottom: 10, width: "100%" }}>
        <TnVedEaeuTreeListbox
          value={value}
          onChange={onChange}
          disabled={disabled}
          searchInputId={manualInputId}
        />
      </div>

      {summary ? <div className="tnved-picker-summary">{summary}</div> : null}
    </div>
  );
}
