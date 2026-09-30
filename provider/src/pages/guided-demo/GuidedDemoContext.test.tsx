import { MantineProvider } from '@mantine/core';
import type { WithId } from '@medplum/core';
import { createReference } from '@medplum/core';
import type { ClinicalImpression, Practitioner } from '@medplum/fhirtypes';
import { MockClient } from '@medplum/mock';
import { MedplumProvider } from '@medplum/react';
import type { RenderHookResult } from '@testing-library/react';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { JSX, ReactNode } from 'react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router';
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

interface Probe {
  controller: GuidedDemoController | undefined;
  chartHook: ReturnType<typeof useGuidedDemo>;
  pathname: string;
  navigate: ReturnType<typeof useNavigate>;
}

// Both demo hooks plus the router, as a chart component under the provider sees them.
function useProbe(): Probe {
  return {
    controller: useGuidedDemoController(),
    chartHook: useGuidedDemo(),
    pathname: useLocation().pathname,
    navigate: useNavigate(),
  };
}

function setup(): RenderHookResult<Probe, unknown> {
  const wrapper = ({ children }: { children: ReactNode }): JSX.Element => (
    <MemoryRouter initialEntries={['/guided-demo']}>
      <MedplumProvider medplum={medplum}>
        <MantineProvider>
          <GuidedDemoProvider>{children}</GuidedDemoProvider>
        </MantineProvider>
      </MedplumProvider>
    </MemoryRouter>
  );
  return renderHook(useProbe, { wrapper });
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
    const { result } = setup();
    await act(async () => undefined);
    expect(result.current.controller?.scenario).toBeUndefined();
    expect(result.current.chartHook).toBeUndefined();
  });

  test('start seeds a patient, stores opaque ids only and opens the chart', async () => {
    const { result } = setup();
    await act(async () => result.current.controller?.start());
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    expect(Object.keys(stored).sort()).toEqual(['acknowledged', 'encounterId', 'patientId', 'tutorial']);
    expect(stored.tutorial).toBe('active');
    expect(JSON.stringify(stored)).not.toMatch(/Lisinopril|lisinopril|Demo/);
    expect(result.current.pathname).toBe(`/Patient/${stored.patientId}`);
    expect(result.current.chartHook).toBeDefined();
    await waitFor(() => expect(result.current.controller?.serverState).toBeDefined());
    expect(result.current.controller?.currentStep).toBe(0);
  });

  test('reaching a step route acknowledges it', async () => {
    const { result } = setup();
    await act(async () => result.current.controller?.start());
    const patientId = result.current.controller?.scenario?.patientId;
    await act(async () => result.current.navigate(`/Patient/${patientId}/DocumentReference`));
    await waitFor(() => expect(result.current.controller?.scenario?.acknowledged).toContain('open-documents'));
  });

  test('restores the scenario after a reload and ends without deleting anything', async () => {
    const first = setup();
    await act(async () => first.result.current.controller?.start());
    const ids = first.result.current.controller?.scenario;
    act(() => first.result.current.controller?.setTutorial('dismissed'));
    first.unmount();

    // A fresh provider reads the same scenario back.
    const { result } = setup();
    await waitFor(() => expect(result.current.controller?.scenario?.encounterId).toBe(ids?.encounterId));
    expect(result.current.controller?.scenario?.tutorial).toBe('dismissed');

    const remove = vi.spyOn(medplum, 'deleteResource');
    act(() => result.current.controller?.end());
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(remove).not.toHaveBeenCalled();
    expect(await medplum.readResource('Patient', ids?.patientId ?? '')).toBeDefined();
  });

  test('ignores unreadable stored state', async () => {
    localStorage.setItem(STORAGE_KEY, '{not json');
    const { result } = setup();
    await act(async () => undefined);
    expect(result.current.controller?.scenario).toBeUndefined();
  });
});
