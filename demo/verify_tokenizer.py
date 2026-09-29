"""Verify the pinned native prompt without downloading model weights."""
import json
from pathlib import Path
from huggingface_hub import hf_hub_download
from tokenizers import Tokenizer
from demo.cases import CASES
from demo.config import MODEL_ID, MODEL_REVISION
from demo.scoring import load_prompt_helper, render_case


class Adapter:
    def __init__(self, path):
        self.tokenizer = Tokenizer.from_file(path)

    def encode(self, text, add_special_tokens=False):
        return self.tokenizer.encode(text, add_special_tokens=add_special_tokens).ids


def main():
    tokenizer = Adapter(hf_hub_download(MODEL_ID, 'tokenizer.json', revision=MODEL_REVISION))
    helper = load_prompt_helper(Path(hf_hub_download(MODEL_ID, 'decider/prompt.py', revision=MODEL_REVISION)))
    results = []
    for case in CASES:
        ids, labels = render_case(case, tokenizer, helper)
        results.append({'case_id': case.id, 'input_tokens': len(ids), 'label_ids': labels})
    report = {'model': MODEL_ID, 'revision': MODEL_REVISION, 'native_prompt_verified': True,
              'weights_downloaded': False, 'gpu_inference_verified': False, 'cases': results}
    Path('artifacts').mkdir(exist_ok=True)
    Path('artifacts/tokenizer-check.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
