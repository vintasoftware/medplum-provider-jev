import {
  Alert,
  Badge,
  Box,
  Button,
  Card,
  Collapse,
  Group,
  Loader,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import { formatDateTime } from '@medplum/core';
import { MedplumLink } from '@medplum/react';
import { IconAlertTriangle, IconClipboardPlus, IconPencil, IconSignature } from '@tabler/icons-react';
import type { JSX, ReactNode } from 'react';
import { useState } from 'react';
import contract from '../../data/model-contract.json';
import type { ConsistencyCheck } from '../../hooks/useConsistencyCheck';
import { TOUR } from '../../pages/guided-demo/tour/anchors';
import {
  headlineResult,
  readStoredCheck,
  RECONCILIATION_TASK_CREATED,
  REVIEW_LABEL_COLORS,
  REVIEW_LABELS,
} from '../../utils/consistency';
import type { ReviewLabel } from '../../utils/consistency-review';
import { splitSentences } from '../../utils/consistency-review';
import { showErrorNotification } from '../../utils/notifications';

export interface ConsistencyReviewCardProps {
  readonly check: ConsistencyCheck;
  /** The note's current text. The check is stale when it differs from the text that was checked. */
  readonly noteText: string;
  readonly locked: boolean;
  readonly onEditNote: () => void;
  readonly onSignWithReason: () => void;
}

const PASSAGE_UNAVAILABLE = 'The version that was checked could not be loaded.';

function formatDay(date: string | undefined): string {
  if (!date) {
    return '';
  }
  return new Date(`${date.slice(0, 10)}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function highlight(text: string, index: number | undefined): ReactNode {
  const sentence = index === undefined ? undefined : splitSentences(text)[index];
  const start = sentence ? text.indexOf(sentence) : -1;
  if (!sentence || start < 0) {
    return text;
  }
  return (
    <>
      {text.slice(0, start)}
      <mark>{sentence}</mark>
      {text.slice(start + sentence.length)}
    </>
  );
}

function passageFallback(loaded: boolean): ReactNode {
  return loaded ? (
    <Text span c="dimmed" fs="italic" inherit>
      {PASSAGE_UNAVAILABLE}
    </Text>
  ) : (
    '…'
  );
}

function summary(choice: ReviewLabel, medication: string, outsideDate: string, mentionsHospital: boolean): string {
  const summaryDate = outsideDate ? ` (${outsideDate})` : '';
  if (choice === 'potential_conflict') {
    return (
      `Today's note and the discharge summary${summaryDate} disagree about ${medication}.` +
      (mentionsHospital ? '' : " Today's note does not mention the hospital stay.")
    );
  }
  if (choice === 'insufficient_information') {
    return `One of the documents does not state a dose for ${medication}. The dose is missing, not necessarily wrong.`;
  }
  return `Today's note and the discharge summary${summaryDate} agree about ${medication}. No action is needed before signing.`;
}

export function ConsistencyReviewCard(props: ConsistencyReviewCardProps): JSX.Element | null {
  const { check, noteText: currentNote, locked, onEditNote, onSignWithReason } = props;
  const { issue, passages, task, running, error, creatingTask } = check;
  const [detailsOpen, setDetailsOpen] = useState(false);
  const stored = issue ? readStoredCheck(issue) : undefined;
  const headline = stored ? headlineResult(stored.results) : undefined;

  if (running) {
    return (
      <Card withBorder shadow="sm" data-tour={TOUR.reviewCard}>
        <Group gap="sm">
          <Loader size="sm" />
          <Text>Checking the note against the outside discharge summary…</Text>
        </Group>
      </Card>
    );
  }

  if (error) {
    return (
      <Alert color="orange" title="Check unavailable" role="alert" icon={<IconAlertTriangle size={18} />}>
        {error}. No replacement prediction is shown. Run Check note again when the issue is resolved.
      </Alert>
    );
  }

  if (!issue || !stored || !headline) {
    return null;
  }

  const outsideDate = formatDay(passages.outside?.date);
  // Compare text, not versions: Sign & Lock saves a new note version with the same text.
  const stale = passages.note !== undefined && passages.note.trim() !== currentNote.trim();
  const needsAction = headline.choice !== 'agreement';
  const mitigations = issue.mitigation ?? [];

  return (
    <Card withBorder shadow="sm" data-tour={TOUR.reviewCard} aria-live="polite">
      <Stack gap="sm">
        <Group justify="space-between" align="flex-start">
          <Group gap="xs">
            <Title order={2} size="h4">
              Consistency check
            </Title>
            <Badge color={REVIEW_LABEL_COLORS[headline.choice]} variant="light">
              {REVIEW_LABELS[headline.choice]}
            </Badge>
            {stale && (
              <Badge color="gray" variant="outline">
                Note changed since this check
              </Badge>
            )}
          </Group>
          <Button variant="subtle" size="xs" onClick={() => setDetailsOpen((o) => !o)} aria-expanded={detailsOpen}>
            {detailsOpen ? 'Hide details' : 'Details'}
          </Button>
        </Group>

        <Text>{summary(headline.choice, headline.medication, outsideDate, stored.mentions_hospital_stay >= 0.5)}</Text>

        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <Box>
            <Text size="xs" c="dimmed" tt="uppercase">
              Outside document · {passages.outside?.title ?? 'Discharge summary'} {outsideDate && `· ${outsideDate}`}
            </Text>
            <Text size="sm" style={{ whiteSpace: 'pre-wrap' }} mt={4}>
              {passages.outside
                ? highlight(passages.outside.text, headline.sentence_outside_index)
                : passageFallback(passages.loaded)}
            </Text>
          </Box>
          <Box>
            <Text size="xs" c="dimmed" tt="uppercase">
              Today's visit note {stale && '· as checked'}
            </Text>
            <Text size="sm" style={{ whiteSpace: 'pre-wrap' }} mt={4}>
              {passages.note !== undefined
                ? highlight(passages.note, headline.sentence_note_index)
                : passageFallback(passages.loaded)}
            </Text>
          </Box>
        </SimpleGrid>

        <Collapse in={detailsOpen}>
          <Stack gap={4}>
            <Table withRowBorders={false} verticalSpacing={2}>
              <Table.Tbody>
                {stored.results.map((r) =>
                  contract.labels.map((label) => (
                    <Table.Tr key={`${r.medication}-${label}`}>
                      <Table.Td>{r.medication}</Table.Td>
                      <Table.Td>{REVIEW_LABELS[label as ReviewLabel]}</Table.Td>
                      <Table.Td>{(r.probabilities[label as ReviewLabel] * 100).toFixed(1)}%</Table.Td>
                    </Table.Tr>
                  ))
                )}
              </Table.Tbody>
            </Table>
            <Text size="xs" c="dimmed">
              Confidence {headline.confidence.toFixed(2)} · model {stored.model} · {stored.input_tokens} input tokens ·
              checked {formatDateTime(stored.checked_at)}. Scores are model probabilities, not validated clinical
              confidence.
            </Text>
            {headline.label_rule === 'no_dose_sentence' && (
              <Text size="xs" c="dimmed">
                Label set by rule: the model labeled the documents as agreeing but found no sentence stating a{' '}
                {headline.medication} dose in one of them, so the check reports insufficient information. The scores and
                confidence above are the model's own.
              </Text>
            )}
          </Stack>
        </Collapse>

        {mitigations.length > 0 && (
          <Stack gap={2}>
            {mitigations.map((m, i) => (
              <Text key={i} size="sm" c="dimmed">
                {m.action.text} · {formatDateTime(m.date)}
                {m.action.text === RECONCILIATION_TASK_CREATED && task && (
                  <>
                    {' · '}
                    <MedplumLink to={`/Task/${task.id}`}>Open task</MedplumLink>
                  </>
                )}
              </Text>
            ))}
          </Stack>
        )}

        {needsAction && !locked && (
          <Group gap="xs" data-tour={TOUR.reviewActions}>
            <Button variant="light" leftSection={<IconPencil size={16} />} onClick={onEditNote}>
              Edit note
            </Button>
            <Button variant="light" leftSection={<IconSignature size={16} />} onClick={onSignWithReason}>
              Sign with a documented reason
            </Button>
            {!task && (
              <Button
                variant="light"
                leftSection={<IconClipboardPlus size={16} />}
                onClick={() => {
                  check.createTask().catch(showErrorNotification);
                }}
                loading={creatingTask}
              >
                Create reconciliation task
              </Button>
            )}
          </Group>
        )}

        <Text size="xs" c="dimmed">
          Advisory only. The check compares two documents and changes nothing in the chart; the provider decides.
        </Text>
      </Stack>
    </Card>
  );
}
