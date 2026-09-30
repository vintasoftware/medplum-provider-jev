import type { WithId } from '@medplum/core';
import type { ClinicalImpression } from '@medplum/fhirtypes';
import { MockClient } from '@medplum/mock';
import { MedplumProvider } from '@medplum/react';
import type { RenderHookResult } from '@testing-library/react';
import { renderHook, waitFor } from '@testing-library/react';
import type { JSX, ReactNode } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { showErrorNotification } from '../utils/notifications';
import type { ChartNoteAutosave } from './useChartNoteAutosave';
import { useChartNoteAutosave } from './useChartNoteAutosave';

vi.mock('../utils/notifications');

const TIMEOUT_MS = 50;

describe('useChartNoteAutosave', () => {
  let medplum: MockClient;
  let impression: WithId<ClinicalImpression>;

  beforeEach(async () => {
    medplum = new MockClient();
    impression = await medplum.createResource<ClinicalImpression>({
      resourceType: 'ClinicalImpression',
      status: 'in-progress',
      subject: { reference: 'Patient/p1' },
      note: [{ text: 'First draft' }],
    });
  });

  function setup(onSaved?: () => void): RenderHookResult<ChartNoteAutosave, unknown> {
    const wrapper = ({ children }: { children: ReactNode }): JSX.Element => (
      <MedplumProvider medplum={medplum}>{children}</MedplumProvider>
    );
    return renderHook(() => useChartNoteAutosave(impression, { onSaved, timeoutMs: TIMEOUT_MS }), { wrapper });
  }

  test('saves the latest text once typing pauses', async () => {
    const patch = vi.spyOn(medplum, 'patchResource');
    const onSaved = vi.fn();
    const { result } = setup(onSaved);

    result.current.save('First draft.');
    result.current.save('First draft. Plan:');
    expect(patch).not.toHaveBeenCalled();

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch).toHaveBeenCalledWith('ClinicalImpression', impression.id, [
      { op: 'add', path: '/note', value: [{ text: 'First draft. Plan:' }] },
    ]);
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  test('flush saves pending text at once and resolves after the server has it', async () => {
    const patch = vi.spyOn(medplum, 'patchResource');
    const { result } = setup();

    result.current.save('Typed and checked right away');
    await result.current.flush();

    expect(patch).toHaveBeenCalledTimes(1);
    expect((await medplum.readResource('ClinicalImpression', impression.id)).note?.[0]?.text).toBe(
      'Typed and checked right away'
    );
    // Nothing is pending any more, so the paused save does not run again.
    await new Promise((resolve) => {
      setTimeout(resolve, TIMEOUT_MS * 2);
    });
    expect(patch).toHaveBeenCalledTimes(1);
  });

  test('keeps text that failed to save pending for the next flush', async () => {
    const patch = vi.spyOn(medplum, 'patchResource').mockRejectedValueOnce(new Error('Network error'));
    const { result } = setup();

    result.current.save('Unsaved text');
    await waitFor(() => expect(showErrorNotification).toHaveBeenCalledTimes(1));

    await result.current.flush();
    expect(patch).toHaveBeenCalledTimes(2);
    expect((await medplum.readResource('ClinicalImpression', impression.id)).note?.[0]?.text).toBe('Unsaved text');
  });

  test('flush rejects when the text cannot be saved', async () => {
    vi.spyOn(medplum, 'patchResource').mockRejectedValueOnce(new Error('Network error'));
    const { result } = setup();

    result.current.save('Unsaved text');
    await expect(result.current.flush()).rejects.toThrow('Network error');
    expect((await medplum.readResource('ClinicalImpression', impression.id)).note?.[0]?.text).toBe('First draft');
  });

  test('removes the note when the text is cleared, then adds it again', async () => {
    const patch = vi.spyOn(medplum, 'patchResource');
    const { result } = setup();

    result.current.save('');
    await result.current.flush();
    expect(patch).toHaveBeenLastCalledWith('ClinicalImpression', impression.id, [{ op: 'remove', path: '/note' }]);
    expect((await medplum.readResource('ClinicalImpression', impression.id)).note).toBeUndefined();

    // A second clear has nothing to remove.
    result.current.save('');
    await result.current.flush();
    expect(patch).toHaveBeenCalledTimes(1);

    result.current.save('Back');
    await result.current.flush();
    expect(patch).toHaveBeenLastCalledWith('ClinicalImpression', impression.id, [
      { op: 'add', path: '/note', value: [{ text: 'Back' }] },
    ]);
  });

  test('saves reach the server in typing order', async () => {
    let finishFirst: () => void = () => undefined;
    const original = medplum.patchResource.bind(medplum);
    const patch = vi.spyOn(medplum, 'patchResource').mockImplementationOnce(
      (...args) =>
        new Promise((resolve) => {
          finishFirst = () => resolve(original(...args));
        })
    );
    const { result } = setup();

    result.current.save('One');
    const first = result.current.flush();
    result.current.save('One two');
    const second = result.current.flush();
    // The second save waits for the first, which is still in flight.
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));

    finishFirst();
    await first;
    await second;
    expect(patch).toHaveBeenCalledTimes(2);
    expect(patch.mock.calls.map(([, , ops]) => JSON.stringify(ops))).toEqual([
      JSON.stringify([{ op: 'add', path: '/note', value: [{ text: 'One' }] }]),
      JSON.stringify([{ op: 'add', path: '/note', value: [{ text: 'One two' }] }]),
    ]);
  });
});
