"""Fetch classinform.ru: razdel-6 + all gruppa-01..97, write tnVedSectionViNotes.ts"""
from __future__ import annotations

import json
import re
import ssl
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "src" / "catalog" / "tnVedSectionViNotes.ts"
UA = "Pipeline-TN-VED-sync/1.0"
BASE = "https://classinform.ru/tn-ved"


def fetch_bytes(url: str) -> tuple[bytes | None, int]:
    ctx = ssl.create_default_context()
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=120) as r:
            return r.read(), r.status
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None, 404
        raise


def decode_body(b: bytes) -> str:
    for enc in ("cp1251", "utf-8"):
        try:
            t = b.decode(enc)
        except UnicodeDecodeError:
            continue
        if "\u0422\u041d \u0412\u042d\u0414" in t or "\u0433\u0440\u0443\u043f\u043f\u0430" in t.lower():
            return t
    return b.decode("utf-8", errors="replace")


def em_notes_to_text(inner_html: str) -> str:
    t = re.sub(r"<br\s*/?>", "\n", inner_html, flags=re.I)
    t = re.sub(r"<[^>]+>", " ", t)
    t = (
        t.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", '"')
    )
    lines = [re.sub(r"\s+", " ", ln).strip() for ln in t.splitlines()]
    return "\n".join(ln for ln in lines if ln).strip()


def extract_notes_em(html: str) -> str:
    # «Примечание:» (ед.) и «Примечания:» (мн.)
    m = re.search(
        r"<em>\s*((?:\u041f\u0440\u0438\u043c\u0435\u0447\u0430\u043d\u0438\u0435|\u041f\u0440\u0438\u043c\u0435\u0447\u0430\u043d\u0438\u044f):[\s\S]*?)</em>",
        html,
        re.I,
    )
    if not m:
        return ""
    return em_notes_to_text(m.group(1))


def format_section_vi_block(text: str) -> str:
    t = text.strip()
    t = re.sub(r"\s+(\d+)\.\s+", r"\n\n\1. ", t)
    return t.strip()


def main() -> None:
    razdel_raw, st = fetch_bytes(f"{BASE}/razdel-6.html")
    if razdel_raw is None:
        raise RuntimeError(f"razdel-6: HTTP {st}")
    razdel = decode_body(razdel_raw)
    section_raw = extract_notes_em(razdel)
    section_vi = format_section_vi_block(section_raw)

    group_notes: dict[str, str] = {}
    for n in range(1, 98):
        code = f"{n:02d}"
        url = f"{BASE}/gruppa-{code}.html"
        raw, status = fetch_bytes(url)
        if raw is None:
            group_notes[code] = ""
            print(f"SKIP gruppa-{code} (HTTP {status})")
            time.sleep(0.15)
            continue
        html = decode_body(raw)
        group_notes[code] = extract_notes_em(html)
        print(f"OK gruppa-{code} ({len(group_notes[code])} chars)")
        time.sleep(0.15)

    body = f"""/* eslint-disable max-len */
/**
 * Примечания ТН ВЭД ЕАЭС (КлассИнформ, 2026): раздел VI + страницы gruppa-01…gruppa-97.
 * https://classinform.ru/tn-ved/razdel-6.html
 * https://classinform.ru/tn-ved/gruppa-XX.html
 * Перегенерация: python scripts/build_tn_ved_group_notes.py
 */

export const SECTION_VI_NOTES = {json.dumps(section_vi, ensure_ascii=False)};

/** Примечания к группе; пустая строка, если страницы нет (например, 77) или блок не найден */
export const GROUP_NOTES_BY_CODE: Record<string, string> = {json.dumps(group_notes, ensure_ascii=False, indent=2)};
"""
    OUT.write_text(body, encoding="utf-8")
    nonempty = sum(1 for v in group_notes.values() if v)
    print("Wrote", OUT, "section_vi len", len(section_vi), "groups with notes", nonempty, "/ 97")


if __name__ == "__main__":
    main()
