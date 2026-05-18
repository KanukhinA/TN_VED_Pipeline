"""
Метрики Dual-Level Introspective Uncertainty (по few_shot_extractor.py из
LLM_QuantityExtractor_Evaluator): расхождение генераций, формат, содержание.
Без pandas/sklearn — только вычисления для отбора кандидатов в few-shot.
"""

from __future__ import annotations

import math
import re
from statistics import mean
from typing import Any, Callable, List, Sequence, Set, Tuple

from app.json_recovery import (
    extract_json_from_response,
    is_valid_json_object,
    parse_json_safe,
    parse_json_from_model_response,
)


def levenshtein_distance(s1: str, s2: str) -> int:
    if len(s1) < len(s2):
        return levenshtein_distance(s2, s1)
    if len(s2) == 0:
        return len(s1)
    previous_row = range(len(s2) + 1)
    for i, c1 in enumerate(s1):
        current_row = [i + 1]
        for j, c2 in enumerate(s2):
            insertions = previous_row[j + 1] + 1
            deletions = current_row[j] + 1
            substitutions = previous_row[j] + (c1 != c2)
            current_row.append(min(insertions, deletions, substitutions))
        previous_row = current_row
    return previous_row[-1]


def extract_structured_output(json_obj: Any) -> Set[Tuple[str, str]]:
    """Пары (тип, ключ:значение) для Jaccard, как в few_shot_extractor."""
    result: set[Tuple[str, str]] = set()
    if not isinstance(json_obj, dict):
        return result
    if "массовая доля" in json_obj:
        mass_dolya = json_obj["массовая доля"]
        if isinstance(mass_dolya, list):
            for item in mass_dolya:
                if isinstance(item, dict):
                    substance = item.get("вещество", "")
                    value = item.get("массовая доля", "")
                    if substance:
                        result.add(("массовая_доля", f"{substance}:{value}"))
    if "прочее" in json_obj:
        prochee = json_obj["прочее"]
        if isinstance(prochee, list):
            for item in prochee:
                if isinstance(item, dict):
                    param = item.get("параметр", "")
                    value = item.get("значение") or item.get("масса") or item.get("количество") or item.get("объем")
                    if param:
                        result.add(("прочее", f"{param}:{value}"))
    return result


def calculate_generation_disagreement(responses: List[str]) -> float:
    k = len(responses)
    if k < 2:
        return 0.0
    distances: List[float] = []
    for i in range(k):
        for j in range(i + 1, k):
            dist = levenshtein_distance(responses[i], responses[j])
            max_len = max(len(responses[i]), len(responses[j]), 1)
            distances.append(dist / max_len)
    return float(mean(distances)) if distances else 0.0


def calculate_format_uncertainty(
    responses: List[str],
    parser_func: Callable[[str], Any] = parse_json_safe,
) -> Tuple[float, float]:
    k = len(responses)
    if k == 0:
        return 1.0, 1.0
    failed_count = 0
    parsed_outputs: List[Any] = []
    for response in responses:
        json_part = extract_json_from_response(response)
        parsed = parser_func(json_part)
        valid = is_valid_json_object(json_part)
        if not valid or not isinstance(parsed, dict) or not parsed:
            failed_count += 1
        else:
            parsed_outputs.append(parsed)
    r_fail = failed_count / k
    if len(parsed_outputs) < 2:
        structural_disagreement = 1.0 if r_fail > 0 else 0.0
    else:
        structures: List[Tuple[Set[str], dict[str, int]]] = []
        for parsed in parsed_outputs:
            keys = set(parsed.keys())
            list_lengths: dict[str, int] = {}
            for key, value in parsed.items():
                if isinstance(value, list):
                    list_lengths[key] = len(value)
            structures.append((keys, list_lengths))
        disagreements: List[float] = []
        for i in range(len(structures)):
            for j in range(i + 1, len(structures)):
                keys_i, lengths_i = structures[i]
                keys_j, lengths_j = structures[j]
                key_diff = len(keys_i.symmetric_difference(keys_j)) / max(len(keys_i.union(keys_j)), 1)
                all_keys = set(lengths_i.keys()) | set(lengths_j.keys())
                length_diff = 0.0
                if all_keys:
                    for key in all_keys:
                        len_i = lengths_i.get(key, 0)
                        len_j = lengths_j.get(key, 0)
                        if len_i != len_j:
                            length_diff += 1.0
                    length_diff /= len(all_keys)
                disagreement = (key_diff + length_diff) / 2.0
                disagreements.append(disagreement)
        structural_disagreement = float(mean(disagreements)) if disagreements else 0.0
    return r_fail, structural_disagreement


def calculate_content_uncertainty(
    responses: List[str],
    parser_func: Callable[[str], Any] = parse_json_from_model_response,
) -> float:
    parsed_outputs: List[Any] = []
    for response in responses:
        parsed = parser_func(response)
        if parsed is not None and isinstance(parsed, dict) and parsed:
            parsed_outputs.append(parsed)
    k_prime = len(parsed_outputs)
    if k_prime < 2:
        return 1.0
    extracted_sets: List[Set[Tuple[str, str]]] = []
    for parsed in parsed_outputs:
        extracted_sets.append(extract_structured_output(parsed))
    jaccard_similarities: List[float] = []
    for i in range(len(extracted_sets)):
        for j in range(i + 1, len(extracted_sets)):
            set_i = extracted_sets[i]
            set_j = extracted_sets[j]
            if len(set_i) == 0 and len(set_j) == 0:
                similarity = 1.0
            elif len(set_i) == 0 or len(set_j) == 0:
                similarity = 0.0
            else:
                intersection = len(set_i & set_j)
                union = len(set_i | set_j)
                similarity = intersection / union if union > 0 else 0.0
            jaccard_similarities.append(similarity)
    avg_jaccard = float(mean(jaccard_similarities)) if jaccard_similarities else 0.0
    return 1.0 - avg_jaccard


def best_json_fragment_from_responses(responses: List[str]) -> str:
    """Первый успешно распарсенный JSON-фрагмент для подсказки few-shot."""
    for response in responses:
        if not (response and response.strip()):
            continue
        json_part = extract_json_from_response(response)
        parsed = parse_json_safe(json_part)
        if isinstance(parsed, dict) and parsed:
            return json_part
    for response in responses:
        if response and response.strip():
            frag = extract_json_from_response(response)
            if frag:
                return frag
    return ""


def _tokenize_text_for_similarity(text: str) -> Set[str]:
    return set(re.findall(r"[a-zA-Zа-яА-Я0-9]+", (text or "").lower()))


def _jaccard_distance(a: Set[str], b: Set[str]) -> float:
    if not a and not b:
        return 0.0
    if not a or not b:
        return 1.0
    inter = len(a & b)
    union = len(a | b)
    if union <= 0:
        return 0.0
    return 1.0 - (inter / union)


def _percentile(values: Sequence[float], percentile: float) -> float:
    if not values:
        return 0.0
    arr = sorted(float(v) for v in values)
    if len(arr) == 1:
        return arr[0]
    p = max(0.0, min(float(percentile), 100.0))
    rank = (p / 100.0) * (len(arr) - 1)
    lo = int(math.floor(rank))
    hi = int(math.ceil(rank))
    if lo == hi:
        return arr[lo]
    frac = rank - lo
    return arr[lo] * (1.0 - frac) + arr[hi] * frac


def detect_outliers_jaccard_knn(
    texts: Sequence[str],
    *,
    k: int = 20,
    percentile: float = 95.0,
) -> Tuple[List[bool], List[float]]:
    """
    Аналог detect_outliers_knn из few_shot_extractor, но на Jaccard-дистанции токенов.
    Возвращает:
    - is_outlier[i] = True, если средняя дистанция до k соседей > percentile порога;
    - score[i] = средняя дистанция до k соседей.
    """
    clean = [str(t).strip() for t in texts]
    n = len(clean)
    if n < 2:
        return [False for _ in range(n)], [0.0 for _ in range(n)]

    token_sets = [_tokenize_text_for_similarity(t) for t in clean]
    k_eff = max(1, min(int(k), n - 1))
    scores: List[float] = []

    for i in range(n):
        dists: List[float] = []
        for j in range(n):
            if i == j:
                continue
            dists.append(_jaccard_distance(token_sets[i], token_sets[j]))
        dists.sort()
        near = dists[:k_eff]
        scores.append(float(mean(near)) if near else 0.0)

    threshold = _percentile(scores, percentile)
    is_outlier = [s > threshold for s in scores]
    return is_outlier, scores
