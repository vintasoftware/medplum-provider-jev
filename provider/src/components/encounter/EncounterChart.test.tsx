// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { MantineProvider } from '@mantine/core';
import type { WithId } from '@medplum/core';
import { createReference } from '@medplum/core';
import type { ClinicalImpression, DetectedIssue, Encounter, Practitioner, Provenance, Task } from '@medplum/fhirtypes';
import { HomerSimpson, MockClient } from '@medplum/mock';
import { MedplumProvider } from '@medplum/react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CHECK_CODE, CHECK_CODE_SYSTEM, CHECK_RESULT_EXTENSION, noteSearch } from '../../utils/consistency';
import { EncounterChart } from './EncounterChart';

const mockPractitioner: WithId<Practitioner> = {
  resourceType: 'Practitioner',
  id: 'practitioner-123',
  name: [{ given: ['Dr.'], family: 'Test' }],
};

const mockEncounter: WithId<Encounter> = {
  resourceType: 'Encounter',
  id: 'encounter-123',
  status: 'in-progress',
  class: {
    system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
    code: 'AMB',
  },
  subject: { reference: `Patient/${HomerSimpson.id}` },
  participant: [
    {
      individual: createReference(mockPractitioner),
    },
  ],
};

const mockClinicalImpression: ClinicalImpression = {
  resourceType: 'ClinicalImpression',
  id: 'clinical-123',
  status: 'in-progress',
  subject: createReference(HomerSimpson),
  encounter: createReference(mockEncounter),
  note: [{ text: 'Test clinical note' }],
};

const mockTask: Task = {
  resourceType: 'Task',
  id: 'task-123',
  status: 'in-progress',
  intent: 'order',
  encounter: createReference(mockEncounter),
  authoredOn: '2024-01-01T10:00:00Z',
};

describe('EncounterChart', () => {
  let medplum: MockClient;

  beforeEach(async () => {
    medplum = new MockClient();
    await medplum.createResource(mockPractitioner);
    await medplum.createResource(mockEncounter);
    await medplum.createResource(mockClinicalImpression);
    vi.clearAllMocks();
  });

  const setup = (props: Partial<Parameters<typeof EncounterChart>[0]> = {}): ReturnType<typeof render> => {
    return render(
      <MemoryRouter>
        <MedplumProvider medplum={medplum}>
          <MantineProvider>
            <EncounterChart encounter={mockEncounter} {...props} />
          </MantineProvider>
        </MedplumProvider>
      </MemoryRouter>
    );
  };

  test('renders loading spinner initially', async () => {
    setup();
    // The Loading component renders a spinner, not text
    const loader = document.querySelector('.mantine-Loader-root');
    expect(loader).toBeInTheDocument();
    // Drain pending async state updates so they don't escape the test
    await act(async () => {});
  });

  test('renders encounter header after loading', async () => {
    setup();

    await waitFor(() => {
      expect(screen.getByText('Visit')).toBeInTheDocument();
    });
  });

  test('renders chart note textarea', async () => {
    setup();

    await waitFor(() => {
      expect(screen.getByText('Fill chart note')).toBeInTheDocument();
    });

    const textarea = screen.getByRole('textbox');
    expect(textarea).toBeInTheDocument();
    expect(textarea).toHaveValue('Test clinical note');
  });

  test('updates chart note on change', async () => {
    const user = userEvent.setup();
    vi.spyOn(medplum, 'patchResource').mockResolvedValue(mockClinicalImpression as any);

    setup();

    await waitFor(() => {
      expect(screen.getByText('Fill chart note')).toBeInTheDocument();
    });

    const textarea = screen.getByRole('textbox');
    await user.clear(textarea);
    await user.type(textarea, 'Updated note');

    // The debounced save patches only the note, never the whole impression.
    await waitFor(
      () => {
        expect(medplum.patchResource).toHaveBeenCalledWith('ClinicalImpression', 'clinical-123', [
          { op: 'add', path: '/note', value: [{ text: 'Updated note' }] },
        ]);
      },
      { timeout: 3000 }
    );
  });

  test('displays tasks when available', async () => {
    await medplum.createResource(mockTask);

    setup();

    await waitFor(() => {
      expect(screen.getByText('Visit')).toBeInTheDocument();
    });
  });

  test('renders notes tab by default', async () => {
    setup();

    await waitFor(() => {
      expect(screen.getByText('Visit')).toBeInTheDocument();
    });

    // The notes tab should be active by default
    await waitFor(() => {
      expect(screen.getByText('Fill chart note')).toBeInTheDocument();
    });
  });

  test('switches to details tab when clicked', async () => {
    const user = userEvent.setup();
    setup();

    await waitFor(() => {
      expect(screen.getByText('Visit')).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByText('Fill chart note')).toBeInTheDocument();
    });

    const detailsTab = screen.getByText('Details & Billing');
    await user.click(detailsTab);

    await waitFor(() => {
      expect(screen.queryByText('Fill chart note')).not.toBeInTheDocument();
    });
  });

  test('switches back to notes tab when clicked', async () => {
    const user = userEvent.setup();
    setup();

    await waitFor(() => {
      expect(screen.getByText('Visit')).toBeInTheDocument();
    });

    const detailsTab = screen.getByText('Details & Billing');
    await user.click(detailsTab);

    await waitFor(() => {
      expect(screen.queryByText('Fill chart note')).not.toBeInTheDocument();
    });

    const notesTab = screen.getByText('Note & Tasks');
    await user.click(notesTab);

    await waitFor(() => {
      expect(screen.getByText('Fill chart note')).toBeInTheDocument();
    });
  });

  test('displays billing tab content when details tab is active', async () => {
    const user = userEvent.setup();
    setup();

    await waitFor(() => {
      expect(screen.getByText('Visit')).toBeInTheDocument();
    });

    const detailsTab = screen.getByText('Details & Billing');
    await user.click(detailsTab);

    await waitFor(() => {
      expect(screen.queryByText('Fill chart note')).not.toBeInTheDocument();
    });
  });

  test('fetches provenances on mount', async () => {
    vi.spyOn(medplum, 'searchResources').mockResolvedValue([] as any);

    setup();

    await waitFor(() => {
      expect(medplum.searchResources).toHaveBeenCalledWith('Provenance', {
        target: 'Encounter/encounter-123',
        _count: '1000',
      });
    });
  });

  test('chart note is enabled when not signed', async () => {
    vi.spyOn(medplum, 'searchResources').mockImplementation((resourceType: string) => {
      if (resourceType === 'Provenance') {
        return [] as any;
      }
      if (resourceType === 'ClinicalImpression') {
        return [mockClinicalImpression];
      }
      if (resourceType === 'Task') {
        return [];
      }
      return [];
    });

    setup();

    await waitFor(() => {
      expect(screen.getByText('Fill chart note')).toBeInTheDocument();
    });

    const textarea = screen.getByRole('textbox');
    expect(textarea).not.toBeDisabled();
  });

  test('handles encounter status change', async () => {
    const user = userEvent.setup();
    vi.spyOn(medplum, 'patchResource').mockResolvedValue({ ...mockEncounter, status: 'finished' } as any);

    setup();

    await waitFor(() => {
      expect(screen.getByText('In Progress')).toBeInTheDocument();
    });

    const statusButton = screen.getByText('In Progress');
    await user.click(statusButton);

    await waitFor(() => {
      expect(screen.getByText('Finished')).toBeInTheDocument();
    });
  });

  test('renders with encounter reference', async () => {
    const encounterRef = { reference: 'Encounter/encounter-123' };

    await act(async () => {
      setup({ encounter: encounterRef });
    });

    await waitFor(() => {
      expect(screen.getByText('Visit')).toBeInTheDocument();
    });
  });

  test('fetches every task for the encounter in one explicit page', async () => {
    await medplum.createResource(mockTask);

    vi.spyOn(medplum, 'searchResources');

    setup();

    await waitFor(() => {
      expect(medplum.searchResources).toHaveBeenCalledWith(
        'Task',
        { encounter: 'Encounter/encounter-123', _count: '1000' },
        expect.any(Object)
      );
    });
  });

  test("fetches the encounter's note with the same search as the consistency Bot", async () => {
    vi.spyOn(medplum, 'searchResources');

    setup();

    await waitFor(() => {
      expect(medplum.searchResources).toHaveBeenCalledWith(
        'ClinicalImpression',
        noteSearch('Encounter/encounter-123', `Patient/${HomerSimpson.id}`),
        expect.objectContaining({ cache: 'no-cache' })
      );
    });
    expect(noteSearch('Encounter/encounter-123', `Patient/${HomerSimpson.id}`)).toEqual({
      encounter: 'Encounter/encounter-123',
      subject: `Patient/${HomerSimpson.id}`,
      _sort: '-_lastUpdated',
      _count: '1',
    });
  });

  describe('signing functionality', () => {
    const finishedEncounter: WithId<Encounter> = {
      ...mockEncounter,
      status: 'finished',
    };

    const getSignButton = (): HTMLElement | null => {
      const buttons = screen.getAllByRole('button');
      return buttons.find((btn) => btn.querySelector('svg') && !btn.textContent?.trim()) || null;
    };

    test('signs without locking - textarea remains enabled', async () => {
      const user = userEvent.setup();
      const mockProvenance: Provenance = {
        resourceType: 'Provenance',
        id: 'provenance-1',
        target: [createReference(finishedEncounter)],
        recorded: new Date().toISOString(),
        agent: [
          {
            who: createReference(mockPractitioner),
          },
        ],
      };

      // Mock searchResources to return empty initially, then return provenance after signing
      let provenanceReturned = false;
      vi.spyOn(medplum, 'searchResources').mockImplementation((resourceType: string) => {
        if (resourceType === 'Provenance') {
          return Promise.resolve(provenanceReturned ? [mockProvenance] : []) as any;
        }
        if (resourceType === 'ClinicalImpression') {
          return Promise.resolve([mockClinicalImpression]) as any;
        }
        if (resourceType === 'Task') {
          return Promise.resolve([]) as any;
        }
        return Promise.resolve([]) as any;
      });

      vi.spyOn(medplum, 'createResource').mockImplementation(async (resource: any) => {
        if (resource.resourceType === 'Provenance') {
          provenanceReturned = true;
          return mockProvenance as any;
        }
        return resource;
      });

      await medplum.createResource(finishedEncounter);
      setup({ encounter: finishedEncounter });

      await waitFor(() => {
        expect(screen.getByText('Fill chart note')).toBeInTheDocument();
      });

      await waitFor(() => {
        const signButton = getSignButton();
        expect(signButton).toBeInTheDocument();
      });

      const signButton = getSignButton();
      if (signButton) {
        await user.click(signButton);
      }

      await waitFor(() => {
        expect(screen.getByText('Just Sign')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Just Sign'));

      await waitFor(() => {
        expect(medplum.createResource).toHaveBeenCalledWith(
          expect.objectContaining({
            resourceType: 'Provenance',
            target: [createReference(finishedEncounter)],
          })
        );
      });

      // Wait for modal to close and component to update
      // Textarea should still be enabled after signing without locking
      await waitFor(
        () => {
          const chartNoteCard = screen.getByText('Fill chart note').closest('.mantine-Card-root');
          const textarea = chartNoteCard?.querySelector('textarea');
          expect(textarea).not.toBeDisabled();
        },
        { timeout: 3000 }
      );
    });

    test('signs with locking - textarea becomes disabled', async () => {
      const user = userEvent.setup();
      const completedClinicalImpression: ClinicalImpression = {
        ...mockClinicalImpression,
        status: 'completed',
      };
      const mockProvenance: Provenance = {
        resourceType: 'Provenance',
        id: 'provenance-1',
        target: [createReference(finishedEncounter)],
        recorded: new Date().toISOString(),
        agent: [
          {
            who: createReference(mockPractitioner),
          },
        ],
      };

      // Mock searchResources to return empty initially, then return provenance after signing
      let provenanceReturned = false;
      vi.spyOn(medplum, 'searchResources').mockImplementation((resourceType: string) => {
        if (resourceType === 'Provenance') {
          return Promise.resolve(provenanceReturned ? [mockProvenance] : []) as any;
        }
        if (resourceType === 'ClinicalImpression') {
          return Promise.resolve([completedClinicalImpression]) as any;
        }
        if (resourceType === 'Task') {
          return Promise.resolve([]) as any;
        }
        return Promise.resolve([]) as any;
      });

      vi.spyOn(medplum, 'createResource').mockImplementation(async (resource: any) => {
        if (resource.resourceType === 'Provenance') {
          provenanceReturned = true;
          return mockProvenance as any;
        }
        return resource;
      });

      await medplum.createResource(finishedEncounter);
      setup({ encounter: finishedEncounter });

      await waitFor(() => {
        expect(screen.getByText('Fill chart note')).toBeInTheDocument();
      });

      await waitFor(() => {
        const signButton = getSignButton();
        expect(signButton).toBeInTheDocument();
      });

      const signButton = getSignButton();
      if (signButton) {
        await user.click(signButton);
      }

      await waitFor(() => {
        expect(screen.getByText('Sign & Lock Note')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Sign & Lock Note'));

      await waitFor(() => {
        expect(medplum.createResource).toHaveBeenCalledWith(
          expect.objectContaining({
            resourceType: 'Provenance',
            target: [createReference(finishedEncounter)],
          })
        );
      });

      // Wait for modal to close and component to update
      // Textarea should be disabled after signing with locking
      await waitFor(
        () => {
          const chartNoteCard = screen.getByText('Fill chart note').closest('.mantine-Card-root');
          const textarea = chartNoteCard?.querySelector('textarea');
          expect(textarea).toBeDisabled();
        },
        { timeout: 3000 }
      );
    });

    test('signs with locking - completes incomplete tasks', async () => {
      const user = userEvent.setup();
      const incompleteTask: Task = {
        ...mockTask,
        id: 'task-incomplete',
        status: 'in-progress',
      };
      const completedTask: Task = {
        ...incompleteTask,
        status: 'completed',
      };

      const completedClinicalImpression: ClinicalImpression = {
        ...mockClinicalImpression,
        status: 'completed',
      };
      const mockProvenance: Provenance = {
        resourceType: 'Provenance',
        id: 'provenance-1',
        target: [createReference(finishedEncounter)],
        recorded: new Date().toISOString(),
        agent: [
          {
            who: createReference(mockPractitioner),
          },
        ],
      };

      await medplum.createResource(incompleteTask);
      let provenanceReturned = false;
      vi.spyOn(medplum, 'patchResource').mockImplementation(async (resourceType: string) =>
        resourceType === 'Task' ? (completedTask as any) : (completedClinicalImpression as any)
      );
      vi.spyOn(medplum, 'createResource').mockImplementation(async (resource: any) => {
        if (resource.resourceType === 'Provenance') {
          provenanceReturned = true;
          return mockProvenance as any;
        }
        return resource;
      });
      vi.spyOn(medplum, 'searchResources').mockImplementation((resourceType: string) => {
        if (resourceType === 'Provenance') {
          return Promise.resolve(provenanceReturned ? [mockProvenance] : []) as any;
        }
        if (resourceType === 'ClinicalImpression') {
          return Promise.resolve([completedClinicalImpression]) as any;
        }
        if (resourceType === 'Task') {
          return Promise.resolve([incompleteTask]) as any;
        }
        return Promise.resolve([]) as any;
      });

      await medplum.createResource(finishedEncounter);
      setup({ encounter: finishedEncounter });

      await waitFor(() => {
        expect(screen.getByText('Fill chart note')).toBeInTheDocument();
      });

      await waitFor(() => {
        const signButton = getSignButton();
        expect(signButton).toBeInTheDocument();
      });

      const signButton = getSignButton();
      if (signButton) {
        await user.click(signButton);
      }

      await waitFor(() => {
        expect(screen.getByText('Sign & Lock Note')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Sign & Lock Note'));

      // Verify that incomplete tasks are updated to completed
      await waitFor(
        () => {
          expect(medplum.patchResource).toHaveBeenCalledWith('Task', 'task-incomplete', [
            { op: 'replace', path: '/status', value: 'completed' },
          ]);
        },
        { timeout: 3000 }
      );
    });

    test('signs with locking - does not update already completed tasks', async () => {
      const user = userEvent.setup();
      const completedTask: Task = {
        ...mockTask,
        id: 'task-completed',
        status: 'completed',
      };

      const completedClinicalImpression: ClinicalImpression = {
        ...mockClinicalImpression,
        status: 'completed',
      };
      const mockProvenance: Provenance = {
        resourceType: 'Provenance',
        id: 'provenance-1',
        target: [createReference(finishedEncounter)],
        recorded: new Date().toISOString(),
        agent: [
          {
            who: createReference(mockPractitioner),
          },
        ],
      };

      await medplum.createResource(completedTask);
      let provenanceReturned = false;
      vi.spyOn(medplum, 'patchResource');
      vi.spyOn(medplum, 'createResource').mockImplementation(async (resource: any) => {
        if (resource.resourceType === 'Provenance') {
          provenanceReturned = true;
          return mockProvenance as any;
        }
        return resource;
      });
      vi.spyOn(medplum, 'searchResources').mockImplementation((resourceType: string) => {
        if (resourceType === 'Provenance') {
          return Promise.resolve(provenanceReturned ? [mockProvenance] : []) as any;
        }
        if (resourceType === 'ClinicalImpression') {
          return Promise.resolve([completedClinicalImpression]) as any;
        }
        if (resourceType === 'Task') {
          return Promise.resolve([completedTask]) as any;
        }
        return Promise.resolve([]) as any;
      });

      await medplum.createResource(finishedEncounter);
      setup({ encounter: finishedEncounter });

      await waitFor(() => {
        expect(screen.getByText('Fill chart note')).toBeInTheDocument();
      });

      await waitFor(() => {
        const signButton = getSignButton();
        expect(signButton).toBeInTheDocument();
      });

      const signButton = getSignButton();
      if (signButton) {
        await user.click(signButton);
      }

      await waitFor(() => {
        expect(screen.getByText('Sign & Lock Note')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Sign & Lock Note'));

      await waitFor(
        () => {
          expect(medplum.createResource).toHaveBeenCalled();
        },
        { timeout: 3000 }
      );

      // Verify that completed tasks are not updated
      const patchCalls = vi.mocked(medplum.patchResource).mock.calls;
      const taskPatchCalls = patchCalls.filter((call) => call[0] === 'Task');
      expect(taskPatchCalls).toHaveLength(0);
    });

    test('chart note is disabled when signed and locked', async () => {
      const mockProvenance: Provenance = {
        resourceType: 'Provenance',
        id: 'provenance-1',
        target: [createReference(finishedEncounter)],
        recorded: new Date().toISOString(),
        agent: [
          {
            who: createReference(mockPractitioner),
          },
        ],
      };

      const completedClinicalImpression: ClinicalImpression = {
        ...mockClinicalImpression,
        status: 'completed',
      };

      vi.spyOn(medplum, 'searchResources').mockImplementation((resourceType: string) => {
        if (resourceType === 'Provenance') {
          return [mockProvenance] as any;
        }
        if (resourceType === 'ClinicalImpression') {
          return [completedClinicalImpression] as any;
        }
        return [] as any;
      });

      setup({ encounter: finishedEncounter });

      await waitFor(() => {
        expect(screen.getByText('Fill chart note')).toBeInTheDocument();
      });

      // Textarea should be disabled when signed and locked
      await waitFor(() => {
        const chartNoteCard = screen.getByText('Fill chart note').closest('.mantine-Card-root');
        const textarea = chartNoteCard?.querySelector('textarea');
        expect(textarea).toBeDisabled();
      });
    });

    test('chart note is enabled when signed but not locked', async () => {
      const mockProvenance: Provenance = {
        resourceType: 'Provenance',
        id: 'provenance-1',
        target: [createReference(finishedEncounter)],
        recorded: new Date().toISOString(),
        agent: [
          {
            who: createReference(mockPractitioner),
          },
        ],
      };

      vi.spyOn(medplum, 'searchResources').mockImplementation((resourceType: string) => {
        if (resourceType === 'Provenance') {
          return [mockProvenance] as any;
        }
        if (resourceType === 'ClinicalImpression') {
          return [mockClinicalImpression] as any;
        }
        return [] as any;
      });

      setup({ encounter: finishedEncounter });

      await waitFor(() => {
        expect(screen.getByText('Fill chart note')).toBeInTheDocument();
      });

      // Textarea should be enabled when signed but not locked
      await waitFor(() => {
        const chartNoteCard = screen.getByText('Fill chart note').closest('.mantine-Card-root');
        const textarea = chartNoteCard?.querySelector('textarea');
        expect(textarea).not.toBeDisabled();
      });
    });
  });
  describe('consistency review', () => {
    const finished: WithId<Encounter> = { ...mockEncounter, id: 'encounter-finished', status: 'finished' };

    beforeEach(() => {
      vi.stubEnv('MEDPLUM_CONSISTENCY_BOT_ID', 'bot-1');
      vi.stubEnv('MEDPLUM_PROJECT_ID', 'demo-project');
      vi.spyOn(medplum, 'getProject').mockReturnValue({ resourceType: 'Project', id: 'demo-project' });
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    });

    test('exposes the tutorial anchors', async () => {
      const { container } = setup();
      await screen.findByText('Fill chart note');
      for (const anchor of ['chart-note', 'check-note', 'visit-status']) {
        expect(container.ownerDocument.querySelector(`[data-tour="${anchor}"]`)).not.toBeNull();
      }
    });

    test('saves the typed note before the automatic check when the visit is finished', async () => {
      const user = userEvent.setup();
      const patch = vi.spyOn(medplum, 'patchResource');
      const execute = vi
        .spyOn(medplum, 'executeBot')
        .mockResolvedValue({ status: 'unavailable', reason: 'No outside discharge summary is on file' });
      setup();
      await screen.findByText('Fill chart note');

      await user.type(screen.getByRole('textbox', { name: 'Chart note' }), ' Continue lisinopril 20 mg.');
      // Finish before the 1.5 s debounce fires.
      await user.click(screen.getByRole('button', { name: /In Progress/ }));
      await user.click(await screen.findByRole('menuitem', { name: 'Finished' }));

      await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
      const noteSave = patch.mock.calls.findIndex(
        ([type, , ops]) => type === 'ClinicalImpression' && JSON.stringify(ops).includes('Continue lisinopril 20 mg.')
      );
      expect(noteSave).toBeGreaterThanOrEqual(0);
      expect(patch.mock.invocationCallOrder[noteSave]).toBeLessThan(execute.mock.invocationCallOrder[0]);
      expect(await screen.findByRole('alert')).toHaveTextContent('No outside discharge summary is on file');
    });

    test('a failed note save stops the check, keeps the text, and is saved again on retry', async () => {
      const user = userEvent.setup();
      const patch = vi.spyOn(medplum, 'patchResource').mockRejectedValueOnce(new Error('Network error'));
      const execute = vi
        .spyOn(medplum, 'executeBot')
        .mockResolvedValue({ status: 'unavailable', reason: 'No outside discharge summary is on file' });
      setup();
      await screen.findByText('Fill chart note');

      const textarea = screen.getByRole('textbox', { name: 'Chart note' });
      await user.type(textarea, ' Continue lisinopril 20 mg.');
      // Check before the 1.5 s debounce fires; the save fails.
      await user.click(screen.getByRole('button', { name: 'Check note' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('The note could not be saved, so it was not checked');
      expect(execute).not.toHaveBeenCalled();
      expect(textarea).toHaveValue('Test clinical note Continue lisinopril 20 mg.');

      await user.click(screen.getByRole('button', { name: 'Check note' }));
      await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
      const saves = patch.mock.calls.filter(
        ([type, , ops]) => type === 'ClinicalImpression' && JSON.stringify(ops).includes('Continue lisinopril 20 mg.')
      );
      expect(saves).toHaveLength(2);
      expect(patch.mock.invocationCallOrder[1]).toBeLessThan(execute.mock.invocationCallOrder[0]);
      expect((await medplum.readResource('ClinicalImpression', 'clinical-123')).note?.[0]?.text).toBe(
        'Test clinical note Continue lisinopril 20 mg.'
      );
    });

    test('Sign & Lock saves pending note text before signing', async () => {
      const user = userEvent.setup();
      await medplum.createResource(finished);
      const impression = await medplum.createResource<ClinicalImpression>({
        ...mockClinicalImpression,
        id: 'ci-pending',
        encounter: createReference(finished),
      });
      const patch = vi.spyOn(medplum, 'patchResource');
      const create = vi.spyOn(medplum, 'createResource');
      setup({ encounter: finished });
      await user.type(await screen.findByRole('textbox', { name: 'Chart note' }), ' Continue 20 mg.');
      // Sign before the 1.5 s debounce fires.
      await user.click(screen.getByRole('button', { name: 'Sign note' }));
      await user.click(await screen.findByText('Sign & Lock Note'));

      await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ resourceType: 'Provenance' })));
      const noteSave = patch.mock.calls.findIndex(
        ([type, , ops]) => type === 'ClinicalImpression' && JSON.stringify(ops).includes('Continue 20 mg.')
      );
      const signature = create.mock.calls.findIndex(([resource]) => resource.resourceType === 'Provenance');
      expect(noteSave).toBeGreaterThanOrEqual(0);
      expect(patch.mock.invocationCallOrder[noteSave]).toBeLessThan(create.mock.invocationCallOrder[signature]);
      const saved = await medplum.readResource('ClinicalImpression', impression.id);
      expect(saved).toMatchObject({ status: 'completed', note: [{ text: 'Test clinical note Continue 20 mg.' }] });
    });

    test('does not sign when the pending note cannot be saved', async () => {
      const user = userEvent.setup();
      await medplum.createResource(finished);
      await medplum.createResource<ClinicalImpression>({
        ...mockClinicalImpression,
        id: 'ci-unsaved',
        encounter: createReference(finished),
      });
      const patch = vi.spyOn(medplum, 'patchResource').mockRejectedValueOnce(new Error('Network error'));
      const create = vi.spyOn(medplum, 'createResource');
      setup({ encounter: finished });
      await user.type(await screen.findByRole('textbox', { name: 'Chart note' }), ' Continue 20 mg.');
      await user.click(screen.getByRole('button', { name: 'Sign note' }));
      await user.click(await screen.findByText('Sign & Lock Note'));

      // The failed call is the note save, made before anything else is signed or locked.
      await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
      expect(patch).toHaveBeenCalledWith('ClinicalImpression', 'ci-unsaved', [
        { op: 'add', path: '/note', value: [{ text: 'Test clinical note Continue 20 mg.' }] },
      ]);
      await act(async () => undefined);
      expect(create).not.toHaveBeenCalledWith(expect.objectContaining({ resourceType: 'Provenance' }));
      expect((await medplum.readResource('ClinicalImpression', 'ci-unsaved')).status).toBe('in-progress');
      expect(screen.getByRole('textbox', { name: 'Chart note' })).toHaveValue('Test clinical note Continue 20 mg.');
    });

    test("edits the newest note of the visit's patient, the one the Bot reads", async () => {
      const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));
      await medplum.createResource(finished);
      const older = await medplum.createResource<ClinicalImpression>({
        ...mockClinicalImpression,
        id: 'ci-older',
        encounter: createReference(finished),
        note: [{ text: 'Older note' }],
      });
      await tick();
      await medplum.createResource<ClinicalImpression>({
        ...mockClinicalImpression,
        id: 'ci-newer',
        encounter: createReference(finished),
        note: [{ text: 'Newer note' }],
      });
      await tick();
      // Newest of all, but for another patient.
      await medplum.createResource<ClinicalImpression>({
        ...mockClinicalImpression,
        id: 'ci-other-patient',
        subject: { reference: 'Patient/someone-else' },
        encounter: createReference(finished),
        note: [{ text: 'Another patient note' }],
      });
      setup({ encounter: finished });

      expect(await screen.findByRole('textbox', { name: 'Chart note' })).toHaveValue('Newer note');
      const botNote = await medplum.searchOne(
        'ClinicalImpression',
        noteSearch(`Encounter/${finished.id}`, `Patient/${HomerSimpson.id}`)
      );
      expect(botNote?.id).toBe('ci-newer');
      expect(botNote?.id).not.toBe(older.id);
    });

    test('Sign & Lock leaves a reconciliation task without an encounter open', async () => {
      const user = userEvent.setup();
      await medplum.createResource(finished);
      await medplum.createResource<ClinicalImpression>({
        ...mockClinicalImpression,
        id: 'ci-finished',
        encounter: createReference(finished),
      });
      const visitTask = await medplum.createResource<Task>({
        ...mockTask,
        id: undefined,
        encounter: createReference(finished),
      });
      const reconciliation = await medplum.createResource<Task>({
        resourceType: 'Task',
        status: 'requested',
        intent: 'order',
        focus: { reference: 'DetectedIssue/check-1' },
        reasonReference: createReference(finished),
      });
      setup({ encounter: finished });
      await user.click(await screen.findByRole('button', { name: 'Sign note' }));
      await user.click(await screen.findByText('Sign & Lock Note'));

      await waitFor(async () => expect((await medplum.readResource('Task', visitTask.id)).status).toBe('completed'));
      expect((await medplum.readResource('Task', reconciliation.id)).status).toBe('requested');
    });

    test('signs with a documented reason and records it on the check', async () => {
      const user = userEvent.setup();
      await medplum.createResource(finished);
      const impression = await medplum.createResource<ClinicalImpression>({
        ...mockClinicalImpression,
        id: 'ci-reason',
        encounter: createReference(finished),
      });
      const issue = await medplum.createResource<DetectedIssue>({
        resourceType: 'DetectedIssue',
        status: 'preliminary',
        code: { coding: [{ system: CHECK_CODE_SYSTEM, code: CHECK_CODE }] },
        patient: { reference: `Patient/${HomerSimpson.id}` },
        implicated: [
          createReference(finished),
          { reference: `ClinicalImpression/${impression.id}/_history/${impression.meta?.versionId}` },
        ],
        extension: [
          {
            url: CHECK_RESULT_EXTENSION,
            valueString: JSON.stringify({
              model: 'jev-1.13.0',
              input_tokens: 900,
              checked_at: '2026-09-23T15:00:00Z',
              mentions_hospital_stay: 0.1,
              results: [
                {
                  medication: 'lisinopril',
                  choice: 'potential_conflict',
                  confidence: 0.9,
                  probabilities: { agreement: 0.05, potential_conflict: 0.9, insufficient_information: 0.05 },
                },
              ],
            }),
          },
        ],
      });
      setup({ encounter: finished });

      await user.click(await screen.findByRole('button', { name: 'Sign with a documented reason' }));
      const lock = await screen.findByRole('button', { name: 'Sign & Lock Note' });
      expect(lock).toBeDisabled();
      const dialog = screen.getByRole('dialog');
      await user.type(dialog.querySelector('input') as HTMLInputElement, 'Hospital dose confirmed with patient');
      expect(lock).toBeEnabled();
      await user.click(lock);

      await waitFor(async () => {
        const [provenance] = await medplum.searchResources('Provenance', { target: `Encounter/${finished.id}` });
        expect(provenance?.reason?.[0]).toMatchObject({ text: 'Hospital dose confirmed with patient' });
        expect(provenance?.entity?.[0]).toMatchObject({
          role: 'source',
          what: { reference: `DetectedIssue/${issue.id}` },
        });
      });
      const updated = await medplum.readResource('DetectedIssue', issue.id);
      expect(updated.status).toBe('final');
      expect(updated.mitigation?.[0]?.action.text).toBe('Signed with documented reason');
      expect(await screen.findByText('Reason: Hospital dose confirmed with patient')).toBeInTheDocument();
    });
  });
});
