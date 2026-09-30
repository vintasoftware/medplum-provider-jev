// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Box, Button, Card, Group, Stack, Textarea, Title } from '@mantine/core';
import type { WithId } from '@medplum/core';
import { createReference, getReferenceString } from '@medplum/core';
import type { Encounter, Practitioner, Provenance, Reference, Task } from '@medplum/fhirtypes';
import { Loading, useMedplum } from '@medplum/react';
import { IconStethoscope } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { COMPLETE_LIST_COUNT } from '../../config/constants';
import { useChartNoteAutosave } from '../../hooks/useChartNoteAutosave';
import { useConsistencyCheck } from '../../hooks/useConsistencyCheck';
import { useEncounterChart } from '../../hooks/useEncounterChart';
import { useGuidedDemo } from '../../pages/guided-demo/GuidedDemoContext';
import { TOUR } from '../../pages/guided-demo/tour/anchors';
import { ChartNoteStatus } from '../../types/encounter';
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
  // The Sign dialog opens from the header's lock button, or from the review card with a required reason.
  const [signDialog, setSignDialog] = useState<'sign' | 'reason'>();
  const noteInputRef = useRef<HTMLTextAreaElement>(null);
  const { save: saveChartNote, flush: flushChartNote } = useChartNoteAutosave(clinicalImpression, {
    onSaved: demo?.refresh,
  });
  const check = useConsistencyCheck(encounter, { beforeCheck: flushChartNote, onChange: demo?.refresh });
  const { runCheck } = check;

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
        // user's status change, never on render or reload. The check saves the note first.
        if (newStatus === 'finished' && previousStatus !== 'finished' && clinicalImpression) {
          runCheck().catch(showErrorNotification);
        }
        demo?.refresh();
      } catch (err) {
        showErrorNotification(err);
      }
    },
    [encounter, medplum, setEncounter, onEncounterChange, appointment, clinicalImpression, demo, runCheck]
  );

  const handleTabChange = (tab: string): void => {
    setActiveTab(tab);
  };

  const handleChartNoteChange = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    setChartNote(e.target.value);
    saveChartNote(e.target.value);
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
        entity: signedWithReason && check.issue ? createReference(check.issue) : undefined,
      })
    );

    if (signedWithReason) {
      await check.markSignedWithReason(practitioner);
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
    runCheck().catch(showErrorNotification);
  };

  const handleEditNote = (): void => {
    noteInputRef.current?.focus();
  };

  if (!patientResource || !encounter) {
    return <Loading />;
  }

  const currentNote = chartNote ?? clinicalImpression?.note?.[0]?.text ?? '';

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
          signDialogOpened={signDialog !== undefined}
          onSignDialogOpen={() => setSignDialog('sign')}
          onSignDialogClose={() => setSignDialog(undefined)}
          requireSignReason={signDialog === 'reason'}
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
                      disabled={!currentNote.trim() || check.running}
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
                  check={check}
                  noteText={currentNote}
                  locked={chartNoteStatus === ChartNoteStatus.SignedAndLocked}
                  onEditNote={handleEditNote}
                  onSignWithReason={() => setSignDialog('reason')}
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
