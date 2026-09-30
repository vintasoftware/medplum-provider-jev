import { useDebouncedCallback } from '@mantine/hooks';
import type { WithId } from '@medplum/core';
import type { ClinicalImpression } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import { useCallback, useRef } from 'react';
import { SAVE_TIMEOUT_MS } from '../config/constants';
import { showErrorNotification } from '../utils/notifications';

export interface ChartNoteAutosave {
  /** Saves the note once typing pauses. */
  save: (note: string) => void;
  /**
   * Saves the latest text now and waits for every save in flight. Rejects when the text could not
   * be saved, so a check or a signature never uses an older note.
   */
  flush: () => Promise<void>;
}

export interface ChartNoteAutosaveOptions {
  /** Called after each save that changed the server copy. */
  onSaved?: () => void;
  timeoutMs?: number;
}

/**
 * Autosaves the chart note of a ClinicalImpression. Saves reach the server in typing order. A flush
 * saves the latest text unless the server already has it, so text that failed to save is saved again.
 * @param clinicalImpression - The note's ClinicalImpression, once loaded.
 * @param options - Save callback and debounce timeout.
 * @returns The save and flush functions.
 */
export function useChartNoteAutosave(
  clinicalImpression: WithId<ClinicalImpression> | undefined,
  options: ChartNoteAutosaveOptions = {}
): ChartNoteAutosave {
  const medplum = useMedplum();
  const { onSaved, timeoutMs = SAVE_TIMEOUT_MS } = options;
  // The text on screen, once typed.
  const latestRef = useRef<string | undefined>(undefined);
  // The text the server has. `clinicalImpression` is not refreshed on save, so it is tracked here.
  const savedRef = useRef<string | undefined>(undefined);
  // Each save starts after the previous one settled.
  const queueRef = useRef<Promise<void>>(Promise.resolve());

  const enqueue = useCallback(
    (note: string): Promise<void> => {
      if (!clinicalImpression) {
        return Promise.resolve();
      }
      const save = async (): Promise<void> => {
        savedRef.current ??= clinicalImpression.note?.[0]?.text ?? '';
        if (note === savedRef.current) {
          return;
        }
        await medplum.patchResource('ClinicalImpression', clinicalImpression.id, [
          note ? { op: 'add', path: '/note', value: [{ text: note }] } : { op: 'remove', path: '/note' },
        ]);
        savedRef.current = note;
        onSaved?.();
      };
      // A failed save rejects its own promise without blocking the saves queued after it.
      const queued = queueRef.current.catch(() => undefined).then(save);
      queueRef.current = queued;
      return queued;
    },
    [clinicalImpression, medplum, onSaved]
  );

  const debouncedSave = useDebouncedCallback((note: string): void => {
    enqueue(note).catch(showErrorNotification);
  }, timeoutMs);

  const save = useCallback(
    (note: string): void => {
      latestRef.current = note;
      debouncedSave(note);
    },
    [debouncedSave]
  );

  const flush = useCallback(async (): Promise<void> => {
    debouncedSave.cancel();
    if (latestRef.current !== undefined) {
      await enqueue(latestRef.current);
    }
    await queueRef.current;
  }, [debouncedSave, enqueue]);

  return { save, flush };
}
