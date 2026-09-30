import type { WithId } from '@medplum/core';
import { createReference, getReferenceString } from '@medplum/core';
import type { DetectedIssue, Encounter, Patient, Practitioner, Reference, Task } from '@medplum/fhirtypes';
import { useMedplum, useMedplumProfile } from '@medplum/react';
import { useCallback, useEffect, useRef, useState } from 'react';
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
  REVIEW_LABELS,
  reviewEncounter,
  SIGNED_WITH_REASON,
} from '../utils/consistency';
import { showErrorNotification } from '../utils/notifications';

/** Passages as the check read them. A source is missing once `loaded` if its checked version cannot be read. */
export interface CheckedPassages {
  loaded: boolean;
  outside?: { title: string; date?: string; text: string };
  note?: string;
}

export interface ConsistencyCheck {
  /** The visit's newest check, or the one just run. */
  issue: WithId<DetectedIssue> | undefined;
  passages: CheckedPassages;
  /** The reconciliation task created for the check, if any. */
  task: WithId<Task> | undefined;
  running: boolean;
  /** Why the last check could not run; cleared by the next run. */
  error: string | undefined;
  creatingTask: boolean;
  /** Saves the note, runs the Bot and stores the result as a DetectedIssue. */
  runCheck: () => Promise<void>;
  createTask: () => Promise<void>;
  /** Records on the check that the note was signed with a documented reason. */
  markSignedWithReason: (signer: Reference<Practitioner>) => Promise<void>;
}

export interface ConsistencyCheckOptions {
  /** Saves any pending note text before the Bot reads it; rejects when it could not be saved. */
  beforeCheck: () => Promise<void>;
  /** Called after each change to the check or its task on the server. */
  onChange?: () => void;
}

/**
 * The consistency check of a visit: the stored result, the passages it compared, and the actions
 * the provider can take on it. Nothing runs on mount; the chart calls `runCheck`.
 *
 * @param encounter - The visit, once loaded.
 * @param options - The note flush and change callback.
 * @returns The check state and actions.
 */
export function useConsistencyCheck(
  encounter: WithId<Encounter> | undefined,
  options: ConsistencyCheckOptions
): ConsistencyCheck {
  const { beforeCheck, onChange } = options;
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const [issue, setIssue] = useState<WithId<DetectedIssue>>();
  const [passages, setPassages] = useState<CheckedPassages>({ loaded: false });
  const [task, setTask] = useState<WithId<Task>>();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string>();
  const [creatingTask, setCreatingTask] = useState(false);
  const runningRef = useRef(false);

  // Show the newest stored check instead of re-running on mount or reload.
  const encounterId = encounter?.id;
  useEffect(() => {
    if (!encounterId) {
      return undefined;
    }
    let cancelled = false;
    findLatestCheck(medplum, encounterId)
      .then((found) => {
        if (!cancelled && found) {
          setIssue(found);
        }
      })
      .catch(showErrorNotification);
    return () => {
      cancelled = true;
    };
  }, [medplum, encounterId]);

  const issueRef = issue ? getReferenceString(issue) : undefined;
  useEffect(() => {
    if (!issueRef) {
      setTask(undefined);
      return;
    }
    medplum.searchOne('Task', { focus: issueRef }, { cache: 'no-cache' }).then(setTask).catch(showErrorNotification);
  }, [medplum, issueRef]);

  // Re-read the passages from the exact versions the check used. Keyed on those versions, so a
  // mitigation (a new issue object with the same sources) does not reload them.
  const noteRef = issue ? implicatedNote(issue)?.reference : undefined;
  const outsideRef = issue ? implicatedDocument(issue)?.reference : undefined;
  useEffect(() => {
    setPassages({ loaded: false });
    if (!issueRef) {
      return undefined;
    }
    let cancelled = false;
    const load = async (): Promise<CheckedPassages> => {
      const [doc, impression] = await Promise.all([
        outsideRef ? readCheckedVersion(medplum, 'DocumentReference', outsideRef) : undefined,
        noteRef ? readCheckedVersion(medplum, 'ClinicalImpression', noteRef) : undefined,
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
      .then((loaded) => {
        if (!cancelled) {
          setPassages(loaded);
        }
      })
      .catch(showErrorNotification);
    return () => {
      cancelled = true;
    };
  }, [medplum, issueRef, noteRef, outsideRef]);

  const runCheck = useCallback(async (): Promise<void> => {
    if (!encounter || runningRef.current) {
      return;
    }
    runningRef.current = true;
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
      if (!profile) {
        setError('No signed-in practitioner');
        return;
      }
      const patient = encounter.subject as Reference<Patient>;
      const author = createReference(profile) as Reference<Practitioner>;
      setIssue(await medplum.createResource(buildDetectedIssue(review, patient, encounter, author)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The check could not be completed');
    } finally {
      runningRef.current = false;
      setRunning(false);
      onChange?.();
    }
  }, [beforeCheck, encounter, medplum, onChange, profile]);

  const createTask = useCallback(async (): Promise<void> => {
    const headline = issue ? headlineResult(readStoredCheck(issue)?.results ?? []) : undefined;
    if (!encounter || !issue || !headline || !profile) {
      return;
    }
    const author = createReference(profile) as Reference<Practitioner>;
    setCreatingTask(true);
    try {
      const created = await medplum.createResource<Task>({
        resourceType: 'Task',
        status: 'requested',
        intent: 'order',
        priority: 'routine',
        code: { text: `Reconcile ${headline.medication} dose with outside discharge summary` },
        for: encounter.subject as Reference<Patient>,
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
      onChange?.();
    }
  }, [encounter, issue, medplum, onChange, profile]);

  const markSignedWithReason = useCallback(
    async (signer: Reference<Practitioner>): Promise<void> => {
      if (!issue) {
        return;
      }
      setIssue(await appendMitigation(medplum, issue, SIGNED_WITH_REASON, signer, true));
    },
    [issue, medplum]
  );

  return { issue, passages, task, running, error, creatingTask, runCheck, createTask, markSignedWithReason };
}
