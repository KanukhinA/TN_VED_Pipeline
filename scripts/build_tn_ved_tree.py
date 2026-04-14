#!/usr/bin/env python3
"""
Современный entrypoint сборки дерева ТН ВЭД для UI.

Исторически реализация находилась в `build_tn_ved_tree_from_xlsx.py`.
Этот файл — каноничная точка запуска, используйте:

  python scripts/build_tn_ved_tree.py
"""

from __future__ import annotations

from build_tn_ved_tree_from_xlsx import main


if __name__ == "__main__":
    raise SystemExit(main())
