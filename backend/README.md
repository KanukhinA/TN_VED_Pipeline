# Backend: Rule Builder and Validator

## Что делает этот модуль

`backend` - это сервис правил для валидации и классификации товарных данных (например, нормализованных данных из документов по ТН ВЭД).  
Он решает три основные задачи:

- хранит и версионирует правила в формате `RuleDSL`;
- компилирует DSL в исполняемую Pydantic-модель с ограничениями;
- валидирует входные данные, проверяет кросс-правила и возвращает класс.

Бизнес-поток такой:

- в UI/интеграции создается или редактируется правило (DSL);
- DSL сохраняется в БД как новая активная версия;
- при проверке данных backend достает активную версию, компилирует (или берет из кеша) и выполняет проверку;
- в ответ возвращаются `ok/errors`, нормализованные данные и `assigned_class`.

## ну 

Зависимости зафиксированы в `backend/requirements.docker.txt`.

## Архитектура backend

- `app/main.py` - создание FastAPI-приложения, startup-инициализация БД;
- `app/api/routes_rules.py` - REST API для правил (CRUD, версии, validate, архив);
- `app/db/models.py` - сущности `Rule` и `RuleVersion`;
- `app/db/session.py` - подключение к БД и сессии SQLAlchemy;
- `app/rules/dsl_models.py` - схема DSL;
- `app/rules/compiler.py` - компиляция DSL -> исполняемая валидация;
- `app/rules/cross_rules.py` - кросс-полевые проверки;
- `app/rules/classification.py` - определение `class_id`;
- `app/pipeline/validator.py` - удобный API для пакетного использования с кешем компиляции;
- `tests/` - unit-тесты бизнес-логики.

## Модель данных и версионирование

### `Rule`

Карточка справочника/правила:

- `id`;
- `model_id`;
- `name`, `description`;
- `is_archived`;
- `created_at`.

### `RuleVersion`

Конкретная версия DSL:

- `rule_id` (FK к `Rule`);
- `version` (монотонно растет);
- `is_active` (только одна активная версия);
- `dsl_json` (снимок DSL);
- `model_id`, `created_at`.

При обновлении существующего справочника backend деактивирует текущую версию и создает новую активную.

## API (основные endpoints)

### Схемы и примеры

- `GET /api/rules/dsl-schema` - JSON Schema для DSL;
- `GET /api/rules/example/fertilizer` - пример DSL и данных.

### Справочники/правила

- `GET /api/rules` - список активных правил (`q`, `include_archived`);
- `GET /api/rules/{rule_id}` - активная версия правила;
- `POST /api/rules` - создать новый справочник (первая версия);
- `PUT /api/rules/{rule_id}` - обновить существующий справочник (новая версия);
- `POST /api/rules/{rule_id}/save` - совместимый маршрут обновления (аналог update);
- `POST /api/rules/{rule_id}/clone` - клонировать в новый `rule_id`;
- `POST /api/rules/{rule_id}/archive` - архивировать;
- `POST /api/rules/{rule_id}/unarchive` - восстановить из архива;
- `DELETE /api/rules/{rule_id}` - удалить.

### Проверка данных

- `POST /api/rules/{rule_id}/validate` - валидировать payload по активной версии.

Swagger UI: `http://localhost:8000/docs`.

## Как работает валидация

Этапы выполнения:

- структурная валидация по схеме DSL (динамическая Pydantic-модель);
- нормализация enum-значений (для строковых ограничений);
- кросс-правила (`sumEquals`, `requiredIf`, `atLeastOnePresent` и т.п.);
- классификация (выбор `class_id`, если описана секция classification).

Результат:

- `ok: bool`;
- `errors: list`;
- `validated_data: dict | null`;
- `assigned_class: str | null`.

## Использование в Python-пайплайне

Для массовой валидации используйте `app/pipeline/validator.py`:

```python
import uuid
from sqlalchemy.orm import Session
from app.pipeline.validator import validate_with_rule

ok, errors, validated_data, assigned_class = validate_with_rule(
    rule_id=uuid.UUID("..."),
    data=declaration_dict,
    db=session,
)
```

Внутри используется `CompiledRuleCache` (in-memory), чтобы не компилировать DSL заново для каждой записи.

## Запуск через Docker Compose

Из корня репозитория:

- первый запуск / после изменения зависимостей:

```bash
docker compose up --build
```

- обычный повторный запуск:

```bash
docker compose up
```

- пересборка конкретных сервисов:

```bash
docker compose build backend frontend
docker compose up -d backend frontend
```

- с принудительной пересборкой без кеша:

```bash
docker compose build --no-cache
docker compose up
```

## Полезные команды эксплуатации

- логи backend:

```bash
docker compose logs -f backend
```

- остановка контейнеров:

```bash
docker compose down
```

- полный сброс с удалением volume БД:

```bash
docker compose down -v
```

## Локальная разработка без Docker (опционально)

Примерный запуск:

```bash
cd backend
pip install -r requirements.docker.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Параметр БД берется из `DATABASE_URL` (см. `app/db/session.py`), при отсутствии используется sqlite по умолчанию.

## Тесты

Запуск из `backend`:

```bash
pytest -q
```

## Границы ответственности модуля

Этот backend:

- не извлекает данные из документов сам;
- не строит UI;
- не решает задачи ETL/парсинга исходных файлов.

Он принимает уже подготовленный JSON и применяет к нему версионируемые правила валидации/классификации.

