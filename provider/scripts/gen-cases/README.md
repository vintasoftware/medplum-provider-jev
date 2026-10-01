# Generating more measure cases

`measure-cases.json`'s `authored_cases` is nine hand-written pairs. This folder adds a larger,
regenerable batch, written from structured specs rather than by hand, and kept separate so the
small authored set stays the hand-picked reference.

## Files

- `case-specs.json` — one spec per case: medication, the two doses/frequencies, whether the note
  should acknowledge a change, and the expected label under `model-contract.json`'s criteria. No
  prose; specs are easy to review and extend without writing text.
- `generated-cases.json` — the output, in the same shape as `authored_cases`
  (`provider/scripts/measure-cases.json`), plus an `id` per case.
- `validate-cases.ts` — checks a generated-cases file against `model-contract.json`'s limits and
  catches cases a spec-writer could get wrong: a missing highlight substring, a date inside
  document text, or a dose spec whose number doesn't appear in the document it names. Run it
  standalone: `node provider/scripts/gen-cases/validate-cases.ts`.

## Regenerating

This step needs an agentic session (Claude Code), not a plain script — the prose comes from a
model, not a template, so each case reads differently. The orchestration lives in the session,
not in a committed file.

1. Edit or add specs in `case-specs.json`. Keep each `id` unique and prefixed `gen-`.
2. For each spec, ask a Sonnet subagent (the `Agent` tool, `model: "sonnet"`) to write one case,
   batching at most 10 subagents per round (so results stay practical to review). Give each
   subagent:
   - the one spec it's assigned,
   - the rule: synthetic patients only, a one- or two-sentence `outside_document.text` and
     `visit_note.text`, the medication and dose/frequency stated as instructed, no explanation of
     a change unless `acknowledge` is true (and then the note must name both the old and new
     numbers), no dates or calendar words anywhere in the text (dates belong only in the `date`
     field, set by the merge step, never by the subagent),
   - the exact output shape: a fenced JSON block with `{ "outside_document": { "title", "text" },
"visit_note": { "title", "text" }, "highlight": { "outside_document", "visit_note" } }`, where
     each `highlight` value is a substring of that document's text giving the dose (or `null` when
     the spec says no dose appears), and nothing else in the reply.
3. Parse each subagent's JSON, fill in `id`, `medication`, `expected` and `date` from the spec
   (`date` can be any valid `YYYY-MM-DD`, distinct between the two documents), and append to
   `generated-cases.json`'s `cases` array.
4. Run `validate-cases.ts`. Fix or drop any case it flags; a dropped spec can be retried with a
   fresh subagent.
5. Run the provider's unit tests and `npm --prefix provider run measure -- --cases
scripts/gen-cases/generated-cases.json` (needs `TYPESAFE_API_KEY`) to see how the model answers
   the new batch.

## Why not Synthea

Synthea's clinical notes are filled-in templates generated from its own simulated record, so a
note can never disagree with the chart — the exact error this check exists to catch. It's still a
good source of realistic medications and chronic-care patients if a future batch wants that
variety; the prose and the conflict still have to come from a spec, written or reviewed by a
person, not the generator.
