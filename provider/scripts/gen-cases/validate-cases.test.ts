import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { validateCases } from './validate-cases';

const SPEC = {
  id: 'gen-x',
  medication: 'lisinopril',
  expected: 'potential_conflict',
  outside: { dose: '10 mg', freq: 'once daily' },
  note: { dose: '20 mg', freq: 'once daily' },
};

const GOOD_CASE = {
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

function write(dir: string, name: string, value: unknown): string {
  const file = join(dir, name);
  writeFileSync(file, JSON.stringify(value));
  return file;
}

function run(cases: unknown[], specs: unknown[] = [SPEC]): ReturnType<typeof validateCases> {
  const dir = mkdtempSync(join(tmpdir(), 'gen-cases-'));
  const casesFile = write(dir, 'cases.json', { cases });
  const specsFile = write(dir, 'specs.json', { specs });
  return validateCases(casesFile, specsFile);
}

describe('validateCases', () => {
  test('accepts a well-formed case', () => {
    expect(run([GOOD_CASE])).toEqual([]);
  });

  test('flags a missing highlight substring', () => {
    const bad = { ...GOOD_CASE, highlight: { ...GOOD_CASE.highlight, visit_note: 'metformin 40 mg' } };
    const issues = run([bad]);
    expect(issues.some((i) => i.problem.includes('highlight'))).toBe(true);
  });

  test('flags a date inside document text', () => {
    const bad = {
      ...GOOD_CASE,
      visit_note: {
        ...GOOD_CASE.visit_note,
        text: 'Synthetic patient Z, seen today. Continue lisinopril 20 mg daily.',
      },
    };
    expect(run([bad]).some((i) => i.problem.includes('date'))).toBe(true);
  });

  test('flags a case with no matching spec', () => {
    expect(run([{ ...GOOD_CASE, id: 'gen-unknown' }]).some((i) => i.problem.includes('no matching spec'))).toBe(true);
  });

  test('flags a spec term missing from the document', () => {
    const bad = {
      ...GOOD_CASE,
      outside_document: { ...GOOD_CASE.outside_document, text: 'Synthetic patient Z, no dose stated.' },
    };
    expect(run([bad]).some((i) => i.problem.includes('missing a spec term'))).toBe(true);
  });

  test('flags a medication mentioned where the spec forbids it', () => {
    const spec = { ...SPEC, id: 'gen-y', outside: { ...SPEC.outside, mentions_medication: false } };
    const bad = { ...GOOD_CASE, id: 'gen-y' };
    expect(run([bad], [spec]).some((i) => i.problem.includes('must not'))).toBe(true);
  });

  test('flags a duplicate id', () => {
    expect(run([GOOD_CASE, GOOD_CASE]).some((i) => i.problem === 'duplicate id')).toBe(true);
  });

  test('flags text over the contract limits', () => {
    const bad = { ...GOOD_CASE, visit_note: { ...GOOD_CASE.visit_note, text: 'x'.repeat(5000) } };
    expect(run([bad]).some((i) => i.problem.includes('text_max'))).toBe(true);
  });
});
