# Отчёт по РИД

## Тема РИД

**Модули программного комплекса интеллектуальной гибридной классификации товарных деклараций при помощи правило-ориентированной системы, больших языковых моделей и векторного поиска**

---

## 1. Общие сведения

- **Полное наименование РИД:** Программный комплекс интеллектуальной гибридной классификации товарных деклараций при помощи правило-ориентированной системы, больших языковых моделей и векторного поиска.
- **Тип РИД:** Программа для ЭВМ.
- **Класс РИД:** Прикладной программный комплекс поддержки принятия решений в задаче таможенной классификации.
- **Краткое назначение:** Автоматизация маршрута от первичной классификации декларации до экспертного подтверждения спорных случаев.

---

## 2. Аннотация

Программный комплекс реализует гибридный подход к классификации товарных деклараций и объединяет несколько механизмов принятия решения: правило-ориентированную обработку, семантический векторный поиск по эталонам и генерацию предложений на базе больших языковых моделей. При поступлении декларации система выполняет детерминированную проверку по правилам справочника, а при отсутствии однозначного результата запускает векторный поиск ближайших эталонов. В сценариях низкой семантической уверенности система инициирует генерацию кандидатного имени класса и направляет случай в экспертный контур подтверждения. Для устойчивости к неформатированным ответам моделей применяются функции извлечения и восстановления JSON-структур. Технический результат выражается в повышении точности классификации, снижении доли ручной обработки, формировании прозрачной последовательности этапов и сохранении управляемого экспертного контроля.

---

## 3. Основание и актуальность разработки

Классификация товарных деклараций в практических сценариях усложняется неструктурированными описаниями, неоднозначностью терминов и неполнотой входных данных. Чисто детерминированные правила не покрывают весь спектр случаев, а полностью генеративный подход снижает предсказуемость результата. Разработанный комплекс решает указанную проблему за счёт гибридной архитектуры, где каждая технология применяется в своей зоне ответственности: правила обеспечивают воспроизводимость, векторный поиск даёт семантическое сопоставление с эталонами, а LLM используется как резервный механизм формирования кандидатных решений.

---

## 4. Назначение и область применения

### 4.1 Функциональное назначение

Комплекс предназначен для автоматизированной поддержки принятия решений при таможенной классификации товаров по текстовым описаниям деклараций, кодам ТН ВЭД и данным справочников.

### 4.2 Область применения

- информационные системы таможенного контроля;
- корпоративные контуры ВЭД с задачами внутренней валидации классификации;
- экспертные рабочие места для разрешения спорных классификационных ситуаций.

### 4.3 Роли пользователей

- оператор/инспектор, инициирующий проверку декларации;
- эксперт, подтверждающий или отклоняющий спорные/LLM-сформированные решения;
- администратор, управляющий справочниками, порогами и параметрами генерации.

---

## 5. Состав и границы РИД

### 5.1 Включаемые модули

- `services/orchestrator/app/main.py`
- `services/semantic-search/app/main.py`
- `services/llm-naming/app/main.py`
- `services/preprocessing/app/main.py` (смысловые блоки предобработки и парсинга JSON)
- `shared/json_recovery.py`
- `backend/app/api/routes_expert_decisions.py`
- `backend/app/db/models.py`

### 5.2 Исключаемые технические части

- frontend-интерфейсы;
- служебные интеграционные адаптеры, не влияющие на алгоритмическую часть;
- инфраструктурные и автогенерируемые файлы (`dist`, `__pycache__`, контейнерные артефакты).

---

## 6. Архитектура и общий сценарий работы

### 6.1 Архитектурный подход

Архитектура комплекса модульно-сервисная. Центральный оркестратор управляет этапами обработки и взаимодействует с сервисом семантического поиска, сервисом LLM-именования класса, backend-API экспертных решений и хранилищем данных.

### 6.2 Укрупнённая схема работы

1. Приём запроса на валидацию декларации.
2. Запуск детерминированного правила-ориентированного контура.
3. При отсутствии итогового класса — семантический поиск по эталонам.
4. При низкой близости/неуспехе поиска — генерация кандидатного имени класса через LLM.
5. Формирование карточки в очереди экспертных решений.
6. Фиксация результата, запуск смежных проверок и постановка фоновой задачи.

---

## 7. Описание блоков кода: схема, входные и выходные данные

## 7.1 Блок оркестрации пайплайна

**Файл:** `services/orchestrator/app/main.py`

**Краткая схема работы:**

1. Принимает `ValidationRequest`.
2. Запрашивает результат правило-ориентированной классификации.
3. При `requires_expert_review=true` формирует шаг маршрутизации в экспертную очередь.
4. При отсутствии `final_class_id` выполняет семантический поиск и пороговую проверку.
5. Если класс всё ещё не определён, запрашивает LLM-предложение имени класса.
6. Создаёт запись в экспертном API для подтверждения решения.
7. Выполняет проверку стоимости и постановку фоновой кластеризации.
8. Возвращает агрегированный `flow` со всеми этапами и итоговым классом.

**Входные данные блока:**

- `declaration_id: str`
- `description: str`
- `tnved_code: str | None`
- `gross_weight_kg: float | None`
- `net_weight_kg: float | None`
- `price: float | None`
- `extracted_features_override: dict | None`

**Выходные данные блока:**

- итоговая структура `flow`:
  - `declaration_id`
  - список шагов `steps` с результатами каждого этапа
  - `status` выполнения
  - `summary_ru`
  - `final_class`
- потоковые события NDJSON для endpoint `validate/stream`;
- идентификатор фоновой задачи кластеризации.

**Листинг ключевого фрагмента:**

```python
class ValidationRequest(BaseModel):
    declaration_id: str
    description: str
    tnved_code: str | None = None
    gross_weight_kg: float | None = None
    net_weight_kg: float | None = None
    price: float | None = None
    extracted_features_override: Optional[dict[str, Any]] = None


async def _run_validate_pipeline(
    payload: ValidationRequest,
    on_phase: Callable[[str, str, str], Awaitable[None]] | None = None,
    on_step: Callable[[dict[str, Any], str, Any], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    async def phase(code: str, title: str, detail: str) -> None:
        if on_phase is not None:
            await on_phase(code, title, detail)

    async def push_step(step: str, result: Any) -> None:
        flow["steps"].append({"step": step, "result": result})
        if on_step is not None:
            await on_step(flow, step, result)

    flow: dict[str, Any] = {"declaration_id": payload.declaration_id, "steps": []}
    class_id: str | None = None
    async with httpx.AsyncClient(timeout=900.0) as client:
        officer = await client.post(
            f"{RULES_ENGINE_URL}/api/pipeline/officer-run",
            json=payload.model_dump(),
        )
        officer.raise_for_status()
        officer_json = officer.json()
        await push_step("officer-pipeline", officer_json)
    flow["status"] = "completed"
    flow["final_class"] = class_id
    return flow
```

## 7.2 Блок векторного семантического сопоставления

**Файл:** `services/semantic-search/app/main.py`

**Краткая схема работы:**

1. Принимает описание декларации и список эталонных примеров.
2. Кодирует запрос и эталоны в эмбеддинги (модель E5).
3. Считает косинусную близость, выбирает лучший эталон.
4. Формирует диагностическое представление пространства признаков (2D-проекция PCA/SVD).
5. Возвращает класс-кандидат, метрики близости и служебные признаки режима.
6. При отсутствии эталонов/ошибке вычислений использует безопасный stub-режим ответа.

**Входные данные блока:**

- `description: str`
- `tnved_code: str | None`
- `similarity_threshold: float | None`
- `rule_id: str | None`
- `reference_examples: list[{description_text, assigned_class_id}] | None`

**Выходные данные блока:**

- `matched: bool`
- `similarity: float`
- `class_id: str | None`
- `service_mode`
- `embedding_model`
- `n_reference_examples_total`, `n_reference_examples_used`
- `feature_space_points` для визуализации.

**Листинг ключевого фрагмента:**

```python
def _embedding_search(payload: SearchRequest, valid: list[tuple[str, str]]) -> dict[str, Any]:
    encoder = _get_encoder()
    query = (payload.description or "").strip()
    passages = [t for t, _ in valid]
    q_emb = encoder.encode([f"query: {query}"], normalize_embeddings=True, show_progress_bar=False)
    cache_key = _make_passage_cache_key(payload.rule_id, valid)
    p_emb = _cache_get(cache_key)
    if p_emb is None:
        p_emb = encoder.encode([f"passage: {p}" for p in passages], normalize_embeddings=True, show_progress_bar=False)
    qv = q_emb.astype(np.float32, copy=False) if isinstance(q_emb, np.ndarray) else np.array(q_emb, dtype=np.float32)
    pv = p_emb.astype(np.float32, copy=False) if isinstance(p_emb, np.ndarray) else np.array(p_emb, dtype=np.float32)
    sims = (qv @ pv.T).flatten()
    best_i = int(np.argmax(sims))
    return {
        "matched": True,
        "similarity": float(sims[best_i]),
        "class_id": valid[best_i][1],
        "service_mode": "reference_embeddings",
    }
```

## 7.3 Блок генерации имени класса на базе LLM

**Файл:** `services/llm-naming/app/main.py`

**Краткая схема работы:**

1. Формирует текст запроса к модели на основе описания товара, кода ТН ВЭД и существующих классов.
2. Запрашивает модель(и) LLM и получает сырой кандидат.
3. Нормализует строку имени класса, отсекает недопустимые форматы (цифровые коды, псевдо-коды ТН ВЭД).
4. При некорректном результате строит fallback-наименование по ключевым словам описания.
5. Возвращает кандидатное имя класса с признаком обязательного экспертного подтверждения.

**Входные данные блока:**

- `description: str`
- `tnved_code: str | None`
- `existing_classes: list[str]`
- `existing_class_labels: list[{class_id, title}]`

**Выходные данные блока:**

- `suggested_class_name: str`
- `mode` (`ollama`, `vllm`, `error`, `empty_input`)
- `model`, `ollama_base_url` (при успешной генерации)
- `requires_expert_confirmation: true`
- метаданные промпта и диагностика ошибок.

**Дефолтный промпт именования класса (`services/llm-naming/config/class_naming_prompt.txt`):**

```text
Ты помогаешь завести имя нового класса товара в таможенном справочнике.
Ниже — описание товара, для которого детерминированная классификация не выбрала класс (или сработала ветка низкой семантической схожести).
Учти код ТН ВЭД и не повторяй уже существующие идентификаторы классов.
Важно: предлагай не код ТН ВЭД и не цифровой шифр, а смысловое имя класса по аналогии с существующими классами.

Расшифровка кода ТН ВЭД: {tnved_decoded}

Уже существующие классы по этому справочнику:
{catalog_block}

Описание товара неизвестного класса:
{description}

Ответ: одна строка — краткое имя класса в стиле справочника: обычно 1-3 слов.
Запрещено: чисто цифровой ответ, код ТН ВЭД
Отвечай без кавычек, пояснений и без markdown.
```

**Листинг ключевого фрагмента (включая запуск LLM):**

```python
def _build_prompt(payload: SuggestRequest) -> str:
    desc = (payload.description or "").strip()
    tn = (payload.tnved_code or "").strip() or "—"
    tnved_decoded = _decode_tnved(payload.tnved_code)
    catalog_block = _format_existing_catalog(payload.existing_class_labels, payload.existing_classes)
    template = _load_prompt_template()
    return template.format(
        tnved_code=tn,
        tnved_decoded=tnved_decoded,
        catalog_block=catalog_block,
        description=desc[:8000],
    )


@app.post("/api/v1/suggest-class-name")
def suggest_class_name(payload: SuggestRequest) -> dict[str, Any]:
    prompt = _build_prompt(payload)
    data = ollama_generate_simple(OLLAMA_MODEL, prompt, num_predict=24, num_ctx=4096, temperature=0.0)
    token = _normalize_class_token((data.get("response") or "").strip())
    return {"suggested_class_name": token, "requires_expert_confirmation": True}
```

## 7.4 Блок предобработки и восстановления JSON

**Файлы:** `services/preprocessing/app/main.py`, `shared/json_recovery.py`

**Краткая схема работы:**

1. Получает сырой текст ответа модели (в т.ч. с комментариями и повреждённым JSON).
2. Выделяет наиболее вероятный JSON-фрагмент (маркеры ответа, fenced-блоки, первая открывающая скобка).
3. Выполняет безопасную автокоррекцию (лишние запятые, незакрытые скобки, `None/null`, кавычки).
4. Пытается распарсить JSON стандартным способом, при неудаче — безопасным fallback (`ast.literal_eval`).
5. Возвращает нормализованную структуру данных для дальнейшего использования в пайплайне.

**Входные данные блока:**

- для `parse-model-json`: `text: str`
- для `preprocess`: `declaration_id`, `description`, `tnved_code`.

**Выходные данные блока:**

- `parsed: dict | list` (или `{}` при неуспехе)
- `extracted_fragment_preview`
- простая структура первичных признаков (`length`, `contains_digits`, `tnved_hint`) для предобработки.

**Мета-промпт генерации системного промпта извлечения признаков (`frontend/src/expert/featureExtractionPromptGenerator.ts`):**

```text
Ты — промпт-инженер, специализирующийся на создании системных инструкций для LLM, которые извлекают структурированные числовые и количественные характеристики из неструктурированных текстов.

Твоя задача: на основе предоставленного JSON-шаблона (где значения заменены на null) и списка допустимых значений для ключевых полей, сгенерировать готовый системный промпт для модели-экстрактора.

ТРЕБОВАНИЯ К ГЕНЕРАЦИИ ПРОМПТА:
1. Сохрани архитектуру: Роль -> Задача (пошагово) -> Правила маппинга полей -> Особые указания -> Строгий JSON-вывод.
2. Автоматически определи тип извлекаемых характеристик из ключей JSON. Сформулируй задачу и правила именно под этот тип данных.
3. Интегрируй список допустимых значений в правила нормализации: укажи, что извлеченные значения должны приводиться к регистру/формату из списка, заменять синонимы на канонические обозначения и игнорировать несуществующие в списке варианты.
4. Включи в "Особые указания" универсальные правила обработки чисел:
   - Язык вывода: русский.
   - Диапазоны и погрешности -> формат [min, max].
   - Логические операторы: "не менее" -> [x, null], "не более" -> [null, x].
   - Десятичный разделитель: точка.
   - Приоритет: конкретные числовые значения заменяют общие/оценочные формулировки.
   - Пропуск: если атрибут отсутствует в тексте — не выводи его в JSON.
   - Единицы измерения: укажи явно для каждого числового поля, кроме справочных/строковых.
5. В конце промпта приведи пример JSON строго в формате исходного шаблона, но с подставленными реалистичными значениями (числа, массивы, корректные null).
6. Стиль: императивный, без воды, готовый к production-использованию. Не добавляй пояснений, комментариев или обрамляющих фраз.

ВЫВОД: Верни ТОЛЬКО сгенерированный системный промпт.
```

**Рабочий промпт извлечения признаков (формируется динамически из мета-промпта + JSON-шаблона справочника + допустимых значений):**

```text
Роль:
Ты — эксперт по извлечению структурированных характеристик товаров из неструктурированного описания декларации.

Задача:
1) Проанализируй текст описания товара.
2) Извлеки только те признаки, которые явно присутствуют в тексте.
3) Верни результат строго по структуре JSON-шаблона.

Правила маппинга:
- Используй только ключи из переданного JSON-шаблона.
- Для полей со списком допустимых значений нормализуй синонимы к каноническим значениям.
- Если значение не найдено или не подтверждено текстом, поле не заполняй (или оставляй null по правилам шаблона).

Особые указания по числам:
- Диапазоны и погрешности записывай как [min, max].
- "Не менее X" -> [X, null], "не более X" -> [null, X].
- Десятичный разделитель: точка.
- Приоритет у точных чисел над оценочными формулировками.

Строгий формат вывода:
- Верни только JSON, без комментариев и markdown.
- Соблюдай структуру:
{json_template_from_catalog}

Допустимые значения и нормализация:
{allowed_values_from_catalog}

Входной текст декларации:
{declaration_description}
```

В реализации этот промпт не хранится как один статический файл: он собирается функцией `buildFeatureExtractionPromptGeneratorRequest(...)` из `frontend/src/expert/featureExtractionPromptGenerator.ts` для конкретного справочника.

**Листинг ключевого фрагмента:**

```python
def parse_json_safe(s: str) -> Any:
    if not isinstance(s, str) or not s.strip():
        return {}
    fragment = _extract_json_like(s)
    if not fragment:
        return {}
    s_clean = _autofix_commas(fragment.strip())
    s_clean = _balance_and_close(s_clean)
    try:
        parsed = json.loads(s_clean)
        if isinstance(parsed, (dict, list)):
            return parsed
    except json.JSONDecodeError:
        pass
    s_eval = re.sub(r"\bnull\b", "None", s_clean)
    try:
        data = ast.literal_eval(s_eval)
        if isinstance(data, (dict, list)):
            return data
    except Exception:
        pass
    return {}
```

## 7.5 Блок экспертных решений и повторной проверки

**Файл:** `backend/app/api/routes_expert_decisions.py`

**Краткая схема работы:**

1. Создаёт записи экспертной очереди (`pending`) с категорией и полезной нагрузкой.
2. Поддерживает фильтрацию и полнотекстовый поиск по карточкам решений.
3. Позволяет эксперту изменить статус (`resolved`, `dismissed`, `pending`) и зафиксировать `resolution`.
4. Для категории `class_name_confirmation` поддерживает автоматическую перепроверку по актуальной версии справочника и авто-закрытие записи, если предложенный класс уже появился в правилах.

**Входные данные блока:**

- создание: `category`, `declaration_id`, `summary_ru`, `payload`, `rule_id`
- фильтры списка: `status`, `category`, `q`, `tnved_prefix`, `has_class`, диапазон дат, пагинация
- patch: `status`, `resolution`
- recheck: `item_id`.

**Выходные данные блока:**

- объект карточки экспертного решения;
- страница списка (`items`, `total`, `page`, `page_size`);
- результат перепроверки (`resolved: bool`, `reason`, обновлённая карточка).

**Листинг ключевого фрагмента:**

```python
@router.post("", response_model=ExpertDecisionItemOut)
def create_expert_decision(payload: ExpertDecisionCreate, db: Session = Depends(get_db_session)) -> ExpertDecisionItemOut:
    row = ExpertDecisionItem(
        category=payload.category.strip(),
        declaration_id=payload.declaration_id.strip(),
        status="pending",
        summary_ru=(payload.summary_ru or "").strip(),
        payload_json=dict(payload.payload),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _to_out(row)
```

## 7.6 Блок моделей предметных данных

**Файл:** `backend/app/db/models.py`

**Краткая схема работы:**

1. Определяет сущности правил, версий правил, эталонных примеров, запусков few-shot и настроек.
2. Определяет сущность `ExpertDecisionItem` для очереди экспертных решений.
3. Фиксирует связи и индексы для быстрого доступа по статусам, категориям, `rule_id` и времени создания.

**Входные данные блока:**

- ORM-операции создания/обновления/чтения для сущностей правил и экспертной очереди.

**Выходные данные блока:**

- устойчивое хранение и выдача структурированных данных для всех этапов гибридной классификации;
- поддержка трассируемости решений по декларации и справочнику.

**Листинг ключевого фрагмента:**

```python
class RuleReferenceExample(Base):
    __tablename__ = "rule_reference_examples"
    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    rule_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("rules.id", ondelete="CASCADE"), nullable=False)
    description_text: Mapped[str] = mapped_column(Text, nullable=False)
    features_json: Mapped[Dict[str, Any]] = mapped_column(JSON, nullable=False)
    assigned_class_id: Mapped[str] = mapped_column(String(512), nullable=False)


class ExpertDecisionItem(Base):
    __tablename__ = "expert_decision_items"
    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    category: Mapped[str] = mapped_column(String(64), nullable=False)
    declaration_id: Mapped[str] = mapped_column(String(512), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="pending")
    payload_json: Mapped[Dict[str, Any]] = mapped_column(JSON, nullable=False)
```

---

## 8. Совокупные входные и выходные данные комплекса

### 8.1 Совокупные входные данные

- идентификатор декларации;
- текстовое описание товара;
- код ТН ВЭД;
- весовые и ценовые параметры (при наличии);
- структура справочника и эталонные примеры (через backend-слой);
- настройки порогов и параметров генерации.

### 8.2 Совокупные выходные данные

- итоговый класс декларации либо отметка о необходимости экспертного подтверждения;
- подробный журнал этапов обработки;
- результаты семантической близости и кандидатные классы;
- LLM-сгенерированное имя класса (как предложение);
- карточка экспертной очереди с решением и временем фиксации;
- служебные задания в очередь фоновой обработки.

---

## 9. Технический результат

- Повышение полноты автоматической классификации за счёт объединения детерминированного и вероятностного контуров.
- Снижение количества ручных операций благодаря автоматической маршрутизации только действительно спорных случаев.
- Повышение устойчивости к шумным и частично неструктурированным текстовым данным.
- Формирование объяснимого маршрута принятия решения с сохранением промежуточных этапов.
- Сохранение управляемости и безопасности принятия решения через обязательный экспертный контур подтверждения.

---

## 10. Практическая ценность и отличительные особенности

### 10.1 Отличительные особенности

- гибридный механизм принятия решений (правила + эмбеддинги + LLM);
- явный fallback-сценарий при низкой семантической уверенности;
- встроенный контур экспертного подтверждения и повторной проверки по актуальному справочнику;
- устойчивое восстановление JSON из нестабильных ответов LLM.

### 10.2 Практическая ценность

Комплекс позволяет ускорить процесс классификации деклараций, уменьшить нагрузку на профильных экспертов и повысить согласованность решений в организациях, работающих с внешнеэкономической деятельностью и таможенными процедурами.

---

## 11. Требования к среде выполнения

### 11.1 Программные требования

- Python-окружение для backend-сервисов;
- HTTP-взаимодействие между сервисами оркестрации, поиска, именования и backend-ядром;
- доступ к СУБД PostgreSQL для хранения справочников и экспертных решений;
- наличие LLM runtime (Ollama и/или vLLM).

### 11.2 Аппаратные требования

- сервер/ВМ с ресурсами CPU и RAM, достаточными для запуска микросервисов;
- при использовании крупных моделей — вычислительные ресурсы GPU (по конфигурации LLM runtime).

### 11.3 Требования к данным

- заполненные справочники правил и версии DSL;
- набор эталонных примеров для повышения качества семантического сопоставления;
- структурированные идентификаторы деклараций и базовые атрибуты товара.

---

## 12. Проверка работоспособности

### 12.1 Рекомендуемые сценарии испытаний

- стандартный случай, когда правило-ориентированный контур сразу назначает класс;
- случай отсутствия класса по правилам и успешного семантического сопоставления;
- случай низкой близости с запуском LLM-именования и созданием экспертной карточки;
- случай некорректного ответа LLM с восстановлением JSON;
- случай повторной перепроверки экспертной карточки по обновлённому справочнику.

### 12.2 Критерии успешности

- корректная последовательность этапов в `flow`;
- заполнение итогового результата или корректная постановка в экспертную очередь;
- отсутствие аварийного завершения при частичных сбоях внешних сервисов;
- корректная запись и изменение статусов в хранилище экспертных решений.

---

## 13. Заключение

Разработанный программный комплекс представляет собой самостоятельный РИД в форме программы для ЭВМ и реализует завершённый процесс гибридной классификации товарных деклараций. Комплекс объединяет воспроизводимость правил, адаптивность семантического поиска и гибкость генеративных моделей, сохраняя экспертный контроль в критических точках принятия решений. Такое сочетание обеспечивает практическую применимость в производственных контурах и создаёт основу для дальнейшего масштабирования.

---

## Приложение А. Перечень исходных файлов листинга

1. `services/orchestrator/app/main.py`
2. `services/semantic-search/app/main.py`
3. `services/llm-naming/app/main.py`
4. `services/preprocessing/app/main.py` (включать смысловые фрагменты)
5. `shared/json_recovery.py`
6. `backend/app/api/routes_expert_decisions.py`
7. `backend/app/db/models.py`

---

## Приложение В. Термины и сокращения

- **РИД** — результат интеллектуальной деятельности.
- **LLM** — большая языковая модель.
- **ТН ВЭД** — товарная номенклатура внешнеэкономической деятельности.
- **Fallback** — резервный сценарий обработки.
- **Эталонный пример** — запись справочника с известным классом для семантического сопоставления.

---

## 14. Полный перечень участков с параметрами по умолчанию

Ниже перечислены все ключевые участки, где используются значения по умолчанию в backend-модулях комплекса.

### 14.1 Оркестратор (`services/orchestrator/app/main.py`)

```python
PREPROCESSING_URL = os.getenv("PREPROCESSING_URL", "http://preprocessing:8004")
RULES_ENGINE_URL = os.getenv("RULES_ENGINE_URL", "http://backend:8000")
SEMANTIC_SEARCH_URL = os.getenv("SEMANTIC_SEARCH_URL", "http://semantic-search:8001")
LLM_GENERATOR_URL = os.getenv("LLM_GENERATOR_URL", "http://llm-naming:8002")
PRICE_VALIDATOR_URL = os.getenv("PRICE_VALIDATOR_URL", "http://price-validator:8006")
DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://rules_user:rules_pass@postgres:5432/rules")
```

```python
class ValidationRequest(BaseModel):
    declaration_id: str
    description: str
    tnved_code: str | None = None
    gross_weight_kg: float | None = None
    net_weight_kg: float | None = None
    price: float | None = None
    extracted_features_override: Optional[dict[str, Any]] = None
```

### 14.2 Семантический поиск (`services/semantic-search/app/main.py`)

```python
E5_MODEL_NAME = os.getenv("SEMANTIC_SEARCH_EMBEDDING_MODEL", "intfloat/multilingual-e5-base")
FORCE_STUB = os.getenv("SEMANTIC_SEARCH_FORCE_STUB", "").strip().lower() in ("1", "true", "yes")
SPACE_MAX_POINTS = max(20, int(os.getenv("SEMANTIC_SEARCH_SPACE_MAX_POINTS", "250")))
CACHE_MAX_ITEMS = max(1, int(os.getenv("SEMANTIC_SEARCH_EMBED_CACHE_MAX_ITEMS", "12")))
```

```python
class ReferenceExampleIn(BaseModel):
    description_text: str = ""
    assigned_class_id: str = ""


class SearchRequest(BaseModel):
    description: str
    tnved_code: str | None = None
    similarity_threshold: float | None = None
    rule_id: str | None = None
    reference_examples: list[ReferenceExampleIn] | None = Field(default=None)
```

### 14.3 Сервис генерации имени класса (`services/llm-naming/app/main.py`)

```python
OLLAMA_MODEL = (os.getenv("OLLAMA_MODEL") or "").strip()
CLASS_NAMING_PROMPT_PATH = Path(os.getenv("CLASS_NAMING_PROMPT_PATH", "/app/config/class_naming_prompt.txt"))
CLASS_NAMING_GENERATION_CONFIG_PATH = Path(
    os.getenv("CLASS_NAMING_GENERATION_CONFIG_PATH", "/app/config/class_naming_generation.json")
)
DEFAULT_CLASS_NAMING_MAX_NEW_TOKENS = 24
```

```python
class SuggestRequest(BaseModel):
    description: str
    tnved_code: str | None = None
    existing_classes: list[str] = Field(default_factory=list)
    existing_class_labels: list[ClassLabelEntry] = Field(default_factory=list)


class PromptTemplateUpdateRequest(BaseModel):
    template: str = ""


class ClassNamingGenerationConfigUpdateRequest(BaseModel):
    max_new_tokens: int = Field(DEFAULT_CLASS_NAMING_MAX_NEW_TOKENS, ge=8, le=256)
```

```python
def _load_prompt_template() -> str:
    try:
        txt = CLASS_NAMING_PROMPT_PATH.read_text(encoding="utf-8")
        if txt.strip():
            return txt
    except Exception:
        pass
    return DEFAULT_CLASS_NAMING_PROMPT_TEMPLATE
```

```python
def _load_generation_config() -> dict[str, int]:
    try:
        txt = CLASS_NAMING_GENERATION_CONFIG_PATH.read_text(encoding="utf-8")
        if txt.strip():
            data = json.loads(txt)
            v = int(data.get("max_new_tokens", DEFAULT_CLASS_NAMING_MAX_NEW_TOKENS))
            v = max(8, min(v, 256))
            return {"max_new_tokens": v}
    except Exception:
        pass
    return {"max_new_tokens": DEFAULT_CLASS_NAMING_MAX_NEW_TOKENS}
```

### 14.4 Preprocessing (`services/preprocessing/app/main.py`)

```python
_MODEL_SETTINGS_FALLBACK = Path(__file__).resolve().parent / "model_runtime_settings.json"
MODEL_SETTINGS_PATH = Path(os.getenv("MODEL_RUNTIME_SETTINGS_PATH", str(_MODEL_SETTINGS_FALLBACK)))
OLLAMA_CONTAINER_NAME = (os.getenv("OLLAMA_CONTAINER_NAME") or "pipeline_ollama").strip()
VLLM_CONTAINER_NAME = (os.getenv("VLLM_CONTAINER_NAME") or "pipeline_vllm").strip()
PREPROCESSING_CONTAINER_NAME = (os.getenv("PREPROCESSING_CONTAINER_NAME") or "pipeline_preprocessing").strip()
DEFAULT_MODEL_SETTINGS: dict[str, Any] = {"models": {}}
```

```python
def _warm_load_model_into_ram(model: str) -> dict[str, Any]:
    settings = _load_model_settings()
    mcfg = (settings.get("models") or {}).get(model.strip()) or {}
    num_ctx = int(mcfg.get("num_ctx", 8192))
    num_predict = min(int(mcfg.get("max_new_tokens", 64)), 128)
    repeat_penalty = float(mcfg.get("repetition_penalty", 1.0))
    temperature = float(mcfg.get("temperature", 0.0))
    enable_thinking = bool(mcfg.get("enable_thinking", False))
```

```python
class OllamaGenerateRequest(BaseModel):
    model: str
    prompt: str
    num_ctx: int = Field(default=8192, ge=256)
    max_new_tokens: int = Field(default=3904, ge=32)
    repetition_penalty: float = Field(default=1.0, ge=0.5, le=2.0)
    temperature: float = Field(default=0.0, ge=0.0, le=2.0)
    top_p: float | None = Field(default=None, ge=0.0, le=1.0)
    enable_thinking: bool = False
```

### 14.5 Экспертные решения (`backend/app/api/routes_expert_decisions.py`)

```python
class ExpertDecisionCreate(BaseModel):
    category: str = Field(..., min_length=1, max_length=64)
    declaration_id: str = Field(..., min_length=1, max_length=512)
    summary_ru: str = ""
    payload: Dict[str, Any] = Field(default_factory=dict)
    rule_id: Optional[str] = None
```

```python
class ExpertDecisionPatch(BaseModel):
    status: Literal["pending", "resolved", "dismissed"]
    resolution: Dict[str, Any] = Field(default_factory=dict)
```

### 14.6 ORM-модели (`backend/app/db/models.py`)

```python
id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow, nullable=False)
is_archived: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
status: Mapped[str] = mapped_column(String(32), nullable=False, default="pending")
summary_ru: Mapped[str] = mapped_column(Text, nullable=False, default="")
```

### 14.7 Общая конфигурация LLM runtime (`shared/llm_runtime/config.py`)

```python
def llm_backend() -> LLMBackend:
    raw = (os.getenv("LLM_BACKEND") or "ollama").strip().lower()
    if raw in ("vllm", "v-llm"):
        return "vllm"
    return "ollama"


def ollama_base_url() -> str:
    return (os.getenv("OLLAMA_BASE_URL") or "http://127.0.0.1:11434").rstrip("/")


def vllm_base_url() -> str:
    return (os.getenv("VLLM_BASE_URL") or "http://127.0.0.1:8000").rstrip("/")
```

### 14.8 Конфиги с дефолтами для prompt-generator

`services/api-gateway/config/prompt_generator.json`

```json
{
  "num_ctx": 8192,
  "max_new_tokens": 3904,
  "temperature": 0.22,
  "repetition_penalty": 1.0,
  "top_p": null,
  "enable_thinking": false
}
```

---

## 15. Полные листинги модулей (без сокращений)

### 15.1 `services/orchestrator/app/main.py`

```python
from __future__ import annotations

import json
import os
import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any, Optional

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import psycopg2

from app.pipeline_config import load_semantic_similarity_threshold

PREPROCESSING_URL = os.getenv("PREPROCESSING_URL", "http://preprocessing:8004")
RULES_ENGINE_URL = os.getenv("RULES_ENGINE_URL", "http://backend:8000")
SEMANTIC_SEARCH_URL = os.getenv("SEMANTIC_SEARCH_URL", "http://semantic-search:8001")
LLM_GENERATOR_URL = os.getenv("LLM_GENERATOR_URL", "http://llm-naming:8002")
PRICE_VALIDATOR_URL = os.getenv("PRICE_VALIDATOR_URL", "http://price-validator:8006")
DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://rules_user:rules_pass@postgres:5432/rules")

app = FastAPI(title="Pipeline Orchestrator", version="0.1.0")


class ValidationRequest(BaseModel):
    declaration_id: str
    description: str
    tnved_code: str | None = None
    gross_weight_kg: float | None = None
    net_weight_kg: float | None = None
    price: float | None = None
    extracted_features_override: Optional[dict[str, Any]] = None


def init_jobs_schema() -> None:
    with psycopg2.connect(DATABASE_URL) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS jobs (
                    id BIGSERIAL PRIMARY KEY,
                    kind TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'queued',
                    payload JSONB NOT NULL,
                    result JSONB,
                    error TEXT,
                    worker_id TEXT,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    started_at TIMESTAMPTZ,
                    finished_at TIMESTAMPTZ
                );
                """
            )
            cur.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_jobs_status_created
                ON jobs (status, created_at);
                """
            )


def enqueue_cluster_job(payload: dict[str, Any]) -> int:
    with psycopg2.connect(DATABASE_URL) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO jobs (kind, status, payload)
                VALUES (%s, 'queued', %s::jsonb)
                RETURNING id;
                """,
                ("clustering", json.dumps(payload, ensure_ascii=False)),
            )
            row = cur.fetchone()
            if row is None:
                raise RuntimeError("failed to enqueue job")
            return int(row[0])


def get_job(job_id: int) -> dict[str, Any] | None:
    with psycopg2.connect(DATABASE_URL) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, kind, status, payload::text, result::text, error, worker_id, created_at, started_at, finished_at
                FROM jobs
                WHERE id = %s;
                """,
                (job_id,),
            )
            row = cur.fetchone()
            if row is None:
                return None
            return {
                "id": int(row[0]),
                "kind": row[1],
                "status": row[2],
                "payload": json.loads(row[3]) if row[3] else None,
                "result": json.loads(row[4]) if row[4] else None,
                "error": row[5],
                "worker_id": row[6],
                "created_at": row[7].isoformat() if row[7] else None,
                "started_at": row[8].isoformat() if row[8] else None,
                "finished_at": row[9].isoformat() if row[9] else None,
            }


@app.on_event("startup")
def startup() -> None:
    init_jobs_schema()


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "orchestrator"}


async def _fetch_reference_examples_for_rule(
    client: httpx.AsyncClient, rule_id: str | None
) -> list[dict[str, str]]:
    if not rule_id:
        return []
    try:
        r = await client.get(
            f"{RULES_ENGINE_URL}/api/rules/{rule_id}/reference-examples",
            timeout=30.0,
        )
        r.raise_for_status()
        data = r.json()
        raw = data.get("examples") if isinstance(data, dict) else None
        if not isinstance(raw, list):
            return []
        out: list[dict[str, str]] = []
        for ex in raw:
            if not isinstance(ex, dict):
                continue
            out.append(
                {
                    "description_text": str(ex.get("description_text") or ""),
                    "assigned_class_id": str(ex.get("assigned_class_id") or ""),
                }
            )
        return out
    except Exception:
        return []


async def _effective_semantic_threshold(client: httpx.AsyncClient, rule_id: str | None) -> tuple[float, dict[str, Any]]:
    """Глобальный порог из pipeline; при наличии rule_id — калибровка по эталонам в БД."""
    base = load_semantic_similarity_threshold()
    if not rule_id:
        return base, {"source": "global", "rule_id": None}
    try:
        r = await client.get(
            f"{RULES_ENGINE_URL}/api/rules/{rule_id}/semantic-threshold",
            timeout=15.0,
        )
        r.raise_for_status()
        data = r.json()
        src = data.get("source")
        raw = data.get("threshold")
        if src == "reference_examples" and isinstance(raw, (int, float)):
            return float(raw), {"source": "reference_examples", "rule_id": rule_id, **data}
        return base, {"source": "global_fallback", "rule_id": rule_id, **data}
    except Exception as exc:
        return base, {"source": "global", "rule_id": rule_id, "error": str(exc)}


def _http_exception_detail(exc: HTTPException) -> str:
    d = exc.detail
    if isinstance(d, str):
        return d
    try:
        return json.dumps(d, ensure_ascii=False)
    except Exception:
        return str(d)


async def _run_validate_pipeline(
    payload: ValidationRequest,
    on_phase: Callable[[str, str, str], Awaitable[None]] | None = None,
    on_step: Callable[[dict[str, Any], str, Any], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    async def phase(code: str, title: str, detail: str) -> None:
        if on_phase is not None:
            await on_phase(code, title, detail)

    async def push_step(step: str, result: Any) -> None:
        flow["steps"].append({"step": step, "result": result})
        if on_step is not None:
            await on_step(flow, step, result)

    flow: dict[str, Any] = {"declaration_id": payload.declaration_id, "steps": []}
    class_id: str | None = None

    async with httpx.AsyncClient(timeout=900.0) as client:
        try:
            await phase(
                "catalog",
                "Подбор справочника",
                "Подбираем подходящий справочник и извлекаем признаки из описания декларации.",
            )
            officer = await client.post(
                f"{RULES_ENGINE_URL}/api/pipeline/officer-run",
                json=payload.model_dump(),
            )
            officer.raise_for_status()
            officer_json = officer.json()
            await push_step("officer-pipeline", officer_json)

            class_id = officer_json.get("final_class_id")
            catalog_classes = officer_json.get("catalog_classification_classes") or []
            requires_expert_review = bool(officer_json.get("requires_expert_review"))

            if requires_expert_review:
                await phase("expert-routing", "Экспертная маршрутизация", "Требуется решение эксперта по классификации.")
                crev = officer_json.get("classification_expert_review") or (
                    (officer_json.get("deterministic") or {}).get("classification_expert_review")
                    if isinstance(officer_json.get("deterministic"), dict)
                    else None
                )
                kind = (crev or {}).get("kind") if isinstance(crev, dict) else None
                if kind == "none_match":
                    expl = (
                        "Ни одно правило классификации не подошло — запись попала в очередь «Решение спорных ситуаций»."
                    )
                elif kind == "ambiguous":
                    ids = (crev or {}).get("matched_class_ids") or []
                    expl = (
                        "Подошло несколько классов: "
                        + ", ".join(str(x) for x in ids)
                        + ". Нужно решение эксперта — запись в очереди «Решение спорных ситуаций»."
                    )
                else:
                    expl = (
                        "Требуется экспертное рассмотрение по классификации — см. страницу «Решение спорных ситуаций»."
                    )
                await push_step(
                    "expert-review-routing",
                    {
                        "requires_expert_review": True,
                        "reason": "classification_expert_review",
                        "classification_expert_review": crev,
                        "explanation_ru": expl,
                    },
                )
            elif not class_id:
                cat = officer_json.get("catalog")
                rule_id_from_catalog: str | None = None
                if isinstance(cat, dict):
                    raw_rid = cat.get("rule_id")
                    if raw_rid is not None and str(raw_rid).strip():
                        rule_id_from_catalog = str(raw_rid).strip()

                threshold, threshold_meta = await _effective_semantic_threshold(client, rule_id_from_catalog)
                flow["semantic_threshold_resolution"] = threshold_meta

                reference_examples = await _fetch_reference_examples_for_rule(client, rule_id_from_catalog)

                await phase("semantic-search", "Семантический fallback", "Ищем ближайший эталон по эмбеддингам.")
                try:
                    ss = await client.post(
                        f"{SEMANTIC_SEARCH_URL}/api/v1/search",
                        json={
                            "description": payload.description,
                            "tnved_code": payload.tnved_code,
                            "similarity_threshold": threshold,
                            "rule_id": rule_id_from_catalog,
                            "reference_examples": reference_examples,
                        },
                    )
                    ss.raise_for_status()
                    ss_data = ss.json()
                except Exception as exc:
                    ss_data = {
                        "matched": False,
                        "similarity": 0.0,
                        "class_id": None,
                        "error": str(exc),
                        "service_mode": "error",
                    }

                sim = float(ss_data.get("similarity") or 0.0)
                matched = bool(ss_data.get("matched"))
                below_or_equal = sim <= threshold

                await push_step(
                    "semantic-search",
                    {
                        **ss_data,
                        "similarity_threshold": threshold,
                        "threshold_resolution": threshold_meta,
                        "reference_examples_submitted": len(reference_examples),
                        "below_threshold": below_or_equal,
                        "explanation_ru": (
                            "Схожесть выше порога и есть кандидат — класс можно взять из семантического поиска (после проверок)."
                            if not below_or_equal and matched and ss_data.get("class_id")
                            else "Схожесть не превышает порог или совпадения нет — по схеме запускается LLM-именование нового класса."
                        ),
                    },
                )

                if not below_or_equal and matched and ss_data.get("class_id"):
                    cand = str(ss_data.get("class_id"))
                    det = (
                        officer_json.get("deterministic")
                        if isinstance(officer_json.get("deterministic"), dict)
                        else None
                    )
                    vf = det.get("validated_features") if isinstance(det, dict) else None
                    if cand and rule_id_from_catalog and isinstance(vf, dict):
                        await phase("semantic-rule-check", "Проверка правила кандидата", "Проверяем RuleMatch2 для класса-кандидата.")
                        try:
                            chk = await client.post(
                                f"{RULES_ENGINE_URL}/api/pipeline/semantic-class-consistency",
                                json={
                                    "rule_id": rule_id_from_catalog,
                                    "class_id": cand,
                                    "validated_features": vf,
                                },
                                timeout=30.0,
                            )
                            chk.raise_for_status()
                            chk_data = chk.json()
                            await push_step("semantic-class-rule-check", chk_data)
                            if bool(chk_data.get("consistent")):
                                class_id = cand
                        except Exception as exc:
                            await push_step(
                                "semantic-class-rule-check",
                                {
                                    "consistent": True,
                                    "skipped": True,
                                    "error": str(exc),
                                },
                            )
                            class_id = cand
                    else:
                        class_id = cand

                if below_or_equal or not matched:
                    await phase("llm-naming", "LLM-именование класса", "Семантика не дала класс — генерируем новое имя класса.")
                    labels_payload: list[dict[str, str]] = []
                    if isinstance(catalog_classes, list):
                        for c in catalog_classes:
                            if not isinstance(c, dict):
                                continue
                            cid = str(c.get("class_id") or "").strip()
                            if not cid:
                                continue
                            labels_payload.append(
                                {"class_id": cid, "title": str(c.get("title") or "").strip()}
                            )
                    body_nm = {
                        "description": payload.description,
                        "tnved_code": payload.tnved_code,
                        "existing_classes": [x["class_id"] for x in labels_payload],
                        "existing_class_labels": labels_payload,
                    }
                    try:
                        nm = await client.post(
                            f"{LLM_GENERATOR_URL}/api/v1/suggest-class-name",
                            json=body_nm,
                        )
                        nm.raise_for_status()
                        nm_data = nm.json()
                    except Exception as exc:
                        nm_data = {
                            "suggested_class_name": "GENERATION_FAILED",
                            "mode": "error",
                            "error": str(exc),
                            "requires_expert_confirmation": True,
                        }
                    await push_step(
                        "llm-class-name-suggestion",
                        {
                            **nm_data,
                            "requires_expert_confirmation": True,
                            "explanation_ru": "Имя класса сгенерировано LLM и не применяется к декларации, пока эксперт не подтвердит его в интерфейсе.",
                        },
                    )
                    try:
                        cat = officer_json.get("catalog")
                        rid = None
                        if isinstance(cat, dict) and cat.get("rule_id") is not None:
                            rid = str(cat.get("rule_id")).strip() or None
                        sug = str(nm_data.get("suggested_class_name") or "").strip()
                        fe = officer_json.get("feature_extraction")
                        fe_summary = ""
                        if isinstance(fe, dict):
                            fe_summary = str(fe.get("extracted_document_ru") or "").strip()
                        body_ed: dict[str, Any] = {
                            "category": "class_name_confirmation",
                            "declaration_id": payload.declaration_id,
                            "summary_ru": (
                                f"Подтвердите идентификатор класса для декларации {payload.declaration_id}: «{sug}»"
                            ),
                            "payload": {
                                "source": "orchestrator",
                                "step": "llm-class-name-suggestion",
                                "llm_result": nm_data,
                                "extracted_features_summary_ru": fe_summary,
                            },
                        }
                        if rid:
                            body_ed["rule_id"] = rid
                        pr_ed = await client.post(
                            f"{RULES_ENGINE_URL}/api/expert-decisions",
                            json=body_ed,
                            timeout=30.0,
                        )
                        pr_ed.raise_for_status()
                    except Exception:
                        pass

            await phase("price-validation", "Проверка стоимости", "Сравниваем заявленную стоимость с ориентировочной.")
            price = await client.post(
                f"{PRICE_VALIDATOR_URL}/api/v1/price/validate",
                json={
                    "declaration_id": payload.declaration_id,
                    "description": payload.description,
                    "class_id": class_id,
                    "declared_price": payload.price,
                    "gross_weight_kg": payload.gross_weight_kg,
                    "net_weight_kg": payload.net_weight_kg,
                },
            )
            price.raise_for_status()
            price_json = price.json()
            await push_step("price-validator", price_json)

            await phase("enqueue-clustering", "Фоновая кластеризация", "Ставим задачу кластеризации в очередь.")
            job_id = enqueue_cluster_job(
                {
                    "declaration_id": payload.declaration_id,
                    "description": payload.description,
                    "tnved_code": payload.tnved_code,
                    "final_class": class_id,
                }
            )
            await push_step("enqueue-clustering-job", {"job_id": job_id})
        except httpx.HTTPStatusError as exc:
            sc = exc.response.status_code
            try:
                body = exc.response.json()
            except Exception:
                body = exc.response.text
            if isinstance(body, dict) and "detail" in body:
                detail: Any = body["detail"]
            else:
                detail = body
            if sc in (400, 404, 422, 502):
                raise HTTPException(status_code=sc, detail=detail) from exc
            raise HTTPException(status_code=502, detail=f"rules-engine error {sc}: {detail}") from exc
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"pipeline dependency unavailable: {exc}") from exc

    flow["status"] = "completed"
    flow["summary_ru"] = flow["steps"][0]["result"].get("summary_ru") if flow["steps"] else None
    flow["final_class"] = class_id
    return flow


@app.post("/api/v1/pipeline/validate")
async def validate(payload: ValidationRequest) -> Any:
    return await _run_validate_pipeline(payload)


@app.post("/api/v1/pipeline/validate/stream")
async def validate_stream(payload: ValidationRequest) -> StreamingResponse:
    async def ndjson_bytes() -> AsyncIterator[bytes]:
        q: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        await q.put(
            {
                "event": "phase",
                "code": "stream-start",
                "title": "Запуск валидации ДТ",
                "detail": "Оркестратор принял запрос и начинает выполнение этапов.",
            }
        )

        async def on_phase(code: str, title: str, detail: str) -> None:
            await q.put({"event": "phase", "code": code, "title": title, "detail": detail})

        async def on_step(flow_state: dict[str, Any], step: str, result: Any) -> None:
            await q.put(
                {
                    "event": "partial",
                    "step": step,
                    "result": {
                        "declaration_id": flow_state.get("declaration_id"),
                        "steps": list(flow_state.get("steps") or []),
                        "status": "running",
                    },
                }
            )

        async def runner() -> None:
            try:
                result = await _run_validate_pipeline(payload, on_phase=on_phase, on_step=on_step)
                await q.put({"event": "complete", "result": result})
            except HTTPException as he:
                await q.put(
                    {
                        "event": "error",
                        "status_code": int(he.status_code),
                        "message": _http_exception_detail(he),
                    }
                )
            except Exception as exc:
                await q.put({"event": "error", "status_code": 502, "message": str(exc)})

        task = asyncio.create_task(runner())
        try:
            while True:
                ev = await q.get()
                yield (json.dumps(ev, ensure_ascii=False) + "\n").encode("utf-8")
                if ev.get("event") in ("complete", "error"):
                    break
        finally:
            await task

    return StreamingResponse(ndjson_bytes(), media_type="application/x-ndjson")


@app.get("/api/v1/jobs/{job_id}")
def job_status(job_id: int) -> dict[str, Any]:
    job = get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    return job
```

### 15.2 `services/semantic-search/app/main.py`

```python
from __future__ import annotations

import hashlib
import os
import threading
from typing import Any

import numpy as np
from fastapi import FastAPI
from pydantic import BaseModel, Field
from sentence_transformers import SentenceTransformer

app = FastAPI(title="Semantic search", version="0.2.0")

E5_MODEL_NAME = os.getenv("SEMANTIC_SEARCH_EMBEDDING_MODEL", "intfloat/multilingual-e5-base")
# Для тестов: всегда вести себя как старая заглушка (игнор эталонов).
FORCE_STUB = os.getenv("SEMANTIC_SEARCH_FORCE_STUB", "").strip().lower() in ("1", "true", "yes")
SPACE_MAX_POINTS = max(20, int(os.getenv("SEMANTIC_SEARCH_SPACE_MAX_POINTS", "250")))
CACHE_MAX_ITEMS = max(1, int(os.getenv("SEMANTIC_SEARCH_EMBED_CACHE_MAX_ITEMS", "12")))

_encoder: SentenceTransformer | None = None
_encoder_lock = threading.Lock()
_passage_emb_cache: dict[str, np.ndarray] = {}
_passage_emb_cache_order: list[str] = []
_cache_lock = threading.Lock()


def _get_encoder() -> SentenceTransformer:
    global _encoder
    if _encoder is None:
        with _encoder_lock:
            if _encoder is None:
                _encoder = SentenceTransformer(E5_MODEL_NAME)
    return _encoder


def _make_passage_cache_key(rule_id: str | None, valid: list[tuple[str, str]]) -> str:
    h = hashlib.sha1()
    h.update((rule_id or "").encode("utf-8", errors="ignore"))
    h.update(b"|")
    h.update(E5_MODEL_NAME.encode("utf-8", errors="ignore"))
    h.update(b"|")
    for desc, cid in valid:
        h.update(cid.encode("utf-8", errors="ignore"))
        h.update(b":")
        h.update(desc.encode("utf-8", errors="ignore"))
        h.update(b"\n")
    return h.hexdigest()


def _cache_get(key: str) -> np.ndarray | None:
    with _cache_lock:
        arr = _passage_emb_cache.get(key)
        if arr is None:
            return None
        if key in _passage_emb_cache_order:
            _passage_emb_cache_order.remove(key)
        _passage_emb_cache_order.append(key)
        return arr


def _cache_set(key: str, value: np.ndarray) -> None:
    with _cache_lock:
        _passage_emb_cache[key] = value
        if key in _passage_emb_cache_order:
            _passage_emb_cache_order.remove(key)
        _passage_emb_cache_order.append(key)
        while len(_passage_emb_cache_order) > CACHE_MAX_ITEMS:
            old = _passage_emb_cache_order.pop(0)
            _passage_emb_cache.pop(old, None)


class ReferenceExampleIn(BaseModel):
    description_text: str = ""
    assigned_class_id: str = ""


class SearchRequest(BaseModel):
    description: str
    tnved_code: str | None = None
    similarity_threshold: float | None = None
    rule_id: str | None = None
    reference_examples: list[ReferenceExampleIn] | None = Field(
        default=None,
        description="Эталоны из БД; при непустом списке с текстами — векторный поиск.",
    )


def _stub_response(payload: SearchRequest, *, service_mode: str, note_ru: str) -> dict[str, Any]:
    matched = payload.tnved_code is not None and str(payload.tnved_code).startswith("27")
    similarity = 0.91 if matched else 0.41
    thr = payload.similarity_threshold
    return {
        "matched": matched,
        "similarity": similarity,
        "class_id": "CLASS-27-STUB" if matched else None,
        "similarity_threshold_echo": thr,
        "rule_id": payload.rule_id,
        "service_mode": service_mode,
        "note_ru": note_ru,
        "embedding_model": None,
        "n_reference_examples_total": 0,
        "n_reference_examples_used": 0,
        "feature_space_points": [],
    }


def _project_to_2d(emb: np.ndarray) -> np.ndarray:
    """PCA до 2D через SVD; на выходе shape (n,2)."""
    if emb.ndim != 2 or emb.shape[0] == 0:
        return np.zeros((0, 2), dtype=np.float32)
    x = emb.astype(np.float32, copy=False)
    x = x - np.mean(x, axis=0, keepdims=True)
    if x.shape[0] == 1:
        return np.array([[0.0, 0.0]], dtype=np.float32)
    u, s, _vt = np.linalg.svd(x, full_matrices=False)
    k = min(2, u.shape[1])
    out = np.zeros((x.shape[0], 2), dtype=np.float32)
    out[:, :k] = u[:, :k] * s[:k]
    return out


def _embedding_search(payload: SearchRequest, valid: list[tuple[str, str]]) -> dict[str, Any]:
    """
    valid: list of (description_text, assigned_class_id)
    """
    encoder = _get_encoder()
    query = (payload.description or "").strip()
    passages = [t for t, _ in valid]
    q_emb = encoder.encode([f"query: {query}"], normalize_embeddings=True, show_progress_bar=False)
    cache_key = _make_passage_cache_key(payload.rule_id, valid)
    p_emb = _cache_get(cache_key)
    cache_hit = p_emb is not None
    if p_emb is None:
        p_emb = encoder.encode([f"passage: {p}" for p in passages], normalize_embeddings=True, show_progress_bar=False)
    if isinstance(q_emb, np.ndarray):
        qv = q_emb.astype(np.float32, copy=False)
    else:
        qv = np.array(q_emb, dtype=np.float32)
    if isinstance(p_emb, np.ndarray):
        pv = p_emb.astype(np.float32, copy=False)
    else:
        pv = np.array(p_emb, dtype=np.float32)
    if not cache_hit:
        _cache_set(cache_key, pv)
    sims = (qv @ pv.T).flatten()
    best_i = int(np.argmax(sims))
    best_sim = float(sims[best_i])
    class_id = valid[best_i][1]
    # Для визуализации пространства: ограничиваем число точек самыми похожими к запросу.
    n_all = len(valid)
    keep_n = min(n_all, SPACE_MAX_POINTS)
    top_idx = np.argsort(sims)[::-1][:keep_n]
    kept_emb = pv[top_idx]
    proj_input = np.vstack([qv[0:1], kept_emb])
    xy = _project_to_2d(proj_input)
    feature_space_points: list[dict[str, Any]] = [
        {
            "kind": "query",
            "x": float(xy[0, 0]),
            "y": float(xy[0, 1]),
            "text": query,
            "class_id": None,
            "similarity": 1.0,
        }
    ]
    for k, idx in enumerate(top_idx, start=1):
        feature_space_points.append(
            {
                "kind": "reference",
                "x": float(xy[k, 0]),
                "y": float(xy[k, 1]),
                "text": valid[int(idx)][0],
                "class_id": valid[int(idx)][1],
                "similarity": float(sims[int(idx)]),
            }
        )
    thr = payload.similarity_threshold
    return {
        "matched": True,
        "similarity": best_sim,
        "class_id": class_id,
        "similarity_threshold_echo": thr,
        "rule_id": payload.rule_id,
        "service_mode": "reference_embeddings",
        "note_ru": (
            f"Векторный поиск по эталонам справочника (модель {E5_MODEL_NAME}): "
            f"взята ближайшая по косинусной схожести запись эталона и её класс."
        ),
        "embedding_model": E5_MODEL_NAME,
        "n_reference_examples_total": len(payload.reference_examples or []),
        "n_reference_examples_used": len(valid),
        "best_example_index": best_i,
        "feature_space_points": feature_space_points,
        "feature_space_points_total": n_all + 1,  # + запрос инспектора
        "embeddings_cache_hit": cache_hit,
    }


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "semantic-search"}


@app.on_event("startup")
def _warmup_encoder() -> None:
    if FORCE_STUB:
        return
    def _bg_warmup() -> None:
        try:
            encoder = _get_encoder()
            # Прогрев первого инференса, чтобы не платить cold-start в запросе инспектора.
            encoder.encode(["query: warmup"], normalize_embeddings=True, show_progress_bar=False)
        except Exception:
            # Не роняем сервис, fallback обработается в runtime.
            pass

    # Важно: прогрев не должен блокировать startup/health.
    threading.Thread(target=_bg_warmup, daemon=True).start()


@app.post("/api/v1/search")
def search(payload: SearchRequest) -> dict[str, object]:
    if FORCE_STUB:
        return _stub_response(
            payload,
            service_mode="stub_forced",
            note_ru="Режим принудительной заглушки (SEMANTIC_SEARCH_FORCE_STUB): для тестов без эмбеддингов.",
        )

    raw_list = payload.reference_examples or []
    valid: list[tuple[str, str]] = []
    for ex in raw_list:
        desc = (ex.description_text or "").strip()
        cid = (ex.assigned_class_id or "").strip()
        if desc and cid:
            valid.append((desc, cid))

    if not valid:
        return _stub_response(
            payload,
            service_mode="stub_no_reference_data",
            note_ru=(
                "Нет эталонов с текстом описания в БД для этого справочника — используется тестовая заглушка "
                "(схожесть и класс не из реальных эмбеддингов). Добавьте эталоны в датасет справочника."
            ),
        )

    try:
        return _embedding_search(payload, valid)
    except Exception as exc:
        return _stub_response(
            payload,
            service_mode="stub_embedding_error",
            note_ru=(
                f"Ошибка расчёта эмбеддингов ({exc!s}); для прохождения пайплайна подставлены значения заглушки. "
                "Проверьте логи semantic-search и доступность модели."
            ),
        )
```

### 15.3 `services/llm-naming/app/main.py`

```python
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
```

### 15.4 `services/preprocessing/app/main.py`

```python
from __future__ import annotations

from typing import Any
import json
import os
import shutil
import subprocess
import time
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from app.llm_runtime_bridge import (
    delete_model_request,
    fetch_running_models,
    get_installed_model_names,
    ollama_pull_stream,
    pause_one_model_ram,
    ready_probe,
    unload_other_running_ollama_models,
)
from shared.llm_runtime.compat import ollama_generate
from shared.llm_runtime.config import is_vllm, runtime_base_url

app = FastAPI(title="Preprocessing Service", version="0.1.0")
_MODEL_SETTINGS_FALLBACK = Path(__file__).resolve().parent / "model_runtime_settings.json"
MODEL_SETTINGS_PATH = Path(os.getenv("MODEL_RUNTIME_SETTINGS_PATH", str(_MODEL_SETTINGS_FALLBACK)))
OLLAMA_CONTAINER_NAME = (os.getenv("OLLAMA_CONTAINER_NAME") or "pipeline_ollama").strip()
VLLM_CONTAINER_NAME = (os.getenv("VLLM_CONTAINER_NAME") or "pipeline_vllm").strip()
PREPROCESSING_CONTAINER_NAME = (os.getenv("PREPROCESSING_CONTAINER_NAME") or "pipeline_preprocessing").strip()


class ModelDeployRequest(BaseModel):
    model: str


class ModelActionRequest(BaseModel):
    model: str


class ModelRuntimeSettingsPayload(BaseModel):
    models: dict[str, dict[str, Any]] = Field(default_factory=dict)
    model_config = ConfigDict(extra="ignore")


DEFAULT_MODEL_SETTINGS: dict[str, Any] = {"models": {}}


def _load_model_settings() -> dict[str, Any]:
    if not MODEL_SETTINGS_PATH.exists():
        return dict(DEFAULT_MODEL_SETTINGS)
    try:
        data = json.loads(MODEL_SETTINGS_PATH.read_text(encoding="utf-8"))
    except Exception:
        return dict(DEFAULT_MODEL_SETTINGS)
    if not isinstance(data, dict):
        return dict(DEFAULT_MODEL_SETTINGS)
    models = data.get("models")
    if not isinstance(models, dict):
        models = {}
    return {"models": models}


def _save_model_settings(payload: dict[str, Any]) -> dict[str, Any]:
    MODEL_SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    normalized = {
        "models": payload.get("models") if isinstance(payload.get("models"), dict) else {},
    }
    MODEL_SETTINGS_PATH.write_text(json.dumps(normalized, ensure_ascii=False, indent=2), encoding="utf-8")
    return normalized


def _warm_load_model_into_ram(model: str) -> dict[str, Any]:
    """
    Загрузить веса в память: короткий generate (после pull или если образ уже на диске).
    Остальные модели в RAM выгружаются — в памяти остаётся одна.
    """
    m = model.strip()
    settings = _load_model_settings()
    mcfg = (settings.get("models") or {}).get(m) or {}
    num_ctx = int(mcfg.get("num_ctx", 8192))
    num_predict = min(int(mcfg.get("max_new_tokens", 64)), 128)
    repeat_penalty = float(mcfg.get("repetition_penalty", 1.0))
    temperature = float(mcfg.get("temperature", 0.0))
    enable_thinking = bool(mcfg.get("enable_thinking", False))
    unload_other_running_ollama_models(m)
    out = ollama_generate(
        m,
        "ok",
        num_ctx=num_ctx,
        num_predict=num_predict,
        repeat_penalty=repeat_penalty,
        temperature=temperature,
        enable_thinking=enable_thinking,
        timeout=600.0,
    )
    raw = (out.get("raw_response") or "")[:400]
    slim = {k: v for k, v in out.items() if k != "raw_response"}
    if raw:
        slim["raw_response_preview"] = raw
    return slim


class PreprocessRequest(BaseModel):
    declaration_id: str
    description: str
    tnved_code: str | None = None


class ParseModelJsonRequest(BaseModel):
    """Сырой ответ LLM (в т.ч. с пояснениями и битым JSON)."""

    text: str


class OllamaGenerateRequest(BaseModel):
    model: str
    prompt: str
    num_ctx: int = Field(default=8192, ge=256)
    max_new_tokens: int = Field(default=3904, ge=32)
    repetition_penalty: float = Field(default=1.0, ge=0.5, le=2.0)
    temperature: float = Field(default=0.0, ge=0.0, le=2.0)
    top_p: float | None = Field(default=None, ge=0.0, le=1.0)
    enable_thinking: bool = False


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "preprocessing"}


@app.get("/ready")
def ready() -> dict[str, Any]:
    ok, _probe_url = ready_probe()
    rb = runtime_base_url()
    return {
        "status": "ok" if ok else "degraded",
        "ollama": "ok" if ok else "down",
        "ollama_base_url": rb,
        "llm_backend": "vllm" if is_vllm() else "ollama",
    }


@app.get("/api/v1/models/settings")
def get_model_settings() -> dict[str, Any]:
    return _load_model_settings()


@app.put("/api/v1/models/settings")
def put_model_settings(payload: ModelRuntimeSettingsPayload) -> dict[str, Any]:
    return _save_model_settings(payload.model_dump())


@app.get("/api/v1/models/available")
def get_available_models() -> dict[str, Any]:
    configured = _load_model_settings()
    configured_models = list((configured.get("models") or {}).keys())
    try:
        installed = sorted(get_installed_model_names())
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=f"llm runtime unavailable ({runtime_base_url()}): {exc}",
        ) from exc
    return {
        "installed_models": installed,
        "configured_models": configured_models,
    }


@app.get("/api/v1/models/running")
def get_running_models() -> dict[str, Any]:
    """Ollama: GET /api/ps. vLLM: GET /v1/models (модели, отданные сервером)."""
    return fetch_running_models()


@app.post("/api/v1/models/deploy")
def deploy_model(payload: ModelDeployRequest) -> dict[str, Any]:
    """
    Ollama: при отсутствии тега — pull, затем короткий generate.
    vLLM: pull нет; модель должна быть в /v1/models, затем короткий generate (прогрев).
    """
    model = (payload.model or "").strip()
    if not model:
        raise HTTPException(status_code=400, detail="model is required")
    t0 = time.time()
    pull_log: list[str] = []
    pull_console_lines: list[str] = []
    last_pull_event: dict[str, Any] = {}
    pulled = False
    try:
        installed = get_installed_model_names()
        if model not in installed:
            if is_vllm():
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Модель {model!r} не найдена в {runtime_base_url()}/v1/models. "
                        "Запустите vLLM с этой моделью или исправьте имя (часто HF id)."
                    ),
                )
            pulled = True
            pull_log, last_pull_event, pull_console_lines = ollama_pull_stream(model)
        warm_load = _warm_load_model_into_ram(model)
    except HTTPException:
        raise
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=502, detail=f"ollama http {exc.response.status_code}: {exc.response.text[:500]}") from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"llm runtime unavailable ({runtime_base_url()}): {exc}") from exc
    tail = pull_log[-400:]
    tail_console = pull_console_lines[-400:]
    duration_sec = round(time.time() - t0, 2)
    return {
        "status": "ok",
        "model": model,
        "pulled": pulled,
        "ollama_pull_last_event": last_pull_event if pulled else None,
        "warm_load": warm_load,
        "pull_log": tail,
        "pull_console_lines": tail_console,
        "duration_sec": duration_sec,
    }


@app.post("/api/v1/models/pause")
def pause_model(payload: ModelActionRequest) -> dict[str, Any]:
    model = (payload.model or "").strip()
    if not model:
        raise HTTPException(status_code=400, detail="model is required")
    try:
        data = pause_one_model_ram(model)
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=502, detail=f"ollama http {exc.response.status_code}: {exc.response.text[:500]}") from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"llm runtime unavailable ({runtime_base_url()}): {exc}") from exc
    if is_vllm() and not data:
        data = {"note": "noop: vLLM не поддерживает выгрузку отдельной модели как Ollama keep_alive=0"}
    return {"status": "ok", "model": model, "action": "pause", "ollama_response": data}


@app.post("/api/v1/models/delete")
def delete_model(payload: ModelActionRequest) -> dict[str, Any]:
    model = (payload.model or "").strip()
    if not model:
        raise HTTPException(status_code=400, detail="model is required")
    try:
        data = delete_model_request(model)
    except HTTPException:
        raise
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=502, detail=f"ollama http {exc.response.status_code}: {exc.response.text[:500]}") from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"llm runtime unavailable ({runtime_base_url()}): {exc}") from exc
    return {"status": "ok", "model": model, "action": "delete", "ollama_response": data}


@app.post("/api/v1/parse-model-json")
def parse_model_json(payload: ParseModelJsonRequest) -> dict[str, Any]:
    from app.json_recovery import extract_json_from_response, parse_json_from_model_response

    raw = (payload.text or "").strip()
    if not raw:
        return {"parsed": {}, "extracted_fragment_preview": ""}
    fragment = extract_json_from_response(raw)
    return {
        "parsed": parse_json_from_model_response(raw),
        "extracted_fragment_preview": fragment[:1200],
    }


@app.post("/api/v1/ollama/generate")
def ollama_generate_endpoint(body: OllamaGenerateRequest) -> dict[str, Any]:
    if not (body.model or "").strip():
        raise HTTPException(status_code=400, detail="model is required")
    if not (body.prompt or "").strip():
        raise HTTPException(status_code=400, detail="prompt is required")
    unload_other_running_ollama_models(body.model.strip())
    try:
        return ollama_generate(
            body.model.strip(),
            body.prompt,
            num_ctx=body.num_ctx,
            num_predict=body.max_new_tokens,
            repeat_penalty=body.repetition_penalty,
            temperature=body.temperature,
            top_p=body.top_p,
            enable_thinking=body.enable_thinking,
        )
    except httpx.HTTPStatusError as e:
        tag = "vllm" if is_vllm() else "ollama"
        raise HTTPException(
            status_code=502,
            detail=f"{tag} http {e.response.status_code}: {e.response.text[:500]}",
        ) from e
    except httpx.RequestError as e:
        raise HTTPException(
            status_code=502,
            detail=f"llm unreachable ({runtime_base_url()}): {e}",
        ) from e


@app.post("/api/v1/preprocess")
def preprocess(payload: PreprocessRequest) -> dict[str, object]:
    return {
        "declaration_id": payload.declaration_id,
        "features": {
            "length": len(payload.description),
            "contains_digits": any(ch.isdigit() for ch in payload.description),
            "tnved_hint": payload.tnved_code,
        },
    }


@app.get("/api/v1/diagnostics/ollama-container-logs")
def ollama_container_logs(tail: int = 200) -> dict[str, Any]:
    """
    Хвост stdout/stderr контейнера LLM через `docker logs` (Ollama или vLLM).
    Нужны: docker CLI в образе и доступ к сокету Docker (см. docker-compose: volume docker.sock).
    """
    t = max(20, min(int(tail), 5000))
    name = VLLM_CONTAINER_NAME if is_vllm() else OLLAMA_CONTAINER_NAME
    env_hint = "VLLM_CONTAINER_NAME" if is_vllm() else "OLLAMA_CONTAINER_NAME"
    if not name:
        return {
            "available": False,
            "reason": f"{env_hint} пуст",
            "hint": "Укажите имя контейнера LLM (Ollama или vLLM).",
            "lines": "",
        }
    docker = shutil.which("docker")
    if not docker:
        return {
            "available": False,
            "reason": "docker CLI не найден в образе preprocessing",
            "hint": "На хосте: docker logs pipeline_ollama --tail 200",
            "lines": "",
        }
    try:
        proc = subprocess.run(
            [docker, "logs", "--tail", str(t), name],
            capture_output=True,
            text=True,
            timeout=25,
        )
        combined = (proc.stdout or "") + (proc.stderr or "")
        if proc.returncode != 0 and not combined.strip():
            return {
                "available": False,
                "reason": f"docker logs завершился с кодом {proc.returncode}",
                "hint": "Убедитесь, что у сервиса preprocessing смонтирован /var/run/docker.sock и имя контейнера верно.",
                "lines": proc.stderr or "",
                "container": name,
            }
        return {
            "available": True,
            "container": name,
            "tail": t,
            "lines": combined.strip() if combined.strip() else "(пусто)",
        }
    except subprocess.TimeoutExpired:
        return {"available": False, "reason": "timeout", "lines": "", "hint": f"docker logs {name}"}
    except Exception as exc:
        return {
            "available": False,
            "reason": str(exc),
            "lines": "",
            "hint": f"docker logs {name} --tail {t}",
        }
```

### 15.5 `shared/json_recovery.py`

```python
"""
Устойчивое извлечение и парсинг JSON из ответов LLM.
Логика согласована с LLM_QuantityExtractor_Evaluator (utils.py): extract_json_from_response + parse_json_safe.
"""

from __future__ import annotations

import ast
import json
import re
from typing import Any


def _extract_json_like(s: str) -> str:
    """
    Извлекает JSON-подстроку:
    1) fenced ```json ... ```
    2) иначе — от первой '{' до конца (или '[')
    """
    if not isinstance(s, str):
        return ""

    m = re.search(r"```(?:json)?\s*(.*?)\s*```", s, flags=re.IGNORECASE | re.DOTALL)
    if m:
        return m.group(1).strip()

    s_stripped = re.sub(r"^[\s\*\-#>]+", "", s.lstrip())
    idx = s_stripped.find("{")
    if idx != -1:
        return s_stripped[idx:].strip()
    idx = s_stripped.find("[")
    if idx != -1:
        return s_stripped[idx:].strip()
    return ""


def _autofix_commas(s: str) -> str:
    s = re.sub(r"}\s*{", "}, {", s)
    s = re.sub(r"}\s*\n\s*{", "},\n{", s)
    s = re.sub(r"]\s*{", "], {", s)
    s = re.sub(r",\s*}", "}", s)
    s = re.sub(r",\s*\]", "]", s)
    return s


def _balance_and_close(s: str) -> str:
    depth_obj = 0
    depth_arr = 0
    in_string = False
    escape = False

    for ch in s:
        if ch == "\\" and not escape:
            escape = True
            continue
        elif escape:
            if ch == '"':
                escape = False
                continue
            escape = False

        if ch == '"' and not escape:
            in_string = not in_string
            continue

        if not in_string:
            if ch == "{":
                depth_obj += 1
            elif ch == "}":
                if depth_obj > 0:
                    depth_obj -= 1
            elif ch == "[":
                depth_arr += 1
            elif ch == "]":
                if depth_arr > 0:
                    depth_arr -= 1

    if in_string:
        s = s + '"'
        if re.search(r'[,{]\s*"[^"]*"$', s.rstrip()):
            s = s.rstrip() + ": null"

    s_stripped = s.rstrip()
    if s_stripped:
        last_non_ws = s_stripped[-1]
        if last_non_ws == ":":
            s = s.rstrip() + " null"
        elif last_non_ws == ",":
            s = s_stripped[:-1].rstrip()

    closing = ""
    if depth_arr > 0:
        closing += "]" * depth_arr
    if depth_obj > 0:
        closing += "}" * depth_obj
    if closing:
        s = s + closing
    return s


def parse_json_safe(s: str) -> Any:
    """
    Парсер JSON с автопочинкой и дозакрытием скобок.
    Возвращает dict, list или {} при неудаче.
    """
    if not isinstance(s, str) or not s.strip():
        return {}

    fragment = _extract_json_like(s)
    if not fragment:
        return {}

    s_clean = fragment
    try:
        s_clean = s_clean.replace("\\n", "\n").replace("\\t", "\t").replace("\\r", "\r")
    except Exception:
        pass
    s_clean = s_clean.replace("\r", "").strip()

    s_clean = (
        s_clean.replace("\u201c", '"')
        .replace("\u201d", '"')
        .replace("\u201a", "'")
        .replace("\u2018", "'")
    )
    s_clean = re.sub(r"\bNone\b", "null", s_clean)
    s_clean = _autofix_commas(s_clean)
    s_clean = _balance_and_close(s_clean)
    s_clean = re.sub(r",\s*,+", ",", s_clean)
    s_clean = re.sub(r",\s*}", "}", s_clean)
    s_clean = re.sub(r",\s*\]", "]", s_clean)

    try:
        parsed = json.loads(s_clean)
        if isinstance(parsed, (dict, list)):
            return parsed
        return {}
    except json.JSONDecodeError:
        pass

    s_eval = re.sub(r"\bnull\b", "None", s_clean)
    try:
        data = ast.literal_eval(s_eval)
        if isinstance(data, (dict, list)):
            return data
        return {}
    except Exception:
        pass
    return {}


def extract_json_from_response(response_text: str) -> str:
    """
    Выделяет JSON-часть из ответа модели (маркеры «Ответ:» / fenced block / первая скобка).
    """
    if not response_text:
        return ""

    response_lower = response_text.lower()
    answer_markers = ("ответ:", "answer:")
    for marker in answer_markers:
        last_idx = -1
        search_pos = 0
        while True:
            idx = response_lower.find(marker, search_pos)
            if idx == -1:
                break
            last_idx = idx
            search_pos = idx + 1

        if last_idx != -1:
            json_part = response_text[last_idx + len(marker) :].strip()
            json_part = json_part.lstrip("\n\r\t ")
            json_blocks = list(
                re.finditer(r"```(?:json)?\s*(.*?)\s*```", json_part, flags=re.IGNORECASE | re.DOTALL)
            )
            if json_blocks:
                extracted = json_blocks[-1].group(1).strip()
                if extracted:
                    return extracted
            first_brace = json_part.find("{")
            first_bracket = json_part.find("[")
            start = -1
            if first_brace != -1 and first_bracket != -1:
                start = min(first_brace, first_bracket)
            elif first_brace != -1:
                start = first_brace
            elif first_bracket != -1:
                start = first_bracket
            if start != -1:
                extracted = json_part[start:].strip()
                if extracted:
                    return extracted
            if json_part.strip():
                return json_part

    json_blocks = list(
        re.finditer(r"```(?:json)?\s*(.*?)\s*```", response_text, flags=re.IGNORECASE | re.DOTALL)
    )
    if json_blocks:
        extracted = json_blocks[-1].group(1).strip()
        if extracted:
            return extracted

    first_brace = response_text.find("{")
    first_bracket = response_text.find("[")
    start = -1
    if first_brace != -1 and first_bracket != -1:
        start = min(first_brace, first_bracket)
    elif first_brace != -1:
        start = first_brace
    elif first_bracket != -1:
        start = first_bracket
    if start != -1:
        extracted = response_text[start:].strip()
        if extracted:
            return extracted
    return response_text.strip()


def parse_json_from_model_response(response_text: str) -> Any:
    """Извлечение кандидата + устойчивый парсинг (удобная точка входа для пайплайна)."""
    fragment = extract_json_from_response(response_text)
    return parse_json_safe(fragment)


def is_valid_json_object(s: str) -> bool:
    try:
        parsed = parse_json_safe(s)
        return isinstance(parsed, dict) and bool(parsed)
    except Exception:
        return False
```

### 15.6 `backend/app/api/routes_expert_decisions.py`

```python
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import String, cast, func, or_
from sqlalchemy.orm import Session

from ..db.models import ExpertDecisionItem, RuleVersion
from ..db.session import get_db_session
from ..rules.compiler import compile_rule
from ..rules.dsl_models import RuleDSL

router = APIRouter(prefix="/api/expert-decisions", tags=["expert-decisions"])


class ExpertDecisionCreate(BaseModel):
    category: str = Field(..., min_length=1, max_length=64)
    declaration_id: str = Field(..., min_length=1, max_length=512)
    summary_ru: str = ""
    payload: Dict[str, Any] = Field(default_factory=dict)
    rule_id: Optional[str] = None
    model_config = ConfigDict(extra="ignore")


class ExpertDecisionItemOut(BaseModel):
    id: str
    category: str
    rule_id: Optional[str] = None
    declaration_id: str
    status: str
    summary_ru: str
    payload_json: Dict[str, Any]
    resolution_json: Optional[Dict[str, Any]] = None
    created_at: str
    resolved_at: Optional[str] = None


class ExpertDecisionPatch(BaseModel):
    status: Literal["pending", "resolved", "dismissed"]
    resolution: Dict[str, Any] = Field(default_factory=dict)
    model_config = ConfigDict(extra="ignore")


class ExpertDecisionListPageOut(BaseModel):
    items: List[ExpertDecisionItemOut]
    total: int
    page: int
    page_size: int


def _json_text_path(column: Any, *keys: str) -> Any:
    """Portable JSON path accessor for SQLAlchemy expressions."""
    expr = column
    for key in keys:
        expr = expr[key]
    if hasattr(expr, "as_string"):
        return expr.as_string()
    if hasattr(expr, "astext"):
        return expr.astext
    return cast(expr, String)


def _parse_iso_datetime_or_400(raw: Optional[str], field_name: str) -> Optional[datetime]:
    if raw is None or not str(raw).strip():
        return None
    val = str(raw).strip()
    # FastAPI often passes Zulu timestamps as "...Z"; fromisoformat expects "+00:00".
    if val.endswith("Z"):
        val = f"{val[:-1]}+00:00"
    try:
        return datetime.fromisoformat(val)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Некорректный формат {field_name}; используйте ISO-дату") from exc


def _to_out(row: ExpertDecisionItem) -> ExpertDecisionItemOut:
    return ExpertDecisionItemOut(
        id=str(row.id),
        category=row.category,
        rule_id=str(row.rule_id) if row.rule_id else None,
        declaration_id=row.declaration_id,
        status=row.status,
        summary_ru=row.summary_ru,
        payload_json=row.payload_json,
        resolution_json=row.resolution_json,
        created_at=row.created_at.isoformat() if row.created_at else "",
        resolved_at=row.resolved_at.isoformat() if row.resolved_at else None,
    )


@router.post("", response_model=ExpertDecisionItemOut)
def create_expert_decision(payload: ExpertDecisionCreate, db: Session = Depends(get_db_session)) -> ExpertDecisionItemOut:
    category = payload.category.strip()
    declaration_id = payload.declaration_id.strip()
    rid: Optional[uuid.UUID] = None
    if payload.rule_id and str(payload.rule_id).strip():
        try:
            rid = uuid.UUID(str(payload.rule_id).strip())
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Некорректный rule_id") from exc

    if category == "class_name_confirmation":
        existing_q = db.query(ExpertDecisionItem).filter(
            ExpertDecisionItem.category == "class_name_confirmation",
            ExpertDecisionItem.declaration_id == declaration_id,
            ExpertDecisionItem.status == "pending",
        )
        if rid is not None:
            existing_q = existing_q.filter(ExpertDecisionItem.rule_id == rid)
        existing = existing_q.order_by(ExpertDecisionItem.created_at.desc()).first()
        if existing is not None:
            return _to_out(existing)

    row = ExpertDecisionItem(
        category=category,
        rule_id=rid,
        declaration_id=declaration_id,
        status="pending",
        summary_ru=(payload.summary_ru or "").strip(),
        payload_json=dict(payload.payload),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _to_out(row)


@router.get("", response_model=ExpertDecisionListPageOut)
def list_expert_decisions(
    status: Optional[str] = Query(None, description="pending | resolved | dismissed"),
    category: Optional[str] = Query(None),
    q: Optional[str] = Query(None, description="Поиск по декларации, описанию, коду ТН ВЭД, классу"),
    tnved_prefix: Optional[str] = Query(None, description="Фильтр по ветке ТН ВЭД (префикс кода)"),
    has_class: Optional[bool] = Query(None, description="true = есть класс, false = нет класса"),
    created_from: Optional[str] = Query(None, description="ISO datetime, начало диапазона"),
    created_to: Optional[str] = Query(None, description="ISO datetime, конец диапазона"),
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=100),
    db: Session = Depends(get_db_session),
) -> ExpertDecisionListPageOut:
    query = db.query(ExpertDecisionItem)
    if status and status.strip():
        query = query.filter(ExpertDecisionItem.status == status.strip())
    if category and category.strip():
        query = query.filter(ExpertDecisionItem.category == category.strip())

    created_from_dt = _parse_iso_datetime_or_400(created_from, "created_from")
    created_to_dt = _parse_iso_datetime_or_400(created_to, "created_to")
    if created_from_dt is not None:
        query = query.filter(ExpertDecisionItem.created_at >= created_from_dt)
    if created_to_dt is not None:
        query = query.filter(ExpertDecisionItem.created_at <= created_to_dt)

    tnved_code_expr = _json_text_path(
        ExpertDecisionItem.payload_json,
        "llm_result",
        "prompt_includes",
        "tnved_code",
    )
    if tnved_prefix and tnved_prefix.strip():
        prefix = "".join(ch for ch in tnved_prefix if ch.isdigit())
        if prefix:
            query = query.filter(func.replace(func.coalesce(tnved_code_expr, ""), " ", "").like(f"{prefix}%"))

    chosen_class_expr = _json_text_path(ExpertDecisionItem.resolution_json, "chosen_class_id")
    confirmed_class_expr = _json_text_path(ExpertDecisionItem.resolution_json, "confirmed_class_id")
    class_expr = func.coalesce(chosen_class_expr, confirmed_class_expr, "")
    class_exists = func.length(func.trim(class_expr)) > 0
    if has_class is True:
        query = query.filter(class_exists)
    elif has_class is False:
        query = query.filter(~class_exists)

    if q and str(q).strip():
        search = f"%{str(q).strip().lower()}%"
        description_expr = _json_text_path(
            ExpertDecisionItem.payload_json,
            "llm_result",
            "prompt_includes",
            "description_excerpt",
        )
        query = query.filter(
            or_(
                func.lower(ExpertDecisionItem.declaration_id).like(search),
                func.lower(ExpertDecisionItem.summary_ru).like(search),
                func.lower(ExpertDecisionItem.category).like(search),
                func.lower(func.coalesce(tnved_code_expr, "")).like(search),
                func.lower(func.coalesce(description_expr, "")).like(search),
                func.lower(func.coalesce(class_expr, "")).like(search),
            )
        )

    total = query.count()
    offset = (page - 1) * page_size
    rows = query.order_by(ExpertDecisionItem.created_at.desc()).offset(offset).limit(page_size).all()
    return ExpertDecisionListPageOut(
        items=[_to_out(r) for r in rows],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.patch("/{item_id}", response_model=ExpertDecisionItemOut)
def patch_expert_decision(
    item_id: str,
    body: ExpertDecisionPatch,
    db: Session = Depends(get_db_session),
) -> ExpertDecisionItemOut:
    try:
        uid = uuid.UUID(item_id.strip())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Некорректный id") from exc
    row = db.query(ExpertDecisionItem).filter(ExpertDecisionItem.id == uid).one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Запись не найдена")
    row.status = body.status
    row.resolution_json = dict(body.resolution) if body.resolution else {}
    if body.status == "pending":
        row.resolved_at = None
    else:
        row.resolved_at = datetime.utcnow()
    db.commit()
    db.refresh(row)
    return _to_out(row)


@router.post("/{item_id}/recheck-current-catalog")
def recheck_class_name_decision_with_current_catalog(
    item_id: str,
    db: Session = Depends(get_db_session),
) -> Dict[str, Any]:
    try:
        uid = uuid.UUID(item_id.strip())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Некорректный id") from exc

    row = db.query(ExpertDecisionItem).filter(ExpertDecisionItem.id == uid).one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Запись не найдена")

    if row.category != "class_name_confirmation":
        raise HTTPException(status_code=400, detail="Операция доступна только для category=class_name_confirmation")

    if row.status != "pending":
        return {
            "status": "skipped",
            "resolved": False,
            "reason": f"Запись уже имеет статус {row.status}",
            "item": _to_out(row).model_dump(),
        }

    if row.rule_id is None:
        return {
            "status": "pending",
            "resolved": False,
            "reason": "Для записи не указан rule_id; переклассификация невозможна.",
            "item": _to_out(row).model_dump(),
        }

    payload = row.payload_json if isinstance(row.payload_json, dict) else {}
    llm_result = payload.get("llm_result") if isinstance(payload, dict) else None
    llm_result = llm_result if isinstance(llm_result, dict) else {}
    suggested = str(llm_result.get("suggested_class_name") or "").strip()
    if not suggested:
        return {
            "status": "pending",
            "resolved": False,
            "reason": "В payload отсутствует suggested_class_name.",
            "item": _to_out(row).model_dump(),
        }

    rv: RuleVersion | None = (
        db.query(RuleVersion)
        .filter(RuleVersion.rule_id == row.rule_id, RuleVersion.is_active.is_(True))
        .order_by(RuleVersion.version.desc())
        .first()
    )
    if rv is None:
        return {
            "status": "pending",
            "resolved": False,
            "reason": "Активная версия справочника не найдена.",
            "item": _to_out(row).model_dump(),
        }

    try:
        dsl = RuleDSL.model_validate(rv.dsl_json)
        compiled = compile_rule(dsl)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Ошибка компиляции актуального справочника: {exc}") from exc

    class_ids: set[str] = set()
    if compiled.classification and compiled.classification.rules:
        for r in compiled.classification.rules:
            cid = (r.class_id or "").strip()
            if cid:
                class_ids.add(cid.lower())

    if suggested.lower() in class_ids:
        row.status = "resolved"
        row.resolution_json = {
            "confirmed_class_id": suggested,
            "source": "current_catalog_recheck",
            "auto_resolved": True,
        }
        row.resolved_at = datetime.utcnow()
        db.commit()
        db.refresh(row)
        return {
            "status": "resolved",
            "resolved": True,
            "reason": "Имя класса найдено в актуальном справочнике; запись закрыта автоматически.",
            "item": _to_out(row).model_dump(),
        }

    return {
        "status": "pending",
        "resolved": False,
        "reason": "По актуальному справочнику декларация всё ещё требует решения эксперта.",
        "item": _to_out(row).model_dump(),
    }
```

### 15.7 `backend/app/db/models.py`

```python
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Dict, Optional

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, String, Text, Uuid
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy import JSON

from .base import Base


class Rule(Base):
    __tablename__ = "rules"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    model_id: Mapped[str] = mapped_column(String(255), nullable=False)
    name: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    description: Mapped[Optional[str]] = mapped_column(String(2000), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow, nullable=False)
    is_archived: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    versions: Mapped[list["RuleVersion"]] = relationship(back_populates="rule", cascade="all, delete-orphan")
    few_shot_runs: Mapped[list["FewShotAssistRun"]] = relationship(
        back_populates="rule", cascade="all, delete-orphan"
    )
    reference_examples: Mapped[list["RuleReferenceExample"]] = relationship(
        back_populates="rule", cascade="all, delete-orphan"
    )

    __table_args__ = (
        Index("ix_rules_model_id", "model_id"),
    )


class RuleVersion(Base):
    __tablename__ = "rule_versions"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    rule_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("rules.id", ondelete="CASCADE"), nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    model_id: Mapped[str] = mapped_column(String(255), nullable=False)

    # Сохраняем DSL как JSON.
    dsl_json: Mapped[Dict[str, Any]] = mapped_column(JSON, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow, nullable=False)

    rule: Mapped[Rule] = relationship(back_populates="versions")

    __table_args__ = (
        Index("ix_rule_versions_rule_id_active", "rule_id", "is_active"),
    )


class RuleReferenceExample(Base):
    """
    Эталонные примеры для справочника: текст описания + JSON признаков + класс после детерминированной классификации.
    Используются для последующего сравнения (например, с порогом семантической схожести).
    """

    __tablename__ = "rule_reference_examples"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    rule_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("rules.id", ondelete="CASCADE"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow, nullable=False)
    description_text: Mapped[str] = mapped_column(Text, nullable=False)
    features_json: Mapped[Dict[str, Any]] = mapped_column(JSON, nullable=False)
    assigned_class_id: Mapped[str] = mapped_column(String(512), nullable=False)

    rule: Mapped["Rule"] = relationship(back_populates="reference_examples")

    __table_args__ = (Index("ix_rule_reference_examples_rule_id_created", "rule_id", "created_at"),)


class FewShotAssistRun(Base):
    """Сохранённый ответ few-shot-assist (шлюз) для справочника — история прогонов."""

    __tablename__ = "few_shot_assist_runs"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    rule_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("rules.id", ondelete="CASCADE"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow, nullable=False)
    result_json: Mapped[Dict[str, Any]] = mapped_column(JSON, nullable=False)

    rule: Mapped["Rule"] = relationship(back_populates="few_shot_runs")

    __table_args__ = (Index("ix_few_shot_assist_runs_rule_id_created", "rule_id", "created_at"),)


class AppSetting(Base):
    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(String(128), primary_key=True)
    value_json: Mapped[Dict[str, Any]] = mapped_column(JSON, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow, nullable=False)


class ExpertDecisionItem(Base):
    """
    Очередь решений эксперта по пайплайну: спорная классификация, подтверждение имени класса от LLM и т.д.
    Категории: classification_ambiguous | classification_none | class_name_confirmation | …
    """

    __tablename__ = "expert_decision_items"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    category: Mapped[str] = mapped_column(String(64), nullable=False)
    rule_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        ForeignKey("rules.id", ondelete="SET NULL"),
        nullable=True,
    )
    declaration_id: Mapped[str] = mapped_column(String(512), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="pending")
    summary_ru: Mapped[str] = mapped_column(Text, nullable=False, default="")
    payload_json: Mapped[Dict[str, Any]] = mapped_column(JSON, nullable=False)
    resolution_json: Mapped[Optional[Dict[str, Any]]] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow, nullable=False)
    resolved_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)

    rule: Mapped[Optional["Rule"]] = relationship()

    __table_args__ = (
        Index("ix_expert_decision_items_status_created", "status", "created_at"),
        Index("ix_expert_decision_items_category_status", "category", "status"),
        Index("ix_expert_decision_items_created_at", "created_at"),
        Index("ix_expert_decision_items_declaration_id", "declaration_id"),
    )
```

### 15.8 `frontend/src/expert/featureExtractionPromptGenerator.ts`

```typescript
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Сборка запроса к LLM, который генерирует системный промпт для извлечения признаков
 * по данным справочника (numeric_characteristics_draft).
 *
 * Параметры вызова LLM для генератора (temperature, num_ctx, …): JSON
 * `services/api-gateway/config/prompt_generator.json` или `PROMPT_GENERATOR_CONFIG_PATH`.
 * Обзор: раздел «Генерация системного промпта извлечения признаков» в корневом README.md.
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
  metaInstructionText?: string;
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
    if (!k) continue;
    if (c.layout === "scalar") {
      allowedBlocks.push(
        `Числовое поле на корне документа (одно значение, не массив): ключ «${k}».`,
      );
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
      allowedBlocks.push(`Примеры допустимых значений поля «${k}» (одно текстовое значение на корне):`);
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

  const metaInstructionText = String(overrides?.metaInstructionText ?? FEATURE_EXTRACTION_PROMPT_GENERATOR_META).trim();
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
```

### 15.9 `services/llm-naming/config/class_naming_prompt.txt`

```text
Ты помогаешь завести имя нового класса товара в таможенном справочнике.
Ниже — описание товара, для которого детерминированная классификация не выбрала класс (или сработала ветка низкой семантической схожести).
Учти код ТН ВЭД и не повторяй уже существующие идентификаторы классов.
Важно: предлагай не код ТН ВЭД и не цифровой шифр, а смысловое имя класса по аналогии с существующими классами.

Расшифровка кода ТН ВЭД: {tnved_decoded}

Уже существующие классы по этому справочнику:
{catalog_block}

Описание товара неизвестного класса:
{description}

Ответ: одна строка — краткое имя класса в стиле справочника: обычно 1-3 слов.
Запрещено: чисто цифровой ответ, код ТН ВЭД
Отвечай без кавычек, пояснений и без markdown.
```

### 15.10 `services/api-gateway/config/prompt_generator.json`

```json
{
  "num_ctx": 8192,
  "max_new_tokens": 3904,
  "temperature": 0.22,
  "repetition_penalty": 1.0,
  "top_p": null,
  "enable_thinking": false
}
```

### 15.11 `shared/llm_runtime/config.py`

```python
from __future__ import annotations

import os
from typing import Literal

LLMBackend = Literal["ollama", "vllm"]


def llm_backend() -> LLMBackend:
    raw = (os.getenv("LLM_BACKEND") or "ollama").strip().lower()
    if raw in ("vllm", "v-llm"):
        return "vllm"
    return "ollama"


def is_vllm() -> bool:
    return llm_backend() == "vllm"


def ollama_base_url() -> str:
    return (os.getenv("OLLAMA_BASE_URL") or "http://127.0.0.1:11434").rstrip("/")


def vllm_base_url() -> str:
    return (os.getenv("VLLM_BASE_URL") or "http://127.0.0.1:8000").rstrip("/")


def runtime_base_url() -> str:
    return vllm_base_url() if is_vllm() else ollama_base_url()
```

