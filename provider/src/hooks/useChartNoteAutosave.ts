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
   * Saves text still waiting on the pause, then waits for every save in flight. Rejects when the
   * text could not be saved, so a check or a signature never uses an older note.
   */
  flush: () => Promise<void>;
}

export interface ChartNoteAutosaveOptions {
  /** Called after each save that changed the server copy. */
  onSaved?: () => void;
  timeoutMs?: number;
}

/**
 * Autosaves the chart note of a ClinicalImpression. Saves reach the server in typing order, and
 * text that failed to save stays pending for the next flush.
 *
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
  // Text typed since the last save started.
  const pendingRef = useRef<string | undefined>(undefined);
  // Each save starts after the previous one settled.
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  // Whether the server copy has a note. `clinicalImpression` is not refreshed on save, so this
  // decides between adding and removing the note when the text is cleared.
  const noteOnServerRef = useRef<boolean | undefined>(undefined);

  const saveNow = useCallback(
    (note: string): Promise<void> => {
      pendingRef.current = undefined;
      if (!clinicalImpression) {
        return Promise.resolve();
      }
      const save = async (): Promise<void> => {
        try {
          if (note) {
            await medplum.patchResource('ClinicalImpression', clinicalImpression.id, [
              { op: 'add', path: '/note', value: [{ text: note }] },
            ]);
            noteOnServerRef.current = true;
          } else if (noteOnServerRef.current ?? Boolean(clinicalImpression.note)) {
            await medplum.patchResource('ClinicalImpression', clinicalImpression.id, [
              { op: 'remove', path: '/note' },
            ]);
            noteOnServerRef.current = false;
          } else {
            return;
          }
          onSaved?.();
        } catch (err) {
          // Newer text, if any, is already pending; otherwise this text is saved again on the next flush.
          pendingRef.current ??= note;
          throw err;
        }
      };
      // A failed save rejects its own promise without blocking the saves queued after it.
      const queued = queueRef.current.catch(() => undefined).then(save);
      queueRef.current = queued;
      return queued;
    },
    [clinicalImpression, medplum, onSaved]
  );

  const debouncedSave = useDebouncedCallback((note: string): void => {
    saveNow(note).catch(showErrorNotification);
  }, timeoutMs);

  const save = useCallback(
    (note: string): void => {
      pendingRef.current = note;
      debouncedSave(note);
    },
    [debouncedSave]
  );

  const flush = useCallback(async (): Promise<void> => {
    if (pendingRef.current !== undefined) {
      debouncedSave.cancel();
      await saveNow(pendingRef.current);
    }
    await queueRef.current;
  }, [debouncedSave, saveNow]);

  return { save, flush };
}
