#!/usr/bin/env python3
"""
Строит TN_VED_CHILDREN для фронтенда из Excel (ТН ВЭД.xlsx).

Использование:
  python scripts/build_tn_ved_tree.py
  python scripts/build_tn_ved_tree.py --input "data/мой_файл.xlsx" --sheet "Лист1"

Требуется: pandas, openpyxl (уже в requirements.txt корня репозитория).
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import re
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

# Корень репозитория: scripts/ -> parent
REPO = Path(__file__).resolve().parent.parent
DEFAULT_INPUT = REPO / "data" / "ТН ВЭД.xlsx"
OUT_FILE = REPO / "frontend" / "src" / "catalog" / "tnVedChildren.generated.ts"
TXT_L3 = REPO / "data" / "TNVED3.TXT"
TXT_L4_A = REPO / "data" / "TNVED4.TXT"
TXT_L4_B = REPO / "data" / "TNVED4.Txt"

VALID_LEN = frozenset({2, 4, 6, 8, 10})
CODE_RE = re.compile(r"^\d{2,10}$")
# Служебные пометки в наименованиях из таблиц (например «(1 код)», «(3 кода)»)
_TITLE_NOISE = re.compile(r"\s*\(\d+\s*код[^)]*\)\s*$", re.IGNORECASE)
_TITLE_LEVEL_SPLIT = re.compile(r"\s*🠺\s*")


def _clean_title(raw: str) -> str:
    s = raw.strip()
    s = _TITLE_NOISE.sub("", s).strip()
    return s


def _normalize_title_levels(raw: str) -> list[str]:
    parts = [p.strip(" :;-") for p in _TITLE_LEVEL_SPLIT.split(raw.strip())]
    return [p for p in parts if p]


def _title_for_code_level(code: str, raw_title: str) -> str:
    """Берем сегмент названия, соответствующий уровню кода (2/4/6/8/10)."""
    levels = _normalize_title_levels(raw_title)
    if not levels:
        return raw_title.strip()
    depth = max(1, len(code) // 2)  # 2->1, 4->2, ..., 10->5
    idx = min(depth - 1, len(levels) - 1)
    return levels[idx].strip()


def _title_before_last_arrow(raw_title: str) -> str | None:
    levels = _normalize_title_levels(raw_title)
    if len(levels) < 2:
        return None
    return " 🠺 ".join(levels[:-1]).strip()


def _common_prefix(strings: list[str]) -> str:
    if not strings:
        return ""
    s1 = min(strings)
    s2 = max(strings)
    i = 0
    while i < len(s1) and i < len(s2) and s1[i] == s2[i]:
        i += 1
    return s1[:i]


def _normalize_group_prefix(prefix: str, parent: str) -> str:
    prefix = re.sub(r"\D", "", prefix or "")
    if len(prefix) < len(parent):
        prefix = parent
    if len(prefix) % 2 == 1:
        prefix += "0"
    return prefix


def _normalized_group_title(title: str) -> str:
    return re.sub(r"\s+", " ", _clean_title(title).casefold()).strip()


def _child_sort_key(code: str) -> tuple[int, str, str]:
    synthetic_match = re.match(r"^(\d{4})::group::(\d+)::", code)
    if synthetic_match:
        numeric = synthetic_match.group(2)
        return (len(numeric), numeric, code)
    digits = re.sub(r"\D", "", code)
    if digits:
        return (len(digits), digits, code)
    return (999, code, code)


def _parse_date_ddmmyyyy(raw: str | None) -> datetime:
    s = str(raw or "").strip()
    if not s:
        return datetime.min
    try:
        return datetime.strptime(s, "%d.%m.%Y")
    except ValueError:
        return datetime.min


def _clean_pipe_title(raw: str) -> str:
    return _clean_title(str(raw or "").replace("\xa0", " ").strip())


def _txt_choose_latest(rows: list[tuple[str, str, str, str]]) -> dict[str, str]:
    """
    rows: [(code, title, start_date_dd.mm.yyyy, end_date_dd.mm.yyyy), ...]
    Для одинакового code приоритетно берем запись, действующую на сегодня.
    Если действующей записи нет, берем запись с самой поздней датой начала.
    """
    today = datetime.today()
    out: dict[str, tuple[datetime, str]] = {}
    active: dict[str, tuple[datetime, str]] = {}
    for code, title, start, end in rows:
        d = _parse_date_ddmmyyyy(start)
        end_d = _parse_date_ddmmyyyy(end)
        is_active = d <= today and (not str(end or "").strip() or end_d >= today)
        if is_active:
            prev_active = active.get(code)
            if prev_active is None or d >= prev_active[0]:
                active[code] = (d, title)
        prev = out.get(code)
        if prev is None or d >= prev[0]:
            out[code] = (d, title)
    merged = dict(out)
    merged.update(active)
    return {k: v[1] for k, v in merged.items()}


def _read_cp866_lines(path: Path) -> list[str]:
    return path.read_text(encoding="cp866", errors="replace").splitlines()


def _norm_fixed_digits(raw: str, n: int) -> str | None:
    s = re.sub(r"\D", "", str(raw or ""))
    if len(s) != n:
        return None
    return s


def _load_from_tnved_txt() -> dict[str, str]:
    """
    Строит карту код->название из TNVED3/4:
      - TNVED3: уровень 4 цифры (группа)
      - TNVED4: уровень 10 цифр (подсубпозиция)
    Названия уровней 6/8 далее автоматически выводятся из 10-значных кодов.
    """
    if not (TXT_L3.is_file() and (TXT_L4_A.is_file() or TXT_L4_B.is_file())):
        return {}

    txt4 = TXT_L4_A if TXT_L4_A.is_file() else TXT_L4_B

    l3_rows: list[tuple[str, str, str, str]] = []
    for ln in _read_cp866_lines(TXT_L3)[1:]:
        p = ln.split("|")
        if len(p) < 4:
            continue
        a = _norm_fixed_digits(p[0], 2)
        b = _norm_fixed_digits(p[1], 2)
        if not a or not b:
            continue
        code = f"{a}{b}"  # 4 digits
        title = _clean_pipe_title(p[2])
        if not title:
            continue
        title = _title_for_code_level(code, title)
        l3_rows.append((code, title, p[3], p[4] if len(p) > 4 else ""))

    l4_rows: list[tuple[str, str, str, str]] = []
    for ln in _read_cp866_lines(txt4)[1:]:
        p = ln.split("|")
        if len(p) < 5:
            continue
        a = _norm_fixed_digits(p[0], 2)
        b = _norm_fixed_digits(p[1], 2)
        c = _norm_fixed_digits(p[2], 6)
        if not a or not b or not c:
            continue
        code = f"{a}{b}{c}"  # 10 digits
        title = _clean_pipe_title(p[3])
        if not title:
            continue
        title = _title_for_code_level(code, title)
        l4_rows.append((code, title, p[4], p[5] if len(p) > 5 else ""))

    out = {}
    out.update(_txt_choose_latest(l3_rows))
    out.update(_txt_choose_latest(l4_rows))
    return out


def _load_xlsx_full_titles(path: Path, sheet_arg: str) -> dict[str, str]:
    if not path.is_file():
        return {}
    try:
        df = _load_excel_dataframe(path, sheet_arg).dropna(how="all")
    except Exception:
        return {}
    if df.empty:
        return {}

    code_i, title_i = _detect_columns(df)
    out: dict[str, str] = {}
    for _, row in df.iterrows():
        raw_c = row.iloc[code_i] if code_i < len(row) else None
        raw_t = row.iloc[title_i] if title_i < len(row) else None
        code = _normalize_code(raw_c)
        if not code or len(code) != 10:
            continue
        title = str(raw_t).strip() if raw_t is not None and str(raw_t).strip() != "nan" else ""
        title = _clean_title(title)
        if title:
            out[code] = title
    return out


def _pad_tn_ved_digit_run(s: str) -> str:
    """Длины ТН ВЭД 2/4/6/8/10; из Excel часто приходят 9 цифр без ведущего нуля."""
    if len(s) in VALID_LEN:
        return s
    for target in (2, 4, 6, 8, 10):
        if len(s) <= target:
            return s.zfill(target)
    return s


def _normalize_code(raw: object) -> str | None:
    if raw is None:
        return None
    if isinstance(raw, float) and raw != raw:  # NaN
        return None

    s: str
    if isinstance(raw, (int, float)) and not isinstance(raw, bool):
        try:
            n = int(round(float(raw)))
        except (TypeError, ValueError, OverflowError):
            return None
        if n < 0:
            return None
        s = str(n)
    else:
        t = str(raw).strip().replace("\u00a0", "")
        t = t.replace(" ", "")
        digits_only = re.sub(r"[^\d]", "", t)
        if len(digits_only) >= 2:
            s = digits_only
        else:
            try:
                n = int(round(float(t.replace(",", "."))))
                if n < 0:
                    return None
                s = str(n)
            except (ValueError, TypeError, OverflowError):
                s = digits_only

    if not s:
        return None
    s = _pad_tn_ved_digit_run(s)
    if len(s) not in VALID_LEN or not CODE_RE.match(s):
        return None
    ch = int(s[:2])
    if ch < 1 or ch > 97:
        return None
    return s


def _detect_columns(df):
    cols = [str(c).strip().lower() for c in df.columns]
    code_i = None
    title_i = None
    code_patterns = ("код", "code", "тн", "вед", "tn", "hs")
    title_patterns = ("наименование", "название", "title", "описание", "description")
    # служебные колонки первого листа при --sheet all (не колонка кода ТН ВЭД)
    code_skip = ("вкладке", "http://", "https://", "www.", "список кодов на")
    title_skip = ("unnamed", "http://", "https://", "www.")

    for i, name in enumerate(cols):
        if code_i is None and any(sk in name for sk in code_skip):
            continue
        if code_i is None and name in ("код", "code"):
            code_i = i
            break

    for i, name in enumerate(cols):
        if code_i is None and any(p in name for p in code_patterns):
            if any(sk in name for sk in code_skip):
                continue
            code_i = i
            break

    for i, name in enumerate(cols):
        if title_i is None and any(p in name for p in title_patterns):
            if any(sk in name for sk in title_skip):
                continue
            title_i = i
            break

    if code_i is None:
        code_i = 0
    if len(cols) <= 1:
        return 0, 0
    if title_i is None:
        title_i = 1
    if code_i == title_i:
        title_i = 1 - code_i
    return code_i, title_i


def _count_valid_in_column(df, col_j: int) -> int:
    n = 0
    for _, row in df.iterrows():
        if col_j < len(row) and _normalize_code(row.iloc[col_j]):
            n += 1
    return n


def _best_code_column_index(df, initial_i: int) -> int:
    ncols = len(df.columns)
    best_j = initial_i
    best_n = _count_valid_in_column(df, initial_i)
    for j in range(ncols):
        if j == initial_i:
            continue
        t = _count_valid_in_column(df, j)
        if t > best_n:
            best_n, best_j = t, j
    return best_j


def _best_title_column_index(df, code_i: int, initial_i: int) -> int:
    def score_title(col_j: int) -> int:
        n = 0
        for _, row in df.iterrows():
            raw_c = row.iloc[code_i] if code_i < len(row) else None
            if not _normalize_code(raw_c):
                continue
            raw_t = row.iloc[col_j] if col_j < len(row) else None
            t = "" if raw_t is None else str(raw_t).strip()
            if not t or t.lower() == "nan":
                continue
            n += 1
        return n

    best_j = initial_i
    best_s = score_title(initial_i)
    for j in range(len(df.columns)):
        if j == code_i:
            continue
        s = score_title(j)
        if s > best_s:
            best_s, best_j = s, j
    return best_j


def _structural_parent(code: str) -> str | None:
    L = len(code)
    if L <= 2:
        return None
    if L == 4:
        return code[:2]
    if L == 6:
        return code[:4]
    if L == 8:
        return code[:6]
    if L == 10:
        return code[:8]
    return None


def _infer_parent(code: str, all_codes: set[str]) -> str | None:
    """Самый длинный собственный префикс из набора кодов (длины только 2/4/6/8/10)."""
    if len(code) == 4:
        # Главы 01-97 в UI заданы отдельно как корневые узлы, поэтому
        # 4-значные позиции должны цепляться к ним даже без отдельной записи в rows.
        return code[:2]
    for L in (8, 6, 4, 2):
        if L >= len(code):
            continue
        p = code[:L]
        if p in all_codes:
            return p
    p = _structural_parent(code)
    while p:
        if p in all_codes:
            return p
        p = _structural_parent(p)
    if len(code) > 2:
        # Если в источнике нет промежуточных уровней (например, есть 10-значный код,
        # но нет записи 4/6/8 знаков), подвешиваем позицию напрямую к главе.
        return code[:2]
    return None


def build_children(rows: dict[str, str], xlsx_titles: dict[str, str] | None = None) -> dict[str, list[dict[str, str]]]:
    codes = set(rows.keys())
    children: dict[str, list[dict[str, str]]] = defaultdict(list)

    for code in sorted(codes, key=lambda c: (len(c), c)):
        parent = _infer_parent(code, codes)
        if parent is None:
            continue
        children[parent].append({"code": code, "title": rows[code]})

    for p in children:
        children[p].sort(key=lambda x: _child_sort_key(x["code"]))

    # Для 10-значных кодов под 4-значным родителем объединяем ветки по общему
    # названию предпоследнего уровня из xlsx: текст до последнего "🠺".
    if xlsx_titles:
        synthetic_children: dict[str, list[dict[str, str]]] = {}
        for parent, items in list(children.items()):
            if len(parent) != 4:
                continue
            items_by_code = {item["code"]: item for item in items if len(item["code"]) == 10}
            prefix6_base_titles: dict[str, str] = {}
            for code in items_by_code:
                if not code.endswith("0000"):
                    continue
                family_prefix = code[:6]
                family_codes = [candidate for candidate in items_by_code if candidate[:6] == family_prefix]
                if len(family_codes) > 1:
                    prefix6_base_titles[family_prefix] = items_by_code[code]["title"]
            prefix6_titles: dict[str, str] = {}
            for item in items:
                code = item["code"]
                if len(code) != 10:
                    continue
                parent_title = _title_before_last_arrow(xlsx_titles.get(code, ""))
                if parent_title and _normalized_group_title(parent_title) != _normalized_group_title(rows.get(parent, "")):
                    prefix6_titles.setdefault(code[:6], parent_title)
            grouped: dict[str, list[dict[str, str]]] = defaultdict(list)
            passthrough: list[dict[str, str]] = []
            for item in items:
                code = item["code"]
                if len(code) != 10:
                    passthrough.append(item)
                    continue
                direct_parent_title = _title_before_last_arrow(xlsx_titles.get(code, ""))
                if direct_parent_title and _normalized_group_title(direct_parent_title) == _normalized_group_title(rows.get(parent, "")):
                    direct_parent_title = None
                parent_title = direct_parent_title or prefix6_titles.get(code[:6]) or prefix6_base_titles.get(code[:6])
                if not parent_title:
                    passthrough.append(item)
                    continue
                grouped[parent_title].append(item)

            if not grouped:
                continue

            next_items: list[dict[str, str]] = list(passthrough)
            for title, group_items in grouped.items():
                prefixes = [g["code"] for g in group_items]
                if len(group_items) == 1 or _normalized_group_title(title) == _normalized_group_title(rows.get(parent, "")):
                    next_items.extend(group_items)
                    continue
                cp = _normalize_group_prefix(_common_prefix(prefixes), parent)
                synth_code = f"{parent}::group::{cp}::{title}"
                next_items.append({"code": synth_code, "title": title})
                synthetic_children[synth_code] = sorted(group_items, key=lambda x: _child_sort_key(x["code"]))
            next_items.sort(key=lambda x: _child_sort_key(x["code"]))
            children[parent] = next_items

        for synth_code, group_items in synthetic_children.items():
            children[synth_code] = group_items
    return dict(children)


def ts_emit(children: dict[str, list[dict[str, str]]], row_count: int) -> str:
    parent_count = len(children)
    lines = [
        "/**",
        " * Автогенерация: `python scripts/build_tn_ved_tree.py`",
        " * Положите полный `data/ТН ВЭД.xlsx` — иначе в UI только демо-фрагмент.",
        " * Не правьте вручную — правки внесите в Excel и перезапустите скрипт.",
        " */",
        "",
        "export const TN_VED_CHILDREN_GENERATED: Record<string, { code: string; title: string }[]> = {",
    ]
    for parent in sorted(children.keys(), key=lambda x: (len(x), x)):
        lines.append(f'  {json.dumps(parent, ensure_ascii=False)}: [')
        for ch in children[parent]:
            c = json.dumps(ch["code"], ensure_ascii=False)
            t = json.dumps(ch["title"], ensure_ascii=False)
            lines.append(f"    {{ code: {c}, title: {t} }},")
        lines.append("  ],")
    lines.append("};")
    lines.append("")
    lines.append("/** Статистика сборки: полный перечень ЕАЭС обычно даёт десятки тысяч строк в Excel. */")
    lines.append(f"export const TN_VED_CHILDREN_BUILD_INFO = {{ rowCount: {row_count}, parentKeyCount: {parent_count} }} as const;")
    lines.append("")
    return "\n".join(lines)


def _load_excel_dataframe(path: Path, sheet_arg: str):
    import pandas as pd

    s = str(sheet_arg).strip().lower()
    if s == "all":
        book = pd.read_excel(path, sheet_name=None, dtype=object)
        parts: list = []
        for _, sdf in book.items():
            if sdf is None or sdf.empty:
                continue
            sdf = sdf.dropna(how="all")
            if not sdf.empty:
                parts.append(sdf)
        if not parts:
            return pd.DataFrame()
        return pd.concat(parts, ignore_index=True)
    try:
        sheet_idx = int(sheet_arg)
    except ValueError:
        sheet_idx = sheet_arg
    return pd.read_excel(path, sheet_name=sheet_idx, dtype=object)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", type=Path, default=DEFAULT_INPUT, help="Путь к .xlsx")
    ap.add_argument(
        "--sheet",
        type=str,
        default="all",
        help='Имя листа, индекс (0 — первый) или all (склеить все непустые листы; по умолчанию — all)',
    )
    args = ap.parse_args()

    path: Path = args.input
    if not path.is_file():
        print(f"Файл не найден: {path}", file=sys.stderr)
        print(f"Положите Excel в {DEFAULT_INPUT} или укажите --input", file=sys.stderr)
        return 1

    if importlib.util.find_spec("pandas") is None:
        print("Установите pandas: pip install pandas openpyxl", file=sys.stderr)
        return 1

    known = _load_from_tnved_txt()
    xlsx_full_titles = _load_xlsx_full_titles(path, args.sheet)
    if not known:
        df = _load_excel_dataframe(path, args.sheet)
        df = df.dropna(how="all")
        if df.empty:
            print("Таблица пуста.", file=sys.stderr)
            return 1

        code_i, title_i = _detect_columns(df)

        def rows_to_known(ci: int, ti: int) -> dict[str, str]:
            out: dict[str, str] = {}
            for _, row in df.iterrows():
                raw_c = row.iloc[ci] if ci < len(row) else None
                raw_t = row.iloc[ti] if ti < len(row) else None
                code = _normalize_code(raw_c)
                if not code:
                    continue
                if ci == ti:
                    title = f"Код {code}"
                else:
                    title = str(raw_t).strip() if raw_t is not None and str(raw_t).strip() != "nan" else f"Код {code}"
                if title != f"Код {code}":
                    title = _title_for_code_level(code, _clean_title(title))
                if not title:
                    title = f"Код {code}"
                out[code] = title
            return out

        known = rows_to_known(code_i, title_i)
        if not known:
            code_i = _best_code_column_index(df, code_i)
            if code_i == title_i and len(df.columns) > 1:
                title_i = 1 - code_i
            known = rows_to_known(code_i, title_i)
        if known:
            best_title_i = _best_title_column_index(df, code_i, title_i)
            if best_title_i != title_i:
                title_i = best_title_i
                known = rows_to_known(code_i, title_i)

    if not known:
        print("Не удалось прочитать ни одной валидной строки (код 2/4/6/8/10 цифр).", file=sys.stderr)
        print(
            f"Проверьте TXT ({TXT_L3.name}, {TXT_L4_A.name}/{TXT_L4_B.name}) или Excel: {path} (sheet={args.sheet!r})",
            file=sys.stderr,
        )
        return 1

    children = build_children(known, xlsx_full_titles)
    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_text(ts_emit(children, len(known)), encoding="utf-8")
    print(f"Записано: {OUT_FILE} ({len(known)} кодов, {len(children)} родительских ключей)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
