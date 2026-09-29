"""Use the reviewed native renderer and require every candidate score."""

import hashlib
import importlib.util
import math
from pathlib import Path
from types import SimpleNamespace

from demo.cases import model_state
from demo.config import LABELS, MAX_CONTEXT_TOKENS, MAX_MODEL_TOKENS, OPTIONS, PROMPT_SHA256


class KeepOrder:
    def shuffle(self, items):
        pass

    def sample(self, items, count):
        return list(items[:count])


def load_prompt_helper(path: Path):
    if hashlib.sha256(path.read_bytes()).hexdigest() != PROMPT_SHA256:
        raise ValueError("The prompt helper differs from the reviewed revision")
    spec = importlib.util.spec_from_file_location("reviewed_decider_prompt", path)
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


def normalize_scores(token_scores, label_ids, temperature):
    if len(label_ids) != len(LABELS) or len(set(label_ids)) != len(LABELS):
        raise ValueError("Exactly three distinct option tokens are required")
    if not math.isfinite(temperature) or temperature <= 0:
        raise ValueError("Invalid temperature")
    values = [float(token_scores[token_id]) for token_id in label_ids]
    if not all(math.isfinite(value) for value in values):
        raise ValueError("Incomplete or non-finite model scores")
    # vLLM processed_logits can be positive: these are not full-vocabulary log probabilities.
    peak = max(values)
    weights = [math.exp((value - peak) / temperature) for value in values]
    probabilities = dict(zip(LABELS, (value / sum(weights) for value in weights)))
    return {"choice": max(probabilities, key=probabilities.get), "probabilities": probabilities}
