# Self-hosting the decision model: Jebadiah 27B on Modal

Instead of TypeSafe's hosted Jev, run the open, Apache-2.0 **frontier-infra/jebadiah-27b** checkpoint on a private Modal GPU Server. This is the path to evaluate when patient data and contractual control matter: Modal documents an Enterprise BAA, and the model and weights stay in your account. [ARTICLE.md](ARTICLE.md) explains the model choice and the HIPAA reasoning.

**Status.** The Server runs Jebadiah's own server, which takes the same `POST /v1/systemone` request the Bot sends to hosted Jev, so the guided demo runs on it with `CONSISTENCY_BACKEND=modal` ([step 5](#5-run-the-guided-demo-on-it)). After an idle period the first check waits on a [cold start of 3–4 minutes](#6-cold-starts-and-warm-up).

## What you need

- A Modal account with a payment method, and `modal setup` done locally.
- A Hugging Face read token for staging: anonymous downloads from Modal get rate limited.
- Python 3.12:

  ```bash
  python3.12 -m venv .venv && . .venv/bin/activate && pip install -r requirements-dev.txt
  python -m pytest -q
  ```

| Artifact | Pin |
| --- | --- |
| Model | [`frontier-infra/jebadiah-27b`](https://huggingface.co/frontier-infra/jebadiah-27b), a Qwen3.8-27B fine-tune, 56 GB of BF16 weights |
| Revision | `3dd6f22cd54d83c5f665b1ad2f6b7183e8f96bed` |
| Server | [`getainode/jebadiah`](https://github.com/getainode/jebadiah) at `cc904344061e4ee71d2cb8297eafd2ce1c798f99`, installed with `uv sync --frozen` |
| GPU | One A100 80 GB; the model uses 53.4 GB |

The pins live in `demo/modal_app.py`. The server is third-party code that sees the documents: review its diff before changing `SERVER_COMMIT`.

## 1. Stage the weights

```bash
HUGGING_FACE_TOKEN=hf_... modal run -m demo.modal_app
```

A CPU function in the US downloads the pinned revision into the v2 Volume `healthcare-jebadiah-weights-v2`, verifies every file against its Git blob or LFS SHA-256, and commits the Volume only after verification. A successful run returns:

```text
{'revision': '3dd6f22cd54d83c5f665b1ad2f6b7183e8f96bed', 'verified_files': 67}
```

The token reaches only the staging function. Skip this step if it already succeeded for this revision.

## 2. Deploy

```bash
modal deploy -m demo.modal_app
python -c 'import modal; print(modal.Server.from_name("healthcare-consistency", "Inference").get_url())'
```

Deploy without `HUGGING_FACE_TOKEN` set, so the app carries no token. The private `Inference` Server runs in the US with US-east routing, scales to zero after five idle minutes and keeps its URL. Memory snapshots are off, weights are mounted read-only and Hub access is disabled. It refuses to start unless the staged revision was verified. Use the printed URL, not a `modal.com/apps/...` dashboard link; regional URLs can end in `.modal.direct`.

The server answers for `jev-latest`, reads each question's option logits in one pass and applies the checkpoint's per-question-type temperatures. It runs one request at a time and queues the rest.

## 3. Authenticate callers

Create a **Proxy Token** in [Modal Settings → Proxy Tokens](https://modal.com/settings/proxy-auth-tokens) for the deployment's workspace (environment `main` if scoping is offered); it is separate from a CLI token. Unauthenticated calls get 401 before inference; a token scoped to another environment can get 403.

Store the values as ordinary **string** secrets in Medplum Project Admin → Secrets, and in the root `.env` for measurement:

| Name | Value |
| --- | --- |
| `CONSISTENCY_MODEL_URL` | The Inference HTTPS origin only: no path, quotes, backticks or `NAME=` prefix |
| `CONSISTENCY_MODAL_KEY` | Token ID, including `wk-` |
| `CONSISTENCY_MODAL_SECRET` | Token secret, including `ws-` |

Never put them in frontend settings or logs; `npm --prefix provider run configure` never copies them.

## 4. Measure

```bash
npm --prefix provider run measure -- --backend modal
```

It sends the Bot's exact requests for the five authored dose cases and the four scenario notes, and writes `artifacts/modal-run-<UTC>.jsonl` with each label, the scores, the highlighted sentences and whether they hit the expected ones. It stops at the first 503: warm the Server first ([step 6](#6-cold-starts-and-warm-up)).

**Result.** On September 30, 2026, on the A100 (`artifacts/modal-run-20260930T121617Z.jsonl`), all 18 highlights hit the expected sentence and, with the [answer rule](#7-answer-rules), 8 of 9 labels matched the authored reference, as many as hosted Jev. Warm requests took 0.5–0.7 s. The eight guided-demo e2e tests, recorded through the real Bot against this Server, all passed. One round on authored synthetic cases, not a clinical evaluation.

## 5. Run the guided demo on it

In Medplum Project Admin → Secrets, add the three secrets from step 3 and set `CONSISTENCY_BACKEND` to `modal` (`typesafe` switches back). The Bot sends hosted Jev's request to `/v1/systemone` with the proxy token.

- The project secrets and the root `.env` are separate copies of the proxy token. After rotating it, update both; a stale project copy only shows as "rejected the project credentials".
- `E2E_RECORD=1` overwrites `provider/e2e/cassettes/`, which hold hosted Jev's answers. Keep recordings made against Modal out of Git.

## 6. Cold starts and warm-up

Measured from zero containers on September 30, 2026: GPU scheduling and weight loading take 1–1.5 minutes, then a warm-up of about 2 minutes. `/health` answered 200 after **186 s and 223 s** in two runs.

- The model's linear-attention kernels compile on first use for each input shape, which made the first requests take 10–37 s. Start-up therefore sends synthetic requests across the Bot's shapes before the Server takes traffic; the Inference logs show `warm-up: … s` when it ends. The first real request then takes about 2 s.
- While no container is ready, Modal's proxy answers **503 at once** (empty body); it does not queue the request. One request schedules a container, but requests 20 s apart once saw none for over 80 s, while retrying every 2 s scheduled one at once.
- The Bot is a Lambda with Medplum's default 10-second `timeout` and gives the model 8 s, so it cannot wait out a cold start. After an idle period, the first **Check note** shows "The self-hosted model is starting or unavailable"; that request starts the GPU, so check again in about four minutes.

Warm the Server before a demo or a measurement run:

```bash
set -a; . ./.env; set +a
until [ "$(curl -s -o /dev/null -w '%{http_code}' -H "Modal-Key: $CONSISTENCY_MODAL_KEY" \
  -H "Modal-Secret: $CONSISTENCY_MODAL_SECRET" "$CONSISTENCY_MODEL_URL/health")" = 200 ]; do sleep 2; done
```

## 7. Answer rules

For `modal` only, the Bot reports `insufficient_information` when the model's own highlight question found no dose sentence in one document, whatever the dose label (`noDoseSentence` in `provider/bots/consistency.ts`). Jebadiah labeled "Plan: continue lisinopril." `agreement` while answering `none` for the highlight. Hosted Jev gets that case right, so the rule is off for it.

The remaining miss is `dose-dates-unexplained`: two dated doses with no explanation, which the reference calls insufficient information and Jebadiah flags as `potential_conflict` (0.94).

## 8. Cost

Modal lists the A100 80 GB at $2.50/h. With 4 CPU cores, 8 GiB of RAM and the 1.15 US-region multiplier, a warm hour is about **$3.16** before storage. Each cold start plus the five idle minutes is about 9 GPU minutes, around $0.47. These are list-price estimates, not a measured bill. [Pricing](https://modal.com/pricing), [regions](https://modal.com/docs/guide/region-selection).

To stop paying after a test, run `modal container stop -y <id>` (from `modal container list`). A container stopped within five minutes of the last request is **replaced**, so stop it after that window and list again.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `429 Too Many Requests` from the Hub while staging | Set `HUGGING_FACE_TOKEN` to a read token (step 1) |
| `Function has 2 dependencies but container got 3 object ids` | Deploy and run from the same `demo/modal_app.py`; only `modal run` needs the token |
| `CONSISTENCY_MODEL_URL must be the HTTPS Modal Server origin` / `Invalid URL` | Store only the origin, as plain text |
| HTTP 503, empty body | No container ready yet ([step 6](#6-cold-starts-and-warm-up)); read the Inference logs, retry every few seconds |
| HTTP 503 from `/health` with a JSON body | The weights are still loading |
| HTTP 401 / 403 | Check the Proxy Token id and secret, workspace and environment scope |
| Card: The self-hosted model is starting or unavailable | Cold start; check again in about four minutes (step 6) |
| Card: The self-hosted model rejected the project credentials | Stale or mis-scoped proxy token in the project secrets (step 5) |
| Card: The self-hosted model could not check this note | The request exceeds the server's 4,096-token prompt limit |
| A stopped container comes back | It was inside the five-minute scale-down window (step 8) |
| `Failed to fetch tokens: Invalid client` / `Not logged in` from the Medplum CLI | The CLI session expired: `npx --prefix provider medplum login` |
| Secrets not visible to the Bot | Use ordinary project Secrets; the Bot's System flag only adds `Project.systemSecret`, and ordinary entries override same-named system ones |

## Residency and patient data

Modal's BAA path is Enterprise. Volumes v2 are covered; keep PHI out of code, image builds, Volumes v1 and memory snapshots. Modal Servers proxy payloads without storing them, unlike Functions, which can retain inputs and outputs for up to seven days. Modal documents strict compute and routing pinning and US logs and durable storage. [Security](https://modal.com/docs/guide/security), [residency](https://modal.com/docs/guide/data-residency).

For patient documents, use a separate access-controlled Medplum project with the required BAA coverage for every service that sees the text. Keep the Bot reading documents through the caller's own FHIR access, never text from the request. Define and test log, backup, cache and deletion policies, and evaluate the task with clinician-reviewed labels. Medplum Bot audit events also reach server logs, so keep document text and secrets out of Bot output. [Bot logging](https://www.medplum.com/docs/bots/bots-in-production).
