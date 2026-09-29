import assert from 'node:assert/strict';
import { copyFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

// Load the actual artifact as user.mjs, matching the hosted loader.
// Moving it also verifies that the model contract is bundled.
const directory = await mkdtemp(join(tmpdir(), 'medplum-bot-esm-'));
const artifact = join(directory, 'user.mjs');
await copyFile(new URL('../bot-dist/consistency-bot.mjs', import.meta.url), artifact);
const { handler } = await import(pathToFileURL(artifact).href);

const event = (input, secrets = {}) => ({ requester: { reference: 'Practitioner/reviewer' }, input, secrets });
const unreachable = new Proxy({}, { get: () => () => assert.fail('The chart must not be read') });

test('ESM artifact exports the handler and reports a missing backend without reading the chart', async () => {
  assert.equal(typeof handler, 'function');
  const result = await handler(unreachable, event({ action: 'review_encounter', encounter_id: 'visit-1' }));
  assert.equal(result.status, 'unavailable');
  assert.match(result.reason, /CONSISTENCY_BACKEND/);
});

test('deployment artifact rejects visitor documents', async () => {
  await assert.rejects(
    handler(unreachable, event({ action: 'review_encounter', encounter_id: 'visit-1', text: 'Unexpected visitor text' })),
    /Only \{ action: "review_encounter", encounter_id \} is accepted/
  );
});
