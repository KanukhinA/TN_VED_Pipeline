# Диаграммы классов backend

Это архитектурные артефакты, а не часть исполняемого кода приложения.
Файлы в этой папке нужны для анализа структуры модулей и связей.

## Что сгенерировано

- `backend/classes_backend_api.puml` и `backend/packages_backend_api.puml`
- `backend/classes_backend_rules.puml` и `backend/packages_backend_rules.puml`
- `backend/classes_backend_db.puml` и `backend/packages_backend_db.puml`
- `backend/classes_backend_pipeline.puml` и `backend/packages_backend_pipeline.puml`
- `backend/classes_backend_app_overview.puml` и `backend/packages_backend_app_overview.puml`

## Как обновлять

Ниже команды, которыми эти файлы собраны в **детальном режиме ООП**:
- `-f ALL` — не скрывать приватные/специальные члены;
- `-m y` — показывать имена модулей;
- `-A -S` — включать связи наследования и ассоциации.

```powershell
& "C:/Users/Acer/AppData/Roaming/Python/Python314/Scripts/pyreverse.exe" -o puml -f ALL -A -S -m y -p backend_api --source-roots "backend" -d "docs/architecture/class-diagrams/backend" "backend/app/api"
& "C:/Users/Acer/AppData/Roaming/Python/Python314/Scripts/pyreverse.exe" -o puml -f ALL -A -S -m y -p backend_rules --source-roots "backend" -d "docs/architecture/class-diagrams/backend" "backend/app/rules"
& "C:/Users/Acer/AppData/Roaming/Python/Python314/Scripts/pyreverse.exe" -o puml -f ALL -A -S -m y -p backend_db --source-roots "backend" -d "docs/architecture/class-diagrams/backend" "backend/app/db"
& "C:/Users/Acer/AppData/Roaming/Python/Python314/Scripts/pyreverse.exe" -o puml -f ALL -A -S -m y -p backend_pipeline --source-roots "backend" -d "docs/architecture/class-diagrams/backend" "backend/app/pipeline"
& "C:/Users/Acer/AppData/Roaming/Python/Python314/Scripts/pyreverse.exe" -o puml -f ALL -A -S -m y -p backend_app_overview --source-roots "backend" -d "docs/architecture/class-diagrams/backend" "backend/app"
```

Ниже сохранены прежние команды (краткий режим) для справки:

```powershell
& "C:/Users/Acer/AppData/Roaming/Python/Python314/Scripts/pyreverse.exe" -o puml -p backend_api --source-roots "backend" -d "docs/architecture/class-diagrams/backend" "backend/app/api"
& "C:/Users/Acer/AppData/Roaming/Python/Python314/Scripts/pyreverse.exe" -o puml -p backend_rules --source-roots "backend" -d "docs/architecture/class-diagrams/backend" "backend/app/rules"
& "C:/Users/Acer/AppData/Roaming/Python/Python314/Scripts/pyreverse.exe" -o puml -p backend_db --source-roots "backend" -d "docs/architecture/class-diagrams/backend" "backend/app/db"
& "C:/Users/Acer/AppData/Roaming/Python/Python314/Scripts/pyreverse.exe" -o puml -p backend_pipeline --source-roots "backend" -d "docs/architecture/class-diagrams/backend" "backend/app/pipeline"
& "C:/Users/Acer/AppData/Roaming/Python/Python314/Scripts/pyreverse.exe" -o puml -p backend_app_overview --source-roots "backend" -d "docs/architecture/class-diagrams/backend" "backend/app"
```

Если нужно, `.puml` можно дальше рендерить в PNG/SVG через PlantUML.
