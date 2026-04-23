import React from "react";

function deepClone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

type EditableProps = {
  value: unknown;
  onChange: (next: unknown) => void;
  disabled?: boolean;
  depth?: number;
};

/**
 * Редактирование извлечённого JSON без сырого текста: скаляры, вложенные объекты и массивы.
 */
function EditableValue({ value, onChange, disabled, depth = 0 }: EditableProps) {
  const pad = Math.min(depth, 4) * 10;

  if (value === null || value === undefined) {
    return (
      <input
        className="officer-input"
        type="text"
        disabled={disabled}
        placeholder="пусто"
        value=""
        onChange={(e) => {
          const t = e.target.value.trim();
          if (!t) onChange(null);
          else if (t === "true") onChange(true);
          else if (t === "false") onChange(false);
          else if (!Number.isNaN(Number(t)) && t !== "") onChange(Number(t));
          else onChange(t);
        }}
      />
    );
  }

  if (typeof value === "boolean") {
    return (
      <label style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
        <input type="checkbox" checked={value} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        <span style={{ fontSize: "0.8125rem", color: "#475569" }}>{value ? "да" : "нет"}</span>
      </label>
    );
  }

  if (typeof value === "number") {
    return (
      <input
        className="officer-input"
        type="number"
        disabled={disabled}
        value={Number.isFinite(value) ? value : ""}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === "" || raw === "-") {
            onChange(0);
            return;
          }
          const n = Number(raw);
          onChange(Number.isFinite(n) ? n : raw);
        }}
      />
    );
  }

  if (typeof value === "string") {
    return (
      <input
        className="officer-input"
        type="text"
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  if (Array.isArray(value)) {
    const sample = value[0];
    const defaultNew =
      value.length > 0
        ? typeof sample === "object" && sample !== null && !Array.isArray(sample)
          ? deepClone(sample as Record<string, unknown>)
          : typeof sample === "number"
            ? 0
            : typeof sample === "boolean"
              ? false
              : ""
        : {};

    return (
      <div style={{ marginLeft: pad > 0 ? 8 : 0, borderLeft: depth > 0 ? "2px solid #e2e8f0" : undefined, paddingLeft: depth > 0 ? 10 : 0 }}>
        {value.map((item, i) => (
          <div key={i} style={{ marginBottom: 10 }}>
            <div style={{ fontSize: "0.75rem", color: "#64748b", marginBottom: 4 }}>Элемент {i + 1}</div>
            <EditableValue
              value={item}
              disabled={disabled}
              depth={depth + 1}
              onChange={(nv) => {
                const next = [...value];
                next[i] = nv;
                onChange(next);
              }}
            />
          </div>
        ))}
        <button
          type="button"
          className="btn-secondary"
          style={{ fontSize: "0.8125rem", padding: "4px 10px" }}
          disabled={disabled}
          onClick={() => onChange([...value, defaultNew])}
        >
          Добавить элемент
        </button>
      </div>
    );
  }

  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    return (
      <div
        style={{
          marginLeft: pad > 0 ? 8 : 0,
          borderLeft: depth > 0 ? "2px solid #e2e8f0" : undefined,
          paddingLeft: depth > 0 ? 10 : 0,
          display: "grid",
          gap: "0.65rem",
        }}
      >
        {keys.map((k) => (
          <div key={k}>
            <div className="officer-section-label" style={{ marginBottom: 4 }}>
              {k}
            </div>
            <EditableValue
              value={value[k]}
              disabled={disabled}
              depth={depth + 1}
              onChange={(nv) => onChange({ ...value, [k]: nv })}
            />
          </div>
        ))}
      </div>
    );
  }

  return (
    <input
      className="officer-input"
      type="text"
      disabled={disabled}
      value={String(value)}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export type ExtractedFeaturesEditorProps = {
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  disabled?: boolean;
};

export function ExtractedFeaturesEditor({ value, onChange, disabled }: ExtractedFeaturesEditorProps) {
  if (Object.keys(value).length === 0) {
    return (
      <p style={{ margin: 0, fontSize: "0.875rem", color: "#64748b", lineHeight: 1.5 }}>
        В объекте признаков нет полей (модель вернула пустой результат).
      </p>
    );
  }
  return (
    <div className="extracted-features-editor" style={{ display: "grid", gap: "0.75rem" }}>
      <EditableValue
        value={value}
        disabled={disabled}
        onChange={(v) => {
          if (isPlainObject(v)) onChange(v);
        }}
      />
    </div>
  );
}

export { deepClone };
