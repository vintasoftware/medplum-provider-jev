// Checks a generated measure-cases batch against model-contract.json's limits and the specs it
// was written from. Run standalone:
//
//   node provider/scripts/gen-cases/validate-cases.ts [generated-cases.json]
//
// Never prints document text: an issue names the case id and field only.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import contract from '../../src/data/model-contract.json' with { type: 'json' };
import { splitSentences } from '../../src/utils/consistency-review.ts';

const HERE = dirname(new URL(import.meta.url).pathname);
const SPECS_FILE = join(HERE, 'case-specs.json');
const DEFAULT_CASES_FILE = join(HERE, 'generated-cases.json');

// A plain year, a month name or a relative-day word anywhere in document text. Dates belong only
// in the case's `date` field, per AGENTS.md: fixture note text must stay free of dates.
const DATE_LIKE =
  /\b(19|20)\d{2}\b|\b(january|february|march|april|may|june|july|august|september|october|november|december|today|yesterday|tomorrow)\b/i;

interface Doc {
  title: string;
  date: string;
  author: string;
  text: string;
}

interface GeneratedCase {
  id: string;
  medication: string;
  expected: string;
  outside_document: Doc;
  visit_note: Doc;
  highlight: { outside_document: string | null; visit_note: string | null };
}

interface Spec {
  id: string;
  medication: string;
  expected: string;
  outside: { dose: string | null; freq: string | null; mentions_medication?: boolean };
  note: { dose: string | null; freq: string | null; mentions_medication?: boolean };
}

export interface Issue {
  case_id: string;
  problem: string;
}

function docIssues(caseId: string, field: 'outside_document' | 'visit_note', doc: Doc): Issue[] {
  const issues: Issue[] = [];
  if (!doc.text.trim()) {
    issues.push({ case_id: caseId, problem: `${field}.text is empty` });
    return issues;
  }
  if (doc.text.length > contract.limits.text_max) {
    issues.push({ case_id: caseId, problem: `${field}.text exceeds text_max (${contract.limits.text_max})` });
  }
  if (doc.title.length > contract.limits.title_max) {
    issues.push({ case_id: caseId, problem: `${field}.title exceeds title_max (${contract.limits.title_max})` });
  }
  const sentences = splitSentences(doc.text);
  if (sentences.length > contract.limits.max_sentences) {
    issues.push({
      case_id: caseId,
      problem: `${field}.text has more than max_sentences (${contract.limits.max_sentences})`,
    });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(doc.date)) {
    issues.push({ case_id: caseId, problem: `${field}.date is not YYYY-MM-DD` });
  }
  if (DATE_LIKE.test(doc.text)) {
    issues.push({ case_id: caseId, problem: `${field}.text looks like it contains a date` });
  }
  return issues;
}

function highlightIssues(
  caseId: string,
  field: 'outside_document' | 'visit_note',
  text: string,
  expected: string | null
): Issue[] {
  if (expected === null) {
    return [];
  }
  const sentences = splitSentences(text);
  if (!sentences.some((s) => s.includes(expected))) {
    return [{ case_id: caseId, problem: `${field}'s highlight substring is not a substring of any sentence` }];
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
 * Validates a generated-cases file against model-contract.json's limits and case-specs.json.
 * @param casesFile - Path to the generated-cases JSON file.
 * @param specsFile - Path to the specs JSON file the cases were written from.
 * @returns Every issue found; empty when the batch is clean.
 */
export function validateCases(casesFile = DEFAULT_CASES_FILE, specsFile = SPECS_FILE): Issue[] {
  const cases: GeneratedCase[] = JSON.parse(readFileSync(casesFile, 'utf8')).cases;
  const specs: Spec[] = JSON.parse(readFileSync(specsFile, 'utf8')).specs;
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
    issues.push(...docIssues(item.id, 'outside_document', item.outside_document));
    issues.push(...docIssues(item.id, 'visit_note', item.visit_note));
    if (item.outside_document.text.length + item.visit_note.text.length > contract.limits.total_text_max) {
      issues.push({
        case_id: item.id,
        problem: `combined text exceeds total_text_max (${contract.limits.total_text_max})`,
      });
    }
    issues.push(
      ...highlightIssues(item.id, 'outside_document', item.outside_document.text, item.highlight.outside_document)
    );
    issues.push(...highlightIssues(item.id, 'visit_note', item.visit_note.text, item.highlight.visit_note));
    issues.push(...specIssues(item, specById.get(item.id)));
  }
  return issues;
}

function main(): void {
  const file = process.argv[2] ?? DEFAULT_CASES_FILE;
  const issues = validateCases(file);
  if (issues.length === 0) {
    console.log('No issues found.');
    return;
  }
  for (const issue of issues) {
    console.log(`${issue.case_id}: ${issue.problem}`);
  }
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
