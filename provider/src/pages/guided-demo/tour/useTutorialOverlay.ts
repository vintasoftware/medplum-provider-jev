import type { Driver, DriveStep } from 'driver.js';
import { driver } from 'driver.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import type { GuidedDemoController } from '../GuidedDemoContext';
import type { TourStep } from './steps';
import { COMPLETE, STEPS } from './steps';

// One Driver.js instance shows the current step as a single highlight. Rules that keep the
// app usable with the overlay:
// - A user exit (Esc, backdrop click, the popover's Skip button) hides the tutorial at once,
//   with no confirmation. Driver.js reports those through onDestroyStarted; our own
//   destroy() calls never do.
// - A highlight is never kept while the tester operates a Mantine Menu or Modal: those are
//   portaled outside the highlighted element, and driver.css disables pointer events there.
//   In `act` steps a capture-phase click on the element removes the highlight before the
//   app's own handler runs, and the step then finishes from server state.

export const ANCHOR_TIMEOUT_MS = 5000;

export interface TutorialOverlay {
  /** Re-highlight the current step, resuming the tutorial if it was hidden. */
  showMe: () => void;
  /** The current step's element did not appear; the coach bar shows the instruction instead. */
  missingAnchor: boolean;
  /** The current step waits for server state (for example the check to finish). */
  waiting: boolean;
}

export function waitForElement(
  selector: string,
  timeoutMs: number
): { promise: Promise<Element | null>; cancel: () => void } {
  let observer: MutationObserver | undefined;
  let timer: number | undefined;
  let settle: (value: Element | null) => void = () => undefined;
  const promise = new Promise<Element | null>((resolve) => {
    settle = resolve;
    const found = document.querySelector(selector);
    if (found) {
      resolve(found);
      return;
    }
    observer = new MutationObserver(() => {
      const element = document.querySelector(selector);
      if (element) {
        cleanup();
        resolve(element);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    timer = window.setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);
  });
  function cleanup(): void {
    observer?.disconnect();
    window.clearTimeout(timer);
  }
  return {
    promise,
    cancel: () => {
      cleanup();
      settle(null);
    },
  };
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function buttonsFor(step: TourStep): NonNullable<NonNullable<DriveStep['popover']>['showButtons']> {
  return step.mode === 'act' ? ['close'] : ['next', 'close'];
}

export function useTutorialOverlay(demo: GuidedDemoController | undefined): TutorialOverlay {
  const location = useLocation();
  const driverRef = useRef<Driver | undefined>(undefined);
  const demoRef = useRef(demo);
  demoRef.current = demo;
  // An `act` step whose element was clicked stays quiet until the step changes or Show me.
  const actedStepRef = useRef<string | undefined>(undefined);
  const [nonce, setNonce] = useState(0);
  const [missingAnchor, setMissingAnchor] = useState(false);
  const nextButtonRef = useRef<HTMLButtonElement | undefined>(undefined);

  const scenario = demo?.scenario;
  const tutorial = scenario?.tutorial;
  const state = demo?.serverState;
  const currentStep = demo?.currentStep ?? 0;
  const step: TourStep | undefined = scenario && state && currentStep < COMPLETE ? STEPS[currentStep] : undefined;
  const ready = !step?.ready || (state ? step.ready(state) : false);
  const waiting = !!step && step.mode === 'point' && !ready;
  const readyRef = useRef(ready);
  readyRef.current = ready;

  const getDriver = useCallback((): Driver => {
    driverRef.current ??= driver({
      allowClose: true,
      allowKeyboardControl: true,
      overlayClickBehavior: 'close',
      smoothScroll: true,
      stagePadding: 8,
      popoverClass: 'jev-tour-popover',
      nextBtnText: 'Next',
      doneBtnText: 'Done',
      onDestroyStarted: () => {
        // Only user exits reach this hook. Hide the tutorial, then finish the destroy.
        demoRef.current?.setTutorial('dismissed');
        driverRef.current?.destroy();
      },
    });
    return driverRef.current;
  }, []);

  // Unmount: remove any overlay.
  useEffect(() => () => driverRef.current?.destroy(), []);

  useEffect(() => {
    actedStepRef.current = undefined;
  }, [step?.id]);

  const stepId = step?.id;
  // Readiness re-highlights only `point` steps. A `type` step toggles Next in place so the
  // tester keeps focus in the note while it saves.
  const stepReady = step?.mode === 'point' ? ready : true;
  const ids = scenario ? { patientId: scenario.patientId, encounterId: scenario.encounterId } : undefined;
  const patientId = ids?.patientId;
  const encounterId = ids?.encounterId;

  useEffect(() => {
    const instance = getDriver();
    instance.destroy();
    setMissingAnchor(false);
    const current = STEPS.find((s) => s.id === stepId);
    if (tutorial !== 'active' || !current || !patientId || !encounterId) {
      return undefined;
    }
    if ((current.mode === 'point' && !stepReady) || actedStepRef.current === current.id) {
      return undefined;
    }

    const index = STEPS.indexOf(current);
    const isLast = current.id === 'done';
    const popover: NonNullable<DriveStep['popover']> = {
      title: escapeHtml(current.title),
      description: escapeHtml(current.description),
      showButtons: buttonsFor(current),
      disableButtons: current.mode === 'type' && !readyRef.current ? ['next'] : [],
      nextBtnText: isLast ? 'Done' : 'Next',
      onNextClick: () => {
        demoRef.current?.acknowledge(current.id);
        if (isLast) {
          demoRef.current?.setTutorial('complete');
        }
        instance.destroy();
      },
      onPopoverRender: (dom) => {
        nextButtonRef.current = dom.nextButton;
        dom.closeButton.setAttribute('aria-label', 'Skip tutorial');
        dom.closeButton.setAttribute('title', 'Skip tutorial');
        const progress = document.createElement('span');
        progress.className = 'jev-tour-progress';
        progress.textContent = `Step ${index + 1} of ${STEPS.length}`;
        dom.title.prepend(progress);
      },
    };

    if (!current.anchor) {
      instance.highlight({ popover });
      return () => instance.destroy();
    }

    let cancelled = false;
    const cleanups: (() => void)[] = [];
    const wait = waitForElement(current.anchor({ patientId, encounterId }), ANCHOR_TIMEOUT_MS);
    cleanups.push(wait.cancel);
    wait.promise
      .then((element) => {
        if (cancelled) {
          return;
        }
        if (!element) {
          setMissingAnchor(true);
          return;
        }
        instance.highlight({
          element,
          disableActiveInteraction: current.mode === 'point' && !current.interactive,
          popover,
        });
        if (current.mode === 'act') {
          const onClick = (): void => {
            actedStepRef.current = current.id;
            instance.destroy();
          };
          element.addEventListener('click', onClick, { capture: true, once: true });
          cleanups.push(() => element.removeEventListener('click', onClick, { capture: true }));
        }
        if (current.mode === 'type') {
          // The autosized textarea changes height as the tester types.
          const onInput = (): void => instance.refresh();
          element.addEventListener('input', onInput);
          cleanups.push(() => element.removeEventListener('input', onInput));
        }
      })
      .catch(() => setMissingAnchor(true));
    return () => {
      cancelled = true;
      cleanups.forEach((fn) => fn());
      instance.destroy();
    };
  }, [getDriver, stepId, stepReady, tutorial, patientId, encounterId, location.pathname, nonce]);

  useEffect(() => {
    const button = nextButtonRef.current;
    if (step?.mode === 'type' && button?.isConnected) {
      button.disabled = !ready;
      button.classList.toggle('driver-popover-btn-disabled', !ready);
    }
  }, [ready, step?.mode]);

  const showMe = useCallback(() => {
    actedStepRef.current = undefined;
    if (demoRef.current?.scenario?.tutorial !== 'active') {
      demoRef.current?.setTutorial('active');
    }
    setNonce((n) => n + 1);
  }, []);

  return { showMe, missingAnchor, waiting };
}
