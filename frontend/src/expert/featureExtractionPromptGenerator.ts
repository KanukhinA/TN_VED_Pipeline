/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Сборка **одноразового** запроса к LLM-генератору: мета-инструкция (только из настроек генератора)
 * + данные справочника. Результат генерации пишется в «Промпт конфигурации» и дальше идёт в извлечение.
 * Мета-текст нигде в пайплайне извлечения не используется — только здесь и в POST /api/feature-extraction/generate-prompt.
 */

import {
  generateNumericCharacteristicsSampleJson,
  normalizeNumericCharacteristicsDraft,
  parseNumericCharacteristicsDraft,
  PROCHEE_ROOT_KEY,
} from "./numericCharacteristicsDraft";

export type PromptGeneratorCatalogError = { ok: false; message: string };

export type PromptGeneratorCatalogOk = {
  ok: true;
  /** Полный текст запроса к LLM-генератору промпта (мета + каталог). */
  generatorPrompt: string;
  jsonTemplateText: string;
  allowedValuesText: string;
  summary: string;
};

export type PromptGeneratorCatalogResult = PromptGeneratorCatalogOk | PromptGeneratorCatalogError;
export type PromptGeneratorOverrides = {
  jsonTemplateText?: string;
  allowedValuesText?: string;
  /** Обязателен: шаблон из GET /api/admin/feature-extraction-prompt-generator-meta («Генератор промптов»). */
  metaInstructionText: string;
};

/**
 * Собирает промпт для LLM на основе загруженного DSL справочника.
 * `metaInstructionText` должен быть загружен с сервера; встроенного резервного варианта нет.
 */
export function buildFeatureExtractionPromptGeneratorRequest(
  dsl: any,
  overrides: PromptGeneratorOverrides,
): PromptGeneratorCatalogResult {
  const metaInstructionText = String(overrides.metaInstructionText ?? "").trim();
  if (!metaInstructionText) {
    return {
      ok: false,
      message:
        "Базовый промпт генератора пуст. Задайте и сохраните его в разделе «Генератор промптов» (общие настройки).",
    };
  }

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
      message:
        "Не удалось построить JSON-шаблон из черновика. Задайте числовые характеристики, текстовые массивы или блок «прочее» в каталоге.",
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
    if (!k) continue;
    if (c.layout === "scalar") {
      allowedBlocks.push(`Числовое поле верхнего уровня документа (одно значение, не массив): ключ «${k}».`);
      allowedBlocks.push("");
      continue;
    }
    const comp = c.componentColumnKey.trim();
    if (!comp) continue;
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
  for (const t of normalized.textScalarFields ?? []) {
    const k = t.fieldKey.trim();
    if (!k) continue;
    const ex = t.exampleValues;
    if (ex?.length) {
      allowedBlocks.push(`Примеры допустимых значений поля «${k}» (одно текстовое значение верхнего уровня):`);
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
  const effectiveJsonTemplateText = String(overrides.jsonTemplateText ?? defaultJsonTemplateText).trim();
  const effectiveAllowedValuesText = String(overrides.allowedValuesText ?? defaultAllowedValuesText).trim();

  const generatorPrompt = [
    metaInstructionText,
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
