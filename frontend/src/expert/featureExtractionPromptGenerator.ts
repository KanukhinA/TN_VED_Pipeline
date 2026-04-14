/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Сборка запроса к LLM, который генерирует системный промпт для извлечения признаков
 * по данным справочника (numeric_characteristics_draft).
 */

import {
  generateNumericCharacteristicsSampleJson,
  normalizeNumericCharacteristicsDraft,
  parseNumericCharacteristicsDraft,
  PROCHEE_ROOT_KEY,
} from "./numericCharacteristicsDraft";

/** Мета-инструкция для модели-генератора промпта (промпт-инженер). */
export const FEATURE_EXTRACTION_PROMPT_GENERATOR_META = `Ты — промпт-инженер, специализирующийся на создании системных инструкций для LLM, которые извлекают структурированные числовые и количественные характеристики из неструктурированных текстов.

Твоя задача: на основе предоставленного JSON-шаблона (где значения заменены на null) и списка допустимых значений для ключевых полей, сгенерировать готовый системный промпт для модели-экстрактора.

ТРЕБОВАНИЯ К ГЕНЕРАЦИИ ПРОМПТА:
1. Сохрани архитектуру: Роль → Задача (пошагово) → Правила маппинга полей → Особые указания → Строгий JSON-вывод.
2. Автоматически определи тип извлекаемых характеристик из ключей JSON. Сформулируй задачу и правила именно под этот тип данных.
3. Интегрируй список допустимых значений в правила нормализации: укажи, что извлечённые значения должны приводиться к регистру/формату из списка, заменять синонимы на канонические обозначения и игнорировать несуществующие в списке варианты.
4. Включи в «Особые указания» универсальные правила обработки чисел:
   - Язык вывода: русский.
   - Диапазоны и погрешности → формат [min, max].
   - Логические операторы: «не менее» → [x, null], «не более» → [null, x].
   - Десятичный разделитель: точка.
   - Приоритет: конкретные числовые значения заменяют общие/оценочные формулировки.
   - Пропуск: если атрибут отсутствует в тексте — не выводи его в JSON.
   - Единицы измерения: укажи явно для каждого числового поля, кроме справочных/строковых.
5. В конце промпта приведи пример JSON строго в формате исходного шаблона, но с подставленными реалистичными значениями (числа, массивы, корректные null).
6. Стиль: императивный, без воды, готовый к production-использованию. Не добавляй пояснений, комментариев или обрамляющих фраз.

ВЫВОД: Верни ТОЛЬКО сгенерированный системный промпт.`;

export type PromptGeneratorCatalogError = { ok: false; message: string };

export type PromptGeneratorCatalogOk = {
  ok: true;
  /** Полный текст запроса к LLM-генератору промпта */
  generatorPrompt: string;
  /** Исходный JSON-шаблон из справочника (для редактирования в UI). */
  jsonTemplateText: string;
  /** Исходный список допустимых значений/правил из справочника (для редактирования в UI). */
  allowedValuesText: string;
  /** Кратко для отладки */
  summary: string;
};

export type PromptGeneratorCatalogResult = PromptGeneratorCatalogOk | PromptGeneratorCatalogError;
export type PromptGeneratorOverrides = {
  jsonTemplateText?: string;
  allowedValuesText?: string;
};

/**
 * Собирает промпт для LLM на основе загруженного DSL справочника.
 * Использует meta.numeric_characteristics_draft и при необходимости имя/ТН ВЭД.
 */
export function buildFeatureExtractionPromptGeneratorRequest(
  dsl: any,
  overrides?: PromptGeneratorOverrides,
): PromptGeneratorCatalogResult {
  if (!dsl || typeof dsl !== "object") {
    return { ok: false, message: "Нет данных справочника (DSL)." };
  }

  const draft = parseNumericCharacteristicsDraft(dsl?.meta?.numeric_characteristics_draft);
  if (!draft) {
    return {
      ok: false,
      message:
        "В справочнике нет черновика числовых характеристик (numeric_characteristics_draft). Задайте структуру в мастере каталога.",
    };
  }

  const normalized = normalizeNumericCharacteristicsDraft(draft);
  const jsonTemplate = generateNumericCharacteristicsSampleJson(normalized);
  if (!jsonTemplate || Object.keys(jsonTemplate).length === 0) {
    return {
      ok: false,
      message: "Не удалось построить JSON-шаблон из черновика. Задайте числовые характеристики, текстовые массивы или блок «прочее» в каталоге.",
    };
  }

  const catalogLines: string[] = [];
  const name = String(dsl?.meta?.name ?? "").trim();
  const tn = String(dsl?.meta?.tn_ved_group_code ?? "").trim();
  const modelId = String(dsl?.model_id ?? "").trim();
  if (name) catalogLines.push(`Название справочника: ${name}`);
  if (tn) catalogLines.push(`ТН ВЭД (группа): ${tn}`);
  if (modelId) catalogLines.push(`model_id: ${modelId}`);

  const allowedBlocks: string[] = [];

  for (const c of normalized.characteristics) {
    const k = c.characteristicKey.trim();
    const comp = c.componentColumnKey.trim();
    if (!k || !comp) continue;
    const allowed = c.allowedComponentValues;
    if (allowed?.length) {
      allowedBlocks.push(`Допустимые значения поля «${comp}» (массив «${k}»):`);
      allowedBlocks.push(allowed.join("\n"));
      allowedBlocks.push("");
    }
  }

  for (const t of normalized.textArrayFields ?? []) {
    const k = t.fieldKey.trim();
    if (!k) continue;
    const ex = t.exampleValues;
    if (ex?.length) {
      allowedBlocks.push(`Примеры допустимых значений поля «${k}» (массив «${k}»):`);
      allowedBlocks.push(ex.join("\n"));
      allowedBlocks.push("");
    }
  }

  if (normalized.procheeEnabled && jsonTemplate[PROCHEE_ROOT_KEY]) {
    allowedBlocks.push(
      `Блок «${PROCHEE_ROOT_KEY}»: структура строк задана в JSON-шаблоне; извлекай параметры и значения по смыслу текста.`,
    );
    allowedBlocks.push("");
  }

  const defaultJsonTemplateText = JSON.stringify(jsonTemplate, null, 2);
  const defaultAllowedValuesText = allowedBlocks.length ? allowedBlocks.join("\n").trimEnd() : "";
  const effectiveJsonTemplateText = String(overrides?.jsonTemplateText ?? defaultJsonTemplateText).trim();
  const effectiveAllowedValuesText = String(overrides?.allowedValuesText ?? defaultAllowedValuesText).trim();

  const generatorPrompt = [
    FEATURE_EXTRACTION_PROMPT_GENERATOR_META,
    "",
    "ВХОДНЫЕ ДАННЫЕ",
    "",
    catalogLines.length ? catalogLines.join("\n") + "\n" : "",
    "1. JSON-шаблон (структура из справочника; извлекаемые числа — null, справочные поля заполнены из перечней где заданы):",
    effectiveJsonTemplateText,
    "",
    effectiveAllowedValuesText,
  ]
    .filter((block, i, arr) => {
      if (block === "" && arr[i - 1] === "") return false;
      return true;
    })
    .join("\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();

  const summary = [
    name || "справочник",
    tn ? `ТН ВЭД ${tn}` : null,
    `${normalized.characteristics.length} характеристик`,
  ]
    .filter(Boolean)
    .join(" · ");

  return {
    ok: true,
    generatorPrompt,
    jsonTemplateText: defaultJsonTemplateText,
    allowedValuesText: defaultAllowedValuesText,
    summary,
  };
}
