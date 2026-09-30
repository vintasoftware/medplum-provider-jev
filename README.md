# Medplum Provider + Jev

This is a guided demo in the Medplum Provider App. A tester plays the role of a primary care provider at a post-discharge follow-up visit. When they finish the visit, a Medplum Bot compares their free-text note with an outside hospital discharge summary using **[TypeSafe's Jev](https://typesafe.ai/)**. A review card shows what it found: `agreement`, `potential_conflict` or `insufficient_information`. The provider edits the note, signs with a documented reason, or creates a reconciliation task.

Demo video:

https://github.com/user-attachments/assets/ce413f25-983d-4384-9b5a-30054e6a4ebd

Synthetic data only. One synthetic run is not clinical validation. Validate it with clinicians before adapting it to real workflows.

## More info

- [ARTICLE.md](ARTICLE.md): why this workflow, how it works, model choices, results and limits.
- [SELF-HOSTING.md](SELF-HOSTING.md): running the open Jebadiah 27B model on a private Modal GPU instead of hosted Jev for proper HIPAA compliance.

## Quick start

You need:

- **Node** `^22.18.0` or `>=24.2.0` (it runs the TypeScript scripts directly).
- A **Medplum project with Bots enabled** at [app.medplum.com](https://app.medplum.com), where you are an administrator. Use a project for synthetic data only: every run creates a new synthetic patient. Ask Medplum's support for Bots if you're not a paying customer yet.
- **Medplum's terminology** set up for that project. The Bot looks up each active medication's RxNorm code with `CodeSystem/$lookup` to find its ingredients. RxNorm is one of Medplum's hosted default terminologies; if the check below fails, ask Medplum's support to set up terminology for your project and mention that the RxNorm code system is needed, not only its value sets. After logging in (step 2 below), `npx --prefix provider medplum get 'CodeSystem/$lookup?system=http://www.nlm.nih.gov/research/umls/rxnorm&code=314076'` should return "lisinopril 10 MG Oral Tablet".
- A **TypeSafe API key**.

From the repository root:

```bash
# 1. Install the app and the Medplum CLI
npm --prefix provider ci --ignore-scripts

# 2. Log in to Medplum in the browser (the CLI keeps the session; no client secret)
npx --prefix provider medplum login
npx --prefix provider medplum project current     # switch with: medplum project switch <id>

# 3. Preview, then apply, the project setup
npm --prefix provider run setup -- --dry-run --email you+tester@example.com
npm --prefix provider run setup -- --email you+tester@example.com

# 4. Run the app
npm --prefix provider run dev
```

Open `http://localhost:3001`, sign in, choose **Guided demo** in the sidebar and click **Start scenario**.

The setup command asks for the TypeSafe key with hidden input the first time. To skip the prompt, put `TYPESAFE_API_KEY=...` in the root `.env` first. `--email` is optional: it invites a practitioner login limited to the demo policy, and Medplum emails that address a link to set the password. Without it, sign in as an admin.

## What the setup command does

`npm --prefix provider run setup` reuses your CLI login. Before each step it reads the project, then creates or changes only what is missing. Running it again is safe, `--dry-run` writes nothing.

| Step | Result |
| --- | --- |
| Check the project | Stops if Bots are not enabled |
| Bot `healthcare-consistency` | Created if missing; `runAsUser: true` so it reads the chart as the signed-in user |
| `provider/medplum.config.json` | Written with your Bot's id (local, ignored by Git) |
| Bot code | Built, smoke-tested and deployed (`npm --prefix provider run deploy:bot`) |
| Project secrets | `TYPESAFE_API_KEY` and `CONSISTENCY_BACKEND=typesafe` added if missing; existing secrets are kept, and the key is never printed |
| AccessPolicy | "Guided demo practitioner (synthetic project)" from [`demo/access-policy.json`](demo/access-policy.json) |
| `--email` | Invites that address as practitioner "Synthetic Rivera" with the policy, or attaches the policy if they are already a member |
| Root `.env` and `provider/.env.local` | Public settings only: base URL, project id, Bot id. Server secrets are never copied to the frontend |

Options: `--dry-run`, `--email <address>`, `--profile <name>` (a named CLI login).

## Try the demo

**Story.** Dr. Synthetic Rivera sees a patient one week after a hospital stay for high blood pressure. The chart lists "lisinopril 10 MG Oral Tablet", and a visit 35 days ago says "Continue lisinopril 10 mg daily". The outside discharge summary in **Documents** says the hospital raised lisinopril from 10 mg to 20 mg daily. Today's visit, "Post-discharge follow-up", is Planned. Each **Start scenario** creates a new patient with these records.

**Primary path.**

1. Read the discharge summary in **Documents**, then open today's visit in **Visits**.
2. Set the status (upper right) to **In Progress** and write the note: BP 138/86, no dizziness, tolerating medications. Take the plan from the chart's list, as a busy provider might: "continue lisinopril 10 mg daily".
3. Set the visit to **Finished**. The note is saved and checked once. The review card shows **Potential conflict**, both passages with the dose sentences highlighted, and **Details** (scores, model, tokens).
4. Handle it. **Edit note** (then **Check note**), **Sign with a documented reason** (the reason is required and recorded on the signature), or **Create reconciliation task** (it stays open after Sign & Lock). There is no Dismiss, and signing is never blocked.
5. Edit the plan to "Lisinopril increased to 20 mg daily at discharge on 9/16; continue 20 mg, recheck BP in 4 weeks.", press **Check note** to get **Agreement**, then click the lock and **Sign & Lock Note**. The visit shows the signature, and the check stays on the visit (the Timeline lists notes, not signatures or checks). The model changed nothing in the chart.

**Side paths** (same patient, before signing; press **Check note** after each edit):

| Plan in the note | Card |
| --- | --- |
| "Continue lisinopril." (no dose) | Insufficient information: the dose is missing, not wrong |
| The change sentence from step 5, first try | Agreement: the tutorial skips straight to signing |
| "Increase lisinopril to 40 mg daily." | Potential conflict: any unexplained difference is flagged |

**Tutorial.** Tips point at the control to use next. Press **Esc**, click outside the highlight, or choose **Skip tutorial** to hide them at any time. The bar at the top of the page has **Show me**, **Hide tutorial**, **Resume** and **End scenario**; End scenario forgets the run in your browser and deletes nothing. Hiding the tips changes only browser state, and progress follows what you actually did in the chart, so a reload or unguided work lands on the right step.

## Everyday commands

| Task | Command |
| --- | --- |
| Run the app | `npm --prefix provider run dev` |
| Redeploy the Bot after changing `provider/bots/consistency.ts` or `provider/src/utils/consistency-review.ts` | `npm --prefix provider run deploy:bot` |
| Check the project setup again | `npm --prefix provider run setup -- --dry-run` |
| Rewrite `provider/.env.local` from the root `.env` | `npm --prefix provider run configure` |
| Unit tests (the whole app, about a minute) | `npm --prefix provider test` |
| Lint with Medplum's ESLint config | `npm --prefix provider run lint` |
| End-to-end tests (replaying recorded Jev answers) | `npm --prefix provider run test:e2e` |
| Measure hosted Jev on the authored cases and scenario notes | `npm --prefix provider run measure` (add `-- --backend modal` for the self-hosted model) |
| Bot artifact smoke test | `npm --prefix provider run test:bot-bundle` |
| Production build | `npm --prefix provider run build` |

## Changing the questions or the scenario

Edit the JSON directly; the Bot, the app and the measurement all read it:

| File | Holds |
| --- | --- |
| `provider/src/data/model-contract.json` | Model, labels, text limits and the question wording the Bot sends to Jev |
| `provider/src/data/guided-scenario.json` | The synthetic discharge summary, prior note and side-path notes |
| `provider/scripts/measure-cases.json` | Measurement inputs with the expected label and highlight for each |

Then run `npm --prefix provider run measure`, redeploy with `npm --prefix provider run deploy:bot`, and re-record the e2e answers (below). `measure` needs `TYPESAFE_API_KEY` in the root `.env` and writes `artifacts/typesafe-run-<UTC>.jsonl` with each label, the probabilities and whether the highlights hit the expected sentences.

## End-to-end tests

Eight Playwright tests in `provider/e2e/` drive each path in Chromium against your Medplum project: the tutorial's primary path, sign with a reason, the reconciliation task, the three side paths, the stale-check badge, and hiding the tutorial followed by a reload and resume. They start real scenarios and check the resulting FHIR resources. Every test records a video in `artifacts/e2e/<test>/video.webm`.

```bash
npx --prefix provider playwright install chromium    # once
npm --prefix provider run test:e2e                   # add -- -g "<name>" --headed to watch one
```

The tests sign in with the Medplum CLI login; the token stays in memory. `E2E_MEDPLUM_PROFILE=<name>` uses a named CLI profile, such as the invited practitioner. The dev server is started if it is not running.

**Recorded Jev answers.** The Bot's responses, which carry Jev's answers, are recorded per test in `provider/e2e/cassettes/` and replayed by default, so a run makes no Bot or TypeSafe calls and gives the same answers every time. Replay fills in the current run's ids, and it fails if the test makes a different number of Bot calls, sends a different note, or if `model-contract.json` changed since recording (each cassette stores its SHA-256). Re-record with real calls after changing the questions, the Bot or the scenario, and review the diff before committing:

```bash
E2E_RECORD=1 npm --prefix provider run test:e2e
```

Cassettes hold synthetic text and model answers only, never keys or tokens. Replay skips the Bot itself; its FHIR reads and the TypeSafe call are covered by recording and by the Bot's unit tests.

## Practitioner policy

The policy grants type-level create, read and update across the project on what the workflow touches, with no `delete` on any clinical type and access to only the consistency Bot. It uses no patient-compartment criteria because the patient changes every run, which is why the project must hold synthetic data only. Types it does not list (Project, ProjectMembership, AccessPolicy, User, ClientApplication, other Bots, AuditEvent) are denied, which covers secrets and admin functions.

`MockClient` does not enforce policies, so check the refusals on the server as the practitioner:

```bash
cd provider
npx medplum profile set pract --base-url https://api.medplum.com/
npx medplum login -p pract
npx medplum get -p pract Project/<project-id>                  # secrets: refused
npx medplum get -p pract admin/projects/<project-id>           # admin: refused
npx medplum post -p pract 'Bot/<another-bot-id>/$execute' '{}' # other Bots: refused
npx medplum delete -p pract Task/<a task from their own run>   # deletes: refused
```

Test deletes only on a record from the practitioner's own run.

## Manual setup

To inspect or repair a project by hand, run these from `provider/` (the Medplum CLI reads `medplum.config.json` from the current directory):

```bash
npx medplum bot create healthcare-consistency <project-id> bots/consistency.ts bot-dist/consistency-bot.mjs
npx medplum patch Bot/<bot-id> '[{"op":"add","path":"/runAsUser","value":true}]'
npm run deploy:bot
npx medplum post AccessPolicy "$(sed 's/BOT_ID/<bot-id>/' ../demo/access-policy.json)"
npx medplum post admin/projects/<project-id>/invite '{"resourceType":"Practitioner","firstName":"Synthetic","lastName":"Rivera","email":"<tester email>","membership":{"access":[{"policy":{"reference":"AccessPolicy/<policy-id>"}}]}}'
```

Add `TYPESAFE_API_KEY` and `CONSISTENCY_BACKEND=typesafe` as ordinary string secrets in [Project Admin](https://app.medplum.com/admin/project) → Secrets; the System flag is not needed, and changing a secret needs no redeploy. Put `MEDPLUM_BASE_URL`, `MEDPLUM_PROJECT_ID` and `MEDPLUM_CONSISTENCY_BOT_ID` in the root `.env`, then run `npm --prefix provider run configure`. To exercise the Bot alone, execute it from its page with `{"action":"review_encounter","encounter_id":"<id>"}`; errors come back as `{"status":"unavailable","reason":"..."}` without document text or secrets.

## Troubleshooting

| Message | Fix |
| --- | --- |
| `The Medplum CLI failed. Log in first` / session expired | `npx --prefix provider medplum login` |
| `root .env uses project … but the CLI is logged in to …` | `npx --prefix provider medplum project switch <id>`, or fix `MEDPLUM_PROJECT_ID` in `.env` |
| `Bots are not enabled for this project` | Enable Bots for the project in Medplum (a paid plan feature) |
| `No medplum.config.json. Run: npm --prefix provider run setup` | Run the setup command once in this checkout |
| Card: The consistency Bot is not configured yet | Rerun setup, then restart `npm run dev` |
| Card: Sign in to the configured synthetic demo project | Sign in to the project in `MEDPLUM_PROJECT_ID` |
| Card: Missing string project secret: TYPESAFE_API_KEY | Rerun setup; it adds missing secrets |
| Card: The model service rejected the project credentials | Replace `TYPESAFE_API_KEY` in Project Admin → Secrets |
| Card: No chart note has been saved for this visit yet | Type the note, then press Check note |
| Card: Medication terminology is unavailable; retry later | Run the RxNorm `$lookup` check under [Quick start](#quick-start). `CodeSystem … not found` means the project cannot see RxNorm: ask Medplum's support to set up terminology for the project |
| Card: An active RxNorm concept has no supported ingredient resolution | An active medication is coded as a concept the Bot cannot map to ingredients, such as a bare brand name; code it as a clinical or branded drug (SCD/SBD) |
| Card: No outside discharge summary is on file | Use Start scenario; the check needs a current LOINC 18842-5 DocumentReference with `text/plain` content |
| Card: The self-hosted model … | `CONSISTENCY_BACKEND` is `modal`; see the troubleshooting table in [SELF-HOSTING.md](SELF-HOSTING.md) |
| e2e: `recorded with different Bot questions` | Re-record: `E2E_RECORD=1 npm --prefix provider run test:e2e` |

## Privacy

TypeSafe's hosted API is used here with synthetic records only. A deployment that processes PHI needs a BAA or DPA with TypeSafe, or the self-hosted path, plus the controls described in the article.

## Provenance

`provider/` is upstream [medplum/medplum-provider](https://github.com/medplum/medplum-provider) commit `511586d3454a185d37084881248a52948e3c43f6` ("Merge from main repo: Release Version 5.1.39", committed 2026-09-16T04:08:45Z), imported on September 23, 2026. Its [Apache-2.0 license](provider/LICENSE.txt) and attribution are preserved. Model licenses apply separately.
