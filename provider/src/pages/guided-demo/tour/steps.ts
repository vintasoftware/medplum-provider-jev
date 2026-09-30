import scenario from '../../../data/guided-scenario.json';
import type { ReviewLabel } from '../../../utils/consistency-review';
import { PATIENT_TAB_SELECTORS, TOUR, tourSelector } from './anchors';

// The tutorial never advances by hand. Each step is done when the chart's server state
// shows it (read by GuidedDemoContext.refresh) or, for informational steps, when the
// tester pressed Next. Later progress implies earlier steps, so a tester who worked
// unguided and resumes lands on the first thing still left to do.

/** Server facts that drive progress. Opaque ids, labels and counts only; no chart text. */
export interface ScenarioState {
  encounterStatus?: string;
  noteSaved: boolean;
  noteVersion?: string;
  /** Consistency checks for the visit, newest first. */
  checks: {
    id: string;
    choice: ReviewLabel;
    noteVersion: string;
    mitigated: boolean;
  }[];
  signed: boolean;
}

export interface ScenarioIds {
  patientId: string;
  encounterId: string;
}

/**
 * - `modal`: centered popover, no element; Next and Skip.
 * - `point`: highlight; Next and Skip. The element is not interactive unless `interactive` is set.
 * - `act`: highlight; the first click on the element closes the highlight so the app's own
 *   menus and dialogs work, and the step finishes from server state.
 * - `type`: highlight; the element stays interactive; Next enables once `ready` holds.
 */
export type StepMode = 'modal' | 'point' | 'act' | 'type';

export interface TourStep {
  id: string;
  mode: StepMode;
  title: string;
  description: string;
  /** Selector of the element to highlight; none for a centered step. */
  anchor?: (ids: ScenarioIds) => string;
  /** The step is done when the tester is on this route. */
  route?: (pathname: string, ids: ScenarioIds) => boolean;
  /** Server evidence that the step is done. Evidence also marks every earlier step done. */
  evidence?: (state: ScenarioState) => boolean;
  /** For `type` and waiting steps: Next is offered only once this holds. */
  ready?: (state: ScenarioState) => boolean;
  /** A `point` step whose element stays usable, for content the tester reads or expands. */
  interactive?: boolean;
  /** Shown in the coach bar while `ready` does not hold yet. */
  waiting?: string;
  /** The step does not apply in this state. */
  skip?: (state: ScenarioState) => boolean;
}

const firstCheck = (s: ScenarioState): ScenarioState['checks'][number] | undefined => s.checks.at(-1);
const flaggedChecks = (s: ScenarioState): ScenarioState['checks'] => s.checks.filter((c) => c.choice !== 'agreement');
const firstIsAgreement = (s: ScenarioState): boolean => firstCheck(s)?.choice === 'agreement';

/** The note was edited after a flagged check, or the note was checked again since. */
export function editedAfterFlag(s: ScenarioState): boolean {
  return flaggedChecks(s).some((c) => c.noteVersion !== s.noteVersion || s.checks[0] !== c);
}

/** The provider acted on a flagged check: edited the note or chose a disposition. */
export function handled(s: ScenarioState): boolean {
  return editedAfterFlag(s) || flaggedChecks(s).some((c) => c.mitigated);
}

/** Re-check done: a newer check agrees, or two checks followed the first flagged one. */
export function rechecked(s: ScenarioState): boolean {
  const flagged = flaggedChecks(s);
  if (flagged.length === 0) {
    return false;
  }
  const newerChecks = s.checks.indexOf(flagged[flagged.length - 1]);
  return (newerChecks >= 1 && s.checks[0].choice === 'agreement') || newerChecks >= 2;
}

export const STEPS: TourStep[] = [
  {
    id: 'welcome',
    mode: 'modal',
    title: 'Post-discharge follow-up',
    description:
      'You are the primary care provider seeing this patient one week after a hospital stay for high blood pressure. ' +
      'Document the visit and the medication plan, finish the visit and sign the note. ' +
      'Press Esc or Skip tutorial at any time to hide these tips; resume them from the bar at the top.',
  },
  {
    id: 'medications',
    mode: 'point',
    title: 'What the chart says',
    description: 'The chart lists lisinopril 10 mg as an active medication. Keep that in mind.',
    anchor: () => tourSelector(TOUR.patientSummary),
  },
  {
    id: 'open-documents',
    mode: 'act',
    title: 'Outside records',
    description: 'Open Documents to see what the hospital sent.',
    anchor: () => PATIENT_TAB_SELECTORS.documents,
    route: (pathname, ids) => pathname.startsWith(`/Patient/${ids.patientId}/DocumentReference`),
  },
  {
    id: 'read-summary',
    mode: 'point',
    title: 'The discharge summary',
    description:
      'This discharge summary comes from another organization. Read the medication section: what dose did the hospital send the patient home on?',
    anchor: () => tourSelector(TOUR.documentDetail),
    interactive: true,
  },
  {
    id: 'open-visits',
    mode: 'act',
    title: "Today's visit",
    description: 'Go to Visits and open today’s Post-discharge follow-up.',
    anchor: () => PATIENT_TAB_SELECTORS.visits,
    route: (pathname, ids) => pathname.startsWith(`/Patient/${ids.patientId}/Encounter/${ids.encounterId}`),
  },
  {
    id: 'start-visit',
    mode: 'act',
    title: 'Start the visit',
    description: 'Set the visit to In Progress.',
    anchor: () => tourSelector(TOUR.visitStatus),
    evidence: (s) => s.encounterStatus === 'in-progress' || s.encounterStatus === 'finished',
  },
  {
    id: 'write-note',
    mode: 'type',
    title: 'Write the visit note',
    description:
      `The patient reports: ${scenario.visit_story} ` + 'Document the visit and the medication plan in your own words.',
    anchor: () => tourSelector(TOUR.chartNote),
    ready: (s) => s.noteSaved,
    waiting: 'Type the note; it saves automatically.',
  },
  {
    id: 'finish-visit',
    mode: 'act',
    title: 'Finish the visit',
    description: 'Set the visit to Finished. The note is checked automatically.',
    anchor: () => tourSelector(TOUR.visitStatus),
    evidence: (s) => s.encounterStatus === 'finished',
  },
  {
    id: 'review-card',
    mode: 'point',
    title: 'What the check found',
    description: 'The check compared your note with the discharge summary. Read both passages.',
    anchor: () => tourSelector(TOUR.reviewCard),
    interactive: true,
    ready: (s) => s.checks.length > 0,
    waiting: 'Checking the note…',
  },
  {
    id: 'handle',
    mode: 'act',
    title: 'Handle it',
    description:
      'Choose how to handle it: edit the note, sign with a documented reason, or create a reconciliation task.',
    anchor: () => tourSelector(TOUR.reviewActions),
    skip: firstIsAgreement,
    evidence: handled,
  },
  {
    id: 'recheck',
    mode: 'act',
    title: 'Check again',
    description: 'Run Check note again to compare the edited note.',
    anchor: () => tourSelector(TOUR.checkNote),
    // Only on the edit branch: a task or a signed reason needs no re-check.
    skip: (s) => firstIsAgreement(s) || !editedAfterFlag(s),
    evidence: rechecked,
  },
  {
    id: 'sign',
    mode: 'act',
    title: 'Sign',
    description: 'Sign and lock the note.',
    anchor: () => tourSelector(TOUR.visitSign),
    evidence: (s) => s.signed,
  },
  {
    id: 'done',
    mode: 'modal',
    title: 'Done',
    description:
      'The visit now shows your signature, and the consistency check stays on it. The model changed nothing in the chart; every decision was yours.',
  },
];

export const COMPLETE = STEPS.length;

/**
 * Index of the first step still to do, or `COMPLETE` once the final step was acknowledged.
 *
 * @param state - Server facts from GuidedDemoContext.refresh.
 * @param acknowledged - Step ids the tester pressed Next on, or whose route they reached.
 * @returns The current step index.
 */
export function deriveCurrentStep(state: ScenarioState, acknowledged: readonly string[]): number {
  const acked = new Set(acknowledged);
  let furthestEvidence = -1;
  STEPS.forEach((step, i) => {
    if (step.evidence?.(state)) {
      furthestEvidence = i;
    }
  });
  for (let i = 0; i < STEPS.length; i++) {
    const step = STEPS[i];
    const done =
      i < furthestEvidence ||
      step.skip?.(state) ||
      step.evidence?.(state) ||
      (acked.has(step.id) && (!step.ready || step.ready(state)));
    if (!done) {
      return i;
    }
  }
  return COMPLETE;
}
