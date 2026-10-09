---
name: medplum-provider-demo
description: Build, extend or review a synthetic-data demo on a Medplum Provider App fork, set up its hosted tester project, or prepare its article and recordings.
metadata:
  version: "3"
---

# Medplum Provider App demos

A demo is a **starter kit**: the Medplum Provider App with a workflow added that outside testers can try with synthetic data. Keep readability, Medplum's own patterns, and separate scenario runs. **Scope belongs to the human**: follow the project's settled demo limits. Large-scale pagination, offline handling, tenant middleware, extra audit plumbing and rare edge cases need a demonstrated requirement. A bounded search is fine when its callers can use a bounded result; a caller requiring all records must receive them or report that its limit was exceeded. Ask before adding machinery for a scenario the project excludes.

Two references anchor every decision:

- **Upstream**: the Medplum monorepo at the pinned release tag, and its `examples/medplum-provider`. The demo's code should read as if upstream's authors wrote it. [Medplum's guidance for AI-assisted work](https://www.medplum.com/docs/building-with-ai-coding-assistants) says the same: read Medplum's docs and code before writing, adapt the closest existing implementation, stay on FHIR R4 with `@medplum/fhirtypes`, and verify fields, search parameters, operations and codes rather than inventing them. Revisit the relevant source after compaction.
- **The reviews in `vintasoftware/medplum-provider-jev`**: the decisions below came from reviewing that fork against upstream. Its `AGENTS.md`, `README.md` and `provider/` are the worked example.

## Choose the work

Read the target repository's instructions, README, structure and scripts. For a **new fork**, follow the steps below, using only the implementation sections its workflow needs. For an **existing fork or review**, use its recorded upstream baseline and apply the steps the requested change reaches. For **hosted tester setup**, use the existing administrator setup and tester-policy reference. For an **article or recordings**, inspect the working demo and its evidence, then use the presentation reference.

Complete the requested deliverable and report what was verified. Commits, deployment, invitations, PRs and publishing follow the user's authorization. A local review can end with local findings or fixes; a Bot or benchmark is needed only when the workflow calls for one.

## Steps

### 1. Pin upstream

1. For a new fork, import `examples/medplum-provider` from the Medplum monorepo at a release tag. For an existing fork, resolve its recorded tag or commit. Keep its `LICENSE.txt` and the SPDX headers on its files. Write a Provenance section in the README naming the tag or commit and the import date.
2. Keep the monorepo at that tag available for comparison. The cheapest form is an export into a scratch folder: `git -C <monorepo> archive v<tag> examples/medplum-provider | tar -x -C <scratch>`. Compare that export against the affected parts of the fork, excluding `node_modules`, `dist` and build outputs, and account for each upstream edit.
3. If the standalone export lacks a lint config, add `eslint.config.mjs` extending `@medplum/eslint-config`, the way the monorepo root does. Keep overrides narrow and justified. Preserve upstream attribution; new files follow the project's attribution choice.

Done when the Provenance section names the baseline and the fork's type, lint and unit results are established, with any pre-existing failures recorded.

### 2. Plan the workflow against Medplum

1. Write the story as the README's "Try the demo" section: who the tester plays, the records they see, the numbered clicks, and what each side path shows.
2. Map the FHIR resources and required interactions, including upstream UI consumers: which the workflow reads, which it writes, and who writes each, the user through the app or a Bot. Use standard resources over custom shapes (a check result is a `DetectedIssue`, a signature is a `Provenance`, follow-up work is a `Task`). Reuse upstream's own helpers for the resources it already creates.
3. For an AI workflow, keep model settings, labels, text limits and question wording in one shared contract. This example uses a JSON file consumed by the Bot, app, measurement and cassette validation. Measurements reuse production request builders and answer rules.
4. Codes are where assistants hallucinate. Use real LOINC, RxNorm and SNOMED codes, and look them up against the project's terminology (`CodeSystem/$lookup`) before relying on them.

Done when the story covers the primary and side paths, and the resource map accounts for every type, interaction and access criterion the workflow and upstream UI need.

### 3. Build it so it reads like upstream

Apply the "Reads like upstream" reference below while writing, not after. The habits that mattered most:

- Upstream files get small, single-purpose edits: an anchor attribute, one hook call, one prop. New behaviour lives in new files in upstream's layout.
- A hook owns server state and the actions on it; a component renders what it is given. Split them the way upstream splits `useEncounterChart` and `EncounterChart`.
- A parent calls a hook's function directly. When a parent must open a child's dialog, the child takes the controlled props that upstream's `useControllableDisclosure` supports.
- Code shared by the Bot and the app lives in one pure module that neither bundle can break.

Done when each affected upstream edit has one purpose, the persistence and evidence guarantees below hold where applicable, and lint has no new errors.

### 4. Write the Bot, when needed

Follow the "Bots" reference. Done when unit tests pass against `MockClient`, the bundle smoke test loads the locally built artifact, and every failure the Bot can report is a fixed, safe message. A bundle test does not inspect deployed code.

### 5. Seed synthetic data and separate testers

Follow the "Synthetic data and testers" reference. An administrator previews and applies setup, then invites testers. Done when a fresh tester can sign in and finish the workflow on their own run, including reloads, and authorized server checks confirm the policy's intended grants and refusals. Fresh runs do not imply access isolation in a shared project.

### 6. Test and verify

Follow the "Testing" reference. For implementation changes, run type/build checks, lint and the whole unit suite; include the Bot bundle check when applicable. Run applicable Practitioner e2e replay when hosted verification is authorized; refresh recordings under the change triggers in the Testing reference. For documentation-only changes, check the document's structure, references and claims. Done when every applicable check has a reported result, with pre-existing or environment-only failures and unverified live behavior identified.

### 7. Ship

- When commits and a PR are requested, keep one coherent change per commit and describe the final behavior and verification. State the demo scope to any independent reviewer.
- Docs say exactly what the code does. When code moves, grep the README, `AGENTS.md`, article and scripts for the old path. Commands in docs run the whole thing (`npm test`), never a hand-kept list of paths.
- Generated assets that reproduce scenario text read the scenario file rather than carrying their own copy. If an article or recordings are requested, follow the presentation reference.

Done when the requested local or published deliverable is ready, with verification and remaining limits stated. Merging is a separate action governed by the user's request.

## Reads like upstream

The review bar. Each rule names the upstream pattern to match.

**Layout.** Match upstream's directories. Hooks in `src/hooks/useX.ts` with `useX.test.tsx` beside them. Pure helpers in `src/utils/`, types in `src/types/`, feature pages under `src/pages/<feature>/`, components under `src/components/<area>/`. Component styles in a `*.module.css` next to the component; the global stylesheet stays as short as upstream's. Feature code that several upstream components import belongs in a module of its own rather than under `pages/`. Split by concern rather than line count; keep code that changes together cohesive.

**State.** A hook returns state plus functions (`runCheck`, `createTask`); the component receives them as props and holds only view state such as a details toggle. Effects key on primitives, an id or a reference string, so a new object with the same identity does not refetch. A save queue keeps two facts, the latest typed text and what the server has; a flush sends the latest text unless the server already has it. Actions that depend on persisted edits, such as checking or signing, wait for a successful save. A failed save retains the latest text for retry and prevents the action from using an older server copy.

**Record selection and evidence.** Consumers reading the same record share its patient/encounter scope and ordering rule. Here, `src/utils/consistency-review.ts` supplies `noteSearch` to the editor, Bot and tutorial. Stored judgments identify the source versions they checked and reload those versions; unreadable evidence is shown as unavailable. Current text cannot stand in for an older judgment's evidence. In this repo, `src/utils/consistency.ts` builds and reads versioned references, and edits mark an old check stale. Use current contracts for an unreleased demo rather than building compatibility for data or clients it never shipped; preserve any existing records the user says matter.

**Reuse before writing.** From `@medplum/react`: `useMedplum`, `useMedplumProfile`, `useResource`, `useSearchOne`, `useSearchResources`, `useSubscription`, `MedplumLink`, `ResourceAvatar`, `AnnotationInput`. From `@medplum/core`: `createReference`, `getReferenceString`, `formatDate`, `formatDateTime`, `formatHumanName`, `createResourceIfNoneExist` for idempotent setup. From the app: `showErrorNotification`, `useControllableDisclosure`, `useDebouncedUpdateResource`. From Mantine: `useDisclosure`, `useDebouncedCallback`.

**Style.** Follow the pinned lint config. In the worked example: Braces on every `if`. `@param` and `@returns` on every documented exported function; a `//` line for a documented internal helper. Explicit return types. `import type` for types. No nested ternary: an `if` chain that assigns a variable. Promise executors with block bodies. camelCase in TypeScript; snake_case only where a wire format demands it, with the boundary named.

**Configuration.** Public settings reach the browser through `import.meta.env`; Vite's `envPrefix` determines what is exposed. A `configure` script copies an explicit allowlist of public names from the root `.env` into `.env.local` and skips all other settings. Ignore credential-bearing environment files while preserving public templates. Secrets live in Medplum project secrets and reach the Bot through `event.secrets`.

**Text keeps up with code.** README rows, `AGENTS.md` lines, UI copy and comments claim exactly what the code checks. A shared module the Bot bundles is named wherever redeploys are documented.

**Change only if it gets smaller or clearer.** A refactor of working demo code earns its place when the result is more readable or shorter, measured on the diff. When it is neither, the human decides.

## Bots

- One `handler(medplum, event)` export. Set `runAsUser: true` for chart access under the tester's policy. This example's Bot reads only and the app stores the result under the tester's own access; grant Bot writes only when the target workflow requires them.
- Validate `event.input` to the exact keys expected and reject the rest. Read settings through `event.secrets`. Every error the Bot returns is a fixed message: never the document text, never the request, never a secret. Keep document text, secrets, request bodies and model response bodies out of logs and errors. Unknown failures map to one generic message.
- Budget time within the runtime limit documented for the target deployment. This example stays under 10 seconds: a budget for chart reads, a budget for terminology, the rest for the model call, with one retry on overload when time remains. Reject incomplete searches when the computation requires the complete set.
- Keep the code the Bot shares with the app (searches, text splitting, the result type) in one module under `src/utils/` that imports nothing Node-only (`Buffer`) and nothing browser-only (`import.meta.env`). Both bundles include it, so the README's redeploy row names it.
- Deploy with `medplum bot deploy` from a `medplum.config.json` the setup script writes (Git-ignored). A bundle smoke test copies the built artifact to a temp folder and loads it, which proves the JSON contract bundled.
- The setup script is idempotent: read the project first, create only what is missing, `--dry-run` writes nothing, secrets are added with a JSON patch that starts with a `test` op on the current list, and secret values are never printed.

## Synthetic data and testers

- Synthetic data only, stated in the README and article. Adapting to PHI is a separate project decision requiring access controls and BAA coverage for every service seeing the text; self-hosting a model alone does not settle that.
- Each scenario run creates a new Patient carrying a run identifier, and clinical records are retained; "End scenario" forgets the run in the browser. Dates are seeded relative to today, and fixture text carries no dates, so a run started next month still reads right. Measurement cases pin their own dates.
- Browser state holds opaque run ids, step ids and tutorial preferences rather than chart text. Derive workflow progress from the chart so reloads and unguided work resume correctly.
- One AccessPolicy per tester role, kept in a JSON file the administrator's setup script applies. Derive interactions and criteria from actual consumers, including upstream sidebar reads, terminology and subscriptions. Lookup types get reads, writes go only to types the role changes, and clinical deletes stay denied. Include `vread` for checked-evidence reloads and `history` where needed. Scope Bot access to `Bot?_id=<the demo's Bot>` and keep `Project`, `ProjectMembership`, `AccessPolicy`, `User` and `ClientApplication` administration out of the tester policy. The worked policy scopes websocket Subscriptions to `%profile` and permits their lifecycle, including delete. The administrator invites each tester as a Practitioner with that policy (`setup --email`).
- `MockClient` does not enforce policies. Verify the complete workflow and intended refusals on a server as the Practitioner: project/admin reads and other Bots should be refused. A delete-refusal probe requires authorization and a disposable record from the tester's own run, since a faulty policy could allow it.
- Fresh runs keep the workflow from mixing scenarios. Type-level policies in a shared synthetic project still allow testers to access each other's records. Scope workflow reads to the run; use patient-compartment criteria or separate projects only when access isolation is a settled requirement.

## Testing

- Unit tests render with `MockClient` inside `MedplumProvider`, `MantineProvider` and `MemoryRouter`, the way upstream's tests do. Hooks are tested with `renderHook` and a wrapper, and results are read from `result.current`. Fixtures come from the real builders (the function that builds the resource in production), so a test cannot carry an answer the system would not produce. Upstream's `HomerSimpson` and `DrAliceSmith` fixtures serve tests of upstream behaviour.
- Bot tests call `handler` with a `MockClient` seeded through the real search paths, stub `fetch` for the model, and assert both the request built and the resources touched. A "writes nothing" test spies on every write method.
- Browser checks use Playwright's headless Chromium and the project's auth fixtures. In this repo, a Practitioner CLI login is placed in `localStorage` as `activeLogin` by an init script; the token is never printed. Check `medplum whoami` before Medplum steps and ask for login when it fails. Hide tutorial overlays before clicking outside their highlights: the first click may only dismiss a tip.
- e2e cassettes record the Bot's responses, which carry the model's answers, with the contract file's hash and replay them by default. Replay fails on a different note, a different call count or a changed contract. It supplies recorded answers directly and bypasses the Bot; the contract hash cannot detect a Bot-only code change. Once a recording request gets a Bot response, fulfill the route, since MedplumClient retries aborted fetches. Report recorder errors at teardown even when page assertions fail.
- After Bot behavior, questions or scenario changes, run the relevant Bot tests and deliberately record against the deployed version when hosted testing is authorized; otherwise state that live behavior is unverified. Review refreshed cassettes before committing. When comparing another backend, copy its recordings to artifacts and restore the canonical cassettes; return project settings to their normal values.
- Validate newly built FHIR resources on a server with `$validate` or a round trip when server verification is in scope; otherwise report it as unverified.
- For AI demos, a measurement script sends production requests and applies production answer rules to the benchmark cases and every scenario note. Write one JSONL row per answer under `artifacts/`, with model identity, probabilities, rule overrides, expected label, highlights and timing; stop on failed or invalid answers. Keep authored expectations distinct from model answers. Fix questions or behavior rather than rewriting a fixture to make an answer pass. Rerun affected measurements after requests or answer rules change. Synthetic results are not clinical validation; say so wherever results appear.
- Evidence over confidence: to know whether a note passes the model, read the cassettes and the measurement rows for that exact text, then state the label and probability they hold.

## Present the demo and article, when requested

Start with the concrete problem and show the provider's primary path, the choices available and their effects on the chart. Explain the model's role, the boundary of automation and the FHIR records that preserve the decision. Connect architecture and annotated screenshots to that working flow. The worked `ARTICLE.md`, `article/` and `videos/` show those pieces.

Ground model comparisons in the same production requests and task-specific cases. Distinguish scenario checks from a broader benchmark and synthetic authored expectations from clinician-reviewed labels. Explain misses, any answer rule and what displayed probabilities mean. Briefly justify the model choice for this task using measured behavior, latency, cost and the decisions its probabilities support; distinguish measurements from published claims. If claiming answer stability, measure repeated rounds. Retain and link the raw runs behind published numbers, with model versions, dates and case provenance; this repo uses `benchmark-runs/`. Generic benchmark rankings do not establish performance on this workflow.

Record the working app and build captions or marketing cuts from that take when requested. When an asset reproduces scenario text, read the scenario file instead of copying it. Update figure copy from the cited measurement evidence. After changing the scenario or results, check existing assets against the app and article. Regenerate assets that misrepresent the workflow or results; an otherwise accurate take can remain after a minor copy change, while its generator must be correct for the next recording. Read `videos/README.md` and the figure scripts for their actual commands.

Keep durable docs short: setup and testing in the README, design and results in the article, and a separate runbook only where needed. Describe the current implementation; Git holds draft history and retired plans. Keep docs aligned with the code: grep references after moving modules, name every bundled source that needs redeployment, and document runnable whole-suite commands. Published results describe synthetic performance and limitations, not clinical validation. Verify current prices, model availability and compliance claims against primary sources when including them. Deliver the requested local draft or publish only as authorized, with verification and any remaining limitations stated.
