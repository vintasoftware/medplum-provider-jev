import type { RenderHookResult } from '@testing-library/react';
import { act, fireEvent, renderHook, screen, waitFor } from '@testing-library/react';
import type { JSX, ReactNode } from 'react';
import { useState } from 'react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { GuidedDemoController, TutorialMode } from '../GuidedDemoContext';
import type { ScenarioState } from './steps';
import { STEPS } from './steps';
import type { TutorialOverlay } from './useTutorialOverlay';
import { useTutorialOverlay } from './useTutorialOverlay';

const IDS = { patientId: 'p1', encounterId: 'e1' };
const EMPTY: ScenarioState = { encounterStatus: 'planned', noteSaved: false, checks: [], signed: false };
const stepIndex = (id: string): number => STEPS.findIndex((s) => s.id === id);

const onStatusClick = vi.fn();

function Chart(): JSX.Element {
  const navigate = useNavigate();
  return (
    <div>
      <div data-tour="patient-summary">Active medications: lisinopril 10 MG Oral Tablet</div>
      <div data-tour="document-detail">Discharge summary text</div>
      <button data-tour="visit-status" onClick={() => onStatusClick(document.body.classList.contains('driver-active'))}>
        Planned
      </button>
      <button onClick={() => navigate('/visit')}>go to visit</button>
    </div>
  );
}

function Visit(): JSX.Element {
  const [show, setShow] = useState(false);
  return (
    <div>
      <button onClick={() => setShow(true)}>load chart</button>
      {show && <div data-tour="chart-note">Fill chart note</div>}
    </div>
  );
}

interface HarnessProps {
  step: string;
  tutorial?: TutorialMode;
  state?: ScenarioState;
}

interface Harness {
  overlay: TutorialOverlay;
  tutorial: TutorialMode;
  acknowledged: string[];
}

// The overlay on a fixed step, with the controller state the overlay may change.
function useHarness(props: HarnessProps): Harness {
  const [tutorial, setTutorial] = useState<TutorialMode>(props.tutorial ?? 'active');
  const [acknowledged, setAcknowledged] = useState<string[]>([]);
  const controller: GuidedDemoController = {
    scenario: { ...IDS, tutorial, acknowledged },
    serverState: props.state ?? EMPTY,
    currentStep: stepIndex(props.step),
    starting: false,
    start: vi.fn(),
    end: vi.fn(),
    acknowledge: (id) => setAcknowledged((a) => [...a, id]),
    setTutorial,
    refresh: vi.fn(),
  };
  return { overlay: useTutorialOverlay(controller), tutorial, acknowledged };
}

function setup(props: HarnessProps): RenderHookResult<Harness, unknown> {
  const wrapper = ({ children }: { children: ReactNode }): JSX.Element => (
    <MemoryRouter initialEntries={['/']}>
      {children}
      <Routes>
        <Route path="/visit" element={<Visit />} />
        <Route path="*" element={<Chart />} />
      </Routes>
    </MemoryRouter>
  );
  return renderHook(() => useHarness(props), { wrapper });
}

const popover = (): HTMLElement | null => document.querySelector('.driver-popover');
const highlighted = (): boolean => document.body.classList.contains('driver-active');

afterEach(() => {
  onStatusClick.mockClear();
  vi.useRealTimers();
});

describe('useTutorialOverlay', () => {
  test('shows the current step next to its anchor with progress and a Skip button', async () => {
    setup({ step: 'medications' });
    await waitFor(() => expect(popover()).not.toBeNull());
    expect(popover()).toHaveTextContent('The chart lists lisinopril 10 mg');
    expect(popover()).toHaveTextContent(`Step 2 of ${STEPS.length}`);
    expect(document.querySelector('[data-tour="patient-summary"]')).toHaveClass('driver-active-element');
    expect(screen.getByRole('button', { name: 'Skip tutorial' })).toBeInTheDocument();
  });

  test.each([
    ['Escape', () => fireEvent.keyUp(window, { key: 'Escape' })],
    ['backdrop click', () => fireEvent.click(document.querySelector('.driver-overlay path') as Element)],
    ['Skip button', () => fireEvent.click(screen.getByRole('button', { name: 'Skip tutorial' }))],
  ])('%s hides the tutorial at once', async (_name, exit) => {
    const { result } = setup({ step: 'medications' });
    await waitFor(() => expect(highlighted()).toBe(true));
    act(() => {
      exit();
    });
    expect(highlighted()).toBe(false);
    expect(popover()).toBeNull();
    expect(result.current.tutorial).toBe('dismissed');

    // Resume re-highlights the same step.
    act(() => result.current.overlay.showMe());
    await waitFor(() => expect(highlighted()).toBe(true));
    expect(result.current.tutorial).toBe('active');
    expect(popover()).toHaveTextContent('The chart lists lisinopril 10 mg');
  });

  test('a reading step keeps its content usable', async () => {
    const reading = setup({ step: 'medications' });
    await waitFor(() => expect(highlighted()).toBe(true));
    expect(document.querySelector('[data-tour="patient-summary"]')).toHaveClass('driver-no-interaction');
    reading.unmount();
    setup({ step: 'read-summary' });
    await waitFor(() => expect(popover()).toHaveTextContent('The discharge summary'));
    const panel = document.querySelector('[data-tour="document-detail"]');
    expect(panel).toHaveClass('driver-active-element');
    expect(panel).not.toHaveClass('driver-no-interaction');
  });

  test('Next acknowledges an informational step', async () => {
    const { result } = setup({ step: 'welcome' });
    await waitFor(() => expect(popover()).toHaveTextContent('Post-discharge follow-up'));
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    });
    expect(result.current.acknowledged).toEqual(['welcome']);
  });

  test('an act step removes the highlight before the control handles the click', async () => {
    const { result } = setup({ step: 'start-visit' });
    await waitFor(() => expect(popover()).toHaveTextContent('Set the visit to In Progress'));
    // Act steps offer Skip but no Next: the step finishes from server state.
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Planned' }));
    expect(onStatusClick).toHaveBeenCalledWith(false);
    expect(highlighted()).toBe(false);
    expect(result.current.tutorial).toBe('active');
  });

  test('a route change re-highlights once the new anchor mounts', async () => {
    setup({ step: 'write-note', state: { ...EMPTY, encounterStatus: 'in-progress' } });
    fireEvent.click(screen.getByRole('button', { name: 'go to visit' }));
    expect(highlighted()).toBe(false);
    fireEvent.click(await screen.findByRole('button', { name: 'load chart' }));
    await waitFor(() => expect(popover()).toHaveTextContent('Write the visit note'));
    // Next waits for the note to save.
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  test('a missing anchor falls back to text', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { result } = setup({ step: 'handle', state: { ...EMPTY, encounterStatus: 'finished', noteSaved: true } });
    expect(result.current.overlay.missingAnchor).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5001);
    });
    expect(result.current.overlay.missingAnchor).toBe(true);
    expect(highlighted()).toBe(false);
  });

  test('stays hidden while dismissed', async () => {
    setup({ step: 'medications', tutorial: 'dismissed' });
    await act(async () => undefined);
    expect(highlighted()).toBe(false);
  });

  test('waits on server state before highlighting a reading step', () => {
    const { result } = setup({
      step: 'review-card',
      state: { ...EMPTY, encounterStatus: 'finished', noteSaved: true },
    });
    expect(result.current.overlay.waiting).toBe(true);
    expect(highlighted()).toBe(false);
  });
});
