import { MantineProvider } from '@mantine/core';
import type { WithId } from '@medplum/core';
import { createReference } from '@medplum/core';
import type {
  ClinicalImpression,
  DetectedIssue,
  DocumentReference,
  Encounter,
  Patient,
  Task,
} from '@medplum/fhirtypes';
import { MockClient } from '@medplum/mock';
import { MedplumProvider } from '@medplum/react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { JSX } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import scenario from '../../data/guided-scenario.json';
import type { ReviewOutput } from '../../utils/consistency';
import { CHECK_CODE, CHECK_CODE_SYSTEM, splitSentences } from '../../utils/consistency';
import type { ConsistencyReviewCardProps } from './ConsistencyReviewCard';
import { ConsistencyReviewCard } from './ConsistencyReviewCard';

const NOTE = scenario.variants[0].note;
let medplum: MockClient;
let patient: WithId<Patient>;
let encounter: WithId<Encounter>;
let impression: WithId<ClinicalImpression>;
let summary: WithId<DocumentReference>;

function botResult(overrides: Partial<Extract<ReviewOutput, { status: 'ok' }>> = {}): ReviewOutput {
  return {
    status: 'ok',
    checked_at: '2026-09-23T15:00:00.000Z',
    model: 'jev-1.13.0',
    input_tokens: 900,
    mentions_hospital_stay: 0.1,
    note_version: impression.meta?.versionId as string,
    outside_version: summary.meta?.versionId as string,
    results: [
      {
        medication: 'lisinopril',
        choice: 'potential_conflict',
        probabilities: { agreement: 0.02, potential_conflict: 0.97, insufficient_information: 0.01 },
        confidence: 0.95,
        sentence_outside: splitSentences(scenario.discharge_summary)[2],
        sentence_note: 'Plan: continue lisinopril 10 mg daily.',
      },
    ],
    documents: [
      {
        title: 'Discharge summary',
        date: '2026-09-16',
        text: scenario.discharge_summary,
        source: `DocumentReference/${summary.id}`,
      },
      { title: "Today's visit note", date: '2026-09-23', text: NOTE, source: `ClinicalImpression/${impression.id}` },
    ],
    ...overrides,
  };
}

const BADGE = { selector: '.mantine-Badge-label' };

function setup(props: Partial<ConsistencyReviewCardProps> = {}): {
  rerender: (next: Partial<ConsistencyReviewCardProps>) => void;
  handlers: Record<string, ReturnType<typeof vi.fn>>;
} {
  const handlers = {
    beforeCheck: vi.fn(async () => undefined),
    onEditNote: vi.fn(),
    onSignWithReason: vi.fn(),
    onIssueChange: vi.fn(),
  };
  const element = (extra: Partial<ConsistencyReviewCardProps>): JSX.Element => (
    <MemoryRouter>
      <MedplumProvider medplum={medplum}>
        <MantineProvider>
          <ConsistencyReviewCard
            encounter={encounter}
            patient={createReference(patient)}
            noteText={NOTE}
            requestSeq={0}
            locked={false}
            {...handlers}
            {...props}
            {...extra}
          />
        </MantineProvider>
      </MedplumProvider>
    </MemoryRouter>
  );
  const view = render(element({}));
  return { rerender: (next) => view.rerender(element(next)), handlers };
}

beforeEach(async () => {
  vi.stubEnv('MEDPLUM_CONSISTENCY_BOT_ID', 'bot-1');
  vi.stubEnv('MEDPLUM_PROJECT_ID', 'demo-project');
  medplum = new MockClient();
  vi.spyOn(medplum, 'getProject').mockReturnValue({ resourceType: 'Project', id: 'demo-project' });
  patient = await medplum.createResource<Patient>({ resourceType: 'Patient', name: [{ family: 'Demo' }] });
  encounter = await medplum.createResource<Encounter>({
    resourceType: 'Encounter',
    status: 'finished',
    class: { code: 'AMB' },
    subject: createReference(patient),
  });
  impression = await medplum.createResource<ClinicalImpression>({
    resourceType: 'ClinicalImpression',
    status: 'in-progress',
    subject: createReference(patient),
    encounter: createReference(encounter),
    note: [{ text: NOTE }],
  });
  summary = await medplum.createResource<DocumentReference>({
    resourceType: 'DocumentReference',
    status: 'current',
    subject: createReference(patient),
    date: '2026-09-16T12:00:00Z',
    description: 'Discharge summary',
    content: [{ attachment: { contentType: 'text/plain', data: btoa(scenario.discharge_summary) } }],
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('ConsistencyReviewCard', () => {
  test('runs once when the chart raises the request number, never on mount', async () => {
    const execute = vi.spyOn(medplum, 'executeBot').mockResolvedValue(botResult());
    const { rerender, handlers } = setup();
    await act(async () => undefined);
    expect(execute).not.toHaveBeenCalled();

    rerender({ requestSeq: 1 });
    expect(await screen.findByText('Potential conflict', BADGE)).toBeInTheDocument();
    expect(handlers.beforeCheck).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      'bot-1',
      { action: 'review_encounter', encounter_id: encounter.id },
      'application/json'
    );
    expect(handlers.beforeCheck.mock.invocationCallOrder[0]).toBeLessThan(execute.mock.invocationCallOrder[0]);

    // A re-render with the same number does not run again.
    rerender({ requestSeq: 1 });
    await act(async () => undefined);
    expect(execute).toHaveBeenCalledTimes(1);

    expect(screen.getByText(/disagree about lisinopril/)).toBeInTheDocument();
    expect(screen.getByText('Plan: continue lisinopril 10 mg daily.').tagName).toBe('MARK');
    const issues = await medplum.searchResources('DetectedIssue', { patient: `Patient/${patient.id}` });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      status: 'preliminary',
      patient: { reference: `Patient/${patient.id}` },
      code: { coding: [{ system: CHECK_CODE_SYSTEM, code: CHECK_CODE }] },
    });
    expect(issues[0].implicated?.map((r) => r.reference)).toEqual([
      `Encounter/${encounter.id}`,
      `ClinicalImpression/${impression.id}/_history/${impression.meta?.versionId}`,
      `DocumentReference/${summary.id}/_history/${summary.meta?.versionId}`,
    ]);
    // The stored result holds no chart text.
    expect(JSON.stringify(issues[0])).not.toContain('lisinopril 10 mg daily');
  });

  test('explains a label set by the no-dose rule and keeps the model scores', async () => {
    const [result] = (botResult() as Extract<ReviewOutput, { status: 'ok' }>).results;
    vi.spyOn(medplum, 'executeBot').mockResolvedValue(
      botResult({
        results: [
          {
            ...result,
            choice: 'insufficient_information',
            probabilities: { agreement: 0.78, potential_conflict: 0.02, insufficient_information: 0.2 },
            sentence_note: undefined,
            label_rule: 'no_dose_sentence',
          },
        ],
      })
    );
    const { rerender } = setup();
    rerender({ requestSeq: 1 });
    await screen.findByText('Insufficient information', BADGE);
    await userEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(await screen.findByText(/Label set by rule/)).toBeInTheDocument();
    expect(screen.getByText('78.0%')).toBeInTheDocument();
    const [issue] = await medplum.searchResources('DetectedIssue', { patient: `Patient/${patient.id}` });
    expect(issue.detail).toContain('label set by rule');
  });

  test('loads the newest stored check without calling the Bot', async () => {
    const execute = vi.spyOn(medplum, 'executeBot');
    vi.spyOn(medplum, 'executeBot').mockResolvedValueOnce(botResult());
    const { rerender } = setup();
    rerender({ requestSeq: 1 });
    await screen.findByText('Potential conflict', BADGE);
    execute.mockClear();

    setup();
    await waitFor(() => expect(screen.getAllByText('Potential conflict', BADGE)).toHaveLength(2));
    expect(execute).not.toHaveBeenCalled();
  });

  test('reloads a Binary-URL discharge summary at the version that was checked', async () => {
    const texts: Record<string, string> = {
      'Binary/original': scenario.discharge_summary,
      'Binary/revised': 'A revised summary that was never checked.',
    };
    const download = vi
      .spyOn(medplum, 'download')
      .mockImplementation(async (url) => new Blob([texts[url as string] ?? '']));
    summary = await medplum.updateResource<DocumentReference>({
      ...summary,
      content: [{ attachment: { contentType: 'text/plain', url: 'Binary/original' } }],
    });
    vi.spyOn(medplum, 'executeBot').mockResolvedValue(botResult());
    const { rerender } = setup();
    rerender({ requestSeq: 1 });
    await screen.findByText('Potential conflict', BADGE);
    const outsideSentence = splitSentences(scenario.discharge_summary)[2];
    expect((await screen.findByText(outsideSentence)).tagName).toBe('MARK');

    // The document changes after the check; a reload still shows what was checked.
    await medplum.updateResource<DocumentReference>({
      ...summary,
      content: [{ attachment: { contentType: 'text/plain', url: 'Binary/revised' } }],
    });
    const readVersion = vi.spyOn(medplum, 'readVersion');
    download.mockClear();
    setup();
    await waitFor(() => expect(screen.getAllByText(outsideSentence)).toHaveLength(2));
    expect(readVersion).toHaveBeenCalledWith('DocumentReference', summary.id, summary.meta?.versionId);
    expect(download).toHaveBeenCalledWith('Binary/original');
    expect(download).not.toHaveBeenCalledWith('Binary/revised');
    expect(screen.queryByText(/revised summary/)).not.toBeInTheDocument();
  });

  test('marks the check stale when the note changed after it', async () => {
    vi.spyOn(medplum, 'executeBot').mockResolvedValue(botResult());
    const { rerender } = setup();
    rerender({ requestSeq: 1 });
    await screen.findByText('Potential conflict', BADGE);
    expect(screen.queryByText('Note changed since this check')).not.toBeInTheDocument();
    rerender({ requestSeq: 1, noteText: `${NOTE} Continue 20 mg.` });
    expect(await screen.findByText('Note changed since this check')).toBeInTheDocument();
  });

  test('a new note version with the same text, as after Sign & Lock, is not stale', async () => {
    vi.spyOn(medplum, 'executeBot').mockResolvedValue(botResult());
    const { rerender } = setup();
    rerender({ requestSeq: 1 });
    await screen.findByText('Potential conflict', BADGE);
    // Sign & Lock sets ClinicalImpression.status to completed, which saves a new version.
    await medplum.updateResource({ ...impression, status: 'completed' });
    rerender({ requestSeq: 1, locked: true });
    await act(async () => undefined);
    expect(screen.queryByText('Note changed since this check')).not.toBeInTheDocument();
  });

  test('creates a reconciliation task that survives Sign & Lock', async () => {
    vi.spyOn(medplum, 'executeBot').mockResolvedValue(botResult());
    const { rerender } = setup();
    rerender({ requestSeq: 1 });
    await userEvent.click(await screen.findByRole('button', { name: 'Create reconciliation task' }));
    await waitFor(async () =>
      expect(await medplum.searchResources('Task', { patient: `Patient/${patient.id}` })).toHaveLength(1)
    );
    const [task] = (await medplum.searchResources('Task', { patient: `Patient/${patient.id}` })) as Task[];
    const [issue] = (await medplum.searchResources('DetectedIssue', {
      patient: `Patient/${patient.id}`,
    })) as DetectedIssue[];
    expect(task.encounter).toBeUndefined();
    expect(task).toMatchObject({
      status: 'requested',
      intent: 'order',
      priority: 'routine',
      code: { text: 'Reconcile lisinopril dose with outside discharge summary' },
      focus: { reference: `DetectedIssue/${issue.id}` },
      reasonReference: { reference: `Encounter/${encounter.id}` },
      for: { reference: `Patient/${patient.id}` },
    });
    expect(issue.mitigation?.[0]?.action.text).toBe('Reconciliation task created');
    expect(await screen.findByText('Open task')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create reconciliation task' })).not.toBeInTheDocument();
  });

  test('offers edit and sign-with-reason actions', async () => {
    vi.spyOn(medplum, 'executeBot').mockResolvedValue(botResult());
    const { rerender, handlers } = setup();
    rerender({ requestSeq: 1 });
    await userEvent.click(await screen.findByRole('button', { name: 'Edit note' }));
    await userEvent.click(screen.getByRole('button', { name: 'Sign with a documented reason' }));
    expect(handlers.onEditNote).toHaveBeenCalled();
    expect(handlers.onSignWithReason).toHaveBeenCalled();
  });

  test('hides actions for agreement', async () => {
    vi.spyOn(medplum, 'executeBot').mockResolvedValue(
      botResult({
        results: [
          {
            medication: 'lisinopril',
            choice: 'agreement',
            probabilities: { agreement: 0.98, potential_conflict: 0.01, insufficient_information: 0.01 },
            confidence: 0.97,
          },
        ],
      })
    );
    const { rerender } = setup();
    rerender({ requestSeq: 1 });
    expect(await screen.findByText('Agreement', BADGE)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit note' })).not.toBeInTheDocument();
  });

  test('hides actions once the note is signed and locked', async () => {
    vi.spyOn(medplum, 'executeBot').mockResolvedValue(botResult());
    const { rerender } = setup();
    rerender({ requestSeq: 1 });
    await screen.findByRole('button', { name: 'Edit note' });
    rerender({ requestSeq: 1, locked: true });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Edit note' })).not.toBeInTheDocument());
    expect(screen.getByText('Potential conflict', BADGE)).toBeInTheDocument();
  });

  test('shows the reason and no prediction when the check is unavailable', async () => {
    vi.spyOn(medplum, 'executeBot').mockResolvedValue({
      status: 'unavailable',
      reason: 'No chart note has been saved for this visit yet',
    });
    const { rerender } = setup();
    rerender({ requestSeq: 1 });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('No chart note has been saved for this visit yet');
    expect(alert).toHaveTextContent('No replacement prediction is shown');
    expect(await medplum.searchResources('DetectedIssue', { patient: `Patient/${patient.id}` })).toHaveLength(0);
  });

  test('refuses to call the Bot outside the configured project', async () => {
    vi.mocked(medplum.getProject).mockReturnValue({ resourceType: 'Project', id: 'other' });
    const execute = vi.spyOn(medplum, 'executeBot');
    const { rerender } = setup();
    rerender({ requestSeq: 1 });
    expect(await screen.findByRole('alert')).toHaveTextContent('Sign in to the configured synthetic demo project');
    expect(execute).not.toHaveBeenCalled();
  });
});
