import { Button, Group, Paper, Text } from '@mantine/core';
import { IconRoute } from '@tabler/icons-react';
import type { JSX } from 'react';
import { showErrorNotification } from '../../utils/notifications';
import { useGuidedDemoController } from './GuidedDemoContext';
import { COMPLETE, STEPS } from './tour/steps';
import { useTutorialOverlay } from './tour/useTutorialOverlay';

/**
 * Compact one-line bar shown above every page while a guided scenario is active. It names the current
 * step, re-highlights it, and hides or resumes the overlays. Hiding changes only local
 * state: the chart, the automatic check, signing and tasks work the same either way.
 */
export function TutorialCoach(): JSX.Element | null {
  const demo = useGuidedDemoController();
  const overlay = useTutorialOverlay(demo);
  const scenario = demo?.scenario;
  if (!demo || !scenario) {
    return null;
  }

  const complete = scenario.tutorial === 'complete' || demo.currentStep >= COMPLETE;
  const step = STEPS[Math.min(demo.currentStep, STEPS.length - 1)];
  const progress = `Step ${Math.min(demo.currentStep + 1, STEPS.length)} of ${STEPS.length}`;
  const hidden = scenario.tutorial === 'dismissed';
  const loading = !demo.serverState;

  let detail: string | undefined;
  if (!hidden && !complete && !loading) {
    if (overlay.waiting) {
      detail = step.waiting;
    } else if (overlay.missingAnchor) {
      detail = step.description;
    }
  }

  return (
    <Paper role="region" aria-label="Guided demo" className="jev-coach" radius={0} px="md">
      <Group justify="space-between" wrap="nowrap" gap="sm">
        <Group gap="xs" wrap="nowrap" miw={0}>
          <IconRoute size={16} color="var(--mantine-color-blue-6)" />
          <Text size="sm" fw={600} style={{ whiteSpace: 'nowrap' }}>
            Guided demo
          </Text>
          <Text size="sm" c="dimmed" truncate>
            {complete
              ? 'Tutorial complete'
              : loading
                ? 'Loading scenario…'
                : `${hidden ? 'Tutorial hidden · ' : ''}${progress}: ${step.title}`}
          </Text>
          {detail && (
            <Text size="sm" truncate data-testid="coach-detail">
              · {detail}
            </Text>
          )}
        </Group>
        <Group gap={4} wrap="nowrap">
          {complete ? (
            <Button
              size="compact-sm"
              variant="light"
              onClick={() => demo.start().catch(showErrorNotification)}
              loading={demo.starting}
            >
              Replay with a new patient
            </Button>
          ) : hidden ? (
            <Button size="compact-sm" variant="light" onClick={overlay.showMe}>
              Resume
            </Button>
          ) : (
            <>
              <Button size="compact-sm" variant="light" onClick={overlay.showMe} disabled={loading}>
                Show me
              </Button>
              <Button size="compact-sm" variant="subtle" onClick={() => demo.setTutorial('dismissed')}>
                Hide tutorial
              </Button>
            </>
          )}
          <Button size="compact-sm" variant="subtle" color="gray" onClick={demo.end}>
            End scenario
          </Button>
        </Group>
      </Group>
    </Paper>
  );
}
