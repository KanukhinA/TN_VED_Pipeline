/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { useMemo, useState } from "react";
import { FERTILIZER_DECLARATION_EXAMPLE, FERTILIZER_RULE_DSL } from "../examples/fertilizer";
import { listRules, saveRule, validateRule } from "../api/client";
import SchemaFieldEditor from "../ui/SchemaFieldEditor";
import CrossRulesEditor from "../ui/CrossRulesEditor";
import { buildPathSuggestionsFromRuleSchema } from "../ui/crossRulePathSuggestions";

type SaveResult = {
  rule_id: string;
  version: number;
  created_at?: string;
};

type WizardMode = "upload" | "scratch";

type SchemaNodeInfo = {
  path: string;
  type: "object" | "array" | "string" | "number" | "integer" | "boolean";
};

function inferSchemaFromJsonValue(value: any): any {
  if (value === null || value === undefined) {
    return { type: "string" };
  }

  if (Array.isArray(value)) {
    const first = value.length > 0 ? value[0] : "";
    return {
      type: "array",
      items: inferSchemaFromJsonValue(first),
      min_items: 0,
    };
  }

  if (typeof value === "object") {
    const properties = Object.entries(value).map(([name, v]) => ({
      name,
      schema: inferSchemaFromJsonValue(v),
    }));
    return {
      type: "object",
      properties,
      required: Object.keys(value),
      additional_properties: false,
    };
  }

  if (typeof value === "number") {
    return Number.isInteger(value) ? { type: "integer" } : { type: "number" };
  }

  if (typeof value === "boolean") {
    return { type: "boolean" };
  }

  return { type: "string" };
}

function parsePathToken(token: string): { name: string; isArrayItem: boolean } {
  if (token.endsWith("[]")) {
    return { name: token.slice(0, -2), isArrayItem: true };
  }
  return { name: token, isArrayItem: false };
}

function collectSchemaNodes(schema: any, prefix = ""): SchemaNodeInfo[] {
  if (!schema || typeof schema !== "object" || !schema.type) return [];

  const nodes: SchemaNodeInfo[] = [];
  const thisPath = prefix;
  if (thisPath) {
    nodes.push({ path: thisPath, type: schema.type });
  }

  if (schema.type === "object") {
    for (const prop of schema.properties ?? []) {
      const p = prefix ? `${prefix}.${prop.name}` : prop.name;
      nodes.push(...collectSchemaNodes(prop.schema, p));
    }
  } else if (schema.type === "array") {
    const p = `${prefix}[]`;
    nodes.push(...collectSchemaNodes(schema.items, p));
  }

  return nodes;
}

function updateFieldSchemaByPath(root: any, path: string, updater: (schema: any) => void): any {
  const next = structuredClone(root);
  const tokens = path.split(".");
  let current = next;

  for (const rawToken of tokens) {
    const { name, isArrayItem } = parsePathToken(rawToken);
    if (!current || current.type !== "object") return root;
    const prop = (current.properties ?? []).find((p: any) => p.name === name);
    if (!prop) return root;

    if (isArrayItem) {
      if (!prop.schema || prop.schema.type !== "array") return root;
      current = prop.schema.items;
    } else {
      current = prop.schema;
    }
  }

  updater(current);
  return next;
}

function setRequiredByPath(root: any, path: string, isRequired: boolean): any {
  const next = structuredClone(root);
  const tokens = path.split(".");
  if (tokens.length === 0) return root;
  const lastToken = tokens[tokens.length - 1];
  const { name: fieldName, isArrayItem } = parsePathToken(lastToken);
  if (isArrayItem) return root;

  let current = next;
  for (let i = 0; i < tokens.length - 1; i++) {
    const { name, isArrayItem: item } = parsePathToken(tokens[i]);
    if (!current || current.type !== "object") return root;
    const prop = (current.properties ?? []).find((p: any) => p.name === name);
    if (!prop) return root;
    if (item) {
      if (!prop.schema || prop.schema.type !== "array") return root;
      current = prop.schema.items;
    } else {
      current = prop.schema;
    }
  }

  if (!current || current.type !== "object") return root;
  const req = new Set<string>(current.required ?? []);
  if (isRequired) req.add(fieldName);
  else req.delete(fieldName);
  current.required = Array.from(req);
  return next;
}

function SchemaSummary(props: { schema: any }) {
  const nodes = collectSchemaNodes(props.schema);
  if (nodes.length === 0) return <div style={{ color: "#64748b" }}>Структура пока пустая.</div>;

  return (
    <div style={{ maxHeight: 260, overflow: "auto", border: "1px solid #e5e7eb", borderRadius: 8, padding: 8 }}>
      {nodes.map((n) => (
        <div key={`${n.path}-${n.type}`} style={{ padding: "4px 0", fontSize: 14 }}>
          <code>{n.path}</code>: <span>{n.type}</span>
        </div>
      ))}
    </div>
  );
}

export default function RuleEditor() {
  const initialDsl = useMemo(() => structuredClone(FERTILIZER_RULE_DSL), []);

  const [dsl, setDsl] = useState<any>(initialDsl);
  const [ruleId, setRuleId] = useState<string | null>(null);

  const [dataJson, setDataJson] = useState<string>(JSON.stringify(FERTILIZER_DECLARATION_EXAMPLE, null, 2));
  const [saveResult, setSaveResult] = useState<SaveResult | null>(null);
  const [validateResult, setValidateResult] = useState<any>(null);

  const [step, setStep] = useState<number>(1);
  const [mode, setMode] = useState<WizardMode>("upload");
  const [sourceJson, setSourceJson] = useState<string>(JSON.stringify(FERTILIZER_DECLARATION_EXAMPLE, null, 2));

  const [busy, setBusy] = useState(false);
  const [activeTab, setActiveTab] = useState<"create" | "list">("create");
  const [catalogs, setCatalogs] = useState<any[]>([]);
  const [catalogsLoading, setCatalogsLoading] = useState(false);
  const schemaNodes = useMemo(() => collectSchemaNodes(dsl.schema), [dsl.schema]);
  const fieldNodes = useMemo(() => schemaNodes.filter((n) => !n.path.endsWith("[]")), [schemaNodes]);
  const numberNodes = useMemo(() => fieldNodes.filter((n) => n.type === "number" || n.type === "integer"), [fieldNodes]);
  const stringNodes = useMemo(() => fieldNodes.filter((n) => n.type === "string"), [fieldNodes]);
  const arrayNodes = useMemo(() => fieldNodes.filter((n) => n.type === "array"), [fieldNodes]);
  const crossRulePathSuggestions = useMemo(() => buildPathSuggestionsFromRuleSchema(dsl?.schema), [dsl?.schema]);

  const [requiredPath, setRequiredPath] = useState<string>("");
  const [requiredFlag, setRequiredFlag] = useState<boolean>(true);

  const [numberPath, setNumberPath] = useState<string>("");
  const [numberMin, setNumberMin] = useState<string>("");
  const [numberMax, setNumberMax] = useState<string>("");

  const [enumPath, setEnumPath] = useState<string>("");
  const [enumValues, setEnumValues] = useState<string>("");

  const [patternPath, setPatternPath] = useState<string>("");
  const [patternValue, setPatternValue] = useState<string>("");

  const [arrayPath, setArrayPath] = useState<string>("");
  const [arrayMin, setArrayMin] = useState<string>("");
  const [arrayMax, setArrayMax] = useState<string>("");

  React.useEffect(() => {
    let cancelled = false;
    async function loadCatalogs() {
      setCatalogsLoading(true);
      try {
        const items = await listRules();
        if (!cancelled) setCatalogs(items);
      } catch {
        if (!cancelled) setCatalogs([]);
      } finally {
        if (!cancelled) setCatalogsLoading(false);
      }
    }
    loadCatalogs();
    return () => {
      cancelled = true;
    };
  }, []);

  function onChangeTop<K extends keyof typeof dsl>(key: K, value: any) {
    setDsl((prev: any) => ({ ...prev, [key]: value }));
  }

  async function onSave() {
    setBusy(true);
    setValidateResult(null);
    try {
      const res = await saveRule(dsl, ruleId);
      setRuleId(res.rule_id);
      setSaveResult({ rule_id: res.rule_id, version: res.version, created_at: res.created_at });
      const items = await listRules();
      setCatalogs(items);
    } finally {
      setBusy(false);
    }
  }

  async function onValidate() {
    if (!ruleId) return;
    setBusy(true);
    setValidateResult(null);
    try {
      const parsed = JSON.parse(dataJson);
      const res = await validateRule(ruleId, parsed);
      setValidateResult(res);
    } catch (e: any) {
      setValidateResult({ ok: false, errors: [{ message: e?.message ?? String(e) }] });
    } finally {
      setBusy(false);
    }
  }

  function createSchemaFromSourceJson() {
    try {
      const parsed = JSON.parse(sourceJson);
      const inferred = inferSchemaFromJsonValue(parsed);
      if (inferred.type !== "object") {
        alert("Корневой JSON должен быть объектом.");
        return;
      }

      setDsl((prev: any) => ({
        ...prev,
        schema: inferred,
      }));
      setDataJson(JSON.stringify(parsed, null, 2));
      setStep(2);
    } catch {
      alert("Некорректный JSON в источнике.");
    }
  }

  function createSchemaFromScratch() {
    setDsl((prev: any) => ({
      ...prev,
      schema: {
        type: "object",
        properties: [],
        required: [],
        additional_properties: false,
      },
    }));
    setStep(2);
  }

  function stepTitle(n: number): string {
    if (n === 1) return "Шаг 1. Источник структуры";
    if (n === 2) return "Шаг 2. Редактор структуры";
    if (n === 3) return "Шаг 3. Настройка правил";
    return "Шаг 4. Сохранение и тест валидации";
  }

  return (
    <div className="container">
      <h1>Конструктор правил Pydantic</h1>

      <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
        <button
          type="button"
          className={activeTab === "create" ? "btn" : "btn-secondary"}
          onClick={() => setActiveTab("create")}
        >
          Создать справочник
        </button>
        <button
          type="button"
          className={activeTab === "list" ? "btn" : "btn-secondary"}
          onClick={() => setActiveTab("list")}
        >
          Существующие справочники
        </button>
      </div>

      {activeTab === "list" && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h2>Существующие справочники</h2>
          {catalogsLoading ? (
            <div>Загрузка...</div>
          ) : catalogs.length === 0 ? (
            <div>Справочников пока нет.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {catalogs.map((c) => (
                <div key={c.rule_id} style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 10 }}>
                  <div>
                    <strong>{c.name || "(без названия)"}</strong> · model_id: <code>{c.model_id}</code>
                  </div>
                  <div style={{ fontSize: 13, color: "#475569" }}>
                    rule_id: <code>{c.rule_id}</code> · версия: {c.version}
                  </div>
                  {c.description ? <div style={{ marginTop: 4 }}>{c.description}</div> : null}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === "create" && (
        <>
          <div className="card" style={{ marginBottom: 16 }}>
            <h2>Существующие справочники</h2>
            {catalogsLoading ? (
              <div>Загрузка...</div>
            ) : catalogs.length === 0 ? (
              <div>Справочников пока нет.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 220, overflow: "auto" }}>
                {catalogs.map((c) => (
                  <div key={c.rule_id} style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 10 }}>
                    <div>
                      <strong>{c.name || "(без названия)"}</strong> · model_id: <code>{c.model_id}</code>
                    </div>
                    <div style={{ fontSize: 13, color: "#475569" }}>
                      rule_id: <code>{c.rule_id}</code> · версия: {c.version}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
            {[1, 2, 3, 4].map((n) => (
              <button
                key={n}
                type="button"
                className={step === n ? "btn" : "btn-secondary"}
                onClick={() => setStep(n)}
              >
                {n}
              </button>
            ))}
          </div>

          <h2>{stepTitle(step)}</h2>

          {step === 1 && (
        <div className="card" style={{ width: "100%", maxWidth: "min(56rem, 100%)" }}>
          <div style={{ display: "flex", gap: 24, marginBottom: 14 }}>
            <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type="radio"
                checked={mode === "upload"}
                onChange={() => setMode("upload")}
              />
              Подгрузить JSON и построить структуру автоматически
            </label>
            <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type="radio"
                checked={mode === "scratch"}
                onChange={() => setMode("scratch")}
              />
              Создать структуру с нуля
            </label>
          </div>

          {mode === "upload" ? (
            <>
              <div style={{ marginBottom: 6 }}>Вставьте пример JSON:</div>
              <textarea value={sourceJson} onChange={(e) => setSourceJson(e.target.value)} />
              <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
                <button type="button" className="btn" onClick={createSchemaFromSourceJson}>
                  Построить структуру из JSON
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setSourceJson(JSON.stringify(FERTILIZER_DECLARATION_EXAMPLE, null, 2))}
                >
                  Подставить пример удобрений
                </button>
              </div>
            </>
          ) : (
            <div>
              <p>Будет создана пустая структура объекта, затем вы добавите поля вручную.</p>
              <button type="button" className="btn" onClick={createSchemaFromScratch}>
                Создать пустую структуру
              </button>
            </div>
          )}
        </div>
          )}

          {step === 2 && (
        <div className="row">
          <div className="col">
            <div className="card">
              <h3>Общие данные правила</h3>
              <div style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%", maxWidth: "min(40rem, 100%)" }}>
                <label>
                  <div style={{ marginBottom: 4 }}>model_id</div>
                  <input
                    style={{ width: "100%" }}
                    value={dsl.model_id ?? ""}
                    onChange={(e) => onChangeTop("model_id", e.target.value)}
                  />
                </label>

                <label>
                  <div style={{ marginBottom: 4 }}>Название</div>
                  <input
                    style={{ width: "100%" }}
                    value={dsl.meta?.name ?? ""}
                    onChange={(e) =>
                      onChangeTop("meta", {
                        ...(dsl.meta ?? {}),
                        name: e.target.value,
                      })
                    }
                  />
                </label>

                <label>
                  <div style={{ marginBottom: 4 }}>Описание</div>
                  <textarea
                    value={dsl.meta?.description ?? ""}
                    onChange={(e) =>
                      onChangeTop("meta", {
                        ...(dsl.meta ?? {}),
                        description: e.target.value,
                      })
                    }
                    style={{ minHeight: 90 }}
                  />
                </label>
              </div>
            </div>
          </div>
          <div className="col">
            <SchemaFieldEditor value={dsl.schema} onChange={(next) => onChangeTop("schema", next)} />
            <div style={{ marginTop: 10 }}>
              <button type="button" className="btn" onClick={() => setStep(3)}>
                Далее: назначить правила
              </button>
            </div>
          </div>
        </div>
          )}

          {step === 3 && (
        <div className="row">
          <div className="col">
            <div className="card">
              <h3>Упрощённая структура</h3>
              <SchemaSummary schema={dsl.schema} />
            </div>
          </div>

          <div className="col">
            <div className="card">
              <h3>Быстрые назначения правил</h3>

              <div style={{ marginTop: 10, borderTop: "1px solid #e5e7eb", paddingTop: 10 }}>
                <strong>Обязательность поля</strong>
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  <select value={requiredPath} onChange={(e) => setRequiredPath(e.target.value)} style={{ flex: 1 }}>
                    <option value="">Выберите поле</option>
                    {fieldNodes.map((n) => (
                      <option key={n.path} value={n.path}>
                        {n.path}
                      </option>
                    ))}
                  </select>
                  <select value={requiredFlag ? "1" : "0"} onChange={(e) => setRequiredFlag(e.target.value === "1")}>
                    <option value="1">Обязательное</option>
                    <option value="0">Необязательное</option>
                  </select>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      if (!requiredPath) return;
                      onChangeTop("schema", setRequiredByPath(dsl.schema, requiredPath, requiredFlag));
                    }}
                  >
                    Применить
                  </button>
                </div>
              </div>

              <div style={{ marginTop: 10, borderTop: "1px solid #e5e7eb", paddingTop: 10 }}>
                <strong>Числовые ограничения (min/max)</strong>
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  <select value={numberPath} onChange={(e) => setNumberPath(e.target.value)} style={{ flex: 1 }}>
                    <option value="">Выберите числовое поле</option>
                    {numberNodes.map((n) => (
                      <option key={n.path} value={n.path}>
                        {n.path}
                      </option>
                    ))}
                  </select>
                  <input placeholder="min" value={numberMin} onChange={(e) => setNumberMin(e.target.value)} />
                  <input placeholder="max" value={numberMax} onChange={(e) => setNumberMax(e.target.value)} />
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      if (!numberPath) return;
                      onChangeTop(
                        "schema",
                        updateFieldSchemaByPath(dsl.schema, numberPath, (s) => {
                          if (s.type !== "number" && s.type !== "integer") return;
                          const c = { ...(s.constraints ?? {}) };
                          c.min = numberMin.trim() ? Number(numberMin) : undefined;
                          c.max = numberMax.trim() ? Number(numberMax) : undefined;
                          s.constraints = c;
                        }),
                      );
                    }}
                  >
                    Применить
                  </button>
                </div>
              </div>

              <div style={{ marginTop: 10, borderTop: "1px solid #e5e7eb", paddingTop: 10 }}>
                <strong>Перечень допустимых значений (enum)</strong>
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  <select value={enumPath} onChange={(e) => setEnumPath(e.target.value)} style={{ flex: 1 }}>
                    <option value="">Выберите поле</option>
                    {fieldNodes
                      .filter((n) => ["string", "number", "integer"].includes(n.type))
                      .map((n) => (
                        <option key={n.path} value={n.path}>
                          {n.path}
                        </option>
                      ))}
                  </select>
                  <input
                    style={{ flex: 1 }}
                    placeholder="значения через запятую"
                    value={enumValues}
                    onChange={(e) => setEnumValues(e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      if (!enumPath) return;
                      onChangeTop(
                        "schema",
                        updateFieldSchemaByPath(dsl.schema, enumPath, (s) => {
                          const raw = enumValues
                            .split(",")
                            .map((x) => x.trim())
                            .filter(Boolean);
                          if (s.type === "string") {
                            s.constraints = { ...(s.constraints ?? {}), enum: raw };
                          } else if (s.type === "number" || s.type === "integer") {
                            const vals = raw.map((x) => Number(x)).filter((x) => Number.isFinite(x));
                            s.constraints = { ...(s.constraints ?? {}), enum: vals };
                          }
                        }),
                      );
                    }}
                  >
                    Применить
                  </button>
                </div>
              </div>

              <div style={{ marginTop: 10, borderTop: "1px solid #e5e7eb", paddingTop: 10 }}>
                <strong>Регулярное выражение (для строк)</strong>
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  <select value={patternPath} onChange={(e) => setPatternPath(e.target.value)} style={{ flex: 1 }}>
                    <option value="">Выберите строковое поле</option>
                    {stringNodes.map((n) => (
                      <option key={n.path} value={n.path}>
                        {n.path}
                      </option>
                    ))}
                  </select>
                  <input
                    style={{ flex: 1 }}
                    placeholder="например: ^[A-Z0-9]+$"
                    value={patternValue}
                    onChange={(e) => setPatternValue(e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      if (!patternPath) return;
                      onChangeTop(
                        "schema",
                        updateFieldSchemaByPath(dsl.schema, patternPath, (s) => {
                          if (s.type !== "string") return;
                          s.constraints = { ...(s.constraints ?? {}), pattern: patternValue || undefined };
                        }),
                      );
                    }}
                  >
                    Применить
                  </button>
                </div>
              </div>

              <div style={{ marginTop: 10, borderTop: "1px solid #e5e7eb", paddingTop: 10 }}>
                <strong>Ограничение размера массива</strong>
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  <select value={arrayPath} onChange={(e) => setArrayPath(e.target.value)} style={{ flex: 1 }}>
                    <option value="">Выберите массив</option>
                    {arrayNodes.map((n) => (
                      <option key={n.path} value={n.path}>
                        {n.path}
                      </option>
                    ))}
                  </select>
                  <input placeholder="min" value={arrayMin} onChange={(e) => setArrayMin(e.target.value)} />
                  <input placeholder="max" value={arrayMax} onChange={(e) => setArrayMax(e.target.value)} />
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      if (!arrayPath) return;
                      onChangeTop(
                        "schema",
                        updateFieldSchemaByPath(dsl.schema, arrayPath, (s) => {
                          if (s.type !== "array") return;
                          s.min_items = arrayMin.trim() ? Number(arrayMin) : undefined;
                          s.max_items = arrayMax.trim() ? Number(arrayMax) : undefined;
                        }),
                      );
                    }}
                  >
                    Применить
                  </button>
                </div>
              </div>
            </div>

            <div className="card" style={{ marginTop: 12 }}>
              <h3>Сложные кросс-полевые правила</h3>
              <p style={{ fontSize: 14, color: "#64748b", lineHeight: 1.5, marginTop: 0 }}>
                Суммы, условная обязательность и «хотя бы N полей на корне». Пути можно подставить из текущей схемы или ввести вручную.
              </p>
              <CrossRulesEditor
                pathSuggestions={crossRulePathSuggestions}
                value={dsl.cross_rules ?? []}
                onChange={(next) => onChangeTop("cross_rules", next)}
              />
            </div>

            <div style={{ marginTop: 12, display: "flex", gap: 10 }}>
              <button type="button" className="btn-secondary" onClick={() => setStep(2)}>
                Назад к структуре
              </button>
              <button type="button" className="btn" onClick={() => setStep(4)}>
                Далее: сохранить и протестировать
              </button>
            </div>
          </div>
        </div>
          )}

          {step === 4 && (
        <div className="row">
          <div className="col">
            <div className="card">
              <h3>Сохранение правила</h3>
              <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
                <button type="button" className="btn" disabled={busy} onClick={onSave}>
                  Сохранить правило
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={busy}
                  onClick={() => {
                    setDsl(structuredClone(FERTILIZER_RULE_DSL));
                    setRuleId(null);
                    setSaveResult(null);
                    setValidateResult(null);
                    setStep(1);
                  }}
                >
                  Сбросить конструктор
                </button>
              </div>

              {saveResult && (
                <div style={{ marginTop: 12 }}>
                  Сохранено: <code>{saveResult.rule_id}</code> (v{saveResult.version})
                </div>
              )}
            </div>
          </div>

          <div className="col">
            <div className="card">
              <h3>Тестовая валидация JSON</h3>
              <textarea value={dataJson} onChange={(e) => setDataJson(e.target.value)} />
              <div style={{ display: "flex", gap: 12, marginTop: 12 }}>
                <button type="button" className="btn" disabled={busy || !ruleId} onClick={onValidate}>
                  Проверить
                </button>
              </div>
              {validateResult && (
                <div style={{ marginTop: 12 }}>
                  <pre>{JSON.stringify(validateResult, null, 2)}</pre>
                </div>
              )}
            </div>
          </div>
        </div>
          )}

          <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
            {step > 1 && (
              <button type="button" className="btn-secondary" onClick={() => setStep(step - 1)}>
                Назад
              </button>
            )}
            {step < 4 && (
              <button type="button" className="btn" onClick={() => setStep(step + 1)}>
                Вперед
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

