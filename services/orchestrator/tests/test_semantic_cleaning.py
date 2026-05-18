"""Тесты LLM-чистки перед семантикой и формы HTTP к Ollama (без живого сервера)."""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
ORCH_ROOT = Path(__file__).resolve().parents[1]
for p in (ORCH_ROOT, REPO_ROOT):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))

from app.semantic_cleaning import (  # noqa: E402
    OLLAMA_SEMANTIC_CLEANING_JSON_FORMAT,
    extract_semantic_cleaned_text,
    finalize_semantic_cleaning_prompt,
    render_semantic_cleaning_prompt,
)
from shared.llm_runtime.ollama_backend import ollama_generate  # noqa: E402

# Как в реальном ответе qwen3 при constrained_decoding=false (JSON с ключом «ответ»).
SAMPLE_MODEL_JSON_ANSWER = (
    '{"ответ": "УДОБРЕНИЯ МИНЕРАЛЬНЫЕ КАЛИЙ СЕРНОКИСЛЫЙ (СУЛЬФАТ КАЛИЯ) ГРАНУЛИРОВАННЫЙ. '
    'СОДЕРЖАНИЕ К2О НЕ МЕНЕЕ 50%. ВИДЕ ГРАНУЛ (2-5 ММ.). ГОСТ Р 51520-99, ТУ 20.15.52-004-63727772-17."}'
)
EXPECTED_INNER = (
    "УДОБРЕНИЯ МИНЕРАЛЬНЫЕ КАЛИЙ СЕРНОКИСЛЫЙ (СУЛЬФАТ КАЛИЯ) ГРАНУЛИРОВАННЫЙ. "
    "СОДЕРЖАНИЕ К2О НЕ МЕНЕЕ 50%. ВИДЕ ГРАНУЛ (2-5 ММ.). ГОСТ Р 51520-99, ТУ 20.15.52-004-63727772-17."
)


@pytest.mark.parametrize("constrained", [False, True])
def test_extract_semantic_cleaned_text_json_otvet_with_or_without_constrained(constrained: bool) -> None:
    assert extract_semantic_cleaned_text(SAMPLE_MODEL_JSON_ANSWER, constrained_decoding=constrained) == EXPECTED_INNER


def test_extract_semantic_cleaned_text_answer_key() -> None:
    raw = '{"answer": "очищенный фрагмент"}'
    assert extract_semantic_cleaned_text(raw, constrained_decoding=False) == "очищенный фрагмент"


def test_extract_semantic_cleaned_text_plain_text_unchanged() -> None:
    raw = "просто текст без json"
    assert extract_semantic_cleaned_text(raw, constrained_decoding=False) == raw


def test_extract_semantic_cleaned_text_fenced_json() -> None:
    raw = '```json\n{"answer": "внутри"}\n```'
    assert extract_semantic_cleaned_text(raw, constrained_decoding=False) == "внутри"


def test_finalize_semantic_cleaning_prompt_adds_suffix_when_constrained() -> None:
    base = "инструкция"
    out = finalize_semantic_cleaning_prompt(base, constrained_decoding=True)
    assert out.startswith(base)
    assert "answer" in out
    assert "---" in out


def test_finalize_semantic_cleaning_prompt_no_suffix_when_free() -> None:
    base = "инструкция"
    assert finalize_semantic_cleaning_prompt(base, constrained_decoding=False) == base


def test_render_semantic_cleaning_prompt_placeholder() -> None:
    t = "Преамбула\n{исходный_текст}\nконец"
    assert "SRC" in render_semantic_cleaning_prompt(t, "SRC")


def test_ollama_semantic_cleaning_schema_uses_answer() -> None:
    assert OLLAMA_SEMANTIC_CLEANING_JSON_FORMAT["required"] == ["answer"]
    assert "answer" in OLLAMA_SEMANTIC_CLEANING_JSON_FORMAT.get("properties", {})


def test_ollama_generate_uses_chat_api_and_top_level_think() -> None:
    """Регрессия: /api/generate + Qwen3 давали пустой response при think в options."""
    captured: dict[str, Any] = {}

    mock_resp = MagicMock()
    mock_resp.raise_for_status = MagicMock()
    mock_resp.json.return_value = {
        "model": "qwen3:4b-q4_K_M",
        "message": {"role": "assistant", "content": '{"answer":"ok"}'},
        "done": True,
        "total_duration": 1,
        "eval_count": 3,
    }

    mock_client = MagicMock()
    mock_client.__enter__ = MagicMock(return_value=mock_client)
    mock_client.__exit__ = MagicMock(return_value=None)

    def _post(url: str, **kwargs: Any) -> MagicMock:
        captured["url"] = url
        captured["json"] = kwargs.get("json")
        return mock_resp

    mock_client.post.side_effect = lambda url, **kw: _post(url, **kw)

    fmt = {"type": "object", "properties": {"answer": {"type": "string"}}, "required": ["answer"]}
    with patch("shared.llm_runtime.ollama_backend.httpx.Client", return_value=mock_client):
        out = ollama_generate(
            "qwen3:4b-q4_K_M",
            "prompt text",
            num_ctx=8192,
            num_predict=128,
            enable_thinking=False,
            response_format=fmt,
        )

    assert captured["url"].endswith("/api/chat")
    body = captured["json"]
    assert body["think"] is False
    assert body["stream"] is False
    assert body["messages"] == [{"role": "user", "content": "prompt text"}]
    assert body["format"] == fmt
    assert out["raw_response"] == '{"answer":"ok"}'
    mock_client.post.assert_called_once()
