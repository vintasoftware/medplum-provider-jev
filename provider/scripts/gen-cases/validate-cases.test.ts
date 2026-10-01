import { describe, expect, test } from 'vitest';
import type { GeneratedCase, Spec } from './validate-cases';
import { validateCases } from './validate-cases';

const SPEC: Spec = {
  id: 'gen-x',
  medication: 'lisinopril',
  expected: 'potential_conflict',
  outside: { dose: '10 mg', freq: 'once daily' },
  note: { dose: '20 mg', freq: 'once daily' },
};

const GOOD_CASE: GeneratedCase = {
  id: 'gen-x',
  medication: 'lisinopril',
  expected: 'potential_conflict',
  outside_document: {
    title: 'Discharge medication list',
    date: '2026-08-01',
    author: 'synthetic',
    text: 'Synthetic patient Z. Lisinopril 10 mg by mouth once daily.',
  },
  visit_note: {
    title: 'Follow-up visit',
    date: '2026-08-08',
    author: 'synthetic',
    text: 'Synthetic patient Z. Continue lisinopril 20 mg by mouth once daily.',
  },
  highlight: { outside_document: 'Lisinopril 10 mg', visit_note: 'lisinopril 20 mg' },
};

const problems = (cases: GeneratedCase[], specs: Spec[] = [SPEC]): string[] =>
  validateCases(cases, specs).map((i) => i.problem);

describe('validateCases', () => {
  test('the committed generated cases are clean', () => {
    expect(validateCases()).toEqual([]);
  });

  test('accepts a well-formed case', () => {
    expect(problems([GOOD_CASE])).toEqual([]);
  });

  test('flags a highlight substring found in no sentence or in two', () => {
    const missing = { ...GOOD_CASE, highlight: { ...GOOD_CASE.highlight, visit_note: 'metformin 40 mg' } };
    expect(problems([missing])).toEqual(["visit_note's highlight substring matches 0 sentences, not one"]);
    const twice = {
      ...GOOD_CASE,
      visit_note: {
        ...GOOD_CASE.visit_note,
        text: 'Lisinopril raised from 10 mg to 20 mg by mouth once daily. Continue lisinopril 20 mg by mouth once daily.',
      },
      highlight: { ...GOOD_CASE.highlight, visit_note: '20 mg by mouth once daily' },
    };
    expect(problems([twice])).toEqual(["visit_note's highlight substring matches 2 sentences, not one"]);
  });

  test('flags a date inside document text', () => {
    const bad = {
      ...GOOD_CASE,
      visit_note: {
        ...GOOD_CASE.visit_note,
        text: 'Synthetic patient Z, seen today. Continue lisinopril 20 mg daily.',
      },
    };
    expect(problems([bad]).some((p) => p.includes('date'))).toBe(true);
  });

  test('flags a case with no matching spec', () => {
    expect(problems([{ ...GOOD_CASE, id: 'gen-unknown' }])).toContain('no matching spec in case-specs.json');
  });

  test('flags a spec term missing from the document', () => {
    const bad = {
      ...GOOD_CASE,
      outside_document: { ...GOOD_CASE.outside_document, text: 'Synthetic patient Z, no dose stated.' },
    };
    expect(problems([bad]).some((p) => p.includes('missing a spec term'))).toBe(true);
  });

  test('flags a medication mentioned where the spec forbids it', () => {
    const spec = { ...SPEC, id: 'gen-y', outside: { ...SPEC.outside, mentions_medication: false } };
    expect(problems([{ ...GOOD_CASE, id: 'gen-y' }], [spec]).some((p) => p.includes('must not'))).toBe(true);
  });

  test('flags a duplicate id', () => {
    expect(problems([GOOD_CASE, GOOD_CASE])).toContain('duplicate id');
  });

  test('flags a document the Bot would refuse', () => {
    const bad = { ...GOOD_CASE, visit_note: { ...GOOD_CASE.visit_note, text: 'x'.repeat(5000) } };
    expect(problems([bad])).toContain('the Bot would refuse it: The note is too long for the demo check');
  });
});
