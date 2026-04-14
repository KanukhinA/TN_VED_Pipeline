/* eslint-disable @typescript-eslint/no-explicit-any */
export const ruleDslMetaSchema: any = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "RuleDSL",
  type: "object",
  additionalProperties: false,
  required: ["model_id", "schema"],
  properties: {
    model_id: {
      type: "string",
      title: "model_id",
    },
    meta: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string", title: "name" },
        description: { type: "string", title: "description" },
        version_label: { type: "string", title: "version_label" },
        tn_ved_group_code: {
          type: "string",
          title: "tn_ved_group_code",
          description: "Код ТН ВЭД ЕАЭС: 2, 4, 6, 8 или 10 цифр; первые две — глава 01–97",
          pattern: "^([0-9]{2}|[0-9]{4}|[0-9]{6}|[0-9]{8}|[0-9]{10})$",
        },
        expert_draft: { type: "object", title: "expert_draft" },
        numeric_characteristics_draft: { type: "object", title: "numeric_characteristics_draft" },
      },
    },
    schema: { $ref: "#/definitions/ObjectFieldSchemaRoot" },
    cross_rules: {
      type: "array",
      title: "cross_rules",
      items: { $ref: "#/definitions/CrossRule" },
      default: [],
    },
  },
  definitions: {
    FieldSchema: {
      oneOf: [
        { $ref: "#/definitions/ObjectFieldSchema" },
        { $ref: "#/definitions/ArrayFieldSchema" },
        { $ref: "#/definitions/StringFieldSchema" },
        { $ref: "#/definitions/NumberFieldSchema" },
        { $ref: "#/definitions/IntegerFieldSchema" },
        { $ref: "#/definitions/BooleanFieldSchema" },
      ],
    },
    PropertyDef: {
      type: "object",
      additionalProperties: false,
      required: ["name", "schema"],
      properties: {
        name: { type: "string", minLength: 1 },
        schema: { $ref: "#/definitions/FieldSchema" },
      },
    },
    ObjectFieldSchemaRoot: { $ref: "#/definitions/ObjectFieldSchema" },
    ObjectFieldSchema: {
      type: "object",
      additionalProperties: false,
      required: ["type", "properties", "required", "additional_properties"],
      properties: {
        type: { const: "object", title: "type" },
        properties: {
          type: "array",
          title: "properties",
          items: { $ref: "#/definitions/PropertyDef" },
          default: [],
        },
        required: {
          type: "array",
          title: "required",
          items: { type: "string" },
          default: [],
        },
        additional_properties: {
          type: "boolean",
          title: "additional_properties",
          default: false,
        },
      },
    },
    ArrayFieldSchema: {
      type: "object",
      additionalProperties: false,
      required: ["type", "items"],
      properties: {
        type: { const: "array", title: "type" },
        min_items: { type: "integer", minimum: 0 },
        max_items: { type: "integer", minimum: 0 },
        items: { $ref: "#/definitions/FieldSchema" },
      },
    },
    StringConstraints: {
      type: "object",
      additionalProperties: false,
      properties: {
        min_length: { type: "integer", minimum: 0 },
        max_length: { type: "integer", minimum: 0 },
        pattern: { type: "string" },
        enum: { type: "array", items: { type: "string" } },
      },
    },
    StringFieldSchema: {
      type: "object",
      additionalProperties: false,
      required: ["type"],
      properties: {
        type: { const: "string", title: "type" },
        title: { type: "string" },
        constraints: { $ref: "#/definitions/StringConstraints" },
      },
    },
    NumberConstraints: {
      type: "object",
      additionalProperties: false,
      properties: {
        min: { type: "number" },
        max: { type: "number" },
        multiple_of: { type: "number" },
        enum: { type: "array", items: { type: "number" } },
      },
    },
    NumberFieldSchema: {
      type: "object",
      additionalProperties: false,
      required: ["type"],
      properties: {
        type: { const: "number", title: "type" },
        title: { type: "string" },
        constraints: { $ref: "#/definitions/NumberConstraints" },
      },
    },
    IntegerConstraints: {
      type: "object",
      additionalProperties: false,
      properties: {
        min: { type: "integer" },
        max: { type: "integer" },
        multiple_of: { type: "integer" },
        enum: { type: "array", items: { type: "integer" } },
      },
    },
    IntegerFieldSchema: {
      type: "object",
      additionalProperties: false,
      required: ["type"],
      properties: {
        type: { const: "integer", title: "type" },
        title: { type: "string" },
        constraints: { $ref: "#/definitions/IntegerConstraints" },
      },
    },
    BooleanFieldSchema: {
      type: "object",
      additionalProperties: false,
      required: ["type"],
      properties: {
        type: { const: "boolean", title: "type" },
        title: { type: "string" },
      },
    },

    CrossRule: {
      oneOf: [
        { $ref: "#/definitions/SumEqualsRule" },
        { $ref: "#/definitions/RequiredIfRule" },
        { $ref: "#/definitions/AtLeastOnePresentRule" },
      ],
    },
    SumEqualsRule: {
      type: "object",
      additionalProperties: false,
      required: ["template", "path", "expected", "tolerance"],
      properties: {
        template: { const: "sumEquals", title: "template" },
        path: { type: "string", minLength: 1 },
        expected: { type: "number" },
        tolerance: { type: "number" },
      },
    },
    AtLeastOnePresentRule: {
      type: "object",
      additionalProperties: false,
      required: ["template", "paths", "min_count"],
      properties: {
        template: { const: "atLeastOnePresent", title: "template" },
        paths: {
          type: "array",
          minItems: 1,
          items: { type: "string", minLength: 1 },
        },
        min_count: { type: "integer", minimum: 1, default: 1 },
      },
    },
    RequiredIfRule: {
      type: "object",
      additionalProperties: false,
      required: ["template", "if", "then"],
      properties: {
        template: { const: "requiredIf", title: "template" },
        if: {
          $ref: "#/definitions/ComparisonCond",
        },
        then: {
          type: "object",
          additionalProperties: false,
          required: ["required_paths"],
          properties: {
            required_paths: {
              type: "array",
              minItems: 1,
              items: { type: "string", minLength: 1 },
            },
          },
        },
      },
    },
    ComparisonCond: {
      type: "object",
      additionalProperties: false,
      required: ["path", "op"],
      properties: {
        path: { type: "string", minLength: 1 },
        op: {
          type: "string",
          enum: [
            "equals",
            "notEquals",
            "gt",
            "gte",
            "lt",
            "lte",
            "in",
            "exists",
            "notExists",
            "regex",
            "notRegex",
          ],
        },
        value: {
          // В MVP оставляем value тип `any`: RJSF это просто JSON.
          type: ["string", "number", "boolean", "array", "null"],
          title: "value",
        },
      },
    },
  },
};

