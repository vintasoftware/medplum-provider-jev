# Benchmark runs

The raw output behind the numbers in [ARTICLE.md](../ARTICLE.md) and [SELF-HOSTING.md](../SELF-HOSTING.md): one JSON line per case and round, with the expected label, the model's label and probabilities, the highlighted sentences and whether they hit the expected ones, and the request time. `npm --prefix provider run measure` writes these to `artifacts/` (gitignored); copy a run here when a document cites it. The files are plain JSONL on purpose: Git compresses them itself, and a diff between runs stays readable.

All runs are from October 1, 2026 on the 100-case benchmark, which `measure` at the time ran as two commands: the guided demo's 4 scenario notes and the 96 generated cases (`provider/scripts/gen-cases/`). The Modal files were renamed from `modal-run-*` to say which model answered.

| File | Model | Cases | Rounds |
| --- | --- | ---: | ---: |
| `typesafe-run-20261001T195856Z.jsonl` | Hosted Jev `jev-1.13.0` | 4 scenario | 1 |
| `typesafe-run-20261001T204314Z.jsonl` | Hosted Jev `jev-1.13.0` | 96 generated | 1 |
| `typesafe-run-20261001T220102Z.jsonl` | Hosted Jev `jev-1.13.0` | 4 scenario | 3 |
| `typesafe-run-20261001T220106Z.jsonl` | Hosted Jev `jev-1.13.0` | 96 generated | 3 |
| `jebadiah-27b-run-20261001T203442Z.jsonl` | Jebadiah 27B on Modal | 4 scenario | 1 |
| `jebadiah-27b-run-20261001T204820Z.jsonl` | Jebadiah 27B on Modal | 96 generated | 1 |
| `autojev-run-20261001T204441Z.jsonl` | AutoJev-27B on Modal | 4 scenario | 1 |
| `autojev-run-20261001T204537Z.jsonl` | AutoJev-27B on Modal | 96 generated | 1 |
| `jebadiah-9b-run-20261001T204747Z.jsonl` | Jebadiah 9B v2 on Modal | 4 scenario | 1 |
| `jebadiah-9b-run-20261001T204441Z.jsonl` | Jebadiah 9B v2 on Modal | 96 generated | 1 |

A self-hosted row names the model by its weights path, which is the pinned checkpoint revision. The `note_ok` flags were scored with the highlight substrings of the time. Four substrings were tightened afterwards to name the plan sentence alone, which turns one recorded hit into a miss: Jebadiah 9B highlighted the sentence describing the change in `gen2-prednisone-taper-ack`, so the documents count 197 highlights for it, not the file's 198. A row with `label_rule` is one where the Bot's answer rule replaced the model's `agreement` (kept in `model_choice`) with `insufficient_information`; see SELF-HOSTING.md step 7.
