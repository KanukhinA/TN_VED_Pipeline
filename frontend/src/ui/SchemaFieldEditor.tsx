/* eslint-disable @typescript-eslint/no-explicit-any */
import React from "react";

type StringConstraints = {
  min_length?: number;
  max_length?: number;
  pattern?: string;
  enum?: string[];
};

type NumberConstraints = {
  min?: number;
  max?: number;
  multiple_of?: number;
  enum?: number[];
};

type IntegerConstraints = {
  min?: number;
  max?: number;
  multiple_of?: number;
  enum?: number[];
};

type FieldSchema =
  | { type: "object"; properties: Array<{ name: string; schema: FieldSchema }>; required: string[]; additional_properties: boolean }
  | { type: "array"; items: FieldSchema; min_items?: number; max_items?: number }
  | { type: "string"; constraints?: StringConstraints }
  | { type: "number"; constraints?: NumberConstraints }
  | { type: "integer"; constraints?: IntegerConstraints }
  | { type: "boolean" };

function safeNumber(v: string): number | undefined {
  const trimmed = v.trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
}

function parseEnumStringToStrings(v: string): string[] {
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseEnumStringToNumbers(v: string): number[] {
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n));
}

function defaultSchemaForType(t: FieldSchema["type"]): FieldSchema {
  switch (t) {
    case "object":
      return { type: "object", properties: [], required: [], additional_properties: false };
    case "array":
      return { type: "array", items: { type: "string", constraints: undefined }, min_items: undefined, max_items: undefined };
    case "string":
      return { type: "string", constraints: undefined };
    case "number":
      return { type: "number", constraints: undefined };
    case "integer":
      return { type: "integer", constraints: undefined };
    case "boolean":
      return { type: "boolean" };
    default:
      return { type: "string" };
  }
}

function FieldTypeSelect(props: { value: FieldSchema["type"]; onChange: (t: FieldSchema["type"]) => void }) {
  return (
    <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <span>Вид данных:</span>
      <select value={props.value} onChange={(e) => props.onChange(e.target.value as any)}>
        <option value="object">объект</option>
        <option value="array">массив</option>
        <option value="string">строка</option>
        <option value="number">число</option>
        <option value="integer">целое</option>
        <option value="boolean">логическое</option>
      </select>
    </label>
  );
}

export default function SchemaFieldEditor(props: { value: FieldSchema; onChange: (next: FieldSchema) => void }) {
  const value = props.value;
  const onTypeChange = (t: FieldSchema["type"]) => {
    props.onChange(defaultSchemaForType(t));
  };

  return (
    <div style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <FieldTypeSelect value={value.type} onChange={onTypeChange} />
      </div>

      {value.type === "object" && (
        <div style={{ marginTop: 12 }}>
          <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 8 }}>
            <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type="checkbox"
                checked={value.additional_properties}
                onChange={(e) => props.onChange({ ...value, additional_properties: e.target.checked })}
              />
              Разрешить дополнительные поля
            </label>
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <strong>Поля объекта</strong>
            <button
              type="button"
              className="btn"
              onClick={() => props.onChange({ ...value, properties: [...value.properties, { name: "", schema: { type: "string" } as FieldSchema }] })}
            >
              + Добавить поле
            </button>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {value.properties.map((p, idx) => {
              const required = value.required.includes(p.name);
              return (
                <div key={`${idx}-${p.name}`} style={{ border: "1px solid #eee", borderRadius: 8, padding: 10 }}>
                  <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 8, width: "100%" }}>
                    <input
                      value={p.name}
                      placeholder="Имя поля"
                      onChange={(e) => {
                        const nextName = e.target.value;
                        const nextProperties = [...value.properties];
                        nextProperties[idx] = { ...nextProperties[idx], name: nextName };

                        // пересобираем required: если переименовали, сохраним требование по старому имени как best-effort
                        const nextRequired = value.required
                          .map((r) => (r === p.name ? nextName : r))
                          .filter(Boolean);

                        props.onChange({ ...value, properties: nextProperties, required: nextRequired });
                      }}
                      style={{ flex: 1 }}
                    />

                    <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <input
                        type="checkbox"
                        checked={required}
                        disabled={!p.name}
                        onChange={(e) => {
                          const nextRequired = e.target.checked ? [...new Set([...value.required, p.name])] : value.required.filter((r) => r !== p.name);
                          props.onChange({ ...value, required: nextRequired });
                        }}
                      />
                      Обязательное
                    </label>

                    <button
                      type="button"
                      className="btn-danger btn-align-end"
                      onClick={() => {
                        const nextProperties = value.properties.filter((_, i) => i !== idx);
                        const nextRequired = value.required.filter((r) => r !== p.name);
                        props.onChange({ ...value, properties: nextProperties, required: nextRequired });
                      }}
                    >
                      Удалить поле
                    </button>
                  </div>

                  <SchemaFieldEditor
                    value={p.schema}
                    onChange={(nextSchema) => {
                      const nextProperties = [...value.properties];
                      nextProperties[idx] = { ...nextProperties[idx], schema: nextSchema };
                      props.onChange({ ...value, properties: nextProperties });
                    }}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}

      {value.type === "array" && (
        <div style={{ marginTop: 12 }}>
          <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 10 }}>
            <label style={{ flex: 1 }}>
              <div style={{ marginBottom: 4 }}>Минимум элементов</div>
              <input
                value={value.min_items ?? ""}
                onChange={(e) => props.onChange({ ...value, min_items: safeNumber(e.target.value) })}
                placeholder="необязательно"
              />
            </label>
            <label style={{ flex: 1 }}>
              <div style={{ marginBottom: 4 }}>Максимум элементов</div>
              <input
                value={value.max_items ?? ""}
                onChange={(e) => props.onChange({ ...value, max_items: safeNumber(e.target.value) })}
                placeholder="необязательно"
              />
            </label>
          </div>

          <strong>Как устроен один элемент массива</strong>
          <div style={{ marginTop: 10 }}>
            <SchemaFieldEditor
              value={value.items}
              onChange={(nextItems) => props.onChange({ ...value, items: nextItems })}
            />
          </div>
        </div>
      )}

      {value.type === "string" && (
        <div style={{ marginTop: 12 }}>
          <div style={{ display: "flex", gap: 12 }}>
            <label style={{ flex: 1 }}>
              <div style={{ marginBottom: 4 }}>Минимальная длина</div>
              <input
                value={value.constraints?.min_length ?? ""}
                onChange={(e) => {
                  const next = { ...(value.constraints ?? {}), min_length: safeNumber(e.target.value) };
                  props.onChange({ ...value, constraints: next });
                }}
              />
            </label>
            <label style={{ flex: 1 }}>
              <div style={{ marginBottom: 4 }}>Максимальная длина</div>
              <input
                value={value.constraints?.max_length ?? ""}
                onChange={(e) => {
                  const next = { ...(value.constraints ?? {}), max_length: safeNumber(e.target.value) };
                  props.onChange({ ...value, constraints: next });
                }}
              />
            </label>
          </div>

          <label style={{ display: "block", marginTop: 10 }}>
            <div style={{ marginBottom: 4 }}>Маска текста (для специалистов)</div>
            <input
              value={value.constraints?.pattern ?? ""}
              onChange={(e) => props.onChange({ ...value, constraints: { ...(value.constraints ?? {}), pattern: e.target.value } })}
              placeholder="например, ^[a-z]+$"
            />
          </label>

          <label style={{ display: "block", marginTop: 10 }}>
            <div style={{ marginBottom: 4 }}>Допустимые значения (через запятую)</div>
            <input
              value={(value.constraints?.enum ?? []).join(", ")}
              onChange={(e) => props.onChange({ ...value, constraints: { ...(value.constraints ?? {}), enum: parseEnumStringToStrings(e.target.value) } })}
              placeholder="p2o5, k2o, ..."
            />
          </label>
        </div>
      )}

      {(value.type === "number" || value.type === "integer") && (
        <div style={{ marginTop: 12 }}>
          <div style={{ display: "flex", gap: 12 }}>
            <label style={{ flex: 1 }}>
              <div style={{ marginBottom: 4 }}>Не меньше</div>
              <input
                value={value.constraints?.min ?? ""}
                onChange={(e) => props.onChange({ ...value, constraints: { ...(value.constraints ?? {}), min: safeNumber(e.target.value) } as any })}
              />
            </label>
            <label style={{ flex: 1 }}>
              <div style={{ marginBottom: 4 }}>Не больше</div>
              <input
                value={value.constraints?.max ?? ""}
                onChange={(e) => props.onChange({ ...value, constraints: { ...(value.constraints ?? {}), max: safeNumber(e.target.value) } as any })}
              />
            </label>
          </div>

          <label style={{ display: "block", marginTop: 10 }}>
            <div style={{ marginBottom: 4 }}>Кратно шагу</div>
            <input
              value={(value.constraints as any)?.multiple_of ?? ""}
              onChange={(e) =>
                props.onChange({
                  ...value,
                  constraints: { ...(value.constraints ?? {}), multiple_of: safeNumber(e.target.value) } as any,
                })
              }
            />
          </label>

          <label style={{ display: "block", marginTop: 10 }}>
            <div style={{ marginBottom: 4 }}>Допустимые числовые значения (через запятую)</div>
            <input
              value={((value.constraints as any)?.enum ?? []).join(", ")}
              onChange={(e) => props.onChange({ ...value, constraints: { ...(value.constraints ?? {}), enum: parseEnumStringToNumbers(e.target.value) } as any })}
            />
          </label>
        </div>
      )}

      {value.type === "boolean" && (
        <div style={{ marginTop: 12, color: "#555" }}>
          <div>Логическое да/нет, без дополнительных ограничений</div>
        </div>
      )}
    </div>
  );
}

