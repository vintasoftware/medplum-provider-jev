# Generated measure cases

A larger, regenerable benchmark for `npm --prefix provider run measure:generated`, separate
from `measure-cases.json` (which stays scoped to the guided demo's four scenario notes, so the
plain `measure` checks the exact notes the demo sends).

- `case-specs.json` — structured specs (medication, doses, acknowledgment flag, expected label),
  no prose.
- `generated-cases.json` — the cases written from those specs, in `measure-cases.json`'s shape.
- `validate-cases.ts` (+ `.test.ts`) — checks a generated-cases file against the model contract's
  limits and the specs it came from. Run: `npm --prefix provider run validate:generated-cases`.

**To add more cases or regenerate**, see the `regenerate-measure-cases` skill
(`.agents/skills/regenerate-measure-cases/SKILL.md`) — it has the full workflow: how to design a
case, how to write specs, and how to spawn subagents to write the prose.
