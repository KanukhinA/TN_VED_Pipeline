/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { useEffect, useMemo, useState } from "react";
import { FERTILIZER_DECLARATION_EXAMPLE, FERTILIZER_RULE_DSL } from "../examples/fertilizer";
import { getTemplate, listTemplates } from "../api/client";
import { collectSchemaNodes, inferSchemaFromJsonValue, type SchemaNodeType } from "../catalog/schemaInfer";

function setSchemaByPath(root: any, path: string, updater: (schema: any, parent?: any) => void): any {
  const next = structuredClone(root);
  const tokens = path.split(".");
  let current = next;
  let parent: any = null;
  for (const token of tokens) {
    const isArray = token.endsWith("[]");
    const name = isArray ? token.slice(0, -2) : token;
    if (current.type !== "object") return root;
    const prop = (current.properties ?? []).find((p: any) => p.name === name);
    if (!prop) return root;
    parent = current;
    current = isArray ? prop.schema.items : prop.schema;
  }
  updater(current, parent);
  return next;
}

type Props = {
  dsl: any;
  setDsl: React.Dispatch<React.SetStateAction<any>>;
};

/**
 * Шаги 1–2 конструктора: источник схемы и дерево полей (встраивается в единый мастер справочника).
 */
export default function SchemaStructurePanel({ dsl, setDsl }: Props) {
  const [sourceMode, setSourceMode] = useState<"template" | "upload" | "scratch">("template");
  const [sourceJson, setSourceJson] = useState(JSON.stringify(FERTILIZER_DECLARATION_EXAMPLE, null, 2));
  const [templates, setTemplates] = useState<any[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState("fertilizer");
  const [subStep, setSubStep] = useState<1 | 2>(1);

  const [parentPath, setParentPath] = useState("");
  const [fieldName, setFieldName] = useState("");
  const [fieldType, setFieldType] = useState<SchemaNodeType>("string");
  const [editPath, setEditPath] = useState("");
  const [requiredFlag, setRequiredFlag] = useState(true);

  const nodes = useMemo(() => collectSchemaNodes(dsl.schema), [dsl.schema]);
  const fieldNodes = useMemo(() => nodes.filter((n) => !n.path.endsWith("[]")), [nodes]);
  const objectContainers = useMemo(
    () => [{ path: "", label: "Корень" }, ...nodes.filter((n) => n.type === "object").map((n) => ({ path: n.path, label: n.path }))],
    [nodes],
  );

  useEffect(() => {
    void (async () => {
      try {
        setTemplates(await listTemplates());
      } catch {
        setTemplates([]);
      }
    })();
  }, []);

  function top(key: string, value: any) {
    setDsl((prev: any) => ({ ...prev, [key]: value }));
  }

  function addField() {
    if (!fieldName.trim()) return;
    const newSchema =
      fieldType === "object"
        ? { type: "object", properties: [], required: [], additional_properties: false }
        : fieldType === "array"
          ? { type: "array", items: { type: "string" }, min_items: 0 }
          : { type: fieldType };
    if (!parentPath) {
      const next = structuredClone(dsl.schema);
      next.properties = [...(next.properties ?? []), { name: fieldName.trim(), schema: newSchema }];
      top("schema", next);
    } else {
      top(
        "schema",
        setSchemaByPath(dsl.schema, parentPath, (s) => {
          if (s.type !== "object") return;
          s.properties = [...(s.properties ?? []), { name: fieldName.trim(), schema: newSchema }];
        }),
      );
    }
    setFieldName("");
  }

  async function applyTemplate() {
    const tpl = await getTemplate(selectedTemplate);
    setDsl(tpl.dsl);
    setSourceJson(JSON.stringify(tpl.example_data, null, 2));
    setSubStep(2);
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "center" }}>
        <button type="button" className={subStep === 1 ? "btn" : "btn-secondary"} onClick={() => setSubStep(1)}>
          1. Источник структуры
        </button>
        <button type="button" className={subStep === 2 ? "btn" : "btn-secondary"} onClick={() => setSubStep(2)}>
          2. Поля и обязательность
        </button>
      </div>

      {subStep === 1 && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Как задать структуру</h3>
          <label style={{ marginRight: 12 }}>
            <input type="radio" checked={sourceMode === "template"} onChange={() => setSourceMode("template")} /> Шаблон
          </label>
          <label style={{ marginRight: 12 }}>
            <input type="radio" checked={sourceMode === "upload"} onChange={() => setSourceMode("upload")} /> Пример JSON
          </label>
          <label>
            <input type="radio" checked={sourceMode === "scratch"} onChange={() => setSourceMode("scratch")} /> С нуля
          </label>
          {sourceMode === "template" && (
            <div style={{ marginTop: 12 }}>
              <select value={selectedTemplate} onChange={(e) => setSelectedTemplate(e.target.value)}>
                {templates.map((t) => (
                  <option key={t.template_id} value={t.template_id}>
                    {t.title}
                  </option>
                ))}
              </select>
              <button type="button" className="btn" style={{ marginLeft: 8 }} onClick={() => void applyTemplate()}>
                Применить шаблон
              </button>
            </div>
          )}
          {sourceMode === "upload" && (
            <div style={{ marginTop: 12 }}>
              <p style={{ color: "#475569", fontSize: 14 }}>
                Вставьте один типичный JSON документа: по нему будет построена черновая схема полей. Потом вы сможете уточнить типы и
                обязательность на следующем подшаге.
              </p>
              <textarea
                className="fe-textarea-code"
                style={{ width: "100%", minHeight: 160, fontSize: 12, padding: 8 }}
                value={sourceJson}
                onChange={(e) => setSourceJson(e.target.value)}
              />
              <button
                type="button"
                className="btn"
                style={{ marginTop: 8 }}
                onClick={() => {
                  try {
                    const parsed = JSON.parse(sourceJson);
                    setDsl((prev: any) => ({
                      ...prev,
                      schema: inferSchemaFromJsonValue(parsed),
                      model_id: prev.model_id || "imported_schema",
                    }));
                    setSubStep(2);
                  } catch (e: any) {
                    window.alert(e?.message ?? "Некорректный JSON");
                  }
                }}
              >
                Построить структуру
              </button>
            </div>
          )}
          {sourceMode === "scratch" && (
            <div style={{ marginTop: 12 }}>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setDsl((prev: any) => ({
                    ...prev,
                    schema: { type: "object", properties: [], required: [], additional_properties: false },
                  }));
                  setSubStep(2);
                }}
              >
                Создать пустую структуру
              </button>
            </div>
          )}
        </div>
      )}

      {subStep === 2 && (
        <div className="row">
          <div className="col">
            <div className="card">
              <h3 style={{ marginTop: 0 }}>Дерево структуры</h3>
              {nodes.map((n) => (
                <div key={n.path}>
                  <code>{n.path || "«корень»"}</code>: {n.type}
                </div>
              ))}
            </div>
          </div>
          <div className="col">
            <div className="card">
              <h3 style={{ marginTop: 0 }}>Добавить поле</h3>
              <select value={parentPath} onChange={(e) => setParentPath(e.target.value)} style={{ marginBottom: 8, display: "block" }}>
                {objectContainers.map((o) => (
                  <option key={o.path || "root"} value={o.path}>
                    {o.label}
                  </option>
                ))}
              </select>
              <input
                placeholder="Имя поля"
                value={fieldName}
                onChange={(e) => setFieldName(e.target.value)}
                style={{ marginRight: 8, padding: 6 }}
              />
              <select value={fieldType} onChange={(e) => setFieldType(e.target.value as SchemaNodeType)} style={{ marginRight: 8 }}>
                <option value="string">строка</option>
                <option value="number">число</option>
                <option value="integer">целое</option>
                <option value="boolean">логическое</option>
                <option value="object">объект</option>
                <option value="array">массив</option>
              </select>
              <button type="button" className="btn" onClick={addField}>
                Добавить
              </button>
              <h3 style={{ marginTop: 16 }}>Изменить обязательность</h3>
              <select value={editPath} onChange={(e) => setEditPath(e.target.value)} style={{ marginBottom: 8, display: "block" }}>
                <option value="">Выберите поле</option>
                {fieldNodes.map((n) => (
                  <option key={n.path} value={n.path}>
                    {n.path}
                  </option>
                ))}
              </select>
              <label style={{ display: "block", marginBottom: 8 }}>
                <input type="checkbox" checked={requiredFlag} onChange={(e) => setRequiredFlag(e.target.checked)} /> Обязательное
              </label>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  if (!editPath) return;
                  top(
                    "schema",
                    setSchemaByPath(dsl.schema, editPath, (_s, parent) => {
                      if (parent?.type !== "object") return;
                      const leaf = editPath.split(".").at(-1)?.replace("[]", "") ?? "";
                      const req = new Set(parent.required ?? []);
                      if (requiredFlag) req.add(leaf);
                      else req.delete(leaf);
                      parent.required = Array.from(req);
                    }),
                  );
                }}
              >
                Применить
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function defaultBuilderDsl(): any {
  return structuredClone(FERTILIZER_RULE_DSL);
}
