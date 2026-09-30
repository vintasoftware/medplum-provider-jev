import type { MedplumClient, WithId } from '@medplum/core';
import type { DetectedIssue, Practitioner } from '@medplum/fhirtypes';
import { useMedplum, useMedplumProfile } from '@medplum/react';
import type { JSX, ReactNode } from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import {
  CHECK_CODE,
  CHECK_CODE_SYSTEM,
  headlineResult,
  implicatedNote,
  readStoredCheck,
} from '../../utils/consistency';
import { noteSearch } from '../../utils/consistency-review';
import { seedScenario } from './seedScenario';
import type { ScenarioState } from './tour/steps';
import { deriveCurrentStep, STEPS } from './tour/steps';

export const STORAGE_KEY = 'jev-guided-demo';

export type TutorialMode = 'active' | 'dismissed' | 'complete';

/** What survives a reload. Opaque ids and step ids only; never names or chart text. */
export interface StoredScenario {
  patientId: string;
  encounterId: string;
  tutorial: TutorialMode;
  acknowledged: string[];
}

export interface GuidedDemoController {
  scenario: StoredScenario | undefined;
  serverState: ScenarioState | undefined;
  /** Index into STEPS, or STEPS.length once the last step was acknowledged. */
  currentStep: number;
  starting: boolean;
  start: () => Promise<void>;
  /** Clears local state only; nothing on the server is deleted. */
  end: () => void;
  acknowledge: (stepId: string) => void;
  setTutorial: (mode: TutorialMode) => void;
  refresh: () => void;
}

export interface GuidedDemoValue {
  refresh: () => void;
}

const ControllerContext = createContext<GuidedDemoController | undefined>(undefined);

/**
 * The demo hook for chart components.
 * @returns The hook, or undefined outside a guided scenario so the chart works without the demo.
 */
export function useGuidedDemo(): GuidedDemoValue | undefined {
  const controller = useContext(ControllerContext);
  return controller?.scenario ? controller : undefined;
}

export function useGuidedDemoController(): GuidedDemoController | undefined {
  return useContext(ControllerContext);
}

function readStored(): StoredScenario | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (value && typeof value.patientId === 'string' && typeof value.encounterId === 'string') {
      return {
        patientId: value.patientId,
        encounterId: value.encounterId,
        tutorial: ['active', 'dismissed', 'complete'].includes(value.tutorial) ? value.tutorial : 'active',
        acknowledged: Array.isArray(value.acknowledged)
          ? value.acknowledged.filter((s: unknown) => typeof s === 'string')
          : [],
      };
    }
  } catch {
    // Storage can be blocked or hold something else; start without a scenario.
  }
  return undefined;
}

function writeStored(value: StoredScenario | undefined): void {
  try {
    if (value) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // The tutorial still works for this page load.
  }
}

export async function readScenarioState(medplum: MedplumClient, encounterId: string): Promise<ScenarioState> {
  const encounterRef = `Encounter/${encounterId}`;
  const encounter = await medplum.readResource('Encounter', encounterId, { cache: 'no-cache' });
  const [impression, issues, provenances] = await Promise.all([
    encounter.subject?.reference
      ? medplum.searchOne('ClinicalImpression', noteSearch(encounterRef, encounter.subject.reference), {
          cache: 'no-cache',
        })
      : undefined,
    medplum.searchResources(
      'DetectedIssue',
      { implicated: encounterRef, code: `${CHECK_CODE_SYSTEM}|${CHECK_CODE}`, _sort: '-identified', _count: '20' },
      { cache: 'no-cache' }
    ),
    medplum.searchResources('Provenance', { target: encounterRef, _count: '1' }, { cache: 'no-cache' }),
  ]);
  return {
    encounterStatus: encounter.status,
    noteSaved: Boolean(impression?.note?.[0]?.text?.trim()),
    noteVersion: impression?.meta?.versionId,
    checks: (issues as WithId<DetectedIssue>[]).flatMap((issue) => {
      const headline = headlineResult(readStoredCheck(issue)?.results ?? []);
      const note = implicatedNote(issue);
      return headline && note
        ? [
            {
              id: issue.id,
              choice: headline.choice,
              noteVersion: note.versionId,
              mitigated: (issue.mitigation?.length ?? 0) > 0,
            },
          ]
        : [];
    }),
    signed: provenances.length > 0,
  };
}

export function GuidedDemoProvider({ children }: { children: ReactNode }): JSX.Element {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const navigate = useNavigate();
  const location = useLocation();
  const [scenario, setScenarioState] = useState<StoredScenario | undefined>(readStored);
  const [serverState, setServerState] = useState<ScenarioState>();
  const [starting, setStarting] = useState(false);
  const refreshGeneration = useRef(0);

  const setScenario = useCallback((update: (prev: StoredScenario | undefined) => StoredScenario | undefined) => {
    setScenarioState((prev) => {
      const next = update(prev);
      writeStored(next);
      return next;
    });
  }, []);

  const encounterId = scenario?.encounterId;
  const refresh = useCallback(() => {
    if (!encounterId || !profile) {
      return;
    }
    const generation = ++refreshGeneration.current;
    readScenarioState(medplum, encounterId)
      .then((next) => {
        if (generation === refreshGeneration.current) {
          setServerState(next);
        }
      })
      .catch(() => {
        // A scenario from another project or a revoked session: keep the overlays quiet.
        if (generation === refreshGeneration.current) {
          setServerState(undefined);
        }
      });
  }, [encounterId, medplum, profile]);

  useEffect(() => {
    refresh();
  }, [refresh, location.pathname]);

  const acknowledge = useCallback(
    (stepId: string) => {
      setScenario((prev) =>
        prev && !prev.acknowledged.includes(stepId) ? { ...prev, acknowledged: [...prev.acknowledged, stepId] } : prev
      );
    },
    [setScenario]
  );

  // Reaching a step's route counts as doing it, even with the tutorial hidden.
  useEffect(() => {
    if (!scenario) {
      return;
    }
    for (const step of STEPS) {
      if (step.route?.(location.pathname, scenario) && !scenario.acknowledged.includes(step.id)) {
        acknowledge(step.id);
      }
    }
  }, [location.pathname, scenario, acknowledge]);

  const setTutorial = useCallback(
    (mode: TutorialMode) => setScenario((prev) => (prev ? { ...prev, tutorial: mode } : prev)),
    [setScenario]
  );

  const start = useCallback(async () => {
    if (profile?.resourceType !== 'Practitioner') {
      throw new Error('Sign in as a practitioner to start the scenario');
    }
    setStarting(true);
    try {
      const seeded = await seedScenario(medplum, profile as WithId<Practitioner>);
      setServerState(undefined);
      setScenario(() => ({
        patientId: seeded.patientId,
        encounterId: seeded.encounterId,
        tutorial: 'active',
        acknowledged: [],
      }));
      await navigate(`/Patient/${seeded.patientId}`);
    } finally {
      setStarting(false);
    }
  }, [medplum, navigate, profile, setScenario]);

  const end = useCallback(() => {
    setServerState(undefined);
    setScenario(() => undefined);
  }, [setScenario]);

  const currentStep = useMemo(
    () => (scenario && serverState ? deriveCurrentStep(serverState, scenario.acknowledged) : 0),
    [scenario, serverState]
  );

  const value = useMemo<GuidedDemoController>(
    () => ({ scenario, serverState, currentStep, starting, start, end, acknowledge, setTutorial, refresh }),
    [scenario, serverState, currentStep, starting, start, end, acknowledge, setTutorial, refresh]
  );

  return <ControllerContext.Provider value={value}>{children}</ControllerContext.Provider>;
}
