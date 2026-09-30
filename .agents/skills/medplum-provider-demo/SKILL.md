---
name: medplum-provider-demo
description: Build, extend or review a demo on a fork of the Medplum Provider App, as a starter kit testers can use on a hosted project with synthetic data. Use when forking medplum-provider, adding a workflow or Bot to a provider-app fork, reviewing such demo code against Medplum's own patterns, or setting up a Medplum project for demo testers.
metadata:
  version: "1"
---

# Medplum Provider App demos

A demo is a **starter kit**: the Medplum Provider App with one workflow added, running on a hosted Medplum project with synthetic data, that outside testers sign in to and try. It is not production software. Skip pagination beyond one page, offline handling, tenant middleware, audit plumbing and rare edge cases. Keep readability, Medplum's own patterns, and enough separation that testers do not trip over each other. **Scope belongs to the human**: when a change would add machinery for a case the demo cannot reach, ask instead of building it.

Two references anchor every decision:

- **Upstream**: the Medplum monorepo at the pinned release tag, and its `examples/medplum-provider`. The demo's code should read as if upstream's authors wrote it. Medplum's own guidance for AI-assisted work (`medplum.com/docs/building-with-ai-coding-assistants`) says the same: read Medplum's docs and code before writing, adapt the closest existing implementation, stay on FHIR R4 with `@medplum/fhirtypes`, and never invent fields, search parameters, operations or codes.
- **The reviews in `vintasoftware/medplum-provider-jev`**: the decisions below came from reviewing that fork against upstream. Its `AGENTS.md`, `README.md` and `provider/` are the worked example.

## Steps

### 1. Pin upstream

1. Import `examples/medplum-provider` from the Medplum monorepo at a release tag. Keep its `LICENSE.txt` and the SPDX headers on its files. Write a Provenance section in the README naming the tag or commit and the import date.
2. Keep the monorepo at that tag available for comparison. The cheapest form is an export into a scratch folder: `git -C <monorepo> archive v<tag> examples/medplum-provider | tar -x -C <scratch>`. Every review starts from `diff -rq` of that export against the fork, excluding `node_modules`, `dist` and build outputs.
3. Add `eslint.config.mjs` extending `@medplum/eslint-config`, the way the monorepo root does, before writing any new code. The standalone export ships without one, so `npm run lint` fails until then. The SPDX header rule is an attribution decision for the human: files the demo adds carry no Medplum header.

Done when `tsc`, `npm run lint` and `npm test` pass on the untouched fork and the Provenance section names the tag.

### 2. Plan the workflow against Medplum

1. Write the story as the README's "Try the demo" section: who the tester plays, the records they see, the numbered clicks, and what each side path shows.
2. Map the FHIR resources: which ones the workflow reads, which it writes, and who writes each, the user through the app or a Bot. Use standard resources over custom shapes (a check result is a `DetectedIssue`, a signature is a `Provenance`, follow-up work is a `Task`). Reuse upstream's own helpers for the resources it already creates.
3. Put every model or AI call behind one JSON contract file holding the model name, the labels, the text limits and the question wording. The Bot, the app, the measurement script and the e2e recordings all read that one file.
4. Codes are where assistants hallucinate. Use real LOINC, RxNorm and SNOMED codes, and look them up against the project's terminology (`CodeSystem/$lookup`) before relying on them.

Done when the resource map lists every type the workflow touches and each one has a row in the AccessPolicy.

### 3. Build it so it reads like upstream

Apply the "Reads like upstream" reference below while writing, not after. The habits that mattered most:

- Upstream files get small, single-purpose edits: an anchor attribute, one hook call, one prop. New behaviour lives in new files in upstream's layout.
- A hook owns server state and the actions on it; a component renders what it is given. Split them the way upstream splits `useEncounterChart` and `EncounterChart`.
- A parent calls a hook's function directly. When a parent must open a child's dialog, the child takes the controlled props that upstream's `useControllableDisclosure` supports.
- Code shared by the Bot and the app lives in one pure module that neither bundle can break.

Done when the diff against upstream reads file by file, each upstream edit has one purpose, and lint reports zero errors.

### 4. Write the Bot

Follow the "Bots" reference. Done when the Bot's unit tests pass against `MockClient`, the bundle smoke test loads the deployed artifact, and every failure the Bot can report is a fixed string with no document text or secret in it.

### 5. Seed synthetic data and separate testers

Follow the "Synthetic data and testers" reference. Done when a fresh tester can run `setup --email`, sign in, start a scenario, and finish it without touching another tester's records, and the CLI confirms the practitioner policy refuses deletes, other Bots and project admin.

### 6. Test and verify

Follow the "Testing" reference. Before any PR, run the whole list: `tsc`, `npm run lint`, the whole unit suite, the Bot bundle smoke test, and the e2e replay with a Practitioner login (`medplum whoami` first). Report each result as it happened.

### 7. Ship

- One commit per item, a PR when the list is done. A review pass such as the thermo-nuclear review loop applies to the PR, with the demo scope stated to the reviewer.
- Docs say exactly what the code does. When code moves, grep the README, `AGENTS.md`, article and scripts for the old path. Commands in docs run the whole thing (`npm test`), never a hand-kept list of paths.
- Anything generated from the scenario (videos, figures, measurement cases) reads the scenario file rather than carrying its own copy of the text.

Done when the PR description lists what was verified and what was not, and the human has merged it.

## Reads like upstream

The review bar. Each rule names the upstream pattern to match.

**Layout.** Hooks in `src/hooks/useX.ts` with `useX.test.tsx` beside them. Pure helpers in `src/utils/`, types in `src/types/`, feature pages under `src/pages/<feature>/`, components under `src/components/<area>/`. Component styles in a `*.module.css` next to the component; the global stylesheet stays as short as upstream's. Feature code that several upstream components import belongs in a module of its own rather than under `pages/`.

**State.** A hook returns state plus functions (`runCheck`, `createTask`); the component receives them as props and holds only view state such as a details toggle. Effects key on primitives, an id or a reference string, so a new object with the same identity does not refetch. A save queue keeps two facts, what is on screen and what the server has, and a flush sends the latest text unless the server already has it.

**Reuse before writing.** From `@medplum/react`: `useMedplum`, `useMedplumProfile`, `useResource`, `useSearchOne`, `useSearchResources`, `useSubscription`, `MedplumLink`, `ResourceAvatar`, `AnnotationInput`. From `@medplum/core`: `createReference`, `getReferenceString`, `formatDate`, `formatDateTime`, `formatHumanName`, `createResourceIfNoneExist` for idempotent setup. From the app: `showErrorNotification`, `useControllableDisclosure`, `useDebouncedUpdateResource`. From Mantine: `useDisclosure`, `useDebouncedCallback`.

**Style the lint config enforces.** Braces on every `if`. `@param` and `@returns` on every documented exported function; a `//` line for a documented internal helper. Explicit return types. `import type` for types. No nested ternary: an `if` chain that assigns a variable. Promise executors with block bodies. camelCase in TypeScript; snake_case only where a wire format demands it, with the boundary named.

**Configuration.** Public settings reach the browser through `import.meta.env` with the exact variable names listed in Vite's `envPrefix`. A `configure` script copies only those names from the root `.env` into `.env.local` and refuses the rest. Secrets live in Medplum project secrets and reach the Bot through `event.secrets`.

**Text keeps up with code.** README rows, `AGENTS.md` lines, UI copy and comments claim exactly what the code checks. A shared module the Bot bundles is named wherever redeploys are documented.

**Change only if it gets smaller or clearer.** A refactor of working demo code earns its place when the result is more readable or shorter, measured on the diff. When it is neither, the human decides.

## Bots

- One `handler(medplum, event)` export. Set `runAsUser: true` so the Bot reads only what the signed-in tester can read, and let the app write the result under the tester's own access. A Bot that writes nothing needs no write rules.
- Validate `event.input` to the exact keys expected and reject the rest. Read settings through `event.secrets`. Every error the Bot returns is a fixed message: never the document text, never the request, never a secret. Unknown failures map to one generic message.
- Budget time under the hosted limit (10 seconds): a budget for chart reads, a budget for terminology, the rest for the model call, with one retry on overload when time remains.
- Keep the code the Bot shares with the app (searches, text splitting, the result type) in one module under `src/utils/` that imports nothing Node-only (`Buffer`) and nothing browser-only (`import.meta.env`). Both bundles include it, so the README's redeploy row names it.
- Deploy with `medplum bot deploy` from a `medplum.config.json` the setup script writes (Git-ignored). A bundle smoke test copies the built artifact to a temp folder and loads it, which proves the JSON contract bundled.
- The setup script is idempotent: read the project first, create only what is missing, `--dry-run` writes nothing, secrets are added with a JSON patch that starts with a `test` op on the current list, and secret values are never printed.

## Synthetic data and testers

- Synthetic data only, stated in the README. A hosted model without a BAA sees synthetic text only; PHI needs a BAA or the self-hosted path.
- Each scenario run creates a new Patient carrying a run identifier, and nothing is ever deleted; "End scenario" forgets the run in the browser. Dates are seeded relative to today, and fixture text carries no dates, so a run started next month still reads right. Measurement cases pin their own dates.
- Browser state holds opaque ids and step ids only.
- One AccessPolicy per tester role, kept in a JSON file the setup script applies: type-level create, read, search and update on the types the workflow touches, no delete on clinical types, `Bot?_id=<the demo's Bot>` only, and no `Project`, `ProjectMembership`, `AccessPolicy`, `User` or `ClientApplication` rows, which keeps secrets and admin out of reach. Invite each tester as a Practitioner with that policy (`setup --email`).
- `MockClient` does not enforce policies. Prove the refusals on the server with the CLI as the practitioner: read `Project/<id>`, read `admin/projects/<id>`, execute another Bot, delete a Task from their own run.
- This is decent separation, not tenant isolation: testers share one synthetic project, and records are tied to runs rather than to users. Stronger separation, patient-compartment criteria on the policy or one project per tester, is a human decision that costs setup work.

## Testing

- Unit tests render with `MockClient` inside `MedplumProvider`, `MantineProvider` and `MemoryRouter`, the way upstream's tests do. Hooks are tested with `renderHook` and a wrapper, and results are read from `result.current`. Fixtures come from the real builders (the function that builds the resource in production), so a test cannot carry an answer the system would not produce. Upstream's `HomerSimpson` and `DrAliceSmith` fixtures serve tests of upstream behaviour.
- Bot tests call `handler` with a `MockClient` seeded through the real search paths, stub `fetch` for the model, and assert both the request built and the resources touched. A "writes nothing" test spies on every write method.
- e2e tests run Playwright against the real project as a Practitioner CLI login placed in `localStorage` as `activeLogin` by an init script; the token is never printed. The Bot's responses, which carry the model's answers, are recorded once per test as cassettes with the contract file's hash and replayed by default; replay fails on a different note, a different call count, or a changed contract. The recorder always answers the route, because `MedplumClient` retries an aborted fetch and would run the Bot again.
- A measurement script sends the Bot's own request to the model for authored cases and every scenario note, writes one JSONL row per answer under `artifacts/`, and stops at the first failed answer. One synthetic run is not clinical validation; say so wherever results appear.
- Evidence over confidence: to know whether a note passes the model, read the cassettes and the measurement rows for that exact text, then state the label and probability they hold.
