import { MantineProvider } from '@mantine/core';
import type { WithId } from '@medplum/core';
import type { DetectedIssue, Encounter, Task } from '@medplum/fhirtypes';
import { MockClient } from '@medplum/mock';
import { MedplumProvider } from '@medplum/react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, test, vi } from 'vitest';
import scenario from '../../data/guided-scenario.json';
import type { CheckedPassages, ConsistencyCheck } from '../../hooks/useConsistencyCheck';
import { buildDetectedIssue } from '../../utils/consistency';
import type { ReviewResult, ReviewSuccess } from '../../utils/consistency-review';
import { splitSentences } from '../../utils/consistency-review';
import type { ConsistencyReviewCardProps } from './ConsistencyReviewCard';
import { ConsistencyReviewCard } from './ConsistencyReviewCard';

const NOTE = scenario.variants[0].note;
const OUTSIDE_SENTENCE = splitSentences(scenario.discharge_summary)[2];
const NOTE_SENTENCE = 'Plan: continue lisinopril 10 mg daily.';
const BADGE = { selector: '.mantine-Badge-label' };

const encounter: WithId<Encounter> = {
  resourceType: 'Encounter',
  id: 'enc-1',
  status: 'finished',
  class: { code: 'AMB' },
  subject: { reference: 'Patient/p1' },
};

const CONFLICT: ReviewResult = {
  medication: 'lisinopril',
  choice: 'potential_conflict',
  probabilities: { agreement: 0.02, potential_conflict: 0.97, insufficient_information: 0.01 },
  confidence: 0.95,
  sentence_outside: OUTSIDE_SENTENCE,
  sentence_note: NOTE_SENTENCE,
};

function makeIssue(result: ReviewResult = CONFLICT, mitigation?: DetectedIssue['mitigation']): WithId<DetectedIssue> {
  const review: ReviewSuccess = {
    status: 'ok',
    checked_at: '2026-09-23T15:00:00.000Z',
    model: 'jev-1.13.0',
    input_tokens: 900,
    mentions_hospital_stay: 0.1,
    note_version: '1',
    outside_version: '1',
    results: [result],
    documents: [
      { title: 'Discharge summary', date: '2026-09-16', text: scenario.discharge_summary, source: 'DocumentReference/d1' },
      { title: "Today's visit note", date: '2026-09-23', text: NOTE, source: 'ClinicalImpression/ci1' },
    ],
  };
  const issue = buildDetectedIssue(review, { reference: 'Patient/p1' }, encounter, { reference: 'Practitioner/pr1' });
  return { ...issue, id: 'issue-1', mitigation };
}

const LOADED: CheckedPassages = {
  loaded: true,
  outside: { title: 'Discharge summary', date: '2026-09-16T12:00:00Z', text: scenario.discharge_summary },
  note: NOTE,
};

function makeCheck(overrides: Partial<ConsistencyCheck> = {}): ConsistencyCheck {
  return {
    issue: makeIssue(),
    passages: LOADED,
    task: undefined,
    running: false,
    error: undefined,
    creatingTask: false,
    runCheck: vi.fn(async () => undefined),
    createTask: vi.fn(async () => undefined),
    markSignedWithReason: vi.fn(async () => undefined),
    ...overrides,
  };
}

function setup(props: Partial<ConsistencyReviewCardProps> = {}): {
  container: HTMLElement;
  handlers: { onEditNote: ReturnType<typeof vi.fn>; onSignWithReason: ReturnType<typeof vi.fn> };
} {
  const handlers = { onEditNote: vi.fn(), onSignWithReason: vi.fn() };
  const { container } = render(
    <MemoryRouter>
      <MedplumProvider medplum={new MockClient()}>
        <MantineProvider>
          <ConsistencyReviewCard check={makeCheck()} noteText={NOTE} locked={false} {...handlers} {...props} />
        </MantineProvider>
      </MedplumProvider>
    </MemoryRouter>
  );
  return { container, handlers };
}

describe('ConsistencyReviewCard', () => {
  test('shows the label, the summary and the highlighted sentences', () => {
    setup();
    expect(screen.getByText('Potential conflict', BADGE)).toBeInTheDocument();
    expect(screen.getByText(/disagree about lisinopril/)).toHaveTextContent('does not mention the hospital stay');
    expect(screen.getByText(OUTSIDE_SENTENCE).tagName).toBe('MARK');
    expect(screen.getByText(NOTE_SENTENCE).tagName).toBe('MARK');
    expect(screen.getByText(/Advisory only/)).toBeInTheDocument();
  });

  test('explains a label set by the no-dose rule and shows the model scores', async () => {
    setup({
      check: makeCheck({
        issue: makeIssue({
          ...CONFLICT,
          choice: 'insufficient_information',
          probabilities: { agreement: 0.78, potential_conflict: 0.02, insufficient_information: 0.2 },
          sentence_note: undefined,
          label_rule: 'no_dose_sentence',
        }),
      }),
    });
    expect(screen.getByText('Insufficient information', BADGE)).toBeInTheDocument();
    expect(screen.getByText(/The dose is missing, not necessarily wrong/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByText(/Label set by rule/)).toBeInTheDocument();
    expect(screen.getByText('78.0%')).toBeInTheDocument();
    expect(screen.getByText(/model jev-1.13.0/)).toHaveTextContent('900 input tokens');
  });

  test('marks the check stale when the note text changed since it', () => {
    setup({ noteText: `${NOTE} Continue 20 mg.` });
    expect(screen.getByText('Note changed since this check')).toBeInTheDocument();
    // The card keeps showing the text that was checked.
    expect(screen.getByText(NOTE_SENTENCE)).toBeInTheDocument();
    expect(screen.getByText(/as checked/)).toBeInTheDocument();
  });

  test('is not stale while the text is unchanged', () => {
    setup({ noteText: `  ${NOTE}\n` });
    expect(screen.queryByText('Note changed since this check')).not.toBeInTheDocument();
  });

  test('shows placeholders while the passages load and a notice for a missing version', () => {
    const { container } = setup({ check: makeCheck({ passages: { loaded: false } }) });
    expect(container).toHaveTextContent('…');
    expect(screen.queryByText(/could not be loaded/)).not.toBeInTheDocument();
    setup({ check: makeCheck({ passages: { loaded: true, outside: LOADED.outside } }) });
    expect(screen.getByText('The version that was checked could not be loaded.')).toBeInTheDocument();
  });

  test('offers edit, sign with reason and task actions', async () => {
    const check = makeCheck();
    const { handlers } = setup({ check });
    await userEvent.click(screen.getByRole('button', { name: 'Edit note' }));
    await userEvent.click(screen.getByRole('button', { name: 'Sign with a documented reason' }));
    await userEvent.click(screen.getByRole('button', { name: 'Create reconciliation task' }));
    expect(handlers.onEditNote).toHaveBeenCalledTimes(1);
    expect(handlers.onSignWithReason).toHaveBeenCalledTimes(1);
    expect(check.createTask).toHaveBeenCalledTimes(1);
  });

  test('hides actions for agreement', () => {
    setup({
      check: makeCheck({
        issue: makeIssue({
          ...CONFLICT,
          choice: 'agreement',
          probabilities: { agreement: 0.98, potential_conflict: 0.01, insufficient_information: 0.01 },
        }),
      }),
    });
    expect(screen.getByText('Agreement', BADGE)).toBeInTheDocument();
    expect(screen.getByText(/No action is needed before signing/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit note' })).not.toBeInTheDocument();
  });

  test('hides actions once the note is signed and locked', () => {
    setup({ locked: true });
    expect(screen.getByText('Potential conflict', BADGE)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit note' })).not.toBeInTheDocument();
  });

  test('lists the mitigations and links to the reconciliation task', () => {
    const task: WithId<Task> = { resourceType: 'Task', id: 'task-1', status: 'requested', intent: 'order' };
    const mitigation = [
      { action: { text: 'Reconciliation task created' }, date: '2026-09-23T15:10:00Z' },
      { action: { text: 'Signed with documented reason' }, date: '2026-09-23T15:20:00Z' },
    ];
    setup({ check: makeCheck({ issue: makeIssue(CONFLICT, mitigation), task }) });
    expect(screen.getByText(/Reconciliation task created/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open task' })).toHaveAttribute('href', '/Task/task-1');
    expect(screen.getByText(/Signed with documented reason/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create reconciliation task' })).not.toBeInTheDocument();
  });

  test('shows progress while a check runs', () => {
    setup({ check: makeCheck({ running: true }) });
    expect(screen.getByText(/Checking the note against the outside discharge summary/)).toBeInTheDocument();
    expect(screen.queryByText('Potential conflict', BADGE)).not.toBeInTheDocument();
  });

  test('shows the reason and no prediction when the check is unavailable', () => {
    setup({ check: makeCheck({ issue: undefined, error: 'No chart note has been saved for this visit yet' }) });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('No chart note has been saved for this visit yet');
    expect(alert).toHaveTextContent('No replacement prediction is shown');
  });

  test('renders nothing without a check', () => {
    const { container } = setup({ check: makeCheck({ issue: undefined }) });
    // Only Mantine's style tags are rendered.
    expect(Array.from(container.children).filter((el) => el.tagName !== 'STYLE')).toHaveLength(0);
  });
});
