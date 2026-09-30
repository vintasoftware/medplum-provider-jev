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
import type { WithId } from '@medplum/core';
import { createReference, formatDateTime, getReferenceString } from '@medplum/core';
import type { DetectedIssue, Encounter, Patient, Practitioner, Reference, Task } from '@medplum/fhirtypes';
import { MedplumLink, useMedplum, useMedplumProfile } from '@medplum/react';
import { IconAlertTriangle, IconClipboardPlus, IconPencil, IconSignature } from '@tabler/icons-react';
import type { JSX, ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import contract from '../../data/model-contract.json';
import { useGuidedDemo } from '../../pages/guided-demo/GuidedDemoContext';
import { TOUR } from '../../pages/guided-demo/tour/anchors';
import type { ReviewLabel, StoredCheck } from '../../utils/consistency';
import {
  appendMitigation,
  attachmentText,
  buildDetectedIssue,
  findLatestCheck,
  headlineResult,
  implicatedDocument,
  implicatedNote,
  noteText,
  readCheckedVersion,
  readStoredCheck,
  RECONCILIATION_TASK_CREATED,
  REVIEW_LABEL_COLORS,
  REVIEW_LABELS,
  reviewEncounter,
  splitSentences,
} from '../../utils/consistency';
import { showErrorNotification } from '../../utils/notifications';

export interface ConsistencyReviewCardProps {
  readonly encounter: WithId<Encounter>;
  readonly patient: Reference<Patient>;
  /** The note's current text. The check is stale when it differs from the text that was checked. */
  readonly noteText: string;
  /** Raised by the chart to request a check. The value on mount never triggers one. */
  readonly requestSeq: number;
  /** Saves any pending note text before the Bot reads it; rejects when it could not be saved. */
  readonly beforeCheck: () => Promise<void>;
  readonly locked: boolean;
  readonly onEditNote: () => void;
  readonly onSignWithReason: () => void;
  readonly onIssueChange?: (issue: WithId<DetectedIssue> | undefined) => void;
  readonly onRunningChange?: (running: boolean) => void;
}

/** Passages as the check read them. A source is missing once `loaded` if its checked version cannot be read. */
interface Passages {
  loaded: boolean;
  outside?: { title: string; date?: string; text: string };
  note?: string;
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
  const {
    encounter,
    patient,
    noteText: currentNote,
    requestSeq,
    beforeCheck,
    locked,
    onEditNote,
    onSignWithReason,
  } = props;
  const { onIssueChange, onRunningChange } = props;
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const demo = useGuidedDemo();
  const [issue, setIssueState] = useState<WithId<DetectedIssue>>();
  const [passages, setPassages] = useState<Passages>({ loaded: false });
  const [running, setRunningState] = useState(false);
  const [error, setError] = useState<string>();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [creatingTask, setCreatingTask] = useState(false);
  const [task, setTask] = useState<WithId<Task>>();
  const handledSeq = useRef(requestSeq);
  const runningRef = useRef(false);

  const author = profile ? (createReference(profile) as Reference<Practitioner>) : undefined;

  const setIssue = useCallback(
    (value: WithId<DetectedIssue> | undefined) => {
      setIssueState(value);
      onIssueChange?.(value);
    },
    [onIssueChange]
  );

  const setRunning = useCallback(
    (value: boolean) => {
      runningRef.current = value;
      setRunningState(value);
      onRunningChange?.(value);
    },
    [onRunningChange]
  );

  // Load the newest stored check instead of re-running on mount or reload.
  useEffect(() => {
    let cancelled = false;
    findLatestCheck(medplum, encounter)
      .then((found) => {
        if (!cancelled && found) {
          setIssue(found);
        }
      })
      .catch(showErrorNotification);
    return () => {
      cancelled = true;
    };
  }, [medplum, encounter.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // An open reconciliation task for this check hides the task action.
  useEffect(() => {
    if (!issue) {
      setTask(undefined);
      return;
    }
    medplum
      .searchOne('Task', { focus: getReferenceString(issue) }, { cache: 'no-cache' })
      .then(setTask)
      .catch(showErrorNotification);
  }, [medplum, issue]);

  // Re-read the passages from the exact versions the check used. A check's sources never change,
  // so a mitigation (a new issue object with the same id) does not reload them.
  useEffect(() => {
    setPassages({ loaded: false });
    if (!issue) {
      return undefined;
    }
    let cancelled = false;
    const load = async (): Promise<Passages> => {
      const docSource = implicatedDocument(issue);
      const noteSource = implicatedNote(issue);
      const [doc, impression] = await Promise.all([
        docSource ? readCheckedVersion(medplum, 'DocumentReference', docSource) : undefined,
        noteSource ? readCheckedVersion(medplum, 'ClinicalImpression', noteSource) : undefined,
      ]);
      const outsideText = doc ? await attachmentText(medplum, doc).catch(() => undefined) : undefined;
      return {
        loaded: true,
        outside:
          doc && outsideText
            ? { title: doc.description ?? 'Discharge summary', date: doc.date, text: outsideText }
            : undefined,
        note: impression ? noteText(impression) : undefined,
      };
    };
    load()
      .then((loaded) => !cancelled && setPassages(loaded))
      .catch(showErrorNotification);
    return () => {
      cancelled = true;
    };
  }, [medplum, issue?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const runCheck = useCallback(async (): Promise<void> => {
    if (runningRef.current) {
      return;
    }
    setRunning(true);
    setError(undefined);
    try {
      try {
        await beforeCheck();
      } catch {
        // Never check an older server copy than the text on screen.
        setError('The note could not be saved, so it was not checked');
        return;
      }
      const review = await reviewEncounter(medplum, encounter.id);
      if (review.status !== 'ok') {
        setError(review.reason);
        return;
      }
      if (!author) {
        setError('No signed-in practitioner');
        return;
      }
      const created = await medplum.createResource(buildDetectedIssue(review, patient, encounter, author));
      setIssue(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The check could not be completed');
    } finally {
      setRunning(false);
      demo?.refresh();
    }
  }, [author, beforeCheck, demo, encounter, medplum, patient, setIssue, setRunning]);

  useEffect(() => {
    if (requestSeq !== handledSeq.current) {
      handledSeq.current = requestSeq;
      runCheck().catch(showErrorNotification);
    }
  }, [requestSeq, runCheck]);

  const stored: StoredCheck | undefined = issue ? readStoredCheck(issue) : undefined;
  const headline = stored ? headlineResult(stored.results) : undefined;

  const createTask = async (): Promise<void> => {
    if (!issue || !headline || !author) {
      return;
    }
    setCreatingTask(true);
    try {
      const created = await medplum.createResource<Task>({
        resourceType: 'Task',
        status: 'requested',
        intent: 'order',
        priority: 'routine',
        code: { text: `Reconcile ${headline.medication} dose with outside discharge summary` },
        for: patient,
        owner: author,
        requester: author,
        authoredOn: new Date().toISOString(),
        focus: createReference(issue),
        reasonReference: createReference(encounter),
        // No Task.encounter: Sign & Lock completes every Task found by Task?encounter=.
        note: [
          {
            text: `The consistency check found "${REVIEW_LABELS[headline.choice]}" between today's note and the outside discharge summary.`,
            authorReference: author,
            time: new Date().toISOString(),
          },
        ],
      });
      setTask(created);
      setIssue(await appendMitigation(medplum, issue, RECONCILIATION_TASK_CREATED, author, false));
    } catch (err) {
      showErrorNotification(err);
    } finally {
      setCreatingTask(false);
      demo?.refresh();
    }
  };

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
                  createTask().catch(showErrorNotification);
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
