import type { APIRequestContext, Page, Route } from '@playwright/test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReviewOutput } from '../bots/consistency.ts';

// Records the consistency Bot's responses (which carry hosted Jev's answers) per test, and
// replays them on later runs so tests do not call the Bot or TypeSafe again.
//
// - E2E_RECORD=1: requests go to the real Bot; each response is saved to
//   e2e/cassettes/<test>.json with run-specific ids replaced by placeholders.
// - Otherwise: each Bot request is answered from the cassette, in order, with the current
//   run's ids filled in. A missing cassette, an extra or missing call, a note that no
//   longer matches the recording, or a change to the Bot's questions fails the test and
//   asks for a re-record.

export const RECORDING = process.env.E2E_RECORD === '1';
const CASSETTE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'cassettes');
const BOT_EXECUTE = /\/fhir\/R4\/Bot\/[^/]+\/\$execute$/;
// The model, labels, limits and question wording the Bot sends. Answers recorded under other
// questions would no longer show what the model does now.
export const CONTRACT_SHA256 = createHash('sha256')
  .update(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data', 'model-contract.json')))
  .digest('hex');

type Ok = Extract<ReviewOutput, { status: 'ok' }>;

export interface Cassette {
  description: string;
  recorded_at: string;
  /** SHA-256 of src/data/model-contract.json when recorded. */
  contract_sha256: string;
  interactions: { note: string; response: Ok }[];
}

interface ChartIds {
  documentReferenceId: string;
  documentVersion: string;
  clinicalImpressionId: string;
  noteVersion: string;
  noteText: string;
}

function cassettePath(name: string): string {
  return join(CASSETTE_DIR, `${name}.json`);
}

async function chartIds(medplum: APIRequestContext, encounterId: string): Promise<ChartIds> {
  const get = async (path: string): Promise<any> => {
    const response = await medplum.get(path, { headers: { 'Cache-Control': 'no-cache' } });
    if (!response.ok()) {
      throw new Error(`GET ${path.split('?')[0]} failed: ${response.status()}`);
    }
    return response.json();
  };
  const encounter = await get(`Encounter/${encounterId}`);
  const [impressions, summaries] = await Promise.all([
    get(
      `ClinicalImpression?encounter=Encounter/${encounterId}&subject=${encounter.subject.reference}&_sort=-_lastUpdated&_count=1`
    ),
    get(
      `DocumentReference?subject=${encounter.subject.reference}&type=http://loinc.org|18842-5&status=current&_sort=-date&_count=1`
    ),
  ]);
  const impression = impressions.entry?.[0]?.resource;
  const summary = summaries.entry?.[0]?.resource;
  return {
    documentReferenceId: summary?.id,
    documentVersion: summary?.meta?.versionId,
    clinicalImpressionId: impression?.id,
    noteVersion: impression?.meta?.versionId,
    noteText: impression?.note?.[0]?.text?.trim() ?? '',
  };
}

function normalize(response: Ok): Ok {
  return {
    ...response,
    checked_at: '{{now}}',
    note_version: '{{noteVersion}}',
    outside_version: '{{documentVersion}}',
    documents: [
      { ...response.documents[0], source: 'DocumentReference/{{documentReferenceId}}' },
      { ...response.documents[1], source: 'ClinicalImpression/{{clinicalImpressionId}}' },
    ],
  };
}

function fill(response: Ok, ids: ChartIds): Ok {
  return JSON.parse(
    JSON.stringify(response)
      .replaceAll('{{now}}', new Date().toISOString())
      .replaceAll('{{documentReferenceId}}', ids.documentReferenceId)
      .replaceAll('{{clinicalImpressionId}}', ids.clinicalImpressionId)
      .replaceAll('{{noteVersion}}', ids.noteVersion)
      .replaceAll('{{documentVersion}}', ids.documentVersion)
  );
}

/**
 * Routes the page's Bot calls through a cassette named after the test.
 *
 * @param page - The test page.
 * @param medplum - An authenticated FHIR request context, used to read the current run's ids.
 * @param name - Cassette file name.
 * @param description - Stored in the cassette to say which path it covers.
 * @returns A function that saves (record) or checks full use of (replay) the cassette.
 */
export async function useJevCassette(
  page: Page,
  medplum: APIRequestContext,
  name: string,
  description: string
): Promise<() => void> {
  const path = cassettePath(name);
  const recorded: Cassette | undefined = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
  if (!RECORDING && !recorded) {
    throw new Error(`No cassette at e2e/cassettes/${name}.json. Record it with: E2E_RECORD=1 npm run test:e2e`);
  }
  if (!RECORDING && recorded?.contract_sha256 !== CONTRACT_SHA256) {
    throw new Error(
      `Cassette ${name} was recorded with different Bot questions (src/data/model-contract.json changed). ` +
        'Re-record with: E2E_RECORD=1 npm run test:e2e'
    );
  }
  const interactions: Cassette['interactions'] = [];
  let used = 0;
  const failures: string[] = [];

  const handle = async (route: Route): Promise<void> => {
    const input = route.request().postDataJSON() as { encounter_id: string };
    const ids = await chartIds(medplum, input.encounter_id);
    if (RECORDING) {
      const response = await route.fetch();
      const body = (await response.json()) as ReviewOutput;
      if (body.status !== 'ok') {
        throw new Error(`The Bot answered "${body.reason}" while recording; fix the setup and record again.`);
      }
      interactions.push({ note: ids.noteText, response: normalize(body) });
      await route.fulfill({ response, json: body });
      return;
    }
    const next = recorded?.interactions[used++];
    if (!next) {
      throw new Error(
        `Cassette ${name} has ${recorded?.interactions.length} Bot calls; the test made more. Re-record.`
      );
    }
    if (next.note !== ids.noteText) {
      throw new Error(`The note sent in call ${used} differs from cassette ${name}. Re-record with E2E_RECORD=1.`);
    }
    await route.fulfill({ json: fill(next.response, ids) });
  };
  // A throw inside a route handler would leave the request hanging; abort it and fail at the end.
  await page.route(BOT_EXECUTE, (route) =>
    handle(route).catch(async (err: Error) => {
      failures.push(err.message);
      await route.abort().catch(() => undefined);
    })
  );

  return () => {
    if (failures.length) {
      throw new Error(failures.join('\n'));
    }
    if (RECORDING) {
      mkdirSync(CASSETTE_DIR, { recursive: true });
      const cassette: Cassette = {
        description,
        recorded_at: new Date().toISOString(),
        contract_sha256: CONTRACT_SHA256,
        interactions,
      };
      writeFileSync(path, JSON.stringify(cassette, null, 2) + '\n');
    } else if (used !== recorded?.interactions.length) {
      throw new Error(`Cassette ${name} has ${recorded?.interactions.length} Bot calls; the test made ${used}.`);
    }
  };
}
