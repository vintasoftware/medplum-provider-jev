"""Use the reviewed native renderer and require every candidate score."""

import hashlib
import importlib.util
import math
from pathlib import Path
from types import SimpleNamespace

from demo.cases import model_state
from demo.config import LABELS, MAX_CONTEXT_TOKENS, MAX_MODEL_TOKENS, OPTIONS, PROMPT_SHA256


class Rejected(ValueError):
    """A request the model cannot score as sent; the message never echoes request text."""


class KeepOrder:
    def shuffle(self, items):
        pass

    def sample(self, items, count):
        return list(items[:count])


def load_prompt_helper(path: Path, sha256=PROMPT_SHA256, name="reviewed_decider_prompt"):
    if hashlib.sha256(path.read_bytes()).hexdigest() != sha256:
        raise ValueError("The prompt helper differs from the reviewed revision")
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def render_case(case, tokenizer, helper):
    state = model_state(case)
    # Native build() slices the context; refuse before it can discard evidence.
    if len(tokenizer.encode("Context:\n" + state, add_special_tokens=False)) > MAX_CONTEXT_TOKENS:
        raise ValueError("Context exceeds the demo limit")
    question = SimpleNamespace(text=case.question, options=list(OPTIONS), gold=0)
    example = SimpleNamespace(context=state, qs=[question])
    item = helper.build(example, tokenizer, KeepOrder(), max_options=255,
                        max_ctx_tokens=MAX_CONTEXT_TOKENS)
    if len(item["ids"]) + 1 > MAX_MODEL_TOKENS:
        raise ValueError("Full prompt exceeds the demo limit")
    if item["perms"] != [[0, 1, 2]] or item["nopts"] != [3]:
        raise ValueError("The renderer changed the candidate set")
    # The pinned helper returns three values; the model card's two-value unpack fails.
    label_ids = list(helper.label_table(tokenizer)[1][:3])
    if len(set(label_ids)) != 3:
        raise ValueError("Option labels must map to distinct tokens")
    return item["ids"], label_ids


def render_question_rows(state, questions, tokenizer, helper, systemone):
    """One row per question, as Decider's own /v1/systemone serves independent questions.

    Returns (rendered questions, rows); each row is (prompt ids, option token ids)."""
    context = systemone.render_state(state)
    if len(tokenizer.encode("Context:\n" + context, add_special_tokens=False)) > MAX_CONTEXT_TOKENS:
        raise Rejected("The documents exceed the model's context limit")
    rendered, rows = {}, []
    label_ids = helper.label_table(tokenizer)[1]
    for key, spec in questions.items():
        try:
            question = systemone.render_question(spec)
        except ValueError:
            raise Rejected("A question is not a valid choice or noul question") from None
        options = question["options"]
        example = SimpleNamespace(context=context, qs=[SimpleNamespace(text=question["question"], options=options, gold=0)])
        item = helper.build(example, tokenizer, KeepOrder(), max_options=255, max_ctx_tokens=MAX_CONTEXT_TOKENS)
        if len(item["ids"]) + 1 > MAX_MODEL_TOKENS:
            raise Rejected("A question exceeds the model's context limit")
        if item["perms"] != [list(range(len(options)))]:
            raise ValueError("The renderer changed the candidate set")
        rendered[key] = question
        rows.append((item["ids"], list(label_ids[:len(options)])))
    return rendered, rows


def softmax_scores(token_scores, label_ids, temperature):
    if len(set(label_ids)) != len(label_ids) or len(label_ids) < 2:
        raise ValueError("Distinct option tokens are required")
    if not math.isfinite(temperature) or temperature <= 0:
        raise ValueError("Invalid temperature")
    values = [float(token_scores[token_id]) for token_id in label_ids]
    if not all(math.isfinite(value) for value in values):
        raise ValueError("Incomplete or non-finite model scores")
    # vLLM processed_logits can be positive: these are not full-vocabulary log probabilities.
    peak = max(values)
    weights = [math.exp((value - peak) / temperature) for value in values]
    return [value / sum(weights) for value in weights]


def normalize_scores(token_scores, label_ids, temperature):
    if len(label_ids) != len(LABELS):
        raise ValueError("Exactly three distinct option tokens are required")
    probabilities = dict(zip(LABELS, softmax_scores(token_scores, label_ids, temperature)))
    return {"choice": max(probabilities, key=probabilities.get), "probabilities": probabilities}
