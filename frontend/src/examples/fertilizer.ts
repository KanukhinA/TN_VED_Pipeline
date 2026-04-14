/* eslint-disable @typescript-eslint/no-explicit-any */

export const FERTILIZER_DECLARATION_EXAMPLE: any = {
  "массовая доля": [
    { "вещество": "p2o5", "массовая доля": 10.8 },
    { "вещество": "k2o", "массовая доля": 16.3 },
    { "вещество": "b", "массовая доля": 0.25 },
    { "вещество": "cao", "массовая доля": 20.4 },
    { "вещество": "mgo", "массовая доля": 2.0 },
  ],
  "прочее": [
    { "параметр": "масса нетто единицы", "масса": 25.0, "единица": "кг" },
    { "параметр": "количество поддонов", "количество": 1.0, "единица": "шт" },
    { "параметр": "стандарт", "значение": "ТУ 2183-003-35608560-2005" },
    { "параметр": "марка", "значение": "борофоска" },
  ],
};

export const FERTILIZER_DECLARATION_MASS_SUM = 49.75;

export const FERTILIZER_RULE_DSL: any = {
  model_id: "fertilizer_declaration",
  meta: {
    name: "Fertilizer rule (mass fractions)",
    description: "Проверка структуры и суммы массовых долей",
    version_label: "mvp-1",
  },
  schema: {
    type: "object",
    additional_properties: false,
    properties: [
      {
        name: "массовая доля",
        schema: {
          type: "array",
          min_items: 1,
          items: {
            type: "object",
            additional_properties: false,
            required: ["вещество", "массовая доля"],
            properties: [
              {
                name: "вещество",
                schema: {
                  type: "string",
                  constraints: { enum: ["p2o5", "k2o", "b", "cao", "mgo"] },
                },
              },
              {
                name: "массовая доля",
                schema: {
                  type: "number",
                  constraints: { min: 0.0, max: 100.0 },
                },
              },
            ],
          },
        },
      },
      {
        name: "прочее",
        schema: {
          type: "array",
          min_items: 0,
          items: {
            type: "object",
            additional_properties: false,
            required: ["параметр"],
            properties: [
              { name: "параметр", schema: { type: "string" } },
              { name: "масса", schema: { type: "number", constraints: { min: 0.0 } } },
              { name: "единица", schema: { type: "string" } },
              { name: "количество", schema: { type: "number", constraints: { min: 0.0 } } },
              { name: "значение", schema: { type: "string" } },
            ],
          },
        },
      },
    ],
    required: ["массовая доля", "прочее"],
  },
  cross_rules: [
    {
      template: "sumEquals",
      path: "массовая доля[*].массовая доля",
      expected: FERTILIZER_DECLARATION_MASS_SUM,
      tolerance: 0.0001,
    },
    {
      template: "atLeastOnePresent",
      paths: ["массовая доля", "прочее"],
      min_count: 2,
    },
  ],
};

