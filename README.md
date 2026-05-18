# Pipeline

**Автоматическая проверка и классификация таможенных деклараций** — извлечение признаков из описания товара, сопоставление со справочником правил, семантический поиск по эталонам, проверка стоимости и экспертный контур для спорных случаев.

> Рабочий прототип (MVP) для отладки архитектуры, бизнес-логики и интерфейсов ролей **инспектор** и **эксперт**. Часть внешних интеграций и фоновых сценариев реализована в упрощённом виде.

---

## Содержание

- [Возможности](#возможности)
- [Архитектура](#архитектура)
- [Стек](#стек)
- [Быстрый старт](#быстрый-старт)
- [Сервисы и порты](#сервисы-и-порты)
- [Конфигурация](#конфигурация)
- [Разработка](#разработка)
- [Документация](#документация)
- [Лицензия и статус](#лицензия-и-статус)

---

## Возможности

| Область | Что делает система |
|--------|---------------------|
| **Проверка ДТ** | Принимает данные декларации и прогоняет их по цепочке микросервисов |
| **Классификация** | Определяет класс товара по DSL-правилам справочника; при неоднозначности — по приоритету |
| **Семантика** | kNN по эмбеддингам эталонов: \(P(c) = V_{\mathrm{best}}(c) \cdot V_w(c) / (\varepsilon + \sum w_j)\) |
| **Контроль описания** | Выявляет противоречия в тексте и числовых характеристиках |
| **Экспертиза** | Передаёт спорные случаи в очередь эксперта; обновление правил и таксономии |
| **Стоимость** | Шаг сверки цены в общем пайплайне (в прототипе — упрощённая заглушка) |

Подробные правила классификации в справочнике — в [`docs/README-klassifikaciya-spravochnika.md`](docs/README-klassifikaciya-spravochnika.md).

---

## Архитектура

Два веб-интерфейса (эксперт и инспектор) обращаются к **API Gateway**, который координирует **оркестратор** проверки декларации. Оркестратор вызывает предобработку (LLM), движок правил, семантический поиск, именование классов и проверку цены. Состояние правил и настроек хранится в **PostgreSQL**.

```mermaid
flowchart TD
    %% Настройки оформления
    %%{init: {'theme': 'base', 'fontSize': '18px', 'layoutDirection': 'TD'}}%%

    %% Стилизация узлов
    classDef input fill:#f9f,stroke:#333,stroke-width:2px;
    classDef process fill:#e1f5fe,stroke:#0277bd,stroke-width:2px;
    classDef decision fill:#fff9c4,stroke:#fbc02d,stroke-width:2px;
    classDef output fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px;
    classDef alert fill:#ffebee,stroke:#c62828,stroke-width:2px,stroke-dasharray: 5 5;
    classDef expert fill:#e0f7fa,stroke:#00838f,stroke-width:3px,stroke-dasharray: 3 3;

    %% Стилизация блоков
    classDef realtimeBlock fill:#f1f8e9,stroke:#1b5e20,stroke-width:3px,stroke-dasharray: none;
    classDef expertBlock fill:#fff3e0,stroke:#e65100,stroke-width:3px,stroke-dasharray: 5 3;
    classDef priceBlock fill:#e3f2fd,stroke:#0d47a1,stroke-width:3px,stroke-dasharray: none;

    %% Точка входа
    DictCheck{Есть справочник<br/>для категории?}:::decision
    VerifiedCode[Подтверждённый код ТН ВЭД]
    %% === БЛОК 1: Real-time для таможенника ===
    subgraph Block1 ["БЛОК 1: Real-time валидация (Таможенник)"]
        direction TB
        class Block1 realtimeBlock

        Mod3[Модуль 3: Извлечение признаков]:::process
        Mod4[Модуль 4: Детерминированная классификация]:::process
        RuleMatch{Совпадение с<br/>классом из справочника?}:::decision
        Mod5[Модуль 5: Семантический поиск]:::process
        SimCheck{Схожесть > Порога?}:::decision
        RuleMatch2{Числовые характеристики противоречат правилам?}:::decision
        Alert[Описание некорректно]:::alert
        ClassFound((Класс найден)):::output
        SaveDB[Сохранение в БД]:::output
    end

    %% === БЛОК 2: Экспертная обработка (офлайн) ===
    subgraph Block2 ["БЛОК 2: Экспертная оценка (офлайн-режим)"]
        direction TB
        class Block2 expertBlock

        RulesCreation[Модуль 9: Создание правил экспертами]:::expert
        Mod6[Модуль 6: LLM-генерация имени класса]:::process
        CheckClusters{Кластеры сформированы?}:::decision
        SemClusterCheck{Схожесть > Порога?<br/>с кластерами}:::decision
        Mod7[Модуль 7: Сборка кластеров]:::process
        Mod8[Модуль 8: Генерация имён кластеров]:::process
        ExpertValidateGen{Валидация экспертом}:::expert
        TaxonomySaved[Таксономия обновлена]:::output
        DeclAnalysis[Анализ таможенной декларации экспертом]:::expert
        DeclDecision{Решение эксперта}:::decision
        DeclInvalid[Декларация признана некорректной]:::alert
    end

    %% === БЛОК 3: Проверка стоимости ===
    subgraph Block3 ["БЛОК 3: Сопоставление с расценкой"]
        direction TB
        class Block3 priceBlock

        PriceCheck[Модуль 10: Проверка стоимости]:::process
        PriceMatch{Стоимость соответствует<br/>декларации?}:::decision
        PriceOK[Стоимость подтверждена]:::output
        PriceMismatch[Стоимость не соответствует: Декларация некорректна]:::alert
    end

    %% === Логика маршрутизации ===
    DictCheck -->|ДА: справочник есть| Mod3
    DictCheck -->|НЕТ: справочника нет| CheckClusters
    Mod3 --> |Признаки | Mod4
    Mod4 --> RuleMatch
    RuleMatch -- ДА --> ClassFound
    RuleMatch -- НЕТ --> Mod5
    Mod5 --> SimCheck
    SimCheck -- ДА --> RuleMatch2
    RuleMatch2 -- ДА: противоречие --> Alert
    RuleMatch2 -- НЕТ: всё ок --> ClassFound
    SimCheck -- НЕТ: не найдено --> Mod6
    Alert -.->|Требуется анализ| DeclAnalysis
    Mod6 --> DeclAnalysis
    VerifiedCode -.->|Подсказка | Mod6
    VerifiedCode -.-> |Категория товара| Mod3
    CheckClusters -- Да --> SemClusterCheck
    SemClusterCheck -- ДА: похоже --> ExpertValidateGen
    SemClusterCheck -- НЕТ: новое --> Mod7
    CheckClusters -- Нет --> Mod7
    Mod7 --> Mod8
    Mod8 --> ExpertValidateGen
    ExpertValidateGen -- Одобрено --> TaxonomySaved
    ExpertValidateGen -- Кластеризация отклонена --> RulesCreation
    TaxonomySaved -.->|Данные| RulesCreation
    RulesCreation -.->|Обновление справочника| Mod4
    DeclAnalysis --> DeclDecision
    DeclDecision -.->|Обновление справочника| RulesCreation
    DeclDecision -- Признать некорректной --> DeclInvalid
    ClassFound --> SaveDB
    SaveDB --> PriceCheck
    PriceCheck --> PriceMatch
    PriceMatch -- ДА --> PriceOK
    PriceMatch -- НЕТ --> PriceMismatch
```

### Сервисы в Docker Compose

| Сервис | Контейнер | Роль |
|--------|-----------|------|
| `postgres` | `pipeline_postgres` | Правила, настройки, очередь кластеризации |
| `ollama` | `pipeline_ollama` | Локальные LLM для предобработки и именования |
| `backend` | `pipeline_rules_engine` | CRUD справочника, классификация по DSL |
| `semantic-search` | `pipeline_semantic_search` | kNN по эмбеддингам (`sentence-transformers`) |
| `llm-naming` | `pipeline_llm_naming` | Предложение имени класса (Ollama / vLLM) |
| `preprocessing` | `pipeline_preprocessing` | Извлечение признаков из текста ДТ |
| `price-validator` | `pipeline_price_validator` | Шаг проверки стоимости |
| `clustering-service` | `pipeline_clustering_service` | Кластеризация эталонов (k-means) |
| `orchestrator` | `pipeline_orchestrator` | Сценарий проверки декларации |
| `api-gateway` | `pipeline_api_gateway` | Единая точка входа для UI |
| `frontend-expert` | `pipeline_frontend_expert` | UI эксперта (nginx + React) |
| `frontend-officer` | `pipeline_frontend_officer` | UI инспектора (nginx + React) |

Конфигурация пайплайна: [`services/api-gateway/config/pipeline.json`](services/api-gateway/config/pipeline.json) (тот же файл смонтирован в оркестратор).

**Тома:** `pgdata` — база; `ollama_data` — модели. Порт Postgres **5432** проброшен на хост для локальной разработки backend без Docker.

**GPU:** для кластеризации можно наложить [`docker-compose.clustering-gpu.yml`](docker-compose.clustering-gpu.yml) (нужны NVIDIA Container Toolkit). У `ollama` в compose по умолчанию `gpus: all` — на CPU-only хосте строку следует убрать.

---

## Стек

| Слой | Технологии |
|------|------------|
| **API** | Python 3, FastAPI, Uvicorn, Pydantic v2 |
| **Данные** | PostgreSQL 16, SQLAlchemy 2 (backend), psycopg2 |
| **ML / NLP** | Ollama / vLLM (`shared/llm_runtime`), sentence-transformers, scikit-learn |
| **Frontend** | React, TypeScript, Vite → статика за nginx |
| **Инфра** | Docker Compose |

---

## Быстрый старт

### Требования

- [Docker Engine](https://docs.docker.com/engine/install/) и Docker Compose v2
- ~8+ ГБ RAM (PostgreSQL + Ollama + эмбеддинги)
- Для GPU: NVIDIA-драйвер и [Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html)

### 1. Клонирование и переменные

```bash
git clone <URL_репозитория>
cd Pipeline
```

Создайте `.env` рядом с `docker-compose.yml` (в git не коммитится):

```env
POSTGRES_PASSWORD=сложный_секрет
OLLAMA_MODEL=llama3.1:8b
# LLM_BACKEND=ollama
# VITE_API_BASE=http://<хост>:8000/api   # при доступе не с localhost
```

### 2. Сборка и запуск

```bash
docker compose build
docker compose up -d
docker compose ps
```

Полная пересборка без кэша (после крупных изменений):

```bash
docker compose build --no-cache
docker compose up -d --force-recreate
```

### 3. Модель Ollama

```bash
docker compose exec ollama ollama pull llama3.1:8b
docker compose exec ollama ollama list
```

Если `ollama` не стартует из‑за GPU:

```bash
# уберите gpus: all в docker-compose.yml, затем:
docker compose up -d ollama
```

### 4. Интерфейсы

| URL | Назначение |
|-----|------------|
| http://localhost:8081 | Эксперт — правила, модели, очередь решений |
| http://localhost:8082 | Инспектор — прогон декларации |
| http://localhost:8000 | API Gateway (`/api`, `/ready`, `/health`) |

### 5. Проверка

```powershell
# Windows PowerShell
Invoke-RestMethod -Uri "http://localhost:8000/ready" | ConvertTo-Json -Depth 6
Invoke-RestMethod -Uri "http://localhost:8000/health"

$body = @{
  declaration_id = "DT-TEST-001"
  description    = "Карбамид гранулированный 46% азота"
  tnved_code     = "3102101000"
} | ConvertTo-Json

Invoke-RestMethod -Uri "http://localhost:8000/api/validate" `
  -Method Post -ContentType "application/json" -Body $body | ConvertTo-Json -Depth 8
```

```bash
# Linux / macOS
curl -s http://localhost:8000/ready | jq .
curl -s -X POST http://localhost:8000/api/validate \
  -H 'Content-Type: application/json' \
  -d '{"declaration_id":"DT-TEST-001","description":"Карбамид гранулированный 46% азота","tnved_code":"3102101000"}' | jq .
```

### Остановка

```bash
docker compose down          # контейнеры остановлены, тома сохранены
docker compose down -v       # + удаление pgdata и ollama_data
```

### Обновление на сервере

```bash
git pull
docker compose build
docker compose up -d
docker compose ps
curl -s http://localhost:8000/ready
```

---

## Сервисы и порты

| Порт | Сервис |
|------|--------|
| 8081 | `frontend-expert` |
| 8082 | `frontend-officer` |
| 8000 | `api-gateway` |
| 8003 | `orchestrator` |
| 8004 | `preprocessing` |
| 8005 | `backend` (движок правил) |
| 8001 | `semantic-search` |
| 8002 | `llm-naming` |
| 8006 | `price-validator` |
| 8007 | `clustering-service` |
| 5432 | `postgres` |
| 11434 | `ollama` |

---

## Конфигурация

### Модели извлечения признаков

Файл [`config/llm_models.json`](config/llm_models.json) — список моделей и параметры генерации. Его читают backend и `preprocessing` (путь в контейнере: `FEATURE_EXTRACTION_MODEL_DEFAULTS_PATH` / `MODEL_RUNTIME_SETTINGS_PATH`).

После первого сохранения через UI настройки дублируются в PostgreSQL; файл в репозитории остаётся эталоном для новых стендов.

### Семантический fallback

Пороги τ₁, τ₂, пол \(s_0\), γ и промпт чистки текста — в UI эксперта (настройки семантики) и через API backend. Формула поддержки класса реализована в [`services/semantic-search/app/main.py`](services/semantic-search/app/main.py).

### Справочник ТН ВЭД

Дерево кодов для UI: `frontend/src/catalog/tnVedChildren.generated.ts`.

```bash
# положите data/ТН ВЭД.xlsx, затем из корня репозитория:
python scripts/build_tn_ved_tree_from_xlsx.py --help
```

### Переменные окружения (выборочно)

| Переменная | Где | Смысл |
|------------|-----|--------|
| `DATABASE_URL` | backend | PostgreSQL (`postgresql+psycopg2://…`) |
| `LLM_BACKEND` | preprocessing, llm-naming | `ollama` (по умолчанию) или `vllm` |
| `OLLAMA_BASE_URL` | preprocessing, llm-naming | URL Ollama |
| `SEMANTIC_SEARCH_EMBEDDING_MODEL` | semantic-search | Модель эмбеддингов |
| `SEMANTIC_SEARCH_FORCE_STUB` | semantic-search | `1` — заглушка без модели |
| `VITE_API_BASE` | сборка frontend | Базовый URL API для браузера |

---

## Разработка

### Backend локально

```bash
docker compose up -d postgres   # или весь compose
cd backend
pip install -r requirements.docker.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

`DATABASE_URL` по умолчанию — в [`backend/app/db/session.py`](backend/app/db/session.py).

### Frontend локально

```bash
cd frontend
npm install
npm run dev        # разработка
npm test           # vitest
npm run build      # production-бандл
```

Режим UI задаётся `VITE_UI_MODE=expert|officer` (в Docker — build-args в compose).

### Тесты

```bash
cd backend && pytest
cd frontend && npm test
cd services/orchestrator && pytest
```

---

## Документация

| Документ | Описание |
|----------|----------|
| [`docs/README-klassifikaciya-spravochnika.md`](docs/README-klassifikaciya-spravochnika.md) | Правила классификации в справочнике (DSL, условия, приоритеты) |
| [`docs/architecture/backend-oop-transition.md`](docs/architecture/backend-oop-transition.md) | Переход backend на слои application / infrastructure |
| [`docs/architecture/class-diagrams/`](docs/architecture/class-diagrams/) | PlantUML-диаграммы классов (для разработчиков) |
| [`backend/README.md`](backend/README.md) | API движка правил |
| [`docker-compose.yml`](docker-compose.yml) | Источник правды по сервисам и томам |

---

## Лицензия и статус

Проект дипломной / исследовательской разработки. Лицензия в репозитории не указана — уточняйте у авторов перед использованием вне учебного контура.

**Статус:** активный MVP; API и схемы данных могут меняться без semver-гарантий.
