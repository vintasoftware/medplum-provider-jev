import { describe, expect, test } from 'vitest';
import type { ScenarioState } from './steps';
import { COMPLETE, deriveCurrentStep, handled, rechecked, STEPS } from './steps';

const INFO = ['welcome', 'medications', 'open-documents', 'read-summary', 'open-visits'];

function state(patch: Partial<ScenarioState> = {}): ScenarioState {
  return { encounterStatus: 'planned', noteSaved: false, noteVersion: '1', checks: [], signed: false, ...patch };
}
const check = (
  id: string,
  choice: ScenarioState['checks'][number]['choice'],
  noteVersion = '2',
  mitigated = false
): ScenarioState['checks'][number] => ({ id, choice, noteVersion, mitigated });
const current = (s: ScenarioState, acked: string[] = []): string =>
  STEPS[deriveCurrentStep(s, acked)]?.id ?? 'complete';

describe('deriveCurrentStep', () => {
  test('walks the informational steps with Next and route acknowledgments', () => {
    expect(current(state())).toBe('welcome');
    for (let i = 1; i < INFO.length; i++) {
      expect(current(state(), INFO.slice(0, i))).toBe(INFO[i]);
    }
    expect(current(state(), INFO)).toBe('start-visit');
  });

  test('follows the primary path to completion', () => {
    expect(current(state({ encounterStatus: 'in-progress' }), INFO)).toBe('write-note');
    // Next pressed before the note saved does not count.
    expect(current(state({ encounterStatus: 'in-progress' }), [...INFO, 'write-note'])).toBe('write-note');
    const saved = { encounterStatus: 'in-progress', noteSaved: true, noteVersion: '2' };
    expect(current(state(saved), [...INFO, 'write-note'])).toBe('finish-visit');
    const finished = { ...saved, encounterStatus: 'finished' };
    expect(current(state(finished), INFO)).toBe('review-card');
    const flagged = { ...finished, checks: [check('a', 'potential_conflict')] };
    expect(current(state(flagged), INFO)).toBe('review-card');
    expect(current(state(flagged), [...INFO, 'review-card'])).toBe('handle');
    const edited = { ...flagged, noteVersion: '3' };
    expect(current(state(edited), INFO)).toBe('recheck');
    const agreed = { ...edited, checks: [check('b', 'agreement', '3'), check('a', 'potential_conflict')] };
    expect(current(state(agreed), INFO)).toBe('sign');
    expect(current(state({ ...agreed, signed: true }), INFO)).toBe('done');
    expect(deriveCurrentStep(state({ ...agreed, signed: true }), [...INFO, 'done'])).toBe(COMPLETE);
  });

  test('waits on the review card until a check exists', () => {
    const finished = state({ encounterStatus: 'finished', noteSaved: true });
    expect(current(finished, [...INFO, 'review-card'])).toBe('review-card');
  });

  test('skips handling and re-checking when the first check agrees', () => {
    const agreed = state({ encounterStatus: 'finished', noteSaved: true, checks: [check('a', 'agreement')] });
    expect(current(agreed, [...INFO, 'review-card'])).toBe('sign');
  });

  test('the task branch skips the re-check', () => {
    const tasked = state({
      encounterStatus: 'finished',
      noteSaved: true,
      noteVersion: '2',
      checks: [check('a', 'potential_conflict', '2', true)],
    });
    expect(handled(tasked)).toBe(true);
    expect(current(tasked, INFO)).toBe('sign');
  });

  test('an out-of-order sign lands on the final step', () => {
    const signedEarly = state({ encounterStatus: 'finished', noteSaved: true, signed: true });
    expect(current(signedEarly)).toBe('done');
  });

  test('resuming after unguided work lands on the first open step', () => {
    // Dismissed at start-visit, then finished, checked, edited and re-checked without the tips.
    const unguided = state({
      encounterStatus: 'finished',
      noteSaved: true,
      noteVersion: '3',
      checks: [check('b', 'agreement', '3'), check('a', 'potential_conflict', '2')],
    });
    expect(current(unguided, ['welcome'])).toBe('sign');
  });

  test('a second flagged re-check still moves on', () => {
    const twice = state({
      encounterStatus: 'finished',
      noteSaved: true,
      noteVersion: '4',
      checks: [
        check('c', 'potential_conflict', '4'),
        check('b', 'potential_conflict', '3'),
        check('a', 'potential_conflict'),
      ],
    });
    expect(rechecked(twice)).toBe(true);
    expect(current(twice, INFO)).toBe('sign');
    const once = { ...twice, checks: twice.checks.slice(1) };
    expect(rechecked(once)).toBe(false);
  });

  test('steps carry anchors that match their mode', () => {
    for (const step of STEPS) {
      expect(Boolean(step.anchor)).toBe(step.mode !== 'modal');
    }
  });
});
