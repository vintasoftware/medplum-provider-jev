---
name: medplum-provider-demo
description: Build, extend or review a synthetic-data demo on a Medplum Provider App fork, set up its hosted tester project, or prepare an article and recordings grounded in the working demo.
metadata:
  version: "2"
---

# Medplum Provider App demos

A demo is a **starter kit**: the Provider App with a workflow added that outside testers can try with synthetic data. Keep upstream's patterns and make the story work from setup through its side paths. **Scope belongs to the human**: use the project's settled demo limits, and ask before adding machinery for a scenario those limits exclude. A bounded search is fine when its callers can use a bounded result; a caller that requires all records must receive them or report that its limit was exceeded.

## Choose the work

Read the target repository's instructions and README, inspect its structure and scripts, and identify the requested deliverable.

- **New fork:** pin upstream, plan the workflow, then apply the implementation, setup and verification sections it needs.
- **Existing fork or review:** compare the affected workflow with its pinned upstream and trace its consumers. Preserve working setup and features; apply only the sections the change reaches.
- **Hosted tester setup:** use the existing setup script and the tester-policy section. An administrator configures the project and invites testers; testers use the app.
- **Article or recordings:** inspect the working demo, its measured results and generated-asset scripts, then use the presentation section. Treat publishing as a separate action governed by the user's request.

Complete the requested deliverable and report what was verified. A refactor of working demo code earns its place when the diff makes it smaller or clearer; ask when it does neither. Commits, deployment, invitations, PRs and publishing follow the user's authorization; a local review ends with local findings or fixes.

Two sources anchor the work:

- **Medplum:** read the relevant docs and the closest upstream implementation before writing. [Medplum's AI coding guidance](https://www.medplum.com/docs/building-with-ai-coding-assistants) calls for FHIR R4, typed resources with `@medplum/fhirtypes`, reuse of existing helpers, and verification against types, tests and a server. Verify fields, search parameters, operations and terminology codes rather than inventing them. Revisit the relevant source after compaction.
- **Worked example:** [vintasoftware/medplum-provider-jev](https://github.com/vintasoftware/medplum-provider-jev). Its README identifies the imported version; `provider/` holds the app, Bots, scripts and tests. PRs [#7](https://github.com/vintasoftware/medplum-provider-jev/pull/7) and [#10](https://github.com/vintasoftware/medplum-provider-jev/pull/10) explain data consistency and upstream patterns; [#3](https://github.com/vintasoftware/medplum-provider-jev/pull/3), [#5](https://github.com/vintasoftware/medplum-provider-jev/pull/5), [#11](https://github.com/vintasoftware/medplum-provider-jev/pull/11) and [#12](https://github.com/vintasoftware/medplum-provider-jev/pull/12) explain dates, recording, whole-suite commands and scenario-owned text. Its `AGENTS.md` holds local operational gotchas. Reuse the lessons that apply to the target workflow.

## Pin upstream

For a new fork, import `examples/medplum-provider` from the Medplum monorepo at a release tag. Preserve its `LICENSE.txt` and SPDX headers. Name the tag or commit and import date in a README Provenance section. For an existing fork, resolve that recorded baseline.

Keep that upstream version available for comparison. One option is `git -C <monorepo> archive v<tag> examples/medplum-provider | tar -x -C <scratch>`. Compare the export with the fork, excluding dependencies and build outputs, and account for each affected upstream edit.

A standalone export may lack an ESLint config. If needed, extend `@medplum/eslint-config` as the monorepo does, with narrow overrides justified by the files they cover. Preserve upstream attribution and follow the project's attribution choice for new files. Establish the fork's build, lint and test results before implementing the feature.

## Plan the workflow

Write the tester's story: their role, the records they see, the primary clicks and the side paths. Put runnable instructions in the README's "Try the demo" section. Keep the provider's decision and any automated action explicit.

Map the FHIR resources and interactions the workflow and upstream UI need, including who performs each write: the user or a Bot. Reuse standard resources and upstream builders. This demo stores checks as `DetectedIssue`, signatures as `Provenance` and reconciliation work as `Task`; choose resources for the target workflow's meaning.

For an AI workflow, keep the model, labels, limits and question wording in one contract consumed by the Bot, app, measurement and cassette validation. Measurements reuse the production request builder and answer rules. Validate terminology codes through the project's terminology service, using `CodeSystem/$lookup` or the appropriate validation operation; typed FHIR alone does not prove a code is valid.

## Build it so it reads like upstream

**Layout and ownership.** Make focused edits to upstream files. Place hooks, pure helpers, types, pages and components in upstream's corresponding directories. Feature code imported by several upstream components belongs in a feature module rather than under a page. Keep component styles beside their components. A hook owns server state and actions; a component renders them and owns view state. Split by concern, as `useEncounterChart` and `EncounterChart` do, rather than by line count.

**Calls and state.** A parent calls the hook's action directly. Use existing controlled disclosure props to open a child's dialog. Key effects on the identity or source versions they read so equivalent resource objects do not cause refetches. Reuse Medplum's hooks, resource/reference helpers and notification utilities, and Mantine's state helpers before introducing another mechanism. Let the pinned lint config enforce style.

**Persisted edits and evidence.** When several consumers read one record, share its selection rule, including patient/encounter scope and ordering. In this repo, `src/utils/consistency-review.ts` provides `noteSearch` to the editor, Bot and tutorial. A check or signature that depends on pending edits waits for a successful save; failures retain the latest typed text for retry. `src/hooks/useChartNoteAutosave.ts` and `useConsistencyCheck.ts` implement that boundary. When a stored judgment shows its evidence, store source-version references and reload those versions; show unavailable evidence if they cannot be read. `src/utils/consistency.ts` implements versioned references, and the card marks a check stale after edits. Current text cannot stand in for the text an older judgment checked. For an unreleased demo, use its current contracts rather than building compatibility for data or clients it never shipped; preserve any existing records the user says matter.

**Configuration.** Copy an explicit allowlist of public settings into browser configuration. Check Vite's `envPrefix` for what becomes public. Keep server secrets in Medplum project secrets, read through `event.secrets`. Ignore environment files containing credentials while preserving public templates.

**Shared code.** Put definitions used by the Bot and app in a pure module that imports neither Node-only nor browser-only APIs. Both bundles include it: name it in the redeploy instructions along with the Bot source and contract.

## Bots, when the workflow needs one

- Export `handler(medplum, event)` and validate the input at that boundary. Use `runAsUser: true` for chart access under the tester's policy. This example's Bot reads only and the app stores the result as the user; grant writes only when the target Bot's work requires them.
- Return fixed, safe failure messages. Keep document text, secrets, request bodies and model response bodies out of logs and errors; map unknown failures to a generic message.
- Budget reads, terminology and model requests within the hosted runtime limit documented for the target deployment. The example budgets under 10 seconds and retries overload only when time remains. Reject an incomplete search when the computation requires the complete set.
- Build and smoke-test the artifact before deployment. The example's smoke test imports a locally built bundle from a temp folder and proves its JSON contract bundled; it does not inspect deployed code. Deploy through the project's CLI config, which setup writes to a Git-ignored file.
- Keep setup idempotent: read existing state, create or change only what is needed, and make `--dry-run` write nothing. Secret patches begin with a `test` on the current value. Print secret names only.

## Synthetic data and testers

Use synthetic data throughout this skill's workflow and say so in the README and article. Adapting it to PHI is a separate project decision requiring access controls and BAA coverage for every service seeing the text; self-hosting a model alone does not settle that.

Each scenario run creates a fresh Patient with a run identifier. "End scenario" forgets browser state and deletes nothing. Seed dates relative to today and keep fixture note text free of dates that would contradict later runs. Measurement cases may pin their own dates. Persist opaque run ids, step ids and tutorial preferences in browser state; derive workflow progress from the chart so reloads and unguided work resume correctly.

An administrator previews and applies setup, then invites each tester as a Practitioner under the role's AccessPolicy. Derive permissions from the resource-and-interaction map, including upstream sidebar reads, terminology and subscriptions. Grant reads to lookup types and writes only to types the role changes. Include `vread` for checked-evidence reloads and `history` where consumers need it. Scope Bot access to the demo Bot and keep Project, ProjectMembership, AccessPolicy, User and ClientApplication administration out of the tester policy. The worked `demo/access-policy.json` also scopes websocket Subscriptions to `%profile`, permitting their lifecycle including delete while clinical deletes remain denied.

Separate fresh runs from access isolation: this example grants type-level access in one shared synthetic project, so testers can access each other's records. Patient-compartment policies or separate projects require a settled isolation requirement. Scope each workflow's reads to its run and verify the whole flow as the tester, including reloading evidence and signing. `MockClient` does not enforce policies: check permissions on a server as that Practitioner, including denied project/admin access and other Bots. A delete-refusal probe requires authorization and a disposable record from the tester's own run, since a faulty policy could allow it.

## Test and verify

Use the repository's scripts and whole suites rather than maintaining a list of test paths. Run build/type checks, lint and units for implementation changes, and the Bot bundle check when applicable. Report pre-existing failures separately. Validate newly built FHIR resources on a server with `$validate` or a round trip when server verification is in scope; otherwise report it as unverified.

- **Units:** follow upstream's `MockClient`, `MedplumProvider`, `MantineProvider` and router wrappers. Test hooks with `renderHook` and read `result.current`. Use production resource builders for feature fixtures. Bot tests call `handler`, exercise the real search inputs, stub the model fetch and inspect its request and resource access. Verify a read-only Bot's absence of writes.
- **Browser:** use Playwright's headless Chromium and the project's auth fixtures. In this repo, a Practitioner CLI session is installed as `activeLogin` in an init script; keep tokens private and check `medplum whoami` before Medplum steps. Hide tutorial overlays before clicking outside their highlights, since the first click may only dismiss a tip.
- **Cassettes:** replay tests the frontend against recorded Bot answers and bypasses the Bot. Validate the note, call count and contract hash. Once a recording request gets a Bot response, fulfill the route; aborting causes MedplumClient retries. Surface recorder failures at teardown even when page assertions fail. The contract hash cannot detect a Bot-only code change.
- **Live verification:** after Bot, question or scenario changes, run the relevant Bot tests and deliberately record against the deployed version when hosted testing is authorized. Otherwise state that live behavior is unverified. Review refreshed cassettes before committing; preserve the canonical backend's recordings when trying another backend by copying comparison recordings to artifacts and restoring the canonical files. Follow the repo's instructions for returning project settings to their normal values.
- **Measurements, for AI demos:** run the production request and answer rules on every scenario note and the benchmark cases that matter to the workflow. Store one structured row per answer with model identity, probabilities, rule overrides, expected label, highlights and timing; stop on failed or invalid answers. Keep authored expectations distinct from model answers; fix questions or behavior rather than rewriting a fixture to make an answer pass. Rerun affected measurements after changing requests or answer rules. Read the evidence for the exact text before claiming how it behaves.

## Present the demo and article, when requested

Start with the concrete problem and show the provider's primary path, the choices available and their effects on the chart. Explain the model's role, the boundary of automation and the FHIR records that preserve the decision. Connect architecture and annotated screenshots to that working flow. The worked `ARTICLE.md`, `article/` and `videos/` show those pieces.

Ground model comparisons in the same production requests and task-specific cases. Distinguish scenario checks from a broader benchmark and synthetic authored expectations from clinician-reviewed labels. Explain misses, any answer rule and what displayed probabilities mean. Briefly justify the model choice for this task using measured behavior, latency, cost and the decisions its probabilities support; distinguish measurements from published claims. If claiming answer stability, measure repeated rounds. Retain and link the raw runs behind published numbers, with model versions, dates and case provenance; this repo uses `benchmark-runs/`. Generic benchmark rankings do not establish performance on this workflow.

Record the working app and build captions or marketing cuts from that take when requested. When an asset reproduces scenario text, read the scenario file instead of copying it. Update figure copy from the cited measurement evidence. After changing the scenario or results, check existing assets against the app and article. Regenerate assets that misrepresent the workflow or results; an otherwise accurate take can remain after a minor copy change, while its generator must be correct for the next recording. Read `videos/README.md` and the figure scripts for their actual commands.

Keep durable docs short: setup and testing in the README, design and results in the article, and a separate runbook only where needed. Describe the current implementation; Git holds draft history and retired plans. Keep docs aligned with the code: grep references after moving modules, name every bundled source that needs redeployment, and document runnable whole-suite commands. Published results describe synthetic performance and limitations, not clinical validation. Verify current prices, model availability and compliance claims against primary sources when including them. Deliver the requested local draft or publish only as authorized, with verification and any remaining limitations stated.
