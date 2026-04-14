/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Преобразует внутреннюю object/array-схему Rule DSL (properties как массив { name, schema })
 * в JSON Schema (draft-07), пригодную для описания нормализованного JSON-документа.
 */

function mapNumberConstraints(c: Record<string, any> | undefined): Record<string, unknown> {
  if (!c || typeof c !== "object") return {};
  const out: Record<string, unknown> = {};
  if (c.min != null) out.minimum = c.min;
  if (c.max != null) out.maximum = c.max;
  if (c.multiple_of != null) out.multipleOf = c.multiple_of;
  if (Array.isArray(c.enum) && c.enum.length) out.enum = c.enum;
  return out;
}

function mapStringConstraints(c: Record<string, any> | undefined): Record<string, unknown> {
  if (!c || typeof c !== "object") return {};
  const out: Record<string, unknown> = {};
  if (c.min_length != null) out.minLength = c.min_length;
  if (c.max_length != null) out.maxLength = c.max_length;
  if (c.pattern) out.pattern = c.pattern;
  if (Array.isArray(c.enum) && c.enum.length) out.enum = c.enum;
  return out;
}

/**
 * Рекурсивно конвертирует узел FieldSchema / ObjectFieldSchema из DSL в JSON Schema.
 */
export function dslFieldSchemaToJsonSchema(dsl: any): any {
  if (dsl == null || typeof dsl !== "object") return dsl;

  const t = dsl.type;
  if (t === "object") {
    const properties: Record<string, unknown> = {};
    const props = dsl.properties;
    if (Array.isArray(props)) {
      for (const p of props) {
        const name = p?.name;
        if (name != null && String(name).length) {
          properties[String(name)] = dslFieldSchemaToJsonSchema(p.schema);
        }
      }
    }
    const out: Record<string, unknown> = {
      type: "object",
      additionalProperties: dsl.additional_properties === true,
    };
    if (Array.isArray(dsl.required) && dsl.required.length > 0) {
      out.required = dsl.required.map(String);
    }
    if (Object.keys(properties).length > 0) {
      out.properties = properties;
    }
    return out;
  }

  if (t === "array") {
    const out: Record<string, unknown> = { type: "array" };
    if (dsl.min_items != null) out.minItems = dsl.min_items;
    if (dsl.max_items != null) out.maxItems = dsl.max_items;
    if (dsl.items != null) out.items = dslFieldSchemaToJsonSchema(dsl.items);
    return out;
  }

  if (t === "string") {
    return { type: "string", ...mapStringConstraints(dsl.constraints) };
  }

  if (t === "number") {
    return { type: "number", ...mapNumberConstraints(dsl.constraints) };
  }

  if (t === "integer") {
    return { type: "integer", ...mapNumberConstraints(dsl.constraints) };
  }

  if (t === "boolean") {
    return { type: "boolean" };
  }

  return dsl;
}

const DRAFT_07 = "http://json-schema.org/draft-07/schema#";

/** Оборачивает корневую схему документа в JSON Schema с $schema. */
export function documentRootToJsonSchemaString(rootDslSchema: any, pretty = true): string {
  const body = dslFieldSchemaToJsonSchema(rootDslSchema);
  const doc = { $schema: DRAFT_07, ...body };
  return JSON.stringify(doc, null, pretty ? 2 : 0);
}
