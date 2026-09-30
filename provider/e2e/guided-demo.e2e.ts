import type { Locator, Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { ScenarioIds } from './fixtures.ts';
import {
  beat,
  checkNote,
  expect,
  expectReview,
  fhirSearch,
  openTodaysVisit,
  reviewCard,
  setVisitStatus,
  signAndLock,
  startScenario,
  test,
  writeNote,
} from './fixtures.ts';

// One test per guided-demo path. Hosted Jev's answers come from e2e/cassettes (see the
// root README, "End-to-end tests"); everything else runs against the Medplum project for real.

const scenario = JSON.parse(readFileSync(new URL('../src/data/guided-scenario.json', import.meta.url), 'utf8')) as {
  variants: { id: string; note: string }[];
};
const NOTE = Object.fromEntries(scenario.variants.map((v) => [v.id, v.note]));
const popover = (page: Page): Locator => page.locator('.driver-popover');
const coach = (page: Page): Locator => page.getByRole('region', { name: 'Guided demo' });

// Starts a scenario with the tutorial hidden, writes the note, finishes the visit.
async function finishWithNote(page: Page, note: string): Promise<ScenarioIds> {
  const ids = await startScenario(page, { tutorial: false });
  await openTodaysVisit(page, ids);
  await setVisitStatus(page, 'In Progress');
  await writeNote(page, note);
  await beat(page);
  await setVisitStatus(page, 'Finished');
  return ids;
}

test('tutorial walks the primary path: conflict, edit, agreement, sign', async ({ page, medplum }) => {
  const ids = await startScenario(page, { tutorial: true });
  await expect(popover(page)).toContainText('Post-discharge follow-up');
  await beat(page);
  await popover(page).getByRole('button', { name: 'Next' }).click();
  await expect(popover(page)).toContainText('lisinopril 10 mg');
  await popover(page).getByRole('button', { name: 'Next' }).click();

  await expect(popover(page)).toContainText('Open Documents');
  await page.locator('.pill-tabs a[href$="/DocumentReference"]').click();
  await expect(popover(page)).toContainText('comes from another organization');
  await beat(page, 2000);
  await popover(page).getByRole('button', { name: 'Next' }).click();

  await expect(popover(page)).toContainText('Go to Visits');
  await page.locator('.pill-tabs a[href$="/Encounter"]').click();
  await expect(popover(page)).toContainText('Set the visit to In Progress');
  await setVisitStatus(page, 'In Progress');

  await expect(popover(page)).toContainText('Write the visit note');
  const next = popover(page).getByRole('button', { name: 'Next' });
  await expect(next).toBeDisabled();
  await writeNote(page, NOTE['shortcut-from-chart']);
  await expect(next).toBeEnabled();
  await next.click();

  await expect(popover(page)).toContainText('Set the visit to Finished');
  await setVisitStatus(page, 'Finished');
  await expect(coach(page)).toContainText('Checking the note');
  await expect(popover(page)).toContainText('What the check found', { timeout: 90_000 });
  await expectReview(page, 'Potential conflict');
  await expect(reviewCard(page).locator('mark').first()).toContainText('increased from 10 mg to 20 mg');
  await reviewCard(page).getByRole('button', { name: 'Details' }).click();
  await beat(page, 2000);
  await popover(page).getByRole('button', { name: 'Next' }).click();

  await expect(popover(page)).toContainText('Choose how to handle it');
  await page.getByRole('button', { name: 'Edit note' }).click();
  await writeNote(page, NOTE['resolved-after-edit']);
  await expect(popover(page)).toContainText('Run Check note again');
  await checkNote(page);
  await expectReview(page, 'Agreement');

  await expect(popover(page)).toContainText('Sign and lock the note');
  await signAndLock(page);
  await expect(popover(page)).toContainText('The visit now shows your signature');
  await popover(page).getByRole('button', { name: 'Done' }).click();
  await expect(coach(page)).toContainText('Tutorial complete');

  const checks = await fhirSearch(medplum, `DetectedIssue?implicated=Encounter/${ids.encounterId}&_sort=-identified`);
  expect(checks.map((c) => c.detail.split(' (')[0])).toEqual(['Agreement', 'Potential conflict']);
  await beat(page);
});

test('sign with a documented reason records it on the signature and the check', async ({ page, medplum }) => {
  const ids = await finishWithNote(page, NOTE['shortcut-from-chart']);
  await expectReview(page, 'Potential conflict');
  await beat(page);

  await page.getByRole('button', { name: 'Sign with a documented reason' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Reason for signing despite the consistency check');
  const lock = dialog.getByRole('button', { name: 'Sign & Lock Note' });
  await expect(lock).toBeDisabled();
  const reason = 'Patient reports the hospital told them to stay on 10 mg; calling the hospital to confirm.';
  await dialog.locator('input').first().fill(reason);
  await beat(page);
  await lock.click();
  await expect(page.getByText(`Reason: ${reason}`)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit note' })).toHaveCount(0);

  const [provenance] = await fhirSearch(medplum, `Provenance?target=Encounter/${ids.encounterId}`);
  expect(provenance.reason[0].text).toBe(reason);
  const [check] = await fhirSearch(medplum, `DetectedIssue?implicated=Encounter/${ids.encounterId}`);
  expect(provenance.entity[0].what.reference).toBe(`DetectedIssue/${check.id}`);
  expect(check.status).toBe('final');
  expect(check.mitigation[0].action.text).toBe('Signed with documented reason');
  await beat(page);
});

test('reconciliation task stays open after Sign & Lock', async ({ page, medplum }) => {
  const ids = await finishWithNote(page, NOTE['shortcut-from-chart']);
  await expectReview(page, 'Potential conflict');
  await beat(page);

  await page.getByRole('button', { name: 'Create reconciliation task' }).click();
  await expect(reviewCard(page).getByText('Open task')).toBeVisible();
  await expect(reviewCard(page)).toContainText('Reconciliation task created');
  await signAndLock(page);

  const [check] = await fhirSearch(medplum, `DetectedIssue?implicated=Encounter/${ids.encounterId}`);
  const [task] = await fhirSearch(medplum, `Task?focus=DetectedIssue/${check.id}`);
  expect(task.status).toBe('requested');
  expect(task.encounter).toBeUndefined();
  expect(task.code.text).toBe('Reconcile lisinopril dose with outside discharge summary');

  await page.goto(`/Patient/${ids.patientId}/Task`);
  await expect(page.getByText('Reconcile lisinopril dose with outside discharge summary').first()).toBeVisible();
  await beat(page, 2000);
});

test('side path: a note with no dose is insufficient information', async ({ page }) => {
  await finishWithNote(page, NOTE['no-dose']);
  await expectReview(page, 'Insufficient information');
  await expect(reviewCard(page)).toContainText('The dose is missing, not necessarily wrong');
  await beat(page, 2000);
});

test('side path: a note that acknowledges the change agrees and skips to signing', async ({ page }) => {
  await finishWithNote(page, NOTE['resolved-after-edit']);
  await expectReview(page, 'Agreement');
  await expect(page.getByRole('button', { name: 'Edit note' })).toHaveCount(0);
  // The card is a reading step, then "handle" and "check again" are skipped.
  await expect(coach(page)).toContainText('Step 9 of 13: What the check found');
  await coach(page).getByRole('button', { name: 'Resume' }).click();
  await expect(popover(page)).toContainText('What the check found');
  await beat(page);
  await popover(page).getByRole('button', { name: 'Next' }).click();
  await expect(popover(page)).toContainText('Sign and lock the note');
  await beat(page, 2000);
});

test('side path: an unexplained 40 mg is flagged', async ({ page }) => {
  await finishWithNote(page, NOTE['unexplained-40mg']);
  await expectReview(page, 'Potential conflict');
  await expect(reviewCard(page)).toContainText('disagree about lisinopril');
  // Jev may not pick "increase to 40 mg" as the note's current-dose sentence, so no highlight is required.
  await expect(reviewCard(page)).toContainText('increase lisinopril to 40 mg daily');
  await beat(page, 2000);
});

test('editing the note after a check marks the check stale', async ({ page }) => {
  await finishWithNote(page, NOTE['shortcut-from-chart']);
  await expectReview(page, 'Potential conflict');
  await expect(page.getByText('Note changed since this check')).toHaveCount(0);
  await writeNote(page, NOTE['resolved-after-edit']);
  await expect(page.getByText('Note changed since this check')).toBeVisible();
  // The card keeps showing the text that was checked.
  await expect(reviewCard(page)).toContainText('continue lisinopril 10 mg daily');
  await beat(page, 2000);
});

test('tutorial hidden from the start: unguided work, reload, resume at signing', async ({ page }) => {
  const ids = await startScenario(page, { tutorial: true });
  await expect(popover(page)).toContainText('Post-discharge follow-up');
  await page.keyboard.press('Escape');
  await expect(popover(page)).toHaveCount(0);
  await expect(coach(page)).toContainText('Tutorial hidden');

  await openTodaysVisit(page, ids);
  await expect(popover(page)).toHaveCount(0);
  await setVisitStatus(page, 'In Progress');
  await writeNote(page, NOTE['shortcut-from-chart']);
  await setVisitStatus(page, 'Finished');
  await expectReview(page, 'Potential conflict');
  await page.getByRole('button', { name: 'Edit note' }).click();
  await writeNote(page, NOTE['resolved-after-edit']);
  await checkNote(page);
  await expectReview(page, 'Agreement');

  await page.reload();
  await expect(coach(page)).toContainText('Tutorial hidden · Step 12 of 13: Sign');
  await expect(popover(page)).toHaveCount(0);
  await coach(page).getByRole('button', { name: 'Resume' }).click();
  await expect(popover(page)).toContainText('Sign and lock the note');
  await beat(page, 2000);
});
