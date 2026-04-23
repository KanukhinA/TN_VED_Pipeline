import React from "react";
import {
  DEFAULT_PROCHEE_TEMPLATE,
  formatNumericCharacteristicsSampleJson,
  parseAllowedComponentValuesFromText,
  type NumericCharacteristicLine,
  type NumericCharacteristicsDraft,
  type NumericCharacteristicLayout,
  type TextScalarFieldLine,
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

function updateTextScalarLine(list: TextScalarFieldLine[], index: number, patch: Partial<TextScalarFieldLine>) {
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
    draft.characteristics.length > 0 ||
    (draft.textArrayFields?.length ?? 0) > 0 ||
    (draft.textScalarFields?.length ?? 0) > 0 ||
    !!draft.procheeEnabled;

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
        Нажмите «Добавить поле» и выберите: <strong>одно число на корне</strong> (например плотность в декларации — ключ и
        значение-число без массива) или <strong>группу полей (массив)</strong> — как раньше: несколько строк с полем
        значения и числом. Для текстовых массивов и блока «прочее» используйте кнопки ниже.
      </p>

      <div style={{ marginBottom: 14 }}>
        <button
          type="button"
          className="btn"
          aria-expanded={addFieldOpen}
          onClick={() =>
            setAddFieldOpen((v) => {
              return !v;
            })
          }
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
                className="btn-secondary"
                onClick={() => {
                  onChange({
                    ...draft,
                    characteristics: [
                      ...draft.characteristics,
                      {
                        characteristicKey: "",
                        componentColumnKey: "",
                        layout: "scalar" satisfies NumericCharacteristicLayout,
                        allowEmpty: false,
                      },
                    ],
                  });
                  setAddFieldOpen(false);
                }}
              >
                Простое число
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  onChange({
                    ...draft,
                    textScalarFields: [...(draft.textScalarFields ?? []), { fieldKey: "", allowEmpty: false, exampleValues: undefined }],
                  });
                  setAddFieldOpen(false);
                }}
              >
                Простое текстовое поле
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  onChange({
                    ...draft,
                    characteristics: [
                      ...draft.characteristics,
                      { characteristicKey: "", componentColumnKey: "", layout: "group" satisfies NumericCharacteristicLayout },
                    ],
                  });
                  setAddFieldOpen(false);
                }}
              >
                Группа полей
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  onChange({
                    ...draft,
                    textArrayFields: [...(draft.textArrayFields ?? []), { fieldKey: "", allowEmpty: false, exampleValues: undefined }],
                  });
                  setAddFieldOpen(false);
                }}
              >
                Массив из допустимых значений
              </button>
              <button type="button" className="btn-secondary" onClick={() => { setAddFieldOpen(false); }}>
                Отмена
              </button>
            </div>
            <p style={{ margin: "10px 0 0", fontSize: 12, color: "#475569", lineHeight: 1.45 }}>
              Группа полей применяется, когда одна и та же характеристика задается для нескольких составляющих товара
              (например, массовая доля или концентрация разных веществ).
            </p>

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

      {draft.characteristics.map((row, idx) => {
        const isScalar = row.layout === "scalar";
        const fieldNo = idx + 1;
        const ordinal =
          draft.characteristics.slice(0, idx + 1).filter((r) => (r.layout === "scalar") === isScalar).length;
        return (
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
              title={
                isScalar
                  ? "На корне JSON одно поле с числом: { \"плотность\": 0.85 }."
                  : "Один блок задаёт массив на корне: в каждой строке текстовое значение и число."
              }
            >
              {`Поле ${fieldNo}. `}
              {isScalar ? `Одно число на корне ${ordinal}` : `Группа полей (массив) ${ordinal}`}
            </div>
            <label style={{ display: "block", marginBottom: 10 }}>
              <span
                style={labelText}
                title={
                  isScalar
                    ? "Имя поля на корне документа; значение в декларации — одно число."
                    : "Это имя в JSON дважды: ключ массива на корне документа и имя поля с числовым значением в каждой строке массива."
                }
              >
                {isScalar ? (
                  <>
                    Ключ числового поля {reqStar}
                  </>
                ) : (
                  <>
                    Ключ поля и числового значения {reqStar}
                  </>
                )}
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
                placeholder={isScalar ? "например: плотность" : "например: массовая_доля"}
              />
            </label>
            <label
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                marginBottom: 10,
                cursor: "pointer",
                userSelect: "none",
              }}
              title={
                isScalar
                  ? "Если включено, поле может отсутствовать в документе (не будет обязательным в required)."
                  : "Если включено, в документе для этого поля допустим пустой массив ([]), и поле может отсутствовать."
              }
            >
              <input
                type="checkbox"
                checked={!!row.allowEmpty}
                onChange={(e) =>
                  onChange({
                    ...draft,
                    characteristics: updateLine(draft.characteristics, idx, { allowEmpty: e.target.checked }),
                  })
                }
                style={{ width: 14, height: 14, margin: 0 }}
              />
              <span style={{ fontSize: 13, color: "#334155" }}>
                {isScalar ? "Можно оставить пустым (поле может отсутствовать)" : "Можно оставить пустым ([])"}
              </span>
            </label>
            {isScalar ? null : (
              <>
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
              </>
            )}
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
        );
      })}

      {(draft.textScalarFields ?? []).length > 0 ? (
        <h4 style={{ marginTop: 8, marginBottom: 10, fontSize: 15, color: "#0f172a" }}>Простые текстовые поля</h4>
      ) : null}

      {(draft.textScalarFields ?? []).map((row, idx) => (
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
          <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 15 }}>
            Поле {draft.characteristics.length + idx + 1}. Простое текстовое поле {idx + 1}
          </div>
          <label style={{ display: "block", marginBottom: 10 }}>
            <span style={labelText} title='Ключ текстового поля на корне JSON, например { "стандарт": "ТУ ..." }.'>
              Ключ поля {reqStar}
            </span>
            <input
              style={{ width: "100%", maxWidth: "100%", padding: 8, borderRadius: 8, border: "1px solid #cbd5e1" }}
              value={row.fieldKey}
              onChange={(e) =>
                onChange({
                  ...draft,
                  textScalarFields: updateTextScalarLine(draft.textScalarFields ?? [], idx, { fieldKey: e.target.value }),
                })
              }
              onBlur={(e) => {
                const v = e.target.value.trim().toLowerCase();
                if (v !== row.fieldKey) {
                  onChange({
                    ...draft,
                    textScalarFields: updateTextScalarLine(draft.textScalarFields ?? [], idx, { fieldKey: v }),
                  });
                }
              }}
              placeholder="например: стандарт"
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
                  textScalarFields: updateTextScalarLine(draft.textScalarFields ?? [], idx, {
                    exampleValues: parsed,
                  }),
                })
              }
              placeholder={"например:\nзначение1\nзначение2"}
            />
          </label>
          <label
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 10,
              cursor: "pointer",
              userSelect: "none",
            }}
            title="Если включено, поле может отсутствовать в документе (не будет обязательным в required)."
          >
            <input
              type="checkbox"
              checked={!!row.allowEmpty}
              onChange={(e) =>
                onChange({
                  ...draft,
                  textScalarFields: updateTextScalarLine(draft.textScalarFields ?? [], idx, { allowEmpty: e.target.checked }),
                })
              }
              style={{ width: 14, height: 14, margin: 0 }}
            />
            <span style={{ fontSize: 13, color: "#334155" }}>Можно оставить пустым (поле может отсутствовать)</span>
          </label>
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
            <button
              type="button"
              className="btn-danger"
              onClick={() =>
                onChange({
                  ...draft,
                  textScalarFields: (draft.textScalarFields ?? []).filter((_, i) => i !== idx),
                })
              }
            >
              Удалить поле
            </button>
          </div>
        </div>
      ))}

      {(draft.textArrayFields ?? []).length > 0 ? (
        <h4 style={{ marginTop: 8, marginBottom: 10, fontSize: 15, color: "#0f172a" }}>Текстовые массивы</h4>
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
          <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 15 }}>
            Поле {draft.characteristics.length + (draft.textScalarFields?.length ?? 0) + idx + 1}. Массив из допустимых значений {idx + 1}
          </div>
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
              placeholder="например: товарные_наименования"
            />
          </label>
          <label style={{ display: "block", marginBottom: 10 }}>
            <span style={labelText} title="Примеры возможных значений — по одному на строку или через запятую.">
              Примеры значений (для enum в схеме)
            </span>
            <AllowedComponentValuesTextarea
              key={`ta-arr-${idx}-${row.fieldKey}`}
              rowKey={`ta-arr-${idx}-${row.fieldKey}`}
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
          <label
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 10,
              cursor: "pointer",
              userSelect: "none",
            }}
            title="Если включено, в документе для этого текстового поля допустим пустой массив ([]), и поле может отсутствовать."
          >
            <input
              type="checkbox"
              checked={!!row.allowEmpty}
              onChange={(e) =>
                onChange({
                  ...draft,
                  textArrayFields: updateTextArrayLine(draft.textArrayFields ?? [], idx, { allowEmpty: e.target.checked }),
                })
              }
              style={{ width: 14, height: 14, margin: 0 }}
            />
            <span style={{ fontSize: 13, color: "#334155" }}>Можно оставить пустым ([])</span>
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
