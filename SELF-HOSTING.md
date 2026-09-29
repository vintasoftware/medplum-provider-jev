# Self-hosting the decision model: Decider on Modal

Instead of TypeSafe's hosted Jev, run the open, Apache-2.0 **Mapika/decider-35b-a3b-nvfp4** checkpoint on a private Modal GPU Server. This is the path to evaluate when patient data and contractual control matter: Modal documents an Enterprise BAA, and the model and weights stay in your account. [ARTICLE.md](ARTICLE.md) explains the model choice and the HIPAA reasoning.

**Status.** The endpoint serves two routes. `POST /check` takes one of nine authored case ids (`demo/cases.py`) and produced the verified prediction below. `POST /v1/systemone` takes the same state and questions the Bot sends to hosted Jev, so the guided demo runs on it with `CONSISTENCY_BACKEND=modal` ([step 5](#5-run-the-guided-demo-on-it)). After an idle period the first check waits on a [5-minute cold start](#6-cold-starts-and-warm-up).

## What you need

- A Modal account with a payment method, and `modal setup` done locally.
- Python 3.12:

  ```bash
  python3.12 -m venv .venv && . .venv/bin/activate && pip install -r requirements-dev.txt
  python -m pytest -q
  ```

- No local GPU and no paid Hugging Face account; the checkpoint is public.

| Artifact | Pin |
| --- | --- |
| Model | `Mapika/decider-35b-a3b-nvfp4` |
| Revision | `798555c06e419c4638c9ebd06c78ed8b5e92c868` |
| Native prompt helper SHA-256 | `5a42134cf470c566e34ac38fb10e63851c21a4bb739475eef797849bcfe460a3` |
| vLLM | 0.29.0, image `vllm/vllm-openai@sha256:082ca6f035279109041ffd3fe0695cb568b29bc580b35c4f297a66a08b216c1b` (CUDA 13.0.2) |
| Modal SDK | 1.5.5 |
| GPU | One RTX PRO 6000 Blackwell, 96 GB |

The pins live in `demo/config.py`. The ~19.6 GB of weights are not the VRAM requirement; the serving limit is 4,096 tokens. B300 needs a separately verified CUDA 13.1 image: changing only the GPU name is not a fallback.

## 1. Stage the weights

```bash
modal run -m demo.modal_app
```

A CPU function in the US downloads the pinned revision into the v2 Volume `healthcare-decider-weights-v2`, verifies every file against its Git blob or LFS SHA-256, checks the prompt-helper hash, and commits the Volume only after verification. A successful run returns:

```text
{'revision': '798555c06e419c4638c9ebd06c78ed8b5e92c868', 'verified_files': 29}
```

`Stopping app - local entrypoint completed` afterwards is normal, and an unauthenticated Hugging Face warning is harmless. Staging does not load the model on a GPU. Skip this step if it already succeeded for this revision.

To check the prompt rendering without weights, `python -m demo.verify_tokenizer` renders all nine prompts with the pinned tokenizer (167–195 tokens each, answer token ids 32, 33 and 34) and writes `artifacts/tokenizer-check.json`.

## 2. Deploy

```bash
modal deploy -m demo.modal_app
python -c 'import modal; print(modal.Server.from_name("healthcare-consistency", "Inference").get_url())'
```

The app defines a private `Inference` Server that runs in the US with US-east routing. It loads the model before opening its port, handles one request at a time (rejecting concurrent ones with 429), scales to zero after five idle minutes and keeps its URL. Memory snapshots are off, weights are mounted read-only and Hub access is disabled. Use the printed URLs, not `modal.com/apps/...` dashboard links or temporary `-dev` endpoints; regional URLs can end in `.modal.direct`.

The inference server builds Decider's native prompt with fixed option order, reads the allowed option-token logits, applies the checkpoint temperature (1.08) once, and returns a normalized distribution. It rejects overlong contexts instead of letting the helper truncate evidence. Expected labels are never model input. [Reference readout](https://github.com/Mapika/decider/blob/main/moe/vllm_check.py).

`POST /v1/systemone` takes TypeSafe's request shape (`choice` and `noul` questions only) and translates it with the checkpoint's own pinned `decider/systemone.py`, one row per question. Overlong input gets 422; only an inference error trips the fail-closed 503 state.

## 3. Authenticate callers

Create a **Proxy Token** in [Modal Settings → Proxy Tokens](https://modal.com/settings/proxy-auth-tokens) for the deployment's workspace (environment `main` if scoping is offered); it is separate from a CLI token. Unauthenticated calls get 401 before inference; a token scoped to another environment can get 403.

Store the values as ordinary **string** secrets in Medplum Project Admin → Secrets, and in the root `.env` for measurement:

| Name | Value |
| --- | --- |
| `CONSISTENCY_MODEL_URL` | The Inference HTTPS origin only: no `/check`, quotes, backticks or `NAME=` prefix |
| `CONSISTENCY_MODAL_KEY` | Token ID, including `wk-` |
| `CONSISTENCY_MODAL_SECRET` | Token secret, including `ws-` |

Never put them in frontend settings or logs; `npm --prefix provider run configure` never copies them.

## 4. Verify and measure

```bash
python -m demo.measure --rounds 1        # up to 5 rounds per deliberate run
```

It calls the endpoint by case id for all nine authored cases, validates the pinned model, revision and fixture digest, and writes `artifacts/gpu-run-<UTC>.jsonl` with each choice, the three scores, timing and the authored reference (marked as not clinician-validated). It stops at the first failure and never substitutes a reference label for a model answer.

After scale-down, requests get **503** until the GPU has started ([step 6](#6-cold-starts-and-warm-up)). Open the **Inference** container logs; wait for model loading and the server listening on port 8000, then retry. Exceptions, repeated restarts or no GPU capacity need investigation; 503 alone does not prove a normal cold start.

To measure the text route with the exact requests the Bot sends, on the authored cases and the four scenario notes:

```bash
npm --prefix provider run measure -- --backend modal
```

It reads the three values above from the root `.env` and writes `artifacts/modal-run-<UTC>.jsonl` with each label, the scores, the highlighted sentences and whether they hit the expected ones.

**Verified result.** The first hosted prediction, for `dose-conflict` (two same-day discharge documents, 10 mg versus 20 mg), returned `potential_conflict` 0.711 (agreement 0.167, insufficient information 0.122) with 186 input tokens and 829.1 ms of server-side inference and readout, at the pinned revision. It matches the authored reference. It is one observation: not a warm-latency benchmark, and not a claim of 71% clinical correctness.

**Text route result.** On September 29, 2026, `measure -- --backend modal` ran the Bot's requests for the five authored dose cases and the four scenario notes (`artifacts/modal-run-20260929T213205Z.jsonl`). All nine answers were valid; all 18 highlights hit the expected sentence. With the [answer rule](#7-answer-rules), 7 of 9 labels match the authored reference; the misses are the two dated-dose cases. The eight guided-demo e2e tests, recorded through the real Bot against this Server, all passed. One round on authored synthetic cases, not a clinical evaluation.

## 5. Run the guided demo on it

In Medplum Project Admin → Secrets, add the three secrets from step 3 and set `CONSISTENCY_BACKEND` to `modal` (`typesafe` switches back). The Bot sends hosted Jev's request to `/v1/systemone` with the proxy token.

- The project secrets and the root `.env` are separate copies of the proxy token. After rotating it, update both; a stale project copy only shows as "rejected the project credentials".
- `E2E_RECORD=1` overwrites `provider/e2e/cassettes/`, which hold hosted Jev's answers. Keep recordings made against Modal out of Git.

## 6. Cold starts and warm-up

Measured from zero containers on September 29, 2026: GPU scheduling 20 s to 2 min, weight loading 45 s, vLLM start-up about 2 min. `/health` answers 200 after **about 5 minutes**. A warm check then takes about 0.4 s.

- While no container is ready, Modal's proxy answers **503 at once** (empty body); it does not queue the request. `modal container list` shows `Pending` through the whole start-up.
- One request is enough to schedule a container, but scheduling can lag: requests 20 s apart once saw no container for over 80 s, while retrying every 2 s scheduled one at once.
- The Bot is a Lambda with Medplum's default 10-second `timeout`, so it cannot wait out a cold start, and a longer timeout would not help because Modal does not hold the request. After an idle period, the first **Check note** shows "The self-hosted model is starting or unavailable"; that request starts the GPU, so check again in about five minutes.

Warm the Server before a demo or a measurement run (both measure scripts stop at the first 503):

```bash
set -a; . ./.env; set +a
until [ "$(curl -s -o /dev/null -w '%{http_code}' -H "Modal-Key: $CONSISTENCY_MODAL_KEY" \
  -H "Modal-Secret: $CONSISTENCY_MODAL_SECRET" "$CONSISTENCY_MODEL_URL/health")" = 200 ]; do sleep 3; done
```

## 7. Answer rules

For `modal` only, the Bot reports `insufficient_information` when the model's own highlight question found no dose sentence in one document, whatever the dose label (`noDoseSentence` in `provider/bots/consistency.ts`). Decider labeled "Plan: continue lisinopril." `agreement` (0.78) while answering `none` for the highlight. Hosted Jev gets that case right, so the rule is off for it.

Decider also flags both dated-dose cases as `potential_conflict`, including one where the later note explains the change. The rule does not cover that; Decider-specific question wording is the next thing to try.

## 8. Cost

Modal lists the RTX PRO 6000 at $0.000842/s ($3.03/h); with the 1.15 US-region multiplier the GPU is about $3.49/h, and a warm hour with the requested 4 CPU cores and 64 GiB RAM is roughly $4.29 before storage. Loading and idle time count: each cold start plus the five idle minutes is about 10 GPU minutes, around $0.70. These are list-price estimates, not a measured bill. [Pricing](https://modal.com/pricing), [regions](https://modal.com/docs/guide/region-selection).

To stop paying after a test, run `modal container stop -y <id>` (from `modal container list`). A container stopped within five minutes of the last request is **replaced**, so stop it after that window and list again.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `An image tried to run a build step after using image.add_local_*` | Use the current `demo/modal_app.py`: packages install before local source is attached |
| `/bin/sh: 1: python: not found` during the image build | Use the current image definition; it aliases the image's `python3` before installing packages |
| `CONSISTENCY_MODEL_URL must be the HTTPS Modal Server origin` / `Invalid URL` | Store only the origin, as plain text |
| HTTP 503, empty body | No container ready yet ([step 6](#6-cold-starts-and-warm-up)); read the Inference logs, retry every few seconds |
| HTTP 503 `operator restart required` | An inference error put the Server in its fail-closed state; read the logs, then stop the container |
| HTTP 401 / 403 | Check the Proxy Token id and secret, workspace and environment scope |
| Card: The self-hosted model is starting or unavailable | Cold start; check again in about five minutes (step 6) |
| Card: The self-hosted model rejected the project credentials | Stale or mis-scoped proxy token in the project secrets (step 5) |
| Card: The self-hosted model could not check this note | The documents exceed the 3,500-token context |
| A stopped container comes back | It was inside the five-minute scale-down window (step 8) |
| `Failed to fetch tokens: Invalid client` / `Not logged in` from the Medplum CLI | The CLI session expired: `npx --prefix provider medplum login` |
| Secrets not visible to the Bot | Use ordinary project Secrets; the Bot's System flag only adds `Project.systemSecret`, and ordinary entries override same-named system ones |

## Residency and patient data

Modal's BAA path is Enterprise. Volumes v2 are covered; keep PHI out of code, image builds, Volumes v1 and memory snapshots. Modal Servers proxy payloads without storing them, unlike Functions, which can retain inputs and outputs for up to seven days. Modal documents strict compute and routing pinning and US logs and durable storage. [Security](https://modal.com/docs/guide/security), [residency](https://modal.com/docs/guide/data-residency).

For patient documents, use a separate access-controlled Medplum project with the required BAA coverage for every service that sees the text. Keep the Bot reading documents through the caller's own FHIR access, never text from the request. Define and test log, backup, cache and deletion policies, and evaluate the task with clinician-reviewed labels. Medplum Bot audit events also reach server logs, so keep document text and secrets out of Bot output. [Bot logging](https://www.medplum.com/docs/bots/bots-in-production).
