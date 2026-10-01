---
name: regenerate-measure-cases
description: Add to or regrow the generated benchmark of dose-reconciliation test cases in provider/scripts/gen-cases/ (specs, Sonnet-subagent-written prose, validation). Use when asked to generate more measure cases, grow the benchmark dataset, add test cases for the consistency check, or regenerate provider/scripts/gen-cases/generated-cases.json.
---

# Regenerating the generated measure-case benchmark

`provider/scripts/gen-cases/generated-cases.json` holds a larger, regenerable batch of cases
for `npm --prefix provider run measure:generated`, in the same shape as the entries
`measure-cases.json` once held. That file now covers only the guided demo's four scenario
notes, so the plain `measure` script checks the exact notes the demo sends. This skill is the
workflow for growing the generated batch.

Don't reach for Synthea or another synthetic-patient generator here: its clinical notes are
filled-in templates generated from its own simulated record, so a note can never disagree with
the chart — the exact error this check exists to catch. Synthea is still a good source of
realistic medications and chronic-care patients if a future batch wants that variety, but the
prose and the conflict still have to come from a spec, not a generated chart.

## Files

- `provider/scripts/gen-cases/case-specs.json` — one spec per case: medication, the two
  doses/frequencies, whether the note should acknowledge a change, and the expected label
  under `provider/src/data/model-contract.json`'s criteria. No prose; specs are easy to review
  and extend without writing text. Keep `id`s unique and prefixed (`gen-`, `gen2-`, `gen3-`, …
  — bump the prefix for each new regeneration round so ids never collide).
- `provider/scripts/gen-cases/generated-cases.json` — the output: `{ "_about", "cases": [...] }`,
  each case shaped like `measure-cases.json`'s entries (`id`, `medication`, `expected`,
  `outside_document`, `visit_note`, `highlight`).
- `provider/scripts/gen-cases/validate-cases.ts` (+ `.test.ts`) — checks a generated-cases file
  against the model contract's limits and catches mistakes a spec-writer could make: a missing
  highlight substring, a date inside document text, a medication mentioned where the spec
  forbids it, or a dose term absent from the document that's supposed to state it. Run
  standalone: `node provider/scripts/gen-cases/validate-cases.ts [path]`, or
  `npm --prefix provider run validate:generated-cases`.

## Case design

Pick what changed and how the note handles it before any text exists — together they fix the
expected label, matching `model-contract.json`'s three criteria:

- **What changed at discharge:** dose up or down, a new frequency, a stopped drug, a new
  formulation, a drug held and then resumed, or no change at all (just different wording).
- **What the note does:** copies the old dose (`potential_conflict`), explicitly acknowledges
  the change by naming both doses (`agreement`), states the dose with equivalent but different
  wording — units, abbreviations, tablet counts, timing words (`agreement`, no acknowledgment
  needed), leaves out the dose or the medication entirely in one document
  (`insufficient_information`), or states a third dose or a frequency change with no explanation
  (`potential_conflict`, per the contract's literal criteria — different current doses/frequencies
  without acknowledgment, even across two plainly dated lists).
- **Hard cases worth covering:** equivalent wording that should read as agreement ("two 10 mg
  tablets" vs. "20 mg", "BID" vs. "twice daily", "mcg" vs. "mg"); acknowledgment phrasing that
  might not be read as acknowledgment (a past hosted-Jev run scored three differently-phrased
  "explained dose change" cases as `potential_conflict` with probability 0.57–0.83 where most
  similarly-worded ones scored correctly — this looks sensitive to the specific acknowledgment
  wording, so cover a range of it); one document missing a dose vs. missing the medication
  entirely; dated lists with no connecting language.

Stay within `model-contract.json`'s `limits`: `text_max` 4000, `title_max` 120,
`total_text_max` 7000, `max_sentences` 40. The Jebadiah self-hosted server also refuses prompts
over 4,096 tokens, so keep each case short (well under 300 characters per document is typical
and plenty).

## Regenerating: write specs, then spawn subagents

This step needs an agentic session, not a plain script — the prose comes from a model, not a
template, so each case reads differently; that variety is the point.

1. **Write specs first**, structured, no prose — append to `case-specs.json` with a fresh id
   prefix. Decide the medication, doses/frequencies and `acknowledge` flag per the design
   section above, and group specs into batches of 6–8 by pattern (same shape of instructions),
   so one subagent can write several cases from one prompt.

2. **Spawn Sonnet subagents, at most 10 at a time** (the `Agent` tool, `model: "sonnet"`), each
   given one batch of specs. Give each subagent:
   - the batch of specs it's assigned (medication, doses/frequencies, acknowledge flag,
     guidance on what the note must or must not say),
   - the rules: synthetic patients only (`Synthetic patient` plus a letter, varied across
     cases — call out letters already used in the prompt so a new round doesn't repeat them),
     1–3 sentences per document, no dates/days/month-names/"today"/"yesterday"/"tomorrow"
     anywhere in the text (dates belong only in the `date` field, assigned at merge time, never
     written by the subagent), each document must literally contain the medication name and the
     dose/frequency strings named in its spec (or must NOT contain the medication name, for a
     "not mentioned" spec),
   - the exact output shape: ONE fenced JSON code block, nothing else, holding an array of
     objects — one per spec in the batch — each `{ "id", "outside_document": { "title", "text" },
     "visit_note": { "title", "text" }, "highlight": { "outside_document", "visit_note" } }`,
     where each `highlight` value is a substring of that document's text giving the dose (or
     `null` when the spec says no dose/no mention appears there).

3. **Collect each subagent's JSON.** A long array sometimes truncates mid-reply; if a reply
   cuts off, message that subagent back asking for just the missing object(s), quoting their
   id(s), rather than the whole batch again — it already has the content in context.

4. **Merge:** fill in `id`, `medication`, `expected` from the spec, and a plausible `date`
   (`YYYY-MM-DD`, discharge before visit) for each document, then append to
   `generated-cases.json`'s `cases` array.

5. **Validate after every merge, not just at the end:** `validate-cases.ts` catches bad cases
   early, before a later batch builds on a misunderstanding. Watch for word-boundary false
   positives in the date check — the word "may" (as a verb, "patient may continue…") matches the
   month-name pattern. Reword the case text rather than loosening the validator; the check
   exists because leaking a real-looking date into fixture text is a mistake worth catching, not
   a false alarm worth suppressing.

6. **Confirm the count and distribution** (`python3 -c "import json,collections;
   d=json.load(open('provider/scripts/gen-cases/generated-cases.json'));
   print(len(d['cases'])); print(collections.Counter(c['expected'] for c in d['cases']))"`) —
   aim for a roughly even split across the three labels so the benchmark doesn't just measure
   the easiest category.

## After regenerating

1. Run the provider's full test suite (`npx vitest run` from `provider/`) and lint
   (`npm run lint`) — the generated files aren't code, but a broken merge can still break JSON
   parsing or an import elsewhere.
2. Run `npm --prefix provider run measure:generated` (needs `TYPESAFE_API_KEY` in the root
   `.env`; costs money per call) to see how hosted Jev answers the new batch. It writes
   `artifacts/typesafe-run-<UTC>.jsonl`.
3. Update [ARTICLE.md](../../../ARTICLE.md)'s "How good is Jev?" section and
   `article/figures.html`'s `results` figure with the new totals and any newly-found failure
   pattern, and re-render with `python article/render_figures.py` (needs Playwright, ffmpeg and
   the recorded demo video).
