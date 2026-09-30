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
import type { RenderHookResult } from '@testing-library/react';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { JSX, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import scenario from '../data/guided-scenario.json';
import { CHECK_CODE, CHECK_CODE_SYSTEM } from '../utils/consistency';
import type { ReviewOutput, ReviewSuccess } from '../utils/consistency-review';
import { splitSentences } from '../utils/consistency-review';
import type { ConsistencyCheck } from './useConsistencyCheck';
import { useConsistencyCheck } from './useConsistencyCheck';

const NOTE = scenario.variants[0].note;
let medplum: MockClient;
let patient: WithId<Patient>;
let encounter: WithId<Encounter>;
let impression: WithId<ClinicalImpression>;
let summary: WithId<DocumentReference>;

function botResult(overrides: Partial<ReviewSuccess> = {}): ReviewOutput {
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

function setup(beforeCheck = vi.fn(async () => undefined)): RenderHookResult<ConsistencyCheck, unknown> & {
  beforeCheck: typeof beforeCheck;
  onChange: ReturnType<typeof vi.fn>;
} {
  const onChange = vi.fn();
  const wrapper = ({ children }: { children: ReactNode }): JSX.Element => (
    <MedplumProvider medplum={medplum}>{children}</MedplumProvider>
  );
  const view = renderHook(() => useConsistencyCheck(encounter, { beforeCheck, onChange }), { wrapper });
  return { ...view, beforeCheck, onChange };
}

async function issues(): Promise<WithId<DetectedIssue>[]> {
  return medplum.searchResources('DetectedIssue', { patient: `Patient/${patient.id}` });
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

describe('useConsistencyCheck', () => {
  test('runs the Bot after the note is saved and stores the result without chart text', async () => {
    const execute = vi.spyOn(medplum, 'executeBot').mockResolvedValue(botResult());
    const { result, beforeCheck, onChange } = setup();
    await act(async () => undefined);
    expect(execute).not.toHaveBeenCalled();
    expect(result.current.issue).toBeUndefined();

    await act(() => result.current.runCheck());

    expect(beforeCheck).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      'bot-1',
      { action: 'review_encounter', encounter_id: encounter.id },
      'application/json'
    );
    expect(beforeCheck.mock.invocationCallOrder[0]).toBeLessThan(execute.mock.invocationCallOrder[0]);
    expect(result.current.running).toBe(false);
    expect(result.current.error).toBeUndefined();
    expect(onChange).toHaveBeenCalledTimes(1);

    const [issue] = await issues();
    expect(result.current.issue?.id).toBe(issue.id);
    expect(issue).toMatchObject({
      status: 'preliminary',
      patient: { reference: `Patient/${patient.id}` },
      code: { coding: [{ system: CHECK_CODE_SYSTEM, code: CHECK_CODE }] },
    });
    expect(issue.implicated?.map((r) => r.reference)).toEqual([
      `Encounter/${encounter.id}`,
      `ClinicalImpression/${impression.id}/_history/${impression.meta?.versionId}`,
      `DocumentReference/${summary.id}/_history/${summary.meta?.versionId}`,
    ]);
    // The stored result holds no chart text; the passages are re-read from the checked versions.
    expect(JSON.stringify(issue)).not.toContain('lisinopril 10 mg daily');
    await waitFor(() => expect(result.current.passages.loaded).toBe(true));
    expect(result.current.passages).toEqual({
      loaded: true,
      outside: { title: 'Discharge summary', date: '2026-09-16T12:00:00Z', text: scenario.discharge_summary },
      note: NOTE,
    });
  });

  test('stores a label set by rule in the detail', async () => {
    const [ruled] = (botResult() as ReviewSuccess).results;
    vi.spyOn(medplum, 'executeBot').mockResolvedValue(
      botResult({
        results: [
          { ...ruled, choice: 'insufficient_information', sentence_note: undefined, label_rule: 'no_dose_sentence' },
        ],
      })
    );
    const { result } = setup();
    await act(() => result.current.runCheck());
    const [issue] = await issues();
    expect(issue.detail).toContain('Insufficient information (lisinopril)');
    expect(issue.detail).toContain('label set by rule');
  });

  test('loads the newest stored check without calling the Bot', async () => {
    const execute = vi.spyOn(medplum, 'executeBot').mockResolvedValueOnce(botResult());
    const first = setup();
    await act(() => first.result.current.runCheck());
    execute.mockClear();

    const { result } = setup();
    await waitFor(() => expect(result.current.issue?.id).toBe(first.result.current.issue?.id));
    expect(execute).not.toHaveBeenCalled();
  });

  test('reads a Binary-URL discharge summary at the version that was checked', async () => {
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
    const first = setup();
    await act(() => first.result.current.runCheck());
    await waitFor(() => expect(first.result.current.passages.outside?.text).toBe(scenario.discharge_summary));

    // The document changes after the check; a reload still shows what was checked.
    await medplum.updateResource<DocumentReference>({
      ...summary,
      content: [{ attachment: { contentType: 'text/plain', url: 'Binary/revised' } }],
    });
    const readVersion = vi.spyOn(medplum, 'readVersion');
    download.mockClear();
    const { result } = setup();
    await waitFor(() => expect(result.current.passages.outside?.text).toBe(scenario.discharge_summary));
    expect(readVersion).toHaveBeenCalledWith('DocumentReference', summary.id, summary.meta?.versionId);
    expect(download).toHaveBeenCalledWith('Binary/original');
    expect(download).not.toHaveBeenCalledWith('Binary/revised');
  });

  test('does not check when the note could not be saved', async () => {
    const execute = vi.spyOn(medplum, 'executeBot');
    const { result } = setup(vi.fn(async () => Promise.reject(new Error('Network error'))));
    await act(() => result.current.runCheck());
    expect(result.current.error).toBe('The note could not be saved, so it was not checked');
    expect(execute).not.toHaveBeenCalled();
  });

  test("reports the Bot's reason and stores nothing", async () => {
    vi.spyOn(medplum, 'executeBot').mockResolvedValue({
      status: 'unavailable',
      reason: 'No chart note has been saved for this visit yet',
    });
    const { result } = setup();
    await act(() => result.current.runCheck());
    expect(result.current.error).toBe('No chart note has been saved for this visit yet');
    expect(result.current.issue).toBeUndefined();
    expect(await issues()).toHaveLength(0);
  });

  test('refuses to call the Bot outside the configured project', async () => {
    vi.mocked(medplum.getProject).mockReturnValue({ resourceType: 'Project', id: 'other' });
    const execute = vi.spyOn(medplum, 'executeBot');
    const { result } = setup();
    await act(() => result.current.runCheck());
    expect(result.current.error).toBe('Sign in to the configured synthetic demo project');
    expect(execute).not.toHaveBeenCalled();
  });

  test('creates a reconciliation task and records it on the check', async () => {
    vi.spyOn(medplum, 'executeBot').mockResolvedValue(botResult());
    const { result, onChange } = setup();
    await act(() => result.current.runCheck());
    await act(() => result.current.createTask());

    const [task] = (await medplum.searchResources('Task', { patient: `Patient/${patient.id}` })) as Task[];
    const [issue] = await issues();
    expect(result.current.task?.id).toBe(task.id);
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
    expect(result.current.issue?.mitigation).toHaveLength(1);
    expect(onChange).toHaveBeenCalledTimes(2);

    // A reload finds the task again.
    const reloaded = setup();
    await waitFor(() => expect(reloaded.result.current.task?.id).toBe(task.id));
  });

  test('records a signature with a documented reason on the check', async () => {
    vi.spyOn(medplum, 'executeBot').mockResolvedValue(botResult());
    const { result } = setup();
    await act(() => result.current.runCheck());
    await act(() => result.current.markSignedWithReason({ reference: 'Practitioner/signer' }));

    const [issue] = await issues();
    expect(issue.status).toBe('final');
    expect(issue.mitigation?.[0]).toMatchObject({
      action: { text: 'Signed with documented reason' },
      author: { reference: 'Practitioner/signer' },
    });
    expect(result.current.issue?.status).toBe('final');
  });
});
