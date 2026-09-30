import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { test as base, expect } from '@playwright/test';
import { useJevCassette } from './jev-cassette.ts';

export { expect };

export interface ScenarioIds {
  patientId: string;
  encounterId: string;
}

interface Fixtures {
  /** FHIR API as the CLI login, for asserting server state. */
  medplum: APIRequestContext;
  /** Replays (or records) the Bot's hosted-Jev answers for this test. */
  jev: void;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set; run the tests with npm run test:e2e`);
  }
  return value;
}

export const test = base.extend<Fixtures>({
  medplum: async ({ playwright }, use) => {
    const context = await playwright.request.newContext({
      baseURL: `${required('E2E_MEDPLUM_BASE_URL')}fhir/R4/`,
      extraHTTPHeaders: { Authorization: `Bearer ${required('E2E_MEDPLUM_TOKEN')}` },
    });
    await use(context);
    await context.dispose();
  },
  page: async ({ page }, use) => {
    // Sign the app in with the CLI session: MedplumClient reads `activeLogin` on start.
    const login = {
      accessToken: required('E2E_MEDPLUM_TOKEN'),
      refreshToken: '',
      profile: { reference: required('E2E_MEDPLUM_PROFILE_REF') },
      project: { reference: required('E2E_MEDPLUM_PROJECT') },
    };
    await page.addInitScript((value) => {
      if (!localStorage.getItem('activeLogin')) {
        localStorage.setItem('activeLogin', value);
      }
    }, JSON.stringify(login));
    await use(page);
  },
  jev: [
    async ({ page, medplum }, use, testInfo) => {
      const name = testInfo.titlePath
        .slice(1)
        .join(' ')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
      const finish = await useJevCassette(page, medplum, name, testInfo.title);
      await use();
      // Reports cassette errors even when the test failed; saves a recording only when it passed.
      finish(testInfo.status === testInfo.expectedStatus);
    },
    { auto: true },
  ],
});

// Page helpers. Each reflects what a tester does in the app.

export async function startScenario(page: Page, options: { tutorial: boolean }): Promise<ScenarioIds> {
  await page.goto('/guided-demo');
  await page.getByRole('button', { name: 'Start scenario' }).click();
  await page.waitForURL(/\/Patient\/[^/]+$/);
  const coach = page.getByRole('region', { name: 'Guided demo' });
  await expect(coach).toBeVisible();
  if (!options.tutorial) {
    await coach.getByRole('button', { name: 'Hide tutorial' }).click();
    await expect(coach).toContainText('Tutorial hidden');
  }
  const stored = await page.evaluate(() => localStorage.getItem('jev-guided-demo'));
  return JSON.parse(stored as string) as ScenarioIds;
}

export async function openTodaysVisit(page: Page, ids: ScenarioIds): Promise<void> {
  await page.goto(`/Patient/${ids.patientId}/Encounter/${ids.encounterId}`);
  await expect(page.getByText('Fill chart note')).toBeVisible();
}

export async function setVisitStatus(page: Page, status: 'In Progress' | 'Finished'): Promise<void> {
  await page.locator('[data-tour="visit-status"]').click();
  await page.getByRole('menuitem', { name: status }).click();
}

// Replaces the note and waits until the server has the new text.
export async function writeNote(page: Page, text: string): Promise<void> {
  const saved = page.waitForResponse(
    (r) => r.request().method() === 'PATCH' && r.url().includes('/ClinicalImpression/') && r.ok(),
    { timeout: 15_000 }
  );
  const note = page.getByLabel('Chart note');
  await note.click();
  await note.fill(text);
  await saved;
}

export function reviewCard(page: Page): Locator {
  return page.locator('[data-tour="review-card"]');
}

export function reviewLabel(page: Page): Locator {
  return reviewCard(page).locator('.mantine-Badge-label').first();
}

export async function expectReview(page: Page, label: string): Promise<void> {
  await expect(reviewLabel(page)).toHaveText(label, { timeout: 90_000 });
}

export async function checkNote(page: Page): Promise<void> {
  await page.locator('[data-tour="check-note"]').click();
}

export async function signAndLock(page: Page): Promise<void> {
  await page.locator('[data-tour="visit-sign"]').click();
  await page.getByRole('button', { name: 'Sign & Lock Note' }).click();
  await expect(page.getByText(/Signed and Locked by/)).toBeVisible();
}

export async function fhirSearch<T = any>(medplum: APIRequestContext, query: string): Promise<T[]> {
  const response = await medplum.get(query, { headers: { 'Cache-Control': 'no-cache' } });
  expect(response.ok(), `GET ${query}`).toBeTruthy();
  return ((await response.json()).entry ?? []).map((e: { resource: T }) => e.resource);
}

// A pause so the recorded video shows each state; it does not affect assertions.
export async function beat(page: Page, ms = 1200): Promise<void> {
  await page.waitForTimeout(ms);
}
