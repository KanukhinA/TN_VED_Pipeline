# Pipeline

Схема модулей и потоков обработки (Mermaid).

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

## Декомпозиция на микросервисы

Ниже — предлагаемое разбиение по **границам изменения, нагрузки и команды**: что выносить в отдельный деплой, а что оставить в одном процессе на раннем MVP.

| Модули схемы | Микросервис | Зачем отдельно |
|--------------|-------------|----------------|
| **М3** Извлечение признаков | `feature-extraction` | Свой жизненный цикл моделей/NLP, частые обновления без перезапуска правил. |
| **М4** Детерминированная классификация + **М9** Правила экспертов | `rule-engine` | DSL, версии справочников, компиляция правил; единый источник истины для «жёсткой» классификации. |
| **М5** Семантический поиск | `semantic-search` | Векторный индекс, иные ресурсы (GPU/память), смена эмбеддингов. |
| **М6**, **М8** (имена классов и кластеров) | `llm-service` | Вызовы внешнего LLM, таймауты, ключи, политика ретраев; общий контур для двух сценариев. |
| **М7** Сборка кластеров (+ оркестрация **М8**) | `taxonomy-clustering` | Пакетные job’ы, офлайн-режим, отдельно от real-time ветки. |
| Декларации, решения эксперта, очереди «на разбор» | `expert-workflow` | BFF/API для экспертного UI, статусы кейсов, связь с правилами и таксономией. |
| **М10** Проверка стоимости | `pricing-validation` | Интеграция с прайсами/тарифами, свой SLA и кэш. |
| Сквозной сценарий Блок 1 → 3 | `pipeline-orchestrator` | Один вход для таможни: порядок М3→М4→М5→М6→сохранение→М10. |
| UI | `frontend` | SPA + nginx. |

**Хранилища:** реляционная БД для правил/деклараций/аудита (PostgreSQL), векторный слой для семантического поиска (pgvector или Qdrant). Для офлайн-веток при росте нагрузки — брокер сообщений.

## Контекстная диаграмма

```plantuml
@startuml
!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Container.puml

title System Context: Automated Classification System

Person(customsOfficer, "Таможенник", "Проверяет декларации на границе")
Person_Ext(declarant, "Декларант", "Подает ДТ")
Person_Ext(expert, "Эксперт", "Настраивает правила классификации")

System(SystemAA, "Система классификации", "Автоматическая валидация ДТ")
System_Ext(SystemF, "Валидация цен", "Внешний сервис ФТС")
System_Ext(SystemC, "ФТС/ФНС", "Контролирующие органы")
SystemDb_Ext(SystemE, "Исторические ДТ", "Архив для аналитики")

Rel(declarant, customsOfficer, "Декларация")
Rel(customsOfficer, SystemAA, "Отправляет декларацию")
Rel(SystemAA, customsOfficer, "Статус валидации")
Rel(expert, SystemAA, "Настраивает правила")
Rel(SystemAA, expert, "Запрос на ручную валидацию")
Rel(SystemAA, SystemF, "Проверка цены")
Rel(SystemF, SystemC, "Отчёт по валидации")
Rel(SystemAA, SystemC, "Передача результатов")
Rel(SystemAA, SystemE, "Сохранение истории")
Rel(SystemC, declarant, "Проверка/штрафы", "пост-контроль")
@enduml
```

## Запуск MVP-контурa (test mode)

### 1) Сборка и старт

```powershell
docker compose build
docker compose up -d
docker compose ps
```

### 2) Ollama и модель

```powershell
docker compose exec ollama ollama pull llama3.1:8b
```

Если сервис не поднят:

```powershell
docker compose up -d ollama
```

### 3) Порты сервисов

- `8081` - `frontend-expert` (Expert UI, nginx)
- `8082` - `frontend-officer` (Officer UI, nginx)
- `8000` - `api-gateway`
- `8003` - `orchestrator`
- `8004` - `preprocessing`
- `8005` - `backend` (`rules-engine`)
- `8001` - `semantic-search`
- `8002` - `llm-naming` (`llm-generator`)
- `8006` - `price-validator`
- `8007` - `clustering-service`
- `11434` - `ollama`

### 4) Health/Ready проверки

```powershell
Invoke-RestMethod -Uri "http://localhost:8000/ready" | ConvertTo-Json -Depth 6
Invoke-RestMethod -Uri "http://localhost:8000/health"
Invoke-RestMethod -Uri "http://localhost:8003/health"
Invoke-RestMethod -Uri "http://localhost:8007/ready"
```

### 5) Smoke test сквозного пайплайна

```powershell
$body = @{
  declaration_id = "DT-TEST-001"
  description    = "Карбамид гранулированный 46% азота"
  tnved_code     = "3102101000"
} | ConvertTo-Json

Invoke-RestMethod -Uri "http://localhost:8000/api/validate" `
  -Method Post -ContentType "application/json" -Body $body | ConvertTo-Json -Depth 8
```

Проверка статуса фоновой job:

```powershell
Invoke-RestMethod -Uri "http://localhost:8000/api/jobs/1" | ConvertTo-Json -Depth 8
```

### 6) Остановка

```powershell
docker compose down
```

С удалением volume БД (полный сброс тестовых данных):

```powershell
docker compose down -v
```

## Развёртывание на сервере

### Требования к хосту

- Docker Engine + `docker compose`
- Ресурсы под PostgreSQL и Ollama (RAM/диск)

### Подготовка

Создайте `.env` рядом с `docker-compose.yml`:

```env
POSTGRES_PASSWORD=сложный_секрет
OLLAMA_MODEL=llama3.1:8b
# OLLAMA_BASE_URL=http://адрес:11434
```

Секреты не храните в Git.

### Базовый запуск

```powershell
docker compose build
docker compose up -d
docker compose ps
```

### Обновление

```powershell
git pull
docker compose build
docker compose up -d
```

### Минимальные проверки после деплоя

- `docker compose ps`
- `Invoke-RestMethod http://<host>:8000/ready`
- `docker compose exec ollama ollama list`

## Контейнерная диаграмма (MVP)

```plantuml
@startuml
!include <C4/C4_Container>

left to right direction
title Система валидации ДТ (Контейнерная диаграмма)

Boundary(SystemBoundary, "") {
    Container(ExpertUI, "Интерфейс эксперта", "React + TS", "Управление правилами")
    Container(OfficerUI, "Интерфейс инспектора", "React + TS", "Прогон ДТ, мониторинг")
    Container(Nginx, "Nginx", "Reverse Proxy", "Статика, SSL, проксирование /api")
    Container(ApiGateway, "Шлюз API", "FastAPI", "Auth, Rate Limit, Маршрутизация")
    Container(Orchestrator, "Оркестратор", "FastAPI", "Координация пайплайна")
    Container(PreprocessingSvc, "Сервис предобработки", "FastAPI + Ollama", "Сегментация + Валидация + Признаки")
    Container(RulesEngine, "Движок правил", "FastAPI", "Классификация, CRUD")
    Container(SemanticSearch, "Семантический поиск", "FastAPI", "Поиск (pgvector)")
    Container(LlmGenerator, "Генерация классов", "FastAPI + Ollama", "Генерация названий")
    Container(PriceValidator, "Проверка стоимости", "FastAPI", "Сверка с ценами ФТС")
    Container(ClusteringService, "Сервис кластеризации", "FastAPI + PyTorch", "Офлайн ML Worker")
    ContainerDb(Postgres, "БД правил и задач", "PostgreSQL", "Правила, Очереди задач, Сессии, История ДТ")
    ContainerDb(VectorDB, "Векторная БД", "PostgreSQL + pgvector", "Эмбеддинги товаров, Векторный поиск")
}

System_Ext(PriceService, "Сервис цен ФТС", "API", "Рыночные цены")
System_Ext(FtsSystem, "Шлюз ФТС/ФНС", "HTTPS/XML", "Контролирующие органы")

Rel(OfficerUI, Nginx, "HTTPS")
Rel(ExpertUI, Nginx, "HTTPS")
Rel(Nginx, ApiGateway, "Proxy /api")
Rel(ApiGateway, Orchestrator, "Валидация ДТ", "REST")
Rel(Orchestrator, PreprocessingSvc, "Текст ДТ")
Rel(PreprocessingSvc, Orchestrator, "Признаки")
Rel(Orchestrator, RulesEngine, "Поиск правила")
Rel(Orchestrator, SemanticSearch, "Поиск похожих")
Rel(Orchestrator, LlmGenerator, "Генерация имени")
Rel(Orchestrator, PriceValidator, "Проверка цены")
Rel(RulesEngine, Postgres, "CRUD правил", "SQL")
Rel(SemanticSearch, VectorDB, "pgvector поиск", "SQL")
Rel(PreprocessingSvc, Postgres, "Кэш эмбеддингов", "SQL")
Rel(Orchestrator, Postgres, "INSERT INTO jobs", "SQL")
Rel(Postgres, ClusteringService, "Poll jobs (SKIP LOCKED)", "SQL")
Rel(ClusteringService, Postgres, "Update result", "SQL")
Rel(OfficerUI, ApiGateway, "Подписка на статус", "WebSocket/SSE")
Rel(ApiGateway, Postgres, "LISTEN job_status / Read status", "SQL")
Rel(PriceValidator, PriceService, "Запрос цены", "HTTPS")
Rel(ApiGateway, FtsSystem, "Отчетность / Результаты", "HTTPS/XML")
@enduml
```
