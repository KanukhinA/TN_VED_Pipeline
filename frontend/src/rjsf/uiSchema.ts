export const ruleDslUiSchema = {
  "ui:order": ["model_id", "meta", "schema", "cross_rules"],
  meta: { "ui:order": ["name", "description", "version_label"] },
  schema: { "ui:order": ["type", "properties", "required", "additional_properties"] },
  "ui:options": {
    // Уменьшаем визуальный шум
    label: false,
  },
} as const;

