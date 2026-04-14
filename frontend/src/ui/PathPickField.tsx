import React, { useId } from "react";
import { groupSuggestions, type CrossRulePathSuggestion } from "./crossRulePathSuggestions";

export type PathPickFieldProps = {
  value: string;
  onChange: (v: string) => void;
  suggestions?: CrossRulePathSuggestion[];
  placeholder?: string;
  hintBelow?: string;
  /** Текст над полем ручного ввода (если не задан, зависит от наличия подсказок). */
  manualInputLabel?: string;
};

export default function PathPickField(props: PathPickFieldProps) {
  const inputId = useId();
  const pickerId = useId();
  const datalistId = `${inputId}-dl`;
  const groups = props.suggestions?.length ? groupSuggestions(props.suggestions) : null;
  const manualLabel =
    props.manualInputLabel ??
    (groups && groups.size > 0 ? "Точный адрес поля (если нет в перечне выше)" : "Имя или адрес поля");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {groups && groups.size > 0 ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          <label htmlFor={pickerId} style={{ fontSize: 13, color: "#64748b", whiteSpace: "nowrap" }}>
            Выбор из структуры
          </label>
          <select
            id={pickerId}
            defaultValue=""
            onChange={(e) => {
              const v = e.target.value;
              if (v) props.onChange(v);
              e.currentTarget.selectedIndex = 0;
            }}
            style={{
              flex: "1 1 240px",
              minWidth: 0,
              maxWidth: "100%",
              padding: 8,
              borderRadius: 8,
              border: "1px solid #cbd5e1",
            }}
          >
            <option value="">Выберите поле…</option>
            {[...groups.entries()].map(([g, items]) => (
              <optgroup key={g} label={g}>
                {items.map((s) => (
                  <option key={`${g}-${s.path}`} value={s.path} title={s.hint ?? s.path}>
                    {s.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
      ) : null}
      <div>
        <label htmlFor={inputId} style={{ display: "block", fontSize: 13, color: "#64748b", marginBottom: 4 }}>
          {manualLabel}
        </label>
        <input
          id={inputId}
          list={props.suggestions?.length ? datalistId : undefined}
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
          placeholder={props.placeholder}
          style={{ width: "100%", padding: 8, borderRadius: 8, border: "1px solid #cbd5e1", boxSizing: "border-box" }}
        />
        {props.suggestions?.length ? (
          <datalist id={datalistId}>
            {props.suggestions.map((s) => (
              <option key={s.path} value={s.path} label={s.label} />
            ))}
          </datalist>
        ) : null}
        {props.hintBelow ? (
          <div style={{ marginTop: 6, fontSize: 12, color: "#64748b", lineHeight: 1.45 }}>{props.hintBelow}</div>
        ) : null}
      </div>
    </div>
  );
}
