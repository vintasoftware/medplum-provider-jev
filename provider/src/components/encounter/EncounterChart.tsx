// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Box, Button, Card, Group, Stack, Textarea, Title } from '@mantine/core';
import { useDebouncedCallback } from '@mantine/hooks';
import type { WithId } from '@medplum/core';
import { createReference, getReferenceString } from '@medplum/core';
import type { DetectedIssue, Encounter, Patient, Practitioner, Provenance, Reference, Task } from '@medplum/fhirtypes';
import { Loading, useMedplum } from '@medplum/react';
import { IconStethoscope } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { COMPLETE_LIST_COUNT, SAVE_TIMEOUT_MS } from '../../config/constants';
import { useEncounterChart } from '../../hooks/useEncounterChart';
import { useGuidedDemo } from '../../pages/guided-demo/GuidedDemoContext';
import { TOUR } from '../../pages/guided-demo/tour/anchors';
import { ChartNoteStatus } from '../../types/encounter';
import { appendMitigation, SIGNED_WITH_REASON } from '../../utils/consistency';
import { buildSignatureProvenance, updateEncounterStatus } from '../../utils/encounter';
import { showErrorNotification } from '../../utils/notifications';
import { TaskDetailsModal } from '../tasks/TaskDetailsModal';
import { TaskPanel } from '../tasks/encounter/TaskPanel';
import { BillingTab } from './BillingTab';
import { ConsistencyReviewCard } from './ConsistencyReviewCard';
import { EncounterHeader } from './EncounterHeader';
import { SignAddendum } from './SignAddendum';

const TASK_COMPLETED_STATUSES = new Set<Task['status']>([
  'completed',
  'cancelled',
  'failed',
  'rejected',
  'entered-in-error',
]);

export interface EncounterChartProps {
  encounter: WithId<Encounter> | Reference<Encounter>;
  task?: WithId<Task> | Reference<Task>;
  onEncounterChange?: (encounter: WithId<Encounter>) => void;
}

export const EncounterChart = (props: EncounterChartProps): JSX.Element => {
  const { encounter: encounterProp, task: taskProp, onEncounterChange } = props;
  const medplum = useMedplum();
  const demo = useGuidedDemo();

  const [activeTab, setActiveTab] = useState('notes');
  const {
    encounter,
    patient: patientResource,
    practitioner,
    tasks,
    clinicalImpression,
    appointment,
    setEncounter,
    setPractitioner,
    setTasks,
    setClinicalImpression,
  } = useEncounterChart(encounterProp);

  const [chartNote, setChartNote] = useState(clinicalImpression?.note?.[0]?.text);
  const [provenances, setProvenances] = useState<Provenance[]>([]);
  const [chartNoteStatus, setChartNoteStatus] = useState(ChartNoteStatus.Unsigned);
  // Consistency review: a raised sequence number asks the card to run one check.
  const [reviewSeq, setReviewSeq] = useState(0);
  const [reviewRunning, setReviewRunning] = useState(false);
  const [reviewIssue, setReviewIssue] = useState<WithId<DetectedIssue>>();
  const [signReasonSeq, setSignReasonSeq] = useState(0);
  const noteInputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!encounter) {
      return;
    }

    const fetchProvenance = async (): Promise<void> => {
      const provenance = await medplum.searchResources('Provenance', {
        target: getReferenceString(encounter),
        _count: COMPLETE_LIST_COUNT,
      });
      setProvenances(provenance);
      if (provenance.length > 0 && clinicalImpression?.status === 'completed') {
        setChartNoteStatus(ChartNoteStatus.SignedAndLocked);
      } else if (provenance.length > 0) {
        setChartNoteStatus(ChartNoteStatus.Signed);
      } else {
        setChartNoteStatus(ChartNoteStatus.Unsigned);
      }
    };

    fetchProvenance().catch((err) => showErrorNotification(err));
  }, [clinicalImpression, encounter, medplum]);

  const updateTaskList = useCallback(
    (updatedTask: WithId<Task>): void => {
      setTasks((prevTasks) => prevTasks.map((task) => (task.id === updatedTask.id ? updatedTask : task)));
    },
    [setTasks]
  );

  const handleEncounterStatusChange = useCallback(
    async (newStatus: Encounter['status']): Promise<void> => {
      if (!encounter) {
        return;
      }

      try {
        const previousStatus = encounter.status;
        const updatedEncounter = await updateEncounterStatus(medplum, encounter, appointment, newStatus);
        setEncounter(updatedEncounter);
        onEncounterChange?.(updatedEncounter);
        // Check the note once when the visit becomes Finished. This runs only from the
        // user's status change, never on render or reload. The card saves the note first.
        if (newStatus === 'finished' && previousStatus !== 'finished' && clinicalImpression) {
          setReviewSeq((seq) => seq + 1);
        }
        demo?.refresh();
      } catch (err) {
        showErrorNotification(err);
      }
    },
    [encounter, medplum, setEncounter, onEncounterChange, appointment, clinicalImpression, demo]
  );

  const handleTabChange = (tab: string): void => {
    setActiveTab(tab);
  };

  // Whether the server copy currently has a note; `clinicalImpression` state is not refreshed on
  // note saves, so this decides between add and remove when the note is cleared.
  const noteOnServerRef = useRef<boolean | undefined>(undefined);

  // Latest typed text and whether it still needs saving, so a check can flush it first.
  const latestNoteRef = useRef<string | undefined>(undefined);
  const notePendingRef = useRef(false);
  const noteSaveRef = useRef<Promise<void>>(Promise.resolve());

  const saveChartNote = useCallback(
    (note: string): Promise<void> => {
      if (!clinicalImpression) {
        return Promise.resolve();
      }
      notePendingRef.current = false;
      const save = async (): Promise<void> => {
        try {
          let updated;
          if (note) {
            updated = await medplum.patchResource('ClinicalImpression', clinicalImpression.id, [
              { op: 'add', path: '/note', value: [{ text: note }] },
            ]);
            noteOnServerRef.current = true;
          } else if (noteOnServerRef.current ?? Boolean(clinicalImpression.note)) {
            updated = await medplum.patchResource('ClinicalImpression', clinicalImpression.id, [
              { op: 'remove', path: '/note' },
            ]);
            noteOnServerRef.current = false;
          }
          if (updated) {
            demo?.refresh();
          }
        } catch (err) {
          // Keep the latest text pending so the next flush saves it again.
          notePendingRef.current = true;
          throw err;
        }
      };
      // Chain saves so they reach the server in typing order. A failed save rejects its own
      // promise but does not block the saves queued after it.
      const queued = noteSaveRef.current.catch(() => undefined).then(save);
      noteSaveRef.current = queued;
      return queued;
    },
    [clinicalImpression, medplum, demo]
  );

  const debouncedPatchChartNote = useDebouncedCallback((note: string): void => {
    saveChartNote(note).catch(showErrorNotification);
  }, SAVE_TIMEOUT_MS);

  /**
   * Saves pending note text now instead of after the debounce, and waits for any save in flight.
   * Rejects when the text could not be saved, so a check or signature never uses an older note.
   */
  const flushChartNote = useCallback(async (): Promise<void> => {
    if (notePendingRef.current) {
      debouncedPatchChartNote.cancel();
      await saveChartNote(latestNoteRef.current ?? '');
    }
    await noteSaveRef.current;
  }, [debouncedPatchChartNote, saveChartNote]);

  const handleChartNoteChange = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    setChartNote(e.target.value);

    if (!clinicalImpression) {
      return;
    }

    latestNoteRef.current = e.target.value;
    notePendingRef.current = true;
    debouncedPatchChartNote(e.target.value);
  };

  const handleSign = async (practitioner: Reference<Practitioner>, lock: boolean, reason?: string): Promise<void> => {
    if (!encounter) {
      return;
    }

    try {
      await flushChartNote();
    } catch (err) {
      showErrorNotification(err);
      return;
    }

    if (lock) {
      // Complete all incomplete tasks
      const tasksToUpdate = tasks.filter((task) => !TASK_COMPLETED_STATUSES.has(task.status));
      const updatedTasks = await Promise.all(
        tasksToUpdate.map((task) =>
          medplum.patchResource('Task', task.id, [{ op: 'replace', path: '/status', value: 'completed' }])
        )
      );

      setTasks(
        tasks.map((task) => {
          const updated = updatedTasks.find((t) => t.id === task.id);
          return updated || task;
        })
      );

      // Mark clinical impression as completed
      if (clinicalImpression) {
        const updatedImpression = await medplum.patchResource('ClinicalImpression', clinicalImpression.id, [
          { op: 'replace', path: '/status', value: 'completed' },
        ]);
        setClinicalImpression(updatedImpression);
      }
    }

    // Create provenance record with signature
    const signedWithReason = reason?.trim() || undefined;
    const newProvenance = await medplum.createResource<Provenance>(
      buildSignatureProvenance(encounter, practitioner, new Date().toISOString(), {
        reason: signedWithReason,
        entity: signedWithReason && reviewIssue ? createReference(reviewIssue) : undefined,
      })
    );

    if (signedWithReason && reviewIssue) {
      setReviewIssue(await appendMitigation(medplum, reviewIssue, SIGNED_WITH_REASON, practitioner, true));
    }

    setProvenances([...provenances, newProvenance]);

    if (lock) {
      setChartNoteStatus(ChartNoteStatus.SignedAndLocked);
    } else {
      setChartNoteStatus(ChartNoteStatus.Signed);
    }
    demo?.refresh();
  };

  const handleCheckNote = (): void => {
    setReviewSeq((seq) => seq + 1);
  };

  const handleEditNote = (): void => {
    noteInputRef.current?.focus();
  };

  if (!patientResource || !encounter) {
    return <Loading />;
  }

  return (
    <>
      <Stack justify="space-between" gap={0}>
        <EncounterHeader
          encounter={encounter}
          chartNoteStatus={chartNoteStatus}
          practitioner={practitioner}
          onStatusChange={handleEncounterStatusChange}
          onTabChange={handleTabChange}
          onSign={handleSign}
          signReasonRequest={signReasonSeq}
        />
        <Box p="md">
          {activeTab === 'notes' && (
            <Stack gap="md">
              <SignAddendum encounter={encounter} provenances={provenances} chartNoteStatus={chartNoteStatus} />

              {clinicalImpression && (
                <Card withBorder shadow="sm" mt="md" data-tour={TOUR.chartNote}>
                  <Group justify="space-between" align="center">
                    <Title>Fill chart note</Title>
                    <Button
                      variant="light"
                      size="xs"
                      radius="xl"
                      leftSection={<IconStethoscope size={14} />}
                      onClick={handleCheckNote}
                      disabled={!(chartNote ?? clinicalImpression.note?.[0]?.text)?.trim() || reviewRunning}
                      data-tour={TOUR.checkNote}
                    >
                      Check note
                    </Button>
                  </Group>
                  <Textarea
                    ref={noteInputRef}
                    aria-label="Chart note"
                    defaultValue={clinicalImpression.note?.[0]?.text}
                    value={chartNote}
                    onChange={handleChartNoteChange}
                    autosize
                    minRows={4}
                    maxRows={8}
                    disabled={chartNoteStatus === ChartNoteStatus.SignedAndLocked}
                  />
                </Card>
              )}
              {clinicalImpression && (
                <ConsistencyReviewCard
                  encounter={encounter}
                  patient={encounter.subject as Reference<Patient>}
                  noteText={chartNote ?? clinicalImpression.note?.[0]?.text ?? ''}
                  requestSeq={reviewSeq}
                  beforeCheck={flushChartNote}
                  locked={chartNoteStatus === ChartNoteStatus.SignedAndLocked}
                  onEditNote={handleEditNote}
                  onSignWithReason={() => setSignReasonSeq((seq) => seq + 1)}
                  onIssueChange={setReviewIssue}
                  onRunningChange={setReviewRunning}
                />
              )}
              {tasks.map((task) => (
                <TaskPanel
                  key={task.id}
                  task={task}
                  onUpdateTask={updateTaskList}
                  enabled={chartNoteStatus !== ChartNoteStatus.SignedAndLocked}
                />
              ))}
            </Stack>
          )}
          {activeTab === 'details' && (
            <BillingTab
              encounter={encounter}
              setEncounter={setEncounter}
              onEncounterSaved={onEncounterChange}
              patient={patientResource}
              practitioner={practitioner}
              setPractitioner={setPractitioner}
              chartNoteStatus={chartNoteStatus}
            />
          )}
        </Box>
      </Stack>
      {taskProp && (
        <TaskDetailsModal key={getReferenceString(taskProp)} task={taskProp} onUpdateTask={updateTaskList} />
      )}
    </>
  );
};
