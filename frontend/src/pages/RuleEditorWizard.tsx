/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { useMemo, useState } from "react";
import { FERTILIZER_DECLARATION_EXAMPLE, FERTILIZER_RULE_DSL } from "../examples/fertilizer";
import {
  archiveRule,
  cloneRule,
  deleteRule,
  getRule,
  getTemplate,
  listRules,
  listTemplates,
  saveRule,
  unarchiveRule,
  validateRule,
} from "../api/client";
import CrossRulesEditor from "../ui/CrossRulesEditor";
import { buildPathSuggestionsFromRuleSchema } from "../ui/crossRulePathSuggestions";
import CatalogListSection from "../ui/CatalogListSection";
import { collectSchemaNodes, inferSchemaFromJsonValue } from "../catalog/schemaInfer";

export type RuleEditorWizardProps = {
  onBackToExpert?: () => void;
};

type SchemaType = "object" | "array" | "string" | "number" | "integer" | "boolean";

function collectNodes(schema: any, prefix = ""): Array<{ path: string; type: SchemaType }> {
  return collectSchemaNodes(schema, prefix);
}

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

function getSchemaAtPath(root: any, path: string): any | null {
  let current = root;
  for (const token of path.split(".")) {
    const isArray = token.endsWith("[]");
    const name = isArray ? token.slice(0, -2) : token;
    if (!current || current.type !== "object") return null;
    const prop = (current.properties ?? []).find((p: any) => p.name === name);
    if (!prop) return null;
    current = isArray ? prop.schema.items : prop.schema;
  }
  return current;
}

export default function RuleEditorWizard({ onBackToExpert }: RuleEditorWizardProps) {
  const [dsl, setDsl] = useState<any>(useMemo(() => structuredClone(FERTILIZER_RULE_DSL), []));
  const [activeTab, setActiveTab] = useState<"create" | "list">("create");
  const [step, setStep] = useState(1);
  const [sourceMode, setSourceMode] = useState<"template" | "upload" | "scratch">("template");
  const [sourceJson, setSourceJson] = useState(JSON.stringify(FERTILIZER_DECLARATION_EXAMPLE, null, 2));
  const [templates, setTemplates] = useState<any[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState("fertilizer");
  const [catalogs, setCatalogs] = useState<any[]>([]);
  const [catalogQuery, setCatalogQuery] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [ruleId, setRuleId] = useState<string | null>(null);
  const [dataJson, setDataJson] = useState(JSON.stringify(FERTILIZER_DECLARATION_EXAMPLE, null, 2));
  const [validateResult, setValidateResult] = useState<any>(null);
  const [showTechJson, setShowTechJson] = useState(false);
  const [busy, setBusy] = useState(false);

  const [parentPath, setParentPath] = useState("");
  const [fieldName, setFieldName] = useState("");
  const [fieldType, setFieldType] = useState<SchemaType>("string");
  const [editPath, setEditPath] = useState("");
  const [requiredFlag, setRequiredFlag] = useState(true);

  const [ruleType, setRuleType] = useState<"required" | "minmax" | "enum" | "regex" | "arrlen">("required");
  const [rulePath, setRulePath] = useState("");
  const [ruleV1, setRuleV1] = useState("");
  const [ruleV2, setRuleV2] = useState("");

  const nodes = useMemo(() => collectNodes(dsl.schema), [dsl.schema]);
  const crossRulePathSuggestions = useMemo(() => buildPathSuggestionsFromRuleSchema(dsl?.schema), [dsl?.schema]);
  const fieldNodes = useMemo(() => nodes.filter((n) => !n.path.endsWith("[]")), [nodes]);
  const objectContainers = useMemo(() => [{ path: "", label: "Корень" }, ...nodes.filter((n) => n.type === "object").map((n) => ({ path: n.path, label: n.path }))], [nodes]);
  const assignmentChips = useMemo(() => {
    const chips: string[] = [];
    for (const node of fieldNodes) {
      const s = getSchemaAtPath(dsl.schema, node.path);
      if (!s) continue;
      if (s.constraints?.min !== undefined || s.constraints?.max !== undefined) chips.push(`${node.path}: диапазон числа`);
      if (s.constraints?.enum?.length) chips.push(`${node.path}: перечень допустимых значений`);
      if (s.constraints?.pattern) chips.push(`${node.path}: маска текста`);
      if (s.min_items !== undefined || s.max_items !== undefined) chips.push(`${node.path}: размер массива`);
    }
    for (const cr of dsl.cross_rules ?? []) chips.push(`по полям документа: ${cr.template}`);
    return chips;
  }, [dsl, fieldNodes]);

  const refreshCatalogs = React.useCallback(async () => {
    try {
      setCatalogs(
        await listRules({
          q: catalogQuery.trim() || undefined,
          include_archived: includeArchived,
        }),
      );
    } catch {
      setCatalogs([]);
    }
  }, [catalogQuery, includeArchived]);

  React.useEffect(() => {
    (async () => {
      try {
        setTemplates(await listTemplates());
      } catch {
        setTemplates([]);
      }
    })();
  }, []);

  React.useEffect(() => {
    const t = window.setTimeout(() => {
      void refreshCatalogs();
    }, 200);
    return () => window.clearTimeout(t);
  }, [refreshCatalogs]);

  function top(key: string, value: any) {
    setDsl((prev: any) => ({ ...prev, [key]: value }));
  }

  function addField() {
    if (!fieldName.trim()) return;
    const newSchema = fieldType === "object" ? { type: "object", properties: [], required: [], additional_properties: false } : fieldType === "array" ? { type: "array", items: { type: "string" }, min_items: 0 } : { type: fieldType };
    if (!parentPath) {
      const next = structuredClone(dsl.schema);
      next.properties = [...(next.properties ?? []), { name: fieldName.trim(), schema: newSchema }];
      top("schema", next);
    } else {
      top("schema", setSchemaByPath(dsl.schema, parentPath, (s) => {
        if (s.type !== "object") return;
        s.properties = [...(s.properties ?? []), { name: fieldName.trim(), schema: newSchema }];
      }));
    }
    setFieldName("");
  }

  function applySimpleRule() {
    if (!rulePath) return;
    top("schema", setSchemaByPath(dsl.schema, rulePath, (s, parent) => {
      if (ruleType === "required" && parent?.type === "object") {
        const leaf = rulePath.split(".").at(-1)?.replace("[]", "") ?? "";
        const req = new Set(parent.required ?? []);
        if (requiredFlag) req.add(leaf); else req.delete(leaf);
        parent.required = Array.from(req);
      }
      if (ruleType === "minmax" && (s.type === "number" || s.type === "integer")) s.constraints = { ...(s.constraints ?? {}), min: ruleV1 ? Number(ruleV1) : undefined, max: ruleV2 ? Number(ruleV2) : undefined };
      if (ruleType === "enum" && (s.type === "string" || s.type === "number" || s.type === "integer")) {
        const arr = ruleV1.split(",").map((x) => x.trim()).filter(Boolean);
        s.constraints = { ...(s.constraints ?? {}), enum: s.type === "string" ? arr : arr.map((x) => Number(x)).filter((x) => Number.isFinite(x)) };
      }
      if (ruleType === "regex" && s.type === "string") s.constraints = { ...(s.constraints ?? {}), pattern: ruleV1 || undefined };
      if (ruleType === "arrlen" && s.type === "array") { s.min_items = ruleV1 ? Number(ruleV1) : undefined; s.max_items = ruleV2 ? Number(ruleV2) : undefined; }
    }));
  }

  async function onSave() {
    setBusy(true);
    try {
      const res = await saveRule(dsl, ruleId);
      setRuleId(res.rule_id);
      await refreshCatalogs();
    } finally { setBusy(false); }
  }

  async function onValidate(targetRuleId?: string) {
    const id = targetRuleId ?? ruleId;
    if (!id) return;
    setBusy(true);
    try {
      setValidateResult(await validateRule(id, JSON.parse(dataJson)));
    } catch (e: any) {
      setValidateResult({ ok: false, errors: [{ message: e?.message ?? String(e) }] });
    } finally { setBusy(false); }
  }

  async function applyTemplate() {
    const tpl = await getTemplate(selectedTemplate);
    setDsl(tpl.dsl);
    setSourceJson(JSON.stringify(tpl.example_data, null, 2));
    setDataJson(JSON.stringify(tpl.example_data, null, 2));
    setStep(2);
  }

  async function openCatalogAtStep(id: string, stepNum: number) {
    const full = await getRule(id);
    setDsl(full.dsl);
    setRuleId(full.rule_id);
    setActiveTab("create");
    setStep(stepNum);
  }

  async function openCatalog(id: string) {
    await openCatalogAtStep(id, 3);
  }

  async function openCatalogToValidate(id: string) {
    const full = await getRule(id);
    setDsl(full.dsl);
    setRuleId(full.rule_id);
    setActiveTab("create");
    setStep(4);
  }

  async function cloneCatalog(id: string) {
    const cloned = await cloneRule(id);
    setDsl(cloned.dsl);
    setRuleId(cloned.rule_id);
    await refreshCatalogs();
    setActiveTab("create");
    setStep(3);
  }

  async function onArchiveCatalog(id: string) {
    if (!window.confirm("Отправить справочник в архив? Он исчезнет из основного перечня, его можно вернуть через «Показать архивные».")) return;
    setBusy(true);
    try {
      await archiveRule(id);
      if (ruleId === id) setRuleId(null);
      await refreshCatalogs();
    } catch (e: any) {
      window.alert(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onUnarchiveCatalog(id: string) {
    setBusy(true);
    try {
      await unarchiveRule(id);
      await refreshCatalogs();
    } catch (e: any) {
      window.alert(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onDeleteCatalog(id: string) {
    if (!window.confirm("Удалить справочник безвозвратно вместе со всеми версиями?")) return;
    setBusy(true);
    try {
      await deleteRule(id);
      if (ruleId === id) setRuleId(null);
      await refreshCatalogs();
    } catch (e: any) {
      window.alert(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="container">
      <h1>Конструктор справочников</h1>
      {onBackToExpert ? (
        <p style={{ marginBottom: 12 }}>
          <button type="button" className="btn-secondary" onClick={onBackToExpert}>
            Вернуться к мастеру товароведа
          </button>
        </p>
      ) : null}
      <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
        <button type="button" className={activeTab === "create" ? "btn" : "btn-secondary"} onClick={() => setActiveTab("create")}>Создать справочник</button>
        <button type="button" className={activeTab === "list" ? "btn" : "btn-secondary"} onClick={() => setActiveTab("list")}>Справочники</button>
      </div>

      <CatalogListSection
        catalogs={catalogs}
        catalogQuery={catalogQuery}
        onCatalogQueryChange={setCatalogQuery}
        includeArchived={includeArchived}
        onIncludeArchivedChange={setIncludeArchived}
        busy={busy}
        onOpenPrimary={(id) => void openCatalog(id)}
        onOpenValidate={(id) => void openCatalogToValidate(id)}
        onClone={(id) => void cloneCatalog(id)}
        onQuickValidate={(id) => void onValidate(id)}
        onArchive={(id) => void onArchiveCatalog(id)}
        onUnarchive={(id) => void onUnarchiveCatalog(id)}
        onDelete={(id) => void onDeleteCatalog(id)}
      />

      {activeTab === "create" && (
        <>
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>{[1, 2, 3, 4].map((n) => <button key={n} className={step === n ? "btn" : "btn-secondary"} onClick={() => setStep(n)}>{n}</button>)}</div>

          {step === 1 && (
            <div className="card">
              <label><input type="radio" checked={sourceMode === "template"} onChange={() => setSourceMode("template")} /> Шаблон</label>{" "}
              <label><input type="radio" checked={sourceMode === "upload"} onChange={() => setSourceMode("upload")} /> JSON</label>{" "}
              <label><input type="radio" checked={sourceMode === "scratch"} onChange={() => setSourceMode("scratch")} /> С нуля</label>
              {sourceMode === "template" && <div style={{ marginTop: 8 }}><select value={selectedTemplate} onChange={(e) => setSelectedTemplate(e.target.value)}>{templates.map((t) => <option key={t.template_id} value={t.template_id}>{t.title}</option>)}</select><button className="btn" style={{ marginLeft: 8 }} onClick={applyTemplate}>Применить шаблон</button></div>}
              {sourceMode === "upload" && <div style={{ marginTop: 8 }}><textarea value={sourceJson} onChange={(e) => setSourceJson(e.target.value)} /><button className="btn" onClick={() => { const parsed = JSON.parse(sourceJson); top("schema", inferSchemaFromJsonValue(parsed)); setDataJson(JSON.stringify(parsed, null, 2)); setStep(2); }}>Построить структуру</button></div>}
              {sourceMode === "scratch" && <div style={{ marginTop: 8 }}><button className="btn" onClick={() => { top("schema", { type: "object", properties: [], required: [], additional_properties: false }); setStep(2); }}>Создать пустую структуру</button></div>}
            </div>
          )}

          {step === 2 && (
            <div className="row">
              <div className="col"><div className="card"><h3>Дерево структуры</h3>{nodes.map((n) => <div key={n.path}><code>{n.path}</code>: {n.type}</div>)}</div></div>
              <div className="col"><div className="card"><h3>Добавить поле</h3><select value={parentPath} onChange={(e) => setParentPath(e.target.value)}>{objectContainers.map((o) => <option key={o.path} value={o.path}>{o.label}</option>)}</select><input placeholder="Имя поля" value={fieldName} onChange={(e) => setFieldName(e.target.value)} /><select value={fieldType} onChange={(e) => setFieldType(e.target.value as SchemaType)}><option value="string">строка</option><option value="number">число</option><option value="integer">целое</option><option value="boolean">логическое</option><option value="object">объект</option><option value="array">массив</option></select><button className="btn" onClick={addField}>Добавить</button><h3 style={{ marginTop: 12 }}>Изменить обязательность</h3><select value={editPath} onChange={(e) => setEditPath(e.target.value)}><option value="">Выберите поле</option>{fieldNodes.map((n) => <option key={n.path} value={n.path}>{n.path}</option>)}</select><label><input type="checkbox" checked={requiredFlag} onChange={(e) => setRequiredFlag(e.target.checked)} /> Обязательное</label><button className="btn-secondary" onClick={() => { if (!editPath) return; top("schema", setSchemaByPath(dsl.schema, editPath, (_s, parent) => { if (parent?.type !== "object") return; const leaf = editPath.split(".").at(-1)?.replace("[]", "") ?? ""; const req = new Set(parent.required ?? []); if (requiredFlag) req.add(leaf); else req.delete(leaf); parent.required = Array.from(req); })); }}>Применить</button></div></div>
            </div>
          )}

          {step === 3 && (
            <div className="row">
              <div className="col"><div className="card"><h3>Назначения по полям</h3><select value={ruleType} onChange={(e) => setRuleType(e.target.value as any)}><option value="required">Обязательность</option><option value="minmax">Диапазон числа</option><option value="enum">Перечень допустимых значений</option><option value="regex">Маска текста</option><option value="arrlen">Размер массива</option></select><select value={rulePath} onChange={(e) => setRulePath(e.target.value)}><option value="">Выберите поле</option>{fieldNodes.map((n) => <option key={n.path} value={n.path}>{n.path}</option>)}</select>{ruleType === "required" ? <label><input type="checkbox" checked={requiredFlag} onChange={(e) => setRequiredFlag(e.target.checked)} /> Обязательное</label> : <div style={{ display: "flex", gap: 8 }}><input placeholder="значение 1" value={ruleV1} onChange={(e) => setRuleV1(e.target.value)} /><input placeholder="значение 2" value={ruleV2} onChange={(e) => setRuleV2(e.target.value)} /></div>}<button className="btn" onClick={applySimpleRule}>Применить</button><div style={{ marginTop: 10 }}>{assignmentChips.length === 0 ? <div>Назначений пока нет</div> : assignmentChips.map((c, i) => <span key={`${i}-${c}`} style={{ display: "inline-block", border: "1px solid #cbd5e1", borderRadius: 999, padding: "3px 8px", marginRight: 6, marginBottom: 6 }}>{c}</span>)}</div></div></div>
              <div className="col"><div className="card"><h3>Правила по полям документа</h3><CrossRulesEditor pathSuggestions={crossRulePathSuggestions} value={dsl.cross_rules ?? []} onChange={(next) => top("cross_rules", next)} /></div></div>
            </div>
          )}

          {step === 4 && (
            <div className="row">
              <div className="col"><div className="card"><button className="btn" disabled={busy} onClick={onSave}>Сохранить справочник</button></div></div>
              <div className="col"><div className="card"><textarea value={dataJson} onChange={(e) => setDataJson(e.target.value)} /><button className="btn" disabled={busy || !ruleId} onClick={() => onValidate()}>Проверить JSON</button>{validateResult && <pre>{JSON.stringify(validateResult, null, 2)}</pre>}</div></div>
              <div className="col"><div className="card"><label><input type="checkbox" checked={showTechJson} onChange={(e) => setShowTechJson(e.target.checked)} /> Показать машинное описание правил (для переноса в другие системы)</label>{showTechJson && <pre style={{ maxHeight: 280, overflow: "auto" }}>{JSON.stringify(dsl, null, 2)}</pre>}</div></div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

