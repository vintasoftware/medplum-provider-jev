import { Alert, Badge, Button, Card, Group, List, Stack, Text, ThemeIcon, Title } from '@mantine/core';
import { MedplumLink } from '@medplum/react';
import { IconCheck, IconPlayerPlay, IconPoint } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useState } from 'react';
import { useGuidedDemoController } from './GuidedDemoContext';
import { STEPS } from './tour/steps';

export function GuidedDemoPage(): JSX.Element {
  const demo = useGuidedDemoController();
  const [error, setError] = useState<string>();

  const start = (): void => {
    setError(undefined);
    demo
      ?.start()
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'The scenario could not be created'));
  };

  const scenario = demo?.scenario;

  return (
    <Stack p="xl" maw={900} mx="auto" gap="lg">
      <Group justify="space-between">
        <Title order={1}>Guided demo: post-discharge follow-up</Title>
        <Badge color="teal" variant="light">
          Synthetic data only
        </Badge>
      </Group>
      <Text>
        You play a primary care provider seeing a patient one week after a hospital stay. The hospital raised a blood
        pressure medication dose; the chart still lists the old dose. Document the visit, finish it and sign the note.
        When the visit is finished, a consistency check compares your note with the outside discharge summary and shows
        what it found.
      </Text>
      <Text size="sm" c="dimmed">
        Tips appear next to the control to use next; press Esc, click outside or choose Skip tutorial to hide them at
        any time. Everything keeps working without them, and the step list below follows your progress either way.
      </Text>

      {error && (
        <Alert color="orange" title="Scenario not started" role="alert">
          {error}
        </Alert>
      )}

      {!scenario ? (
        <Group>
          <Button leftSection={<IconPlayerPlay size={16} />} onClick={start} loading={demo?.starting}>
            Start scenario
          </Button>
        </Group>
      ) : (
        <Card withBorder>
          <Stack gap="md">
            <Group justify="space-between">
              <Text fw={600}>Current scenario</Text>
              <Group gap="xs">
                <Button component={MedplumLink} to={`/Patient/${scenario.patientId}`} variant="light" size="xs">
                  Open patient chart
                </Button>
                <Button
                  component={MedplumLink}
                  to={`/Patient/${scenario.patientId}/Encounter/${scenario.encounterId}`}
                  variant="light"
                  size="xs"
                >
                  Open today's visit
                </Button>
              </Group>
            </Group>
            <List spacing={6} size="sm" center>
              {STEPS.map((step, i) => {
                const done = i < (demo?.currentStep ?? 0);
                const isCurrent = i === demo?.currentStep;
                let color = 'gray';
                if (done) {
                  color = 'teal';
                } else if (isCurrent) {
                  color = 'blue';
                }
                return (
                  <List.Item
                    key={step.id}
                    icon={
                      <ThemeIcon size={20} radius="xl" color={color} variant="light">
                        {done ? <IconCheck size={12} /> : <IconPoint size={12} />}
                      </ThemeIcon>
                    }
                  >
                    <Text size="sm" fw={isCurrent ? 600 : 400} c={done ? 'dimmed' : undefined}>
                      {step.title}
                    </Text>
                  </List.Item>
                );
              })}
            </List>
            <Group gap="xs">
              {scenario.tutorial === 'active' ? (
                <Button variant="default" size="xs" onClick={() => demo?.setTutorial('dismissed')}>
                  Hide tutorial
                </Button>
              ) : (
                <Button variant="default" size="xs" onClick={() => demo?.setTutorial('active')}>
                  Resume tutorial
                </Button>
              )}
              <Button variant="default" size="xs" onClick={start} loading={demo?.starting}>
                Start a new scenario
              </Button>
              <Button variant="subtle" color="gray" size="xs" onClick={() => demo?.end()}>
                End scenario
              </Button>
            </Group>
            <Text size="xs" c="dimmed">
              End scenario forgets this run in your browser only. The synthetic records stay in the project; nothing is
              deleted.
            </Text>
          </Stack>
        </Card>
      )}
    </Stack>
  );
}
