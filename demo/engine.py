"""Serialized Decider readouts: one fixture by id, or typed questions over document text.

Only option-token scores are read; there is no generic generation endpoint."""

import json
import time
from pathlib import Path

from demo.config import MAX_MODEL_TOKENS, MAX_QUESTIONS, MODEL_ID, MODEL_PATH, MODEL_REVISION, SYSTEMONE_SHA256
from demo.decider_contract import fixture_digest
from demo.scoring import load_prompt_helper, normalize_scores, render_case, render_question_rows, softmax_scores


class DeciderEngine:
    def __init__(self):
        from vllm import LLM, SamplingParams
        self.sampling_params = SamplingParams
        path = Path(MODEL_PATH)
        if (path / "VERIFIED_REVISION").read_text().strip() != MODEL_REVISION:
            raise ValueError("Stage and verify the pinned model before serving")
        self.helper = load_prompt_helper(path / "decider/prompt.py")
        self.systemone_helper = load_prompt_helper(path / "decider/systemone.py", SYSTEMONE_SHA256, "reviewed_decider_systemone")
        self.temperature = float(json.loads((path / "decider_config.json").read_text())["temperature"])
        if self.temperature != 1.08:
            raise ValueError("Unexpected checkpoint temperature")
        self.llm = LLM(model=MODEL_PATH, trust_remote_code=False, dtype="bfloat16",
            max_model_len=MAX_MODEL_TOKENS, max_num_seqs=MAX_QUESTIONS, gpu_memory_utilization=0.80,
            logprobs_mode="processed_logits", max_logprobs=256, enable_prefix_caching=False,
            enforce_eager=True, disable_log_stats=True, seed=0)
        self.tokenizer = self.llm.get_tokenizer()

    def check(self, case):
        ids, label_ids = render_case(case, self.tokenizer, self.helper)
        params = self.sampling_params(max_tokens=1, temperature=1.0, top_p=1.0,
                                      logprobs=3, allowed_token_ids=label_ids, seed=0)
        started = time.perf_counter()
        outputs = self.llm.generate([{"prompt_token_ids": ids}], params, use_tqdm=False)
        scores = outputs[0].outputs[0].logprobs[0]
        result = normalize_scores({key: value.logprob for key, value in scores.items()}, label_ids, self.temperature)
        return {**result, "case_id": case.id, "model": MODEL_ID, "revision": MODEL_REVISION,
                "fixtures_sha256": fixture_digest(), "temperature": self.temperature, "inference_ms": round((time.perf_counter() - started) * 1000, 1),
                "input_tokens": len(ids), "review_required": True}

    def prepare(self, state, questions):
        """Tokenize before taking the GPU; raises Rejected for input the model cannot score."""
        return render_question_rows(state, questions, self.tokenizer, self.helper, self.systemone_helper)

    def systemone(self, prepared):
        rendered, rows = prepared
        params = [self.sampling_params(max_tokens=1, temperature=1.0, top_p=1.0, logprobs=len(labels),
                                       allowed_token_ids=labels, seed=0) for _, labels in rows]
        started = time.perf_counter()
        outputs = self.llm.generate([{"prompt_token_ids": ids} for ids, _ in rows], params, use_tqdm=False)
        answers = {}
        for (key, question), (_, labels), output in zip(rendered.items(), rows, outputs):
            scores = output.outputs[0].logprobs[0]
            probabilities = softmax_scores({k: v.logprob for k, v in scores.items()}, labels, self.temperature)
            answers[key] = self.systemone_helper.format_answer(question, probabilities)
        return {"model": MODEL_ID, "revision": MODEL_REVISION, "answers": answers,
                "usage": {"input_tokens": self.systemone_helper.unique_tokens([{"ids": ids} for ids, _ in rows]),
                          "output_tokens": 0},
                "temperature": self.temperature, "inference_ms": round((time.perf_counter() - started) * 1000, 1),
                "review_required": True}
