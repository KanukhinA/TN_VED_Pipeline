/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { useId, useRef } from "react";
import {
  matchStructureNumericValuePath,
  matchStructureRowDescriptorByPath,
  type StructureRowFieldDescriptor,
} from "../expert/numericCharacteristicsDraft";
import type { CrossRulePathSuggestion } from "./crossRulePathSuggestions";
import PathPickField from "./PathPickField";
import StructureEnumValueControl from "./StructureEnumValueControl";

type SumEqualsRule = {
  template: "sumEquals";
  path: string;
  expected: number;
  tolerance: number;
};

type RequiredIfRule = {
  template: "requiredIf";
  if: {
    path: string;
    op:
      | "equals"
      | "notEquals"
      | "gt"
      | "gte"
      | "lt"
      | "lte"
      | "in"
      | "exists"
      | "notExists"
      | "regex"
      | "notRegex";
    value?: any;
  };
  then: {
    required_paths: string[];
  };
};

type AtLeastOnePresentRule = {
  template: "atLeastOnePresent";
  paths: string[];
  min_count: number;
};

type CrossRule = SumEqualsRule | RequiredIfRule | AtLeastOnePresentRule;

function safeString(v: any): string {
  return typeof v === "string" ? v : "";
}

function safeNumber(v: any): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function removeAt<T>(arr: T[], idx: number): T[] {
  return arr.filter((_, i) => i !== idx);
}

const ADD_OPTIONS: { template: CrossRule["template"]; label: string; hint: string }[] = [
  {
    template: "sumEquals",
    label: "Сумма чисел по полю",
    hint: "Складывает все числа по пути (например доли по полям одного массива) и сравнивает с ожидаемой суммой.",
  },
  {
    template: "requiredIf",
    label: "Если условие, поля обязательны",
    hint: "Сначала проверяется одно поле (равно, больше, «есть в JSON»…). Если условие выполнено, указанные поля тоже должны быть в документе.",
  },
  {
    template: "atLeastOnePresent",
    label: "Сколько полей должно быть",
    hint: "Задаёте несколько путей (обычно имена полей на корне) и минимум, сколько из них должны присутствовать.",
  },
];

function opNeedsValue(op: string): boolean {
  return op !== "exists" && op !== "notExists";
}

const IF_ENUM_STRING_OPS = new Set(["equals", "notEquals", "in"]);
const IF_NUMERIC_OPS = new Set(["gt", "gte", "lt", "lte"]);

export default function CrossRulesEditor(props: {
  value: CrossRule[];
  onChange: (next: CrossRule[]) => void;
  /** Подсказки путей из схемы / черновика структуры */
  pathSuggestions?: CrossRulePathSuggestion[];
  /** Поля и перечни значений с шага «Структура» (мастер числовых характеристик) */
  structureRowDescriptors?: StructureRowFieldDescriptor[];
  /** Упрощённый заголовок и одна кнопка добавления с выбором типа проверки */
  friendlyChrome?: boolean;
}) {
  const rules = props.value ?? [];
  const friendly = props.friendlyChrome ?? false;
  const sug = props.pathSuggestions;
  const rowDesc = props.structureRowDescriptors;
  const addKindRef = useRef<HTMLSelectElement>(null);
  const addKindId = useId();

  const addRule = (template: CrossRule["template"]) => {
    let next: CrossRule;
    if (template === "sumEquals") {
      next = { template, path: "", expected: 100, tolerance: 0.0001 };
    } else if (template === "requiredIf") {
      next = {
        template,
        if: { path: "", op: "equals", value: "" },
        then: { required_paths: [""] },
      };
    } else {
      next = { template, paths: [""], min_count: 1 };
    }
    props.onChange([...rules, next]);
  };

  const updateRuleAt = (idx: number, update: CrossRule) => {
    const next = rules.slice();
    next[idx] = update;
    props.onChange(next);
  };

  return (
    <div style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <strong>{friendly ? "Проверки данных (не классификация)" : "Правила по полям документа"}</strong>
        {friendly ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "flex-end" }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 4, flex: "1 1 220px", minWidth: 0 }} htmlFor={addKindId}>
              <span style={{ fontSize: 12, color: "#64748b" }}>Что добавить</span>
              <select
                id={addKindId}
                ref={addKindRef}
                defaultValue="sumEquals"
                style={{ width: "100%", padding: 8, borderRadius: 8, border: "1px solid #cbd5e1" }}
              >
                {ADD_OPTIONS.map((o) => (
                  <option key={o.template} value={o.template} title={o.hint}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="btn"
              style={{ alignSelf: "flex-end" }}
              onClick={() => {
                const template = (addKindRef.current?.value ?? "sumEquals") as CrossRule["template"];
                addRule(template);
              }}
            >
              Добавить проверку
            </button>
          </div>
        ) : (
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button type="button" className="btn" onClick={() => addRule("sumEquals")}>
              + Сумма
            </button>
            <button type="button" className="btn" onClick={() => addRule("requiredIf")}>
              + Условная обязательность
            </button>
            <button type="button" className="btn" onClick={() => addRule("atLeastOnePresent")}>
              + Поля на корне
            </button>
          </div>
        )}
      </div>

      {friendly ? (
        <p style={{ marginTop: 12, marginBottom: 0, fontSize: 13, color: "#64748b", lineHeight: 1.5 }}>
          Эти правила смотрят на <strong>значения в JSON</strong> после нормализации: суммы по столбцу, «если поле X такое-то, поле Y обязательно»,
          «хотя бы N из перечисленных полей на корне должны быть». Классы документа здесь не задаются, только целостность данных.
        </p>
      ) : null}

      {rules.length === 0 ? (
        <div style={{ marginTop: 12, color: "#666" }}>Пока нет проверок. Выберите тип выше и нажмите «Добавить».</div>
      ) : null}

      <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 12 }}>
        {rules.map((r, idx) => {
          const opt = ADD_OPTIONS.find((o) => o.template === r.template);
          return (
            <div key={`${idx}-${r.template}`} style={{ border: "1px solid #eee", borderRadius: 8, padding: 12, background: "#fafafa" }}>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
                <div>
                  <div style={{ fontWeight: 700 }}>
                    {idx + 1}){" "}
                    {r.template === "sumEquals"
                      ? "Сумма по числовому полю"
                      : r.template === "requiredIf"
                        ? "Условие и обязательные поля"
                        : "Наличие полей на корне"}
                  </div>
                  {friendly && opt ? (
                    <div style={{ marginTop: 6, fontSize: 13, color: "#475569", lineHeight: 1.45 }}>{opt.hint}</div>
                  ) : null}
                </div>
                <button type="button" className="btn-danger" onClick={() => props.onChange(removeAt(rules, idx))}>
                  Удалить
                </button>
              </div>

              {r.template === "sumEquals" && (
                <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 12 }}>
                  <PathPickField
                    value={safeString(r.path)}
                    onChange={(path) => updateRuleAt(idx, { ...r, path })}
                    suggestions={sug}
                    placeholder="выберите из перечня или введите вручную"
                    hintBelow="Обычно выбирают «Числа по всем строкам поля» для нужного поля; система соберёт все числа в полях и сложит."
                  />
                  <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                    <label style={{ flex: "1 1 140px" }}>
                      <div style={{ marginBottom: 4, fontSize: 13, color: "#64748b" }}>Сумма должна быть</div>
                      <input
                        value={String(r.expected)}
                        onChange={(e) => updateRuleAt(idx, { ...r, expected: safeNumber(e.target.value) })}
                        style={{ width: "100%", padding: 8, borderRadius: 8, border: "1px solid #cbd5e1" }}
                        inputMode="decimal"
                      />
                    </label>
                    <label style={{ flex: "1 1 140px" }}>
                      <div style={{ marginBottom: 4, fontSize: 13, color: "#64748b" }}>Допуск ±</div>
                      <input
                        value={String(r.tolerance)}
                        onChange={(e) => updateRuleAt(idx, { ...r, tolerance: safeNumber(e.target.value) })}
                        style={{ width: "100%", padding: 8, borderRadius: 8, border: "1px solid #cbd5e1" }}
                        inputMode="decimal"
                      />
                    </label>
                  </div>
                </div>
              )}

              {r.template === "atLeastOnePresent" && (
                <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 12 }}>
                  <div style={{ fontSize: 13, color: "#64748b", lineHeight: 1.45 }}>
                    Отметьте ключи полей из структуры (или введите вручную). В документе должно присутствовать не меньше указанного числа из этого перечня.
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {r.paths.map((p, pIdx) => (
                      <div key={`${pIdx}`} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        <PathPickField
                          value={p}
                          onChange={(path) => {
                            const nextPaths = r.paths.slice();
                            nextPaths[pIdx] = path;
                            updateRuleAt(idx, { ...r, paths: nextPaths });
                          }}
                          suggestions={sug}
                          placeholder="ключ поля на корне"
                        />
                        <div style={{ display: "flex", justifyContent: "flex-end", width: "100%" }}>
                          <button
                            type="button"
                            className="btn-danger"
                            onClick={() => {
                              const nextPaths = removeAt(r.paths, pIdx);
                              updateRuleAt(idx, { ...r, paths: nextPaths.length ? nextPaths : [""] });
                            }}
                          >
                            Удалить ключ
                          </button>
                        </div>
                      </div>
                    ))}
                    <button type="button" className="btn" onClick={() => updateRuleAt(idx, { ...r, paths: [...r.paths, ""] })}>
                      + Ещё ключ
                    </button>
                  </div>
                  <label style={{ maxWidth: 280 }}>
                    <div style={{ marginBottom: 4, fontSize: 13, color: "#64748b" }}>Минимум присутствующих из перечня</div>
                    <input
                      value={String(r.min_count)}
                      onChange={(e) => updateRuleAt(idx, { ...r, min_count: Math.max(0, safeNumber(e.target.value)) })}
                      style={{ width: "100%", padding: 8, borderRadius: 8, border: "1px solid #cbd5e1" }}
                      inputMode="numeric"
                    />
                  </label>
                </div>
              )}

              {r.template === "requiredIf" && (
                <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 12 }}>
                  <div style={{ border: "1px dashed #cbd5e1", borderRadius: 8, padding: 12, background: "#fff" }}>
                    <div style={{ fontWeight: 700, marginBottom: 8 }}>Шаг 1: когда срабатывает правило</div>
                    <PathPickField
                      value={safeString(r.if.path)}
                      onChange={(path) => updateRuleAt(idx, { ...r, if: { ...r.if, path } })}
                      suggestions={sug}
                      placeholder="выберите поле или введите имя"
                      hintBelow="Для проверки «поле заполнено / пусто» выберите операторы «Поле есть в документе» или «Поля нет»; отдельное значение не нужно."
                    />
                    <div style={{ display: "flex", gap: 12, marginTop: 12, flexWrap: "wrap" }}>
                      <label style={{ flex: "1 1 160px" }}>
                        <div style={{ marginBottom: 4, fontSize: 13, color: "#64748b" }}>Оператор</div>
                        <select
                          value={r.if.op}
                          onChange={(e) => {
                            const op = e.target.value as RequiredIfRule["if"]["op"];
                            let value: any = r.if.value;
                            if (op === "exists" || op === "notExists") value = undefined;
                            else if (op === "regex" || op === "notRegex")
                              value = typeof r.if.value === "string" ? r.if.value : "";
                            else if (op === "in") {
                              if (r.if.op !== "in") value = undefined;
                            } else if (Array.isArray(r.if.value)) value = undefined;
                            updateRuleAt(idx, { ...r, if: { ...r.if, op, value } });
                          }}
                          style={{ width: "100%", padding: 8, borderRadius: 8, border: "1px solid #cbd5e1" }}
                        >
                          <option value="equals">Равно</option>
                          <option value="notEquals">Не равно</option>
                          <option value="gt">Больше</option>
                          <option value="gte">Не меньше</option>
                          <option value="lt">Меньше</option>
                          <option value="lte">Не больше</option>
                          <option value="in">Одно из перечня</option>
                          <option value="regex">Соответствует regex</option>
                          <option value="notRegex">Не соответствует regex</option>
                          <option value="exists">Поле есть в документе</option>
                          <option value="notExists">Поля нет в документе</option>
                        </select>
                      </label>
                      {opNeedsValue(r.if.op) ? (
                        <>
                          <StructureEnumValueControl
                            path={safeString(r.if.path)}
                            op={r.if.op}
                            value={r.if.value}
                            onValueChange={(v) => updateRuleAt(idx, { ...r, if: { ...r.if, value: v } })}
                            structureRowDescriptors={rowDesc}
                            enumLabel="С чем сравнить"
                          />
                          {(() => {
                            const path = safeString(r.if.path);
                            const desc = rowDesc?.length ? matchStructureRowDescriptorByPath(path, rowDesc) : undefined;
                            const hasEnum = !!(desc?.allowedValues?.length);
                            const hasNumCol = rowDesc?.length ? !!matchStructureNumericValuePath(path, rowDesc) : false;

                            if (IF_ENUM_STRING_OPS.has(r.if.op) && hasEnum) {
                              return null;
                            }
                            if (IF_NUMERIC_OPS.has(r.if.op)) {
                              return (
                                <label style={{ flex: "1 1 160px" }}>
                                  <div style={{ marginBottom: 4, fontSize: 13, color: "#64748b" }}>Число для сравнения</div>
                                  <input
                                    type="number"
                                    step="any"
                                    value={
                                      r.if.value === undefined || r.if.value === null ? "" : String(r.if.value)
                                    }
                                    onChange={(e) => {
                                      const t = e.target.value;
                                      updateRuleAt(idx, {
                                        ...r,
                                        if: { ...r.if, value: t === "" ? undefined : Number(t) },
                                      });
                                    }}
                                    style={{ width: "100%", padding: 8, borderRadius: 8, border: "1px solid #cbd5e1" }}
                                  />
                                </label>
                              );
                            }
                            if ((r.if.op === "equals" || r.if.op === "notEquals") && hasNumCol) {
                              return (
                                <label style={{ flex: "1 1 160px" }}>
                                  <div style={{ marginBottom: 4, fontSize: 13, color: "#64748b" }}>Число для сравнения</div>
                                  <input
                                    type="number"
                                    step="any"
                                    value={
                                      r.if.value === undefined || r.if.value === null ? "" : String(r.if.value)
                                    }
                                    onChange={(e) => {
                                      const t = e.target.value;
                                      updateRuleAt(idx, {
                                        ...r,
                                        if: { ...r.if, value: t === "" ? undefined : Number(t) },
                                      });
                                    }}
                                    style={{ width: "100%", padding: 8, borderRadius: 8, border: "1px solid #cbd5e1" }}
                                  />
                                </label>
                              );
                            }
                            if (IF_ENUM_STRING_OPS.has(r.if.op)) {
                              return (
                                <div
                                  style={{
                                    flex: "1 1 260px",
                                    fontSize: 13,
                                    color: "#64748b",
                                    lineHeight: 1.45,
                                    maxWidth: "min(28rem, 100%)",
                                  }}
                                >
                                  Текст сравнивается только с перечнем на шаге «Структура»: выберите поле значения в «Выбор из структуры».
                                </div>
                              );
                            }
                            return null;
                          })()}
                        </>
                      ) : (
                        <div style={{ flex: "1 1 160px", fontSize: 13, color: "#64748b", alignSelf: "flex-end", paddingBottom: 8 }}>
                          Для этого оператора отдельное значение не задаётся.
                        </div>
                      )}
                    </div>
                  </div>

                  <div style={{ border: "1px dashed #cbd5e1", borderRadius: 8, padding: 12, background: "#fff" }}>
                    <div style={{ fontWeight: 700, marginBottom: 8 }}>Шаг 2: что обязательно заполнить, если условие выполнено</div>
                    <div style={{ fontSize: 13, color: "#64748b", marginBottom: 10, lineHeight: 1.45 }}>
                      Каждый пункт проверяется отдельно: соответствующее поле должно быть в документе.
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      {r.then.required_paths.map((p, pIdx) => (
                        <div key={`${pIdx}`} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                          <PathPickField
                            value={p}
                            onChange={(path) => {
                              const nextRequired = r.then.required_paths.slice();
                              nextRequired[pIdx] = path;
                              updateRuleAt(idx, { ...r, then: { ...r.then, required_paths: nextRequired } });
                            }}
                            suggestions={sug}
                            placeholder="обязательное поле"
                          />
                          <div style={{ display: "flex", justifyContent: "flex-end", width: "100%" }}>
                            <button
                              type="button"
                              className="btn-danger"
                              onClick={() => {
                                const nextRequired = removeAt(r.then.required_paths, pIdx);
                                updateRuleAt(idx, {
                                  ...r,
                                  then: { ...r.then, required_paths: nextRequired.length ? nextRequired : [""] },
                                });
                              }}
                            >
                              Убрать
                            </button>
                          </div>
                        </div>
                      ))}
                      <button
                        type="button"
                        className="btn"
                        onClick={() =>
                          updateRuleAt(idx, { ...r, then: { ...r.then, required_paths: [...r.then.required_paths, ""] } })
                        }
                      >
                        + Обязательное поле
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
