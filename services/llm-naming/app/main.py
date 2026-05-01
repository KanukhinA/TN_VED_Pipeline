from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI
from fastapi import HTTPException
from pydantic import BaseModel, Field

from app.ollama_client import OLLAMA_BASE_URL, ollama_generate_simple, ollama_list_models
from shared.llm_runtime.config import is_vllm

app = FastAPI(title="LLM naming", version="0.3.0")

OLLAMA_MODEL = (os.getenv("OLLAMA_MODEL") or "").strip()
CLASS_NAMING_PROMPT_PATH = Path(os.getenv("CLASS_NAMING_PROMPT_PATH", "/app/config/class_naming_prompt.txt"))
CLASS_NAMING_GENERATION_CONFIG_PATH = Path(
    os.getenv("CLASS_NAMING_GENERATION_CONFIG_PATH", "/app/config/class_naming_generation.json")
)
DEFAULT_CLASS_NAMING_MAX_NEW_TOKENS = 24

DEFAULT_CLASS_NAMING_PROMPT_TEMPLATE = (
    "Ты помогаешь завести имя нового класса товара в таможенном справочнике.\n"
    "Ниже — описание товара, для которого детерминированная классификация не выбрала класс "
    "(или сработала ветка низкой семантической схожести).\n"
    "Учти код ТН ВЭД и не повторяй уже существующие идентификаторы классов.\n"
    "Важно: предлагай не код ТН ВЭД и не цифровой шифр, а смысловое имя класса по аналогии с существующими классами.\n\n"
    "Расшифровка кода ТН ВЭД: {tnved_decoded}\n\n"
    "Уже существующие классы по этому справочнику:\n"
    "{catalog_block}\n\n"
    "Описание товара неизвестного класса:\n"
    "{description}\n\n"
    "Ответ: одна строка — краткое имя класса в стиле справочника: 2-5 слов через '_' (до 40 символов), "
    "допустимы буквы/цифры/подчеркивание.\n"
    "Запрещено: чисто цифровой ответ, код ТН ВЭД, шаблоны вроде 3102500000_0001.\n"
    "Без кавычек, без пояснений и без markdown."
)

TN_VED_GROUP_TITLES: tuple[str, ...] = (
    "Живые животные",
    "Мясо и пищевые мясные субпродукты",
    "Рыба и ракообразные, моллюски",
    "Молоко и молочные продукты; яйца; мёд",
    "Прочие продукты животного происхождения",
    "Живые деревья и растения; луковицы и т.п.",
    "Овощи и некоторые съедобные корнеплоды",
    "Съедобные фрукты и орехи; цитрусовые",
    "Кофе, чай, пряности",
    "Зерновые культуры",
    "Продукция мукомольной промышленности",
    "Семена и плоды масличные; зерна и семена",
    "Смолы, экссудаты; прочие растительные продукты",
    "Материалы растительного происхождения для плетения",
    "Жиры и масла животного или растительного происхождения",
    "Готовые пищевые продукты из мяса, рыбы",
    "Сахар и кондитерские изделия из сахара",
    "Какао и готовые изделия из какао",
    "Готовые продукты из зерна, мучные смеси",
    "Готовые продукты из овощей, фруктов",
    "Разные съедобные готовые продукты",
    "Напитки, спирты и уксус",
    "Остатки пищевой промышленности; готовые корма",
    "Табак и промышленные заменители табака",
    "Соль; серы; земли и камень; штукатурки, известь",
    "Руды, шлак и зола",
    "Топливо минеральное; нефть и продукты перегонки",
    "Неорганическая химия; соединения драгметаллов",
    "Органическая химия",
    "Фармацевтическая продукция",
    "Удобрения",
    "Экстракты дубильные и красильные; пигменты, краски",
    "Эфирные масла и косметика; мыло",
    "Мыло, моющие средства, воски",
    "Альбуминоиды; клеи; ферменты",
    "Взрывчатые вещества; пиротехника; спички",
    "Киноплёнка и фототовары",
    "Разные химические продукты",
    "Пластмассы и изделия из них; резина",
    "Кожа сырья и выделанная; меховые шкурки",
    "Изделия из кожи; дорожные принадлежности",
    "Меха и изделия из них",
    "Древесина и изделия; древесный уголь",
    "Пробка и изделия из пробки",
    "Изделия из соломы и материалов для плетения",
    "Древесная масса (пульпа); отходы и лом бумаги",
    "Бумага и картон",
    "Печатные книги, газеты, графика",
    "Шёлк",
    "Шерсть и пух тонкий; пряжа и ткани",
    "Хлопок",
    "Прочие растительные текстильные волокна; бумажная пряжа",
    "Химические нити; полотна из синтетики",
    "Химические волокна короткие (степл)",
    "Вата, войлок, нетканые материалы; шнуры",
    "Ковры и прочие текстильные покрытия",
    "Специальные ткани; кружево; вышивка",
    "Пропитанные текстильные материалы",
    "Трикотажные полотна машинного вязания",
    "Трикотажные предметы одежды",
    "Предметы одежды не трикотажные",
    "Прочие готовые текстильные изделия",
    "Обувь, гетры и аналоги",
    "Головные уборы и их части",
    "Зонты, трости, хлысты",
    "Перья и пух; искусственные цветы",
    "Камень, гипс, цемент, асбест, слюда",
    "Керамические изделия",
    "Стекло и изделия из стекла",
    "Жемчуг, драгоценные камни, бижутерия",
    "Чёрные металлы",
    "Изделия из чёрных металлов",
    "Медь и изделия из меди",
    "Никель и изделия из никеля",
    "Алюминий и изделия из алюминия",
    "(Резерв)",
    "Свинец и изделия из свинца",
    "Цинк и изделия из цинка",
    "Олово и изделия из олова",
    "Прочие недрагоценные металлы",
    "Инструменты, ножевые изделия, ложки и вилки",
    "Прочие изделия из недрагоценных металлов",
    "Реакторы, котлы; машины и механизмы",
    "Электрические машины и аппаратура",
    "Железнодорожный подвижной состав",
    "Средства наземного транспорта, кроме ж/д",
    "Летательные аппараты, космос",
    "Суда и плавучие средства",
    "Оптика, фото, кино, медицинские приборы",
    "Часы всех видов",
    "Музыкальные инструменты",
    "Оружие и боеприпасы",
    "Мебель; постельные принадлежности; светильники",
    "Игрушки, спорт, приборы для настольных игр",
    "Разные промышленные товары",
    "Произведения искусства, предметы коллекционирования и антиквариат",
)


class ClassLabelEntry(BaseModel):
    class_id: str = ""
    title: str = ""


class SuggestRequest(BaseModel):
    """Соответствует ветке Mod6 README: описание, ТН ВЭД, перечень классов справочника."""

    description: str
    tnved_code: str | None = None
    existing_classes: list[str] = Field(default_factory=list)
    existing_class_labels: list[ClassLabelEntry] = Field(default_factory=list)


class PromptTemplateUpdateRequest(BaseModel):
    template: str = ""


class ClassNamingGenerationConfigUpdateRequest(BaseModel):
    max_new_tokens: int = Field(DEFAULT_CLASS_NAMING_MAX_NEW_TOKENS, ge=8, le=256)


def _load_prompt_template() -> str:
    try:
        txt = CLASS_NAMING_PROMPT_PATH.read_text(encoding="utf-8")
        if txt.strip():
            return txt
    except Exception:
        pass
    return DEFAULT_CLASS_NAMING_PROMPT_TEMPLATE


def _save_prompt_template(template: str) -> str:
    normalized = (template or "").strip()
    if not normalized:
        raise ValueError("Шаблон промпта не может быть пустым.")
    CLASS_NAMING_PROMPT_PATH.parent.mkdir(parents=True, exist_ok=True)
    CLASS_NAMING_PROMPT_PATH.write_text(normalized + "\n", encoding="utf-8")
    return normalized


def _load_generation_config() -> dict[str, int]:
    try:
        txt = CLASS_NAMING_GENERATION_CONFIG_PATH.read_text(encoding="utf-8")
        if txt.strip():
            raw = txt
            import json

            data = json.loads(raw)
            v = int(data.get("max_new_tokens", DEFAULT_CLASS_NAMING_MAX_NEW_TOKENS))
            v = max(8, min(v, 256))
            return {"max_new_tokens": v}
    except Exception:
        pass
    return {"max_new_tokens": DEFAULT_CLASS_NAMING_MAX_NEW_TOKENS}


def _save_generation_config(max_new_tokens: int) -> dict[str, int]:
    v = max(8, min(int(max_new_tokens), 256))
    import json

    payload = {"max_new_tokens": v}
    CLASS_NAMING_GENERATION_CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    CLASS_NAMING_GENERATION_CONFIG_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return payload


def _normalize_class_token(text: str) -> str:
    line = (text or "").strip().split("\n")[0].strip()
    line = re.sub(r"^[\"']|[\"']$", "", line)
    token = "".join(c if (c.isalnum() or c in "_-") else "_" for c in line[:48])
    token = re.sub(r"_+", "_", token).strip("_")
    return token or "CLASS"


def _looks_like_classifier_code(token: str, tnved_code: str | None) -> bool:
    t = (token or "").strip().lower()
    if not t:
        return True
    if re.fullmatch(r"\d{6,14}(_\d{1,6})?", t):
        return True
    if re.fullmatch(r"[0-9_]+", t):
        return True
    tn_digits = re.sub(r"\D", "", str(tnved_code or ""))
    tok_digits = re.sub(r"\D", "", t)
    if tn_digits and tok_digits and tok_digits.startswith(tn_digits[: min(10, len(tn_digits))]):
        return True
    return False


def _fallback_class_name(description: str, existing: list[str]) -> str:
    words = [w.lower() for w in re.findall(r"[A-Za-zА-Яа-я0-9]+", description or "")]
    meaningful = [w for w in words if len(w) >= 3 and not w.isdigit()]
    base = "class_" + "_".join(meaningful[:3]) if meaningful else "class_new_product"
    token = _normalize_class_token(base)[:40] or "class_new_product"
    existing_norm = {str(x).strip().lower() for x in existing if str(x).strip()}
    if token.lower() not in existing_norm:
        return token
    for i in range(2, 100):
        cand = _normalize_class_token(f"{token}_{i}")[:40]
        if cand.lower() not in existing_norm:
            return cand
    return "class_new_product"


def _ollama_running_models(timeout: float = 3.0) -> list[str]:
    """Returns currently loaded Ollama models from /api/ps."""
    if is_vllm():
        return []
    url = f"{OLLAMA_BASE_URL}/api/ps"
    with httpx.Client(timeout=timeout) as client:
        r = client.get(url)
        r.raise_for_status()
        data = r.json()
    models = data.get("models")
    if not isinstance(models, list):
        return []
    out: list[str] = []
    for row in models:
        if not isinstance(row, dict):
            continue
        name = str(row.get("name") or "").strip()
        if name:
            out.append(name)
    return out


def _candidate_models() -> tuple[list[str], list[str]]:
    """
    Build model priority list:
    1) currently running model(s) in Ollama
    2) all available models from backend
    3) explicit OLLAMA_MODEL from env (if set)
    """
    candidates: list[str] = []
    errors: list[str] = []

    try:
        for name in _ollama_running_models():
            if name and name not in candidates:
                candidates.append(name)
    except Exception as exc:
        errors.append(f"running_model_discovery_failed: {exc}")

    try:
        for name in ollama_list_models():
            if name and name not in candidates:
                candidates.append(name)
    except Exception as exc:
        errors.append(f"model_discovery_failed: {exc}")

    if OLLAMA_MODEL and OLLAMA_MODEL not in candidates:
        candidates.append(OLLAMA_MODEL)

    return candidates, errors


def _format_existing_catalog(labels: list[ClassLabelEntry], raw_ids: list[str]) -> str:
    lines: list[str] = []
    if labels:
        for e in labels:
            cid = (e.class_id or "").strip()
            if not cid:
                continue
            t = (e.title or "").strip()
            lines.append(f"- {cid}" + (f" — {t}" if t else ""))
    elif raw_ids:
        for x in raw_ids:
            s = str(x).strip()
            if s:
                lines.append(f"- {s}")
    return "\n".join(lines) if lines else "(в справочнике пока нет классов — придумайте новый идентификатор)"


def _decode_tnved(tnved_code: str | None) -> str:
    raw = (tnved_code or "").strip()
    if not raw:
        return "Код не указан."
    digits = re.sub(r"\D", "", raw)
    if len(digits) < 2:
        return f"Код: {raw}. Недостаточно цифр для определения группы ТН ВЭД."
    group = digits[:2]
    try:
        idx = int(group) - 1
    except ValueError:
        return f"Код: {raw}. Группа ТН ВЭД не распознана."
    if idx < 0 or idx >= len(TN_VED_GROUP_TITLES):
        return f"Код: {raw}. Группа ТН ВЭД {group} вне диапазона 01-97."
    return f"Группа {group} — {TN_VED_GROUP_TITLES[idx]}. Исходный код: {raw}."


def _build_prompt(payload: SuggestRequest) -> str:
    desc = (payload.description or "").strip()
    tn = (payload.tnved_code or "").strip() or "—"
    tnved_decoded = _decode_tnved(payload.tnved_code)
    catalog_block = _format_existing_catalog(payload.existing_class_labels, payload.existing_classes)
    template = _load_prompt_template()
    try:
        return template.format(
            tnved_code=tn,
            tnved_decoded=tnved_decoded,
            catalog_block=catalog_block,
            description=desc[:8000],
        )
    except Exception:
        return DEFAULT_CLASS_NAMING_PROMPT_TEMPLATE.format(
            tnved_code=tn,
            tnved_decoded=tnved_decoded,
            catalog_block=catalog_block,
            description=desc[:8000],
        )


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "llm-naming"}


@app.get("/api/v1/prompt-template")
def get_prompt_template() -> dict[str, Any]:
    return {"template": _load_prompt_template(), "path": str(CLASS_NAMING_PROMPT_PATH)}


@app.put("/api/v1/prompt-template")
def put_prompt_template(payload: PromptTemplateUpdateRequest) -> dict[str, Any]:
    try:
        tpl = _save_prompt_template(payload.template)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"status": "ok", "template": tpl, "path": str(CLASS_NAMING_PROMPT_PATH)}


@app.get("/api/v1/generation-config")
def get_generation_config() -> dict[str, Any]:
    cfg = _load_generation_config()
    return {**cfg, "path": str(CLASS_NAMING_GENERATION_CONFIG_PATH)}


@app.put("/api/v1/generation-config")
def put_generation_config(payload: ClassNamingGenerationConfigUpdateRequest) -> dict[str, Any]:
    cfg = _save_generation_config(payload.max_new_tokens)
    return {"status": "ok", **cfg, "path": str(CLASS_NAMING_GENERATION_CONFIG_PATH)}


@app.post("/api/v1/suggest-class-name")
def suggest_class_name(payload: SuggestRequest) -> dict[str, Any]:
    desc = (payload.description or "").strip()
    if not desc:
        return {"suggested_class_name": "EMPTY", "mode": "empty_input", "requires_expert_confirmation": True}

    prompt = _build_prompt(payload)
    generation_cfg = _load_generation_config()
    max_new_tokens = int(generation_cfg.get("max_new_tokens", DEFAULT_CLASS_NAMING_MAX_NEW_TOKENS))
    prompt_meta = {
        "description_excerpt": desc[:400],
        "tnved_code": payload.tnved_code,
        "existing_classes_count": len(payload.existing_classes or []) + len(payload.existing_class_labels or []),
        "max_new_tokens": max_new_tokens,
    }
    attempted_models: list[str] = []
    candidate_models, errors = _candidate_models()

    for model_name in candidate_models:
        attempted_models.append(model_name)
        try:
            data = ollama_generate_simple(model_name, prompt, num_predict=max_new_tokens, num_ctx=4096, temperature=0.0)
            raw = (data.get("response") or "").strip()
            token = _normalize_class_token(raw)
            existing_ids: list[str] = [str(x).strip() for x in (payload.existing_classes or []) if str(x).strip()]
            if payload.existing_class_labels:
                existing_ids.extend(
                    [str(x.class_id).strip() for x in payload.existing_class_labels if str(x.class_id).strip()]
                )
            if _looks_like_classifier_code(token, payload.tnved_code):
                token = _fallback_class_name(desc, existing_ids)
            return {
                "suggested_class_name": token,
                "mode": "vllm" if is_vllm() else "ollama",
                "model": model_name,
                "ollama_base_url": OLLAMA_BASE_URL,
                "requires_expert_confirmation": True,
                "prompt_includes": prompt_meta,
            }
        except Exception as exc:
            errors.append(f"{model_name}: {exc}")

    return {
        "suggested_class_name": "GENERATION_FAILED",
        "mode": "error",
        "error": "Unable to generate class name with available Ollama models.",
        "attempted_models": attempted_models,
        "errors": errors[:5],
        "requires_expert_confirmation": True,
        "prompt_includes": prompt_meta,
    }
