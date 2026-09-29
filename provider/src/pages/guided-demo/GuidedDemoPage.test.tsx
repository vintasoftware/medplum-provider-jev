import { MantineProvider } from '@mantine/core';
import { MockClient } from '@medplum/mock';
import { MedplumProvider } from '@medplum/react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, test } from 'vitest';
import { GuidedDemoProvider, STORAGE_KEY } from './GuidedDemoContext';
import { GuidedDemoPage } from './GuidedDemoPage';

let medplum: MockClient;

function setup(): void {
  render(
    <MemoryRouter initialEntries={['/guided-demo']}>
      <MedplumProvider medplum={medplum}>
        <MantineProvider>
          <GuidedDemoProvider>
            <Routes>
              <Route path="/guided-demo" element={<GuidedDemoPage />} />
              <Route path="/Patient/:id" element={<div>Patient chart</div>} />
            </Routes>
          </GuidedDemoProvider>
        </MantineProvider>
      </MedplumProvider>
    </MemoryRouter>
  );
}

beforeEach(() => {
  localStorage.clear();
  medplum = new MockClient();
});

describe('GuidedDemoPage', () => {
  test('starts a scenario and opens the patient chart', async () => {
    setup();
    expect(screen.getByText('Synthetic data only')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Start scenario' }));
    expect(await screen.findByText('Patient chart')).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}').tutorial).toBe('active');
  });

  test('lists the steps and hides, resumes and ends the tutorial', async () => {
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'Start scenario' }));
    await screen.findByText('Patient chart');
    setup();
    expect(await screen.findByText('Post-discharge follow-up')).toBeInTheDocument();
    expect(screen.getByText('Sign')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Hide tutorial' }));
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}').tutorial).toBe('dismissed');
    await userEvent.click(screen.getByRole('button', { name: 'Resume tutorial' }));
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}').tutorial).toBe('active');

    await userEvent.click(screen.getByRole('button', { name: 'End scenario' }));
    await waitFor(() => expect(localStorage.getItem(STORAGE_KEY)).toBeNull());
    expect(screen.getByRole('button', { name: 'Start scenario' })).toBeInTheDocument();
  });
});
