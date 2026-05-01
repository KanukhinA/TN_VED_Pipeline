import { matchStructureRowDescriptorByPath, type StructureRowFieldDescriptor } from "../expert/numericCharacteristicsDraft";

type Props = {
  path: string;
  op: string;
  value: unknown;
  onValueChange: (v: unknown) => void;
  structureRowDescriptors?: StructureRowFieldDescriptor[];
  /** Текст над полем выбора из перечня */
  enumLabel?: string;
};

const STRING_OPS = new Set([
  "equals",
  "notEquals",
  "in",
  "regex",
  "notRegex",
  "contains",
  "notContains",
  "startsWith",
  "endsWith",
  "iEquals",
  "iContains",
  "iStartsWith",
  "iEndsWith",
]);

function splitTextValues(raw: string): string[] {
  return raw
    .split(/\r?\n|,/g)
    .map((x) => x.trim())
    .filter(Boolean);
}

/**
 * Значение для path-условия: перечень со структуры, либо (для regex) свободный шаблон.
 * Regex/notRegex всегда дают поле ввода, даже без перечня и без сопоставления пути со структурой.
 */
export default function StructureEnumValueControl({
  path,
  op,
  value,
  onValueChange,
  structureRowDescriptors,
  enumLabel = "Значение из структуры",
}: Props) {
  const desc = structureRowDescriptors?.length ? matchStructureRowDescriptorByPath(path, structureRowDescriptors) : undefined;
  const ef = desc && desc.allowedValues.length > 0 ? desc : undefined;

  if (op === "regex" || op === "notRegex") {
    return (
      <label style={{ flex: "1 1 min(20rem, 100%)", display: "block" }}>
        <span style={{ fontSize: 13, color: "#64748b", lineHeight: 1.45 }}>
          {ef ? `${enumLabel} — ` : ""}Шаблон regex (синтаксис Python, проверка как{" "}
          <code style={{ fontSize: 11 }}>re.search</code> по строковому значению поля)
        </span>
        <input
          type="text"
          spellCheck={false}
          value={value === undefined || value === null ? "" : String(value)}
          onChange={(e) => {
            const t = e.target.value;
            onValueChange(t === "" ? undefined : t);
          }}
          placeholder="например nitrate|селитра|^n"
          className="fe-textarea-code"
          style={{
            display: "block",
            width: "100%",
            marginTop: 4,
            padding: 8,
            borderRadius: 8,
            border: "1px solid #cbd5e1",
          }}
        />
      </label>
    );
  }

  if (!STRING_OPS.has(op)) {
    return null;
  }

  if (op === "in") {
    const arr = Array.isArray(value) ? value.map(String) : value != null && value !== "" ? [String(value)] : [];
    if (!ef) {
      return (
        <label style={{ flex: "1 1 min(22rem, 100%)", display: "block" }}>
          <span style={{ fontSize: 13, color: "#64748b" }}>Значения (через запятую или с новой строки)</span>
          <textarea
            spellCheck={false}
            value={arr.join("\n")}
            onChange={(e) => {
              const vals = splitTextValues(e.target.value);
              onValueChange(vals.length ? vals : undefined);
            }}
            placeholder={"например:\nту\nгост\niso"}
            className="fe-textarea-code"
            style={{
              display: "block",
              width: "100%",
              marginTop: 4,
              minHeight: 72,
              padding: 8,
              borderRadius: 8,
              border: "1px solid #cbd5e1",
            }}
          />
        </label>
      );
    }
    return (
      <label style={{ flex: "1 1 200px", display: "block" }}>
        <span style={{ fontSize: 13, color: "#64748b" }}>{enumLabel} (несколько, Ctrl или ⌘ + клик)</span>
        <select
          multiple
          size={Math.min(Math.max(ef.allowedValues.length, 2), 8)}
          value={arr}
          onChange={(e) => {
            const vals = Array.from(e.target.selectedOptions, (o) => o.value);
            onValueChange(vals.length ? vals : undefined);
          }}
          style={{ width: "100%", padding: 6, marginTop: 4, borderRadius: 6, border: "1px solid #cbd5e1" }}
        >
          {ef.allowedValues.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </label>
    );
  }

  if (!ef) {
    return (
      <label style={{ flex: "1 1 min(20rem, 100%)", display: "block" }}>
        <span style={{ fontSize: 13, color: "#64748b" }}>Значение</span>
        <input
          type="text"
          spellCheck={false}
          value={value === undefined || value === null ? "" : String(value)}
          onChange={(e) => {
            const t = e.target.value;
            onValueChange(t === "" ? undefined : t);
          }}
          placeholder="введите текст"
          className="fe-textarea-code"
          style={{
            display: "block",
            width: "100%",
            marginTop: 4,
            padding: 8,
            borderRadius: 8,
            border: "1px solid #cbd5e1",
          }}
        />
      </label>
    );
  }

  return (
    <label style={{ flex: "1 1 160px" }}>
      <span style={{ fontSize: 13, color: "#64748b" }}>{enumLabel}</span>
      <select
        value={value === undefined || value === null ? "" : String(value)}
        onChange={(e) => {
          const t = e.target.value;
          onValueChange(t === "" ? undefined : t);
        }}
        style={{ width: "100%", padding: 6, marginTop: 4, borderRadius: 6, border: "1px solid #cbd5e1" }}
      >
        <option value="">(выберите)</option>
        {ef.allowedValues.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
    </label>
  );
}
