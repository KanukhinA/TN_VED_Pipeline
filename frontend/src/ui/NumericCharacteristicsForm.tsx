import React from "react";
import {
  DEFAULT_PROCHEE_TEMPLATE,
  formatNumericCharacteristicsSampleJson,
  parseAllowedComponentValuesFromText,
  type NumericCharacteristicLine,
  type NumericCharacteristicsDraft,
  type TextArrayFieldLine,
} from "../expert/numericCharacteristicsDraft";

/** Черновик текста перечня до записи в состояние формы. */
function AllowedComponentValuesTextarea(props: {
  rowKey: string;
  allowedComponentValues: string[] | undefined;
  onCommit: (parsed: string[] | undefined) => void;
  placeholder: string;
}) {
  const canonical = (props.allowedComponentValues ?? []).join("\n");
  const [text, setText] = React.useState(canonical);
  const editingRef = React.useRef(false);

  React.useEffect(() => {
    if (!editingRef.current) {
      setText(canonical);
    }
  }, [props.rowKey, canonical]);

  return (
    <textarea
      style={{
        width: "100%",
        maxWidth: "100%",
        minHeight: 72,
        padding: 8,
        borderRadius: 8,
        border: "1px solid #cbd5e1",
        fontSize: 14,
      }}
      value={text}
      onChange={(e) => {
        editingRef.current = true;
        setText(e.target.value);
      }}
      onBlur={() => {
        editingRef.current = false;
        const parsed = parseAllowedComponentValuesFromText(text);
        props.onCommit(parsed);
        setText((parsed ?? []).join("\n"));
      }}
      placeholder={props.placeholder}
    />
  );
}

type Props = {
  draft: NumericCharacteristicsDraft;
  onChange: (next: NumericCharacteristicsDraft) => void;
  /** Не показывать пример JSON внизу (если схема выводится в колонке справа) */
  hideInlinePreview?: boolean;
};

function updateLine(list: NumericCharacteristicLine[], index: number, patch: Partial<NumericCharacteristicLine>) {
  const next = list.slice();
  next[index] = { ...next[index], ...patch };
  return next;
}

function updateTextArrayLine(list: TextArrayFieldLine[], index: number, patch: Partial<TextArrayFieldLine>) {
  const next = list.slice();
  next[index] = { ...next[index], ...patch };
  return next;
}

function parseProcheeJsonArray(raw: string): Array<Record<string, unknown>> | null {
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return null;
    if (!v.every((x) => x && typeof x === "object" && !Array.isArray(x))) return null;
    return v as Array<Record<string, unknown>>;
  } catch {
    return null;
  }
}

function ProcheeJsonTextarea(props: {
  rows: Array<Record<string, unknown>> | undefined;
  onCommit: (rows: Array<Record<string, unknown>>) => void;
}) {
  const canonical = JSON.stringify(props.rows?.length ? props.rows : [...DEFAULT_PROCHEE_TEMPLATE], null, 2);
  const [text, setText] = React.useState(canonical);
  const editingRef = React.useRef(false);

  React.useEffect(() => {
    if (!editingRef.current) {
      setText(canonical);
    }
  }, [canonical]);

  return (
    <textarea
      style={{
        width: "100%",
        maxWidth: "100%",
        minHeight: 200,
        padding: 8,
        borderRadius: 8,
        border: "1px solid #cbd5e1",
        fontSize: 13,
        fontFamily: "ui-monospace, monospace",
      }}
      value={text}
      onChange={(e) => {
        editingRef.current = true;
        setText(e.target.value);
      }}
      onBlur={() => {
        editingRef.current = false;
        const parsed = parseProcheeJsonArray(text);
        if (parsed) {
          props.onCommit(parsed);
          setText(JSON.stringify(parsed, null, 2));
        } else {
          window.alert('Нужен JSON-массив объектов, например [{"параметр": "…", …}, …].');
          setText(canonical);
        }
      }}
      spellCheck={false}
    />
  );
}

const labelText: React.CSSProperties = {
  display: "block",
  fontSize: 13,
  fontWeight: 600,
  marginBottom: 4,
  cursor: "help",
  width: "fit-content",
  maxWidth: "100%",
  borderBottom: "1px dotted #94a3b8",
};

const reqStar = (
  <span style={{ color: "#b91c1c" }} aria-hidden="true">
    *
  </span>
);

export default function NumericCharacteristicsForm({ draft, onChange, hideInlinePreview }: Props) {
  const [addFieldOpen, setAddFieldOpen] = React.useState(false);

  const hasAnyFields =
    draft.characteristics.length > 0 || (draft.textArrayFields?.length ?? 0) > 0 || !!draft.procheeEnabled;

  return (
    <div>
      <label style={{ display: "block", marginBottom: 12 }}>
        <span
          style={labelText}
          title="Краткое имя набора правил, по которому вы и коллеги узнаёте этот справочник в перечне."
        >
          Название справочника {reqStar}
        </span>
        <input
          style={{ width: "100%", maxWidth: "100%", padding: 8, borderRadius: 8, border: "1px solid #cbd5e1" }}
          value={draft.catalogName}
          onChange={(e) => onChange({ ...draft, catalogName: e.target.value })}
          placeholder="Например: состав по декларации"
        />
      </label>
      <label style={{ display: "block", marginBottom: 16 }}>
        <span style={labelText} title="Необязательно: для чего нужен справочник, чтобы не путать с похожими.">
          Описание
        </span>
        <textarea
          style={{ width: "100%", maxWidth: "100%", minHeight: 48, padding: 8, borderRadius: 8, border: "1px solid #cbd5e1" }}
          value={draft.catalogDescription}
          onChange={(e) => onChange({ ...draft, catalogDescription: e.target.value })}
          placeholder="По желанию"
        />
      </label>

      <h3 style={{ marginTop: 0, marginBottom: 8, fontSize: 17 }}>Структура полей документа</h3>
      <p style={{ margin: "0 0 12px", fontSize: 13, color: "#475569", lineHeight: 1.45 }}>
        Сначала нажмите «Добавить поле» и выберите тип: числовая характеристика (массив с текстовым компонентом и числом) или
        текстовая (массив однотипных строк). Блок «прочее» добавляется отдельной кнопкой — для произвольных пар
        «параметр — значение» в одном массиве.
      </p>

      <div style={{ marginBottom: 14 }}>
        <button
          type="button"
          className="btn"
          aria-expanded={addFieldOpen}
          onClick={() => setAddFieldOpen((v) => !v)}
        >
          {addFieldOpen ? "Скрыть выбор типа поля" : "Добавить поле"}
        </button>
        {addFieldOpen ? (
          <div
            role="region"
            aria-label="Выбор типа нового поля"
            style={{
              marginTop: 10,
              padding: 12,
              borderRadius: 8,
              border: "1px solid #bae6fd",
              background: "#f0f9ff",
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 14, color: "#0c4a6e" }}>Выберите тип поля</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  onChange({
                    ...draft,
                    characteristics: [
                      ...draft.characteristics,
                      { characteristicKey: "", componentColumnKey: "" },
                    ],
                  });
                  setAddFieldOpen(false);
                }}
              >
                Числовая характеристика
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  onChange({
                    ...draft,
                    textArrayFields: [...(draft.textArrayFields ?? []), { fieldKey: "", exampleValues: undefined }],
                  });
                  setAddFieldOpen(false);
                }}
              >
                Текстовая характеристика
              </button>
              <button type="button" className="btn-secondary" onClick={() => setAddFieldOpen(false)}>
                Отмена
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {!hasAnyFields ? (
        <div
          style={{
            marginBottom: 16,
            padding: 14,
            borderRadius: 8,
            border: "1px dashed #cbd5e1",
            background: "#f8fafc",
            color: "#64748b",
            fontSize: 14,
          }}
        >
          Поля ещё не заданы. Нажмите «Добавить поле» или добавьте блок «прочее» ниже.
        </div>
      ) : null}

      {draft.characteristics.length > 0 ? (
        <h4 style={{ marginTop: 0, marginBottom: 10, fontSize: 15, color: "#0f172a" }}>Числовые характеристики</h4>
      ) : null}

      {draft.characteristics.map((row, idx) => (
        <div
          key={idx}
          style={{
            border: "1px solid #e2e8f0",
            borderRadius: 8,
            padding: 12,
            marginBottom: 10,
            background: "#fff",
          }}
        >
          <div
            style={{ fontWeight: 600, marginBottom: 8, fontSize: 15, cursor: "help", width: "fit-content" }}
            title="Один блок задаёт одно поле-массив в нормализованном документе: в каждой строке текстовое значение и число."
          >
            Числовая характеристика {idx + 1}
          </div>
          <label style={{ display: "block", marginBottom: 10 }}>
            <span
              style={labelText}
              title="Это имя в JSON дважды: ключ массива на корне документа и имя поля с числовым значением в каждой строке массива."
            >
              Ключ поля и числового значения {reqStar}
            </span>
            <input
              style={{ width: "100%", maxWidth: "100%", padding: 8, borderRadius: 8, border: "1px solid #cbd5e1" }}
              value={row.characteristicKey}
              onChange={(e) =>
                onChange({ ...draft, characteristics: updateLine(draft.characteristics, idx, { characteristicKey: e.target.value }) })
              }
              onBlur={(e) => {
                const v = e.target.value.trim().toLowerCase();
                if (v !== row.characteristicKey) {
                  onChange({ ...draft, characteristics: updateLine(draft.characteristics, idx, { characteristicKey: v }) });
                }
              }}
              placeholder="например: массовая_доля"
            />
          </label>
          <label style={{ display: "block", marginBottom: 10 }}>
            <span
              style={labelText}
              title="Текстовое поле в строке массива: значение из документа (вещество, название измерения и т.п.)."
            >
              Поле значения {reqStar}
            </span>
            <input
              style={{ width: "100%", maxWidth: "100%", padding: 8, borderRadius: 8, border: "1px solid #cbd5e1" }}
              value={row.componentColumnKey}
              onChange={(e) =>
                onChange({ ...draft, characteristics: updateLine(draft.characteristics, idx, { componentColumnKey: e.target.value }) })
              }
              onBlur={(e) => {
                const v = e.target.value.trim().toLowerCase();
                if (v !== row.componentColumnKey) {
                  onChange({ ...draft, characteristics: updateLine(draft.characteristics, idx, { componentColumnKey: v }) });
                }
              }}
              placeholder="например: вещество"
            />
          </label>
          <label style={{ display: "block", marginBottom: 10 }}>
            <span
              style={labelText}
              title="По одному значению на строку ввода или несколько через запятую. Если в самом значении нужна запятая, заключите его в кавычки."
            >
              Допустимые значения поля (с новой строки или через запятую)
            </span>
            <AllowedComponentValuesTextarea
              key={`${idx}-${row.characteristicKey}-${row.componentColumnKey}`}
              rowKey={`${idx}-${row.characteristicKey}-${row.componentColumnKey}`}
              allowedComponentValues={row.allowedComponentValues}
              onCommit={(parsed) =>
                onChange({
                  ...draft,
                  characteristics: updateLine(draft.characteristics, idx, {
                    allowedComponentValues: parsed,
                  }),
                })
              }
              placeholder={'например:\nNa, P2O5, K2O\nили с новой строки\n"массовая доля, %"'}
            />
          </label>
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
            <button
              type="button"
              className="btn-danger"
              onClick={() => onChange({ ...draft, characteristics: draft.characteristics.filter((_, i) => i !== idx) })}
            >
              Удалить поле
            </button>
          </div>
        </div>
      ))}

      {(draft.textArrayFields ?? []).length > 0 ? (
        <h4 style={{ marginTop: 8, marginBottom: 10, fontSize: 15, color: "#0f172a" }}>Текстовые характеристики</h4>
      ) : null}

      {(draft.textArrayFields ?? []).map((row, idx) => (
        <div
          key={idx}
          style={{
            border: "1px solid #e2e8f0",
            borderRadius: 8,
            padding: 12,
            marginBottom: 10,
            background: "#fff",
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 15 }}>Текстовая характеристика {idx + 1}</div>
          <label style={{ display: "block", marginBottom: 10 }}>
            <span style={labelText} title="Один и тот же ключ для массива на корне и для свойства в каждой строке.">
              Ключ поля {reqStar}
            </span>
            <input
              style={{ width: "100%", maxWidth: "100%", padding: 8, borderRadius: 8, border: "1px solid #cbd5e1" }}
              value={row.fieldKey}
              onChange={(e) =>
                onChange({
                  ...draft,
                  textArrayFields: updateTextArrayLine(draft.textArrayFields ?? [], idx, { fieldKey: e.target.value }),
                })
              }
              onBlur={(e) => {
                const v = e.target.value.trim().toLowerCase();
                if (v !== row.fieldKey) {
                  onChange({
                    ...draft,
                    textArrayFields: updateTextArrayLine(draft.textArrayFields ?? [], idx, { fieldKey: v }),
                  });
                }
              }}
              placeholder="например: товарная_позиция"
            />
          </label>
          <label style={{ display: "block", marginBottom: 10 }}>
            <span style={labelText} title="Примеры возможных значений — по одному на строку или через запятую.">
              Примеры значений (для enum в схеме)
            </span>
            <AllowedComponentValuesTextarea
              key={`ta-${idx}-${row.fieldKey}`}
              rowKey={`ta-${idx}-${row.fieldKey}`}
              allowedComponentValues={row.exampleValues}
              onCommit={(parsed) =>
                onChange({
                  ...draft,
                  textArrayFields: updateTextArrayLine(draft.textArrayFields ?? [], idx, {
                    exampleValues: parsed,
                  }),
                })
              }
              placeholder={"например:\nзначение1\nзначение2"}
            />
          </label>
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
            <button
              type="button"
              className="btn-danger"
              onClick={() =>
                onChange({
                  ...draft,
                  textArrayFields: (draft.textArrayFields ?? []).filter((_, i) => i !== idx),
                })
              }
            >
              Удалить поле
            </button>
          </div>
        </div>
      ))}

      <h3 style={{ marginTop: 20, marginBottom: 8, fontSize: 17 }}>Блок «прочее»</h3>
      <p style={{ margin: "0 0 10px", fontSize: 13, color: "#475569", lineHeight: 1.45 }}>
        Массив на корне JSON с ключом «прочее»: в каждой строке свой набор полей (масса, количество, марка, стандарт и т.д.). Добавляет в
        схему отдельное свойство с гибкой структурой строк.
      </p>
      {!draft.procheeEnabled ? (
        <button
          type="button"
          className="btn"
          style={{ marginBottom: 16 }}
          onClick={() =>
            onChange({
              ...draft,
              procheeEnabled: true,
              procheeRows: draft.procheeRows?.length ? draft.procheeRows : DEFAULT_PROCHEE_TEMPLATE.map((o) => ({ ...o })),
            })
          }
        >
          Добавить блок «прочее» в JSON
        </button>
      ) : (
        <div
          style={{
            border: "1px solid #e2e8f0",
            borderRadius: 8,
            padding: 12,
            marginBottom: 16,
            background: "#fafafa",
          }}
        >
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10, alignItems: "center" }}>
            <button
              type="button"
              className="btn"
              title="Подставить типовой набор строк (масса, количество, стандарт, марка и т.д.)."
              onClick={() =>
                onChange({
                  ...draft,
                  procheeEnabled: true,
                  procheeRows: DEFAULT_PROCHEE_TEMPLATE.map((o) => ({ ...o })),
                })
              }
            >
              Подставить типовой шаблон «прочее»
            </button>
            <button
              type="button"
              className="btn-danger"
              title="Убрать ключ «прочее» из схемы и JSON-примера."
              onClick={() =>
                onChange({
                  ...draft,
                  procheeEnabled: false,
                  procheeRows: undefined,
                })
              }
            >
              Удалить блок «прочее»
            </button>
          </div>
          <label style={{ display: "block", marginBottom: 6 }}>
            <span style={{ ...labelText, cursor: "help" }} title="Массив объектов — содержимое ключа «прочее» на корне документа.">
              JSON массива «прочее»
            </span>
            <ProcheeJsonTextarea rows={draft.procheeRows} onCommit={(procheeRows) => onChange({ ...draft, procheeRows })} />
          </label>
        </div>
      )}

      {!hideInlinePreview ? (
        <>
          <pre
            style={{
              marginTop: 12,
              padding: 12,
              background: "#0f172a",
              color: "#e2e8f0",
              borderRadius: 8,
              fontSize: 12,
              overflow: "auto",
            }}
            title="Пример корня JSON по текущим ключам (по две строки в каждом массиве поля)."
          >
            {formatNumericCharacteristicsSampleJson(draft)}
          </pre>
        </>
      ) : null}
    </div>
  );
}
