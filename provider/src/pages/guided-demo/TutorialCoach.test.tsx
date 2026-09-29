import { MantineProvider } from '@mantine/core';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { GuidedDemoController, TutorialMode } from './GuidedDemoContext';
import { COMPLETE, STEPS } from './tour/steps';
import { TutorialCoach } from './TutorialCoach';

let controller: GuidedDemoController | undefined;
vi.mock('./GuidedDemoContext', () => ({ useGuidedDemoController: () => controller }));

function makeController(step: string | number, tutorial: TutorialMode = 'active'): GuidedDemoController {
  return {
    scenario: { patientId: 'p1', encounterId: 'e1', tutorial, acknowledged: [] },
    serverState: { encounterStatus: 'finished', noteSaved: true, checks: [], signed: false },
    currentStep: typeof step === 'number' ? step : STEPS.findIndex((s) => s.id === step),
    starting: false,
    start: vi.fn(async () => undefined),
    end: vi.fn(),
    acknowledge: vi.fn(),
    setTutorial: vi.fn(),
    refresh: vi.fn(),
  };
}

function setup(): void {
  render(
    <MemoryRouter>
      <MantineProvider>
        <TutorialCoach />
      </MantineProvider>
    </MemoryRouter>
  );
}

beforeEach(() => {
  controller = undefined;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('TutorialCoach', () => {
  test('renders nothing outside a scenario', () => {
    setup();
    expect(screen.queryByRole('region', { name: 'Guided demo' })).not.toBeInTheDocument();
  });

  test('names the step and hides the tutorial', async () => {
    controller = makeController('finish-visit');
    setup();
    expect(screen.getByRole('region', { name: 'Guided demo' })).toHaveTextContent(
      `Step 8 of ${STEPS.length}: Finish the visit`
    );
    await userEvent.click(screen.getByRole('button', { name: 'Hide tutorial' }));
    expect(controller.setTutorial).toHaveBeenCalledWith('dismissed');
  });

  test('collapses to Resume when hidden and ends the scenario locally', async () => {
    controller = makeController('sign', 'dismissed');
    setup();
    expect(screen.getByText(/Tutorial hidden/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(controller.setTutorial).toHaveBeenCalledWith('active');
    await userEvent.click(screen.getByRole('button', { name: 'End scenario' }));
    expect(controller.end).toHaveBeenCalled();
  });

  test('shows the waiting text while the check runs', () => {
    controller = makeController('review-card');
    setup();
    expect(screen.getByTestId('coach-detail')).toHaveTextContent('Checking the note');
  });

  test('shows the instruction as text when the anchor never appears', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    controller = makeController('sign');
    setup();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5001);
    });
    expect(screen.getByTestId('coach-detail')).toHaveTextContent('Sign and lock the note.');
  });

  test('offers a replay with a new patient when complete', async () => {
    controller = makeController(COMPLETE, 'complete');
    setup();
    expect(screen.getByText('Tutorial complete')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Replay with a new patient' }));
    expect(controller.start).toHaveBeenCalled();
  });
});
