# Generated measure cases

The regenerable part of the benchmark that `npm --prefix provider run measure` runs: 91 cases
written by Sonnet subagents from structured specs, plus the five original hand-written cases
(`dose-*`). The other four inputs are the guided demo's scenario notes, whose expected answers
live in `../measure-cases.json`.

- `case-specs.json` — structured specs (medication, doses, acknowledgment flag, expected label),
  no prose.
- `generated-cases.json` — the cases, one per spec.
- `validate-cases.ts` (+ `.test.ts`) — checks the committed cases with the Bot's own document
  rules and against their specs; the test suite runs it.

**Runs cited by the documents** live in `../../../benchmark-runs/`.

**To add more cases or regenerate**, see the `regenerate-measure-cases` skill
(`.agents/skills/regenerate-measure-cases/SKILL.md`) — it has the full workflow: how to design a
case, how to write specs, and how to spawn subagents to write the prose.
