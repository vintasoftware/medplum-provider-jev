import { MantineProvider } from '@mantine/core';
import type { WithId } from '@medplum/core';
import { createReference } from '@medplum/core';
import type { ClinicalImpression, Practitioner } from '@medplum/fhirtypes';
import { MockClient } from '@medplum/mock';
import { MedplumProvider } from '@medplum/react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { JSX } from 'react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CHECK_CODE, CHECK_CODE_SYSTEM, CHECK_RESULT_EXTENSION } from '../../utils/consistency';
import { buildSignatureProvenance } from '../../utils/encounter';
import type { GuidedDemoController } from './GuidedDemoContext';
import {
  GuidedDemoProvider,
  readScenarioState,
  STORAGE_KEY,
  useGuidedDemo,
  useGuidedDemoController,
} from './GuidedDemoContext';
import { seedScenario } from './seedScenario';

let medplum: MockClient;
let practitioner: WithId<Practitioner>;
let controller: GuidedDemoController | undefined;
let chartHook: ReturnType<typeof useGuidedDemo>;

function Probe(): JSX.Element {
  controller = useGuidedDemoController();
  chartHook = useGuidedDemo();
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <div>
      <span data-testid="path">{location.pathname}</span>
      <span data-testid="step">{controller?.currentStep}</span>
      <button onClick={() => navigate(`/Patient/${controller?.scenario?.patientId}/DocumentReference`)}>docs</button>
    </div>
  );
}

function setup(): void {
  render(
    <MemoryRouter initialEntries={['/guided-demo']}>
      <MedplumProvider medplum={medplum}>
        <MantineProvider>
          <GuidedDemoProvider>
            <Routes>
              <Route path="*" element={<Probe />} />
            </Routes>
          </GuidedDemoProvider>
        </MantineProvider>
      </MedplumProvider>
    </MemoryRouter>
  );
}

function check(noteVersion: string, choice: string, identified: string): Record<string, unknown> {
  return {
    resourceType: 'DetectedIssue',
    status: 'preliminary',
    code: { coding: [{ system: CHECK_CODE_SYSTEM, code: CHECK_CODE }] },
    identifiedDateTime: identified,
    extension: [
      {
        url: CHECK_RESULT_EXTENSION,
        valueString: JSON.stringify({
          results: [{ medication: 'lisinopril', choice, confidence: 1, probabilities: {} }],
        }),
      },
    ],
    noteVersion,
  };
}

beforeEach(async () => {
  localStorage.clear();
  medplum = new MockClient();
  practitioner = (await medplum.getProfile()) as WithId<Practitioner>;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('readScenarioState', () => {
  test('reads status, note, checks newest first and signatures', async () => {
    const seeded = await seedScenario(medplum, practitioner);
    const encounterRef = { reference: `Encounter/${seeded.encounterId}` };
    let state = await readScenarioState(medplum, seeded.encounterId);
    expect(state).toMatchObject({ encounterStatus: 'planned', noteSaved: false, checks: [], signed: false });

    const impression = (await medplum.searchOne('ClinicalImpression', {
      encounter: encounterRef.reference,
    })) as WithId<ClinicalImpression>;
    const saved = await medplum.updateResource({ ...impression, note: [{ text: 'Plan: continue lisinopril.' }] });
    for (const [version, choice, when] of [
      ['1', 'potential_conflict', '2026-09-23T15:00:00Z'],
      ['2', 'agreement', '2026-09-23T15:05:00Z'],
    ]) {
      const { noteVersion, ...issue } = check(version, choice, when);
      await medplum.createResource({
        ...issue,
        implicated: [encounterRef, { reference: `ClinicalImpression/${impression.id}/_history/${noteVersion}` }],
      } as never);
    }
    await medplum.createResource(
      buildSignatureProvenance(encounterRef, createReference(practitioner), new Date().toISOString())
    );

    state = await readScenarioState(medplum, seeded.encounterId);
    expect(state.noteSaved).toBe(true);
    expect(state.noteVersion).toBe(saved.meta?.versionId);
    expect(state.checks.map((c) => [c.choice, c.noteVersion])).toEqual([
      ['agreement', '2'],
      ['potential_conflict', '1'],
    ]);
    expect(state.signed).toBe(true);
  });
});

describe('GuidedDemoProvider', () => {
  test('has no chart hook until a scenario starts', async () => {
    setup();
    await act(async () => undefined);
    expect(controller?.scenario).toBeUndefined();
    expect(chartHook).toBeUndefined();
  });

  test('start seeds a patient, stores opaque ids only and opens the chart', async () => {
    setup();
    await act(async () => controller?.start());
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    expect(Object.keys(stored).sort()).toEqual([
      'acknowledged',
      'encounterId',
      'patientId',
      'tutorial',
    ]);
    expect(stored.tutorial).toBe('active');
    expect(JSON.stringify(stored)).not.toMatch(/Lisinopril|lisinopril|Demo/);
    expect(screen.getByTestId('path')).toHaveTextContent(`/Patient/${stored.patientId}`);
    expect(chartHook).toBeDefined();
    await waitFor(() => expect(controller?.serverState).toBeDefined());
    expect(controller?.currentStep).toBe(0);
  });

  test('reaching a step route acknowledges it', async () => {
    setup();
    await act(async () => controller?.start());
    await userEvent.click(screen.getByText('docs'));
    await waitFor(() => expect(controller?.scenario?.acknowledged).toContain('open-documents'));
  });

  test('restores the scenario after a reload and ends without deleting anything', async () => {
    setup();
    await act(async () => controller?.start());
    const ids = controller?.scenario;
    act(() => controller?.setTutorial('dismissed'));
    cleanup();

    // A fresh provider reads the same scenario back.
    setup();
    await waitFor(() => expect(controller?.scenario?.encounterId).toBe(ids?.encounterId));
    expect(controller?.scenario?.tutorial).toBe('dismissed');

    const remove = vi.spyOn(medplum, 'deleteResource');
    act(() => controller?.end());
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(remove).not.toHaveBeenCalled();
    expect(await medplum.readResource('Patient', ids?.patientId ?? '')).toBeDefined();
  });

  test('ignores unreadable stored state', async () => {
    localStorage.setItem(STORAGE_KEY, '{not json');
    setup();
    await act(async () => undefined);
    expect(controller?.scenario).toBeUndefined();
  });
});
