// Checks the generated measure cases against the Bot's document rules and the specs they were
// written from. Never reports document text: an issue names the case id and field only. The
// committed batch is checked by validate-cases.test.ts; run it after every merge.

import type { SourceDocument } from '../../bots/consistency.ts';
import { checkDocuments, MODAL_MAX_SENTENCES } from '../../bots/consistency.ts';
import contract from '../../src/data/model-contract.json' with { type: 'json' };
import { splitSentences } from '../../src/utils/consistency-review.ts';
import specsFile from './case-specs.json' with { type: 'json' };
import generated from './generated-cases.json' with { type: 'json' };

// A plain year, a month name or a relative-day word anywhere in document text. Dates belong only
// in the case's `date` field, per AGENTS.md: fixture note text must stay free of dates.
const DATE_LIKE =
  /\b(19|20)\d{2}\b|\b(january|february|march|april|may|june|july|august|september|october|november|december|today|yesterday|tomorrow)\b/i;

type Field = 'outside_document' | 'visit_note';

export interface GeneratedCase {
  id: string;
  medication: string;
  expected: string;
  outside_document: SourceDocument;
  visit_note: SourceDocument;
  /** A substring of exactly one sentence, the one a reader expects highlighted; null when no sentence gives a dose. */
  highlight: Record<Field, string | null>;
}

interface SpecSide {
  dose: string | null;
  freq: string | null;
  mentions_medication?: boolean;
}

export interface Spec {
  id: string;
  medication: string;
  expected: string;
  outside: SpecSide;
  note: SpecSide;
}

export interface Issue {
  case_id: string;
  problem: string;
}

function docIssues(caseId: string, field: Field, doc: SourceDocument): Issue[] {
  const issues: Issue[] = [];
  // Both backends must ask the highlight question, so the stricter sentence limit applies.
  if (splitSentences(doc.text).length > MODAL_MAX_SENTENCES) {
    issues.push({ case_id: caseId, problem: `${field}.text has more than ${MODAL_MAX_SENTENCES} sentences` });
  }
  if (DATE_LIKE.test(doc.text)) {
    issues.push({ case_id: caseId, problem: `${field}.text looks like it contains a date` });
  }
  return issues;
}

export function highlightIssues(caseId: string, field: Field, text: string, expected: string | null): Issue[] {
  if (expected === null) {
    return [];
  }
  // Scoring passes when the picked sentence contains the substring, so it must pick out one sentence.
  const matches = splitSentences(text).filter((s) => s.includes(expected)).length;
  if (matches !== 1) {
    return [{ case_id: caseId, problem: `${field}'s highlight substring matches ${matches} sentences, not one` }];
  }
  return [];
}

function specIssues(item: GeneratedCase, spec: Spec | undefined): Issue[] {
  if (!spec) {
    return [{ case_id: item.id, problem: 'no matching spec in case-specs.json' }];
  }
  const issues: Issue[] = [];
  if (spec.medication !== item.medication) {
    issues.push({ case_id: item.id, problem: `medication differs from the spec (${spec.medication})` });
  }
  if (spec.expected !== item.expected) {
    issues.push({ case_id: item.id, problem: `expected differs from the spec (${spec.expected})` });
  }
  for (const [field, doc, side] of [
    ['outside_document', item.outside_document, spec.outside],
    ['visit_note', item.visit_note, spec.note],
  ] as const) {
    if (side.mentions_medication === false && doc.text.toLowerCase().includes(item.medication.toLowerCase())) {
      issues.push({
        case_id: item.id,
        problem: `${field}.text mentions ${item.medication}, which the spec says it must not`,
      });
    }
    for (const token of [side.dose, side.freq]) {
      if (token && !doc.text.toLowerCase().includes(token.toLowerCase())) {
        issues.push({ case_id: item.id, problem: `${field}.text is missing a spec term` });
      }
    }
  }
  return issues;
}

/**
 * Validates generated cases against the Bot's document rules and the specs they came from.
 * @param cases - The cases to check; the committed batch by default.
 * @param specs - The specs they were written from; the committed specs by default.
 * @returns Every issue found; empty when the batch is clean.
 */
export function validateCases(cases: GeneratedCase[] = generated.cases, specs: Spec[] = specsFile.specs): Issue[] {
  const specById = new Map(specs.map((s) => [s.id, s]));
  const issues: Issue[] = [];
  const seenIds = new Set<string>();
  for (const item of cases) {
    if (seenIds.has(item.id)) {
      issues.push({ case_id: item.id, problem: 'duplicate id' });
    }
    seenIds.add(item.id);
    if (!(contract.labels as readonly string[]).includes(item.expected)) {
      issues.push({ case_id: item.id, problem: `expected is not one of model-contract.json's labels` });
    }
    try {
      checkDocuments(item.outside_document, item.visit_note);
    } catch (err) {
      issues.push({ case_id: item.id, problem: `the Bot would refuse it: ${(err as Error).message}` });
    }
    for (const [field, doc] of [
      ['outside_document', item.outside_document],
      ['visit_note', item.visit_note],
    ] as const) {
      issues.push(...docIssues(item.id, field, doc));
      issues.push(...highlightIssues(item.id, field, doc.text, item.highlight[field]));
    }
    issues.push(...specIssues(item, specById.get(item.id)));
  }
  return issues;
}
