/* eslint-disable @typescript-eslint/no-explicit-any */

/** Строит фрагмент Rule DSL schema по одному экземпляру JSON (как в конструкторе). */
export function inferSchemaFromJsonValue(value: any): any {
  if (Array.isArray(value)) return { type: "array", items: inferSchemaFromJsonValue(value[0] ?? ""), min_items: 0 };
  if (value && typeof value === "object") {
    return {
      type: "object",
      properties: Object.entries(value).map(([name, v]) => ({ name, schema: inferSchemaFromJsonValue(v) })),
      required: Object.keys(value),
      additional_properties: false,
    };
  }
  if (typeof value === "number") return Number.isInteger(value) ? { type: "integer" } : { type: "number" };
  if (typeof value === "boolean") return { type: "boolean" };
  return { type: "string" };
}

export type SchemaNodeType = "object" | "array" | "string" | "number" | "integer" | "boolean";

export function collectSchemaNodes(schema: any, prefix = ""): Array<{ path: string; type: SchemaNodeType }> {
  if (!schema?.type) return [];
  const out: Array<{ path: string; type: SchemaNodeType }> = [];
  if (prefix) out.push({ path: prefix, type: schema.type });
  if (schema.type === "object")
    for (const p of schema.properties ?? []) out.push(...collectSchemaNodes(p.schema, prefix ? `${prefix}.${p.name}` : p.name));
  if (schema.type === "array") out.push(...collectSchemaNodes(schema.items, `${prefix}[]`));
  return out;
}
