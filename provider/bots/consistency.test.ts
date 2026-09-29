import type { BotEvent, WithId } from '@medplum/core';
import type { ClinicalImpression, DocumentReference, Encounter, Patient } from '@medplum/fhirtypes';
import { MockClient } from '@medplum/mock';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import scenario from '../src/data/guided-scenario.json';
import contract from '../src/data/model-contract.json';
import { buildRequest, handler, medicationName, splitSentences } from './consistency';

const NOTE = scenario.variants[0].note;
let medplum: MockClient;
let patient: WithId<Patient>;
let encounter: WithId<Encounter>;
let impression: WithId<ClinicalImpression>;

const secrets = (values: Record<string, string | undefined>): BotEvent['secrets'] =>
  Object.fromEntries(Object.entries(values).map(([name, valueString]) => [name, { name, valueString }]));

const event = (
  input: unknown,
  values: Record<string, string | undefined> = { TYPESAFE_API_KEY: 'ts-test' }
): BotEvent => ({
  bot: { reference: 'Bot/consistency' },
  contentType: 'application/json',
  input,
  requester: { reference: 'Practitioner/reviewer' },
  secrets: secrets(values),
});
const review = (): unknown => ({ action: 'review_encounter', encounter_id: encounter.id });

function choice(probabilities: Record<string, number>): unknown {
  const best = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0];
  return { type: 'choice', choice: best, probabilities, confidence: 0.7 };
}

function sentenceChoice(count: number, picked: number): unknown {
  // 0.9 on the picked sentence, the rest spread over the other options including `none`.
  const rest = 0.1 / count;
  return choice({
    ...Object.fromEntries(Array.from({ length: count }, (_, n) => [`s${n + 1}`, n === picked ? 0.9 : rest])),
    none: rest,
  });
}

function modelResponse(): unknown {
  const outside = splitSentences(scenario.discharge_summary);
  const note = splitSentences(NOTE);
  return {
    model: 'jev-1.13.0',
    answers: {
      mentions_hospital_stay: { type: 'noul', noul: 0.2 },
      dose_0: choice({ agreement: 0.1, potential_conflict: 0.8, insufficient_information: 0.1 }),
      sentence_outside_document_0: sentenceChoice(outside.length, 2),
      sentence_visit_note_0: sentenceChoice(note.length, 4),
    },
    usage: { input_tokens: 812, output_tokens: 40 },
  };
}

async function discharge(
  date: string,
  text: string,
  extra: Partial<DocumentReference> = {}
): Promise<DocumentReference> {
  return medplum.createResource<DocumentReference>({
    resourceType: 'DocumentReference',
    status: 'current',
    type: { coding: [{ system: 'http://loinc.org', code: '18842-5', display: 'Discharge summary' }] },
    subject: { reference: `Patient/${patient.id}` },
    date,
    description: 'Discharge summary',
    author: [{ display: 'Outside Hospital (synthetic)' }],
    content: [{ attachment: { contentType: 'text/plain', data: Buffer.from(text).toString('base64') } }],
    ...extra,
  });
}

beforeEach(async () => {
  medplum = new MockClient();
  patient = await medplum.createResource<Patient>({ resourceType: 'Patient', name: [{ family: 'Demo' }] });
  encounter = await medplum.createResource<Encounter>({
    resourceType: 'Encounter',
    status: 'finished',
    class: { code: 'AMB' },
    subject: { reference: `Patient/${patient.id}` },
    period: { start: '2026-09-23T14:00:00Z' },
  });
  impression = await medplum.createResource<ClinicalImpression>({
    resourceType: 'ClinicalImpression',
    status: 'in-progress',
    subject: { reference: `Patient/${patient.id}` },
    encounter: { reference: `Encounter/${encounter.id}` },
    note: [{ text: NOTE }],
  });
  await medplum.createResource({
    resourceType: 'MedicationRequest',
    status: 'active',
    intent: 'order',
    subject: { reference: `Patient/${patient.id}` },
    medicationCodeableConcept: {
      coding: [
        {
          system: 'http://www.nlm.nih.gov/research/umls/rxnorm',
          code: '314076',
          display: 'lisinopril 10 MG Oral Tablet',
        },
      ],
    },
  });
  await discharge('2026-08-01T12:00:00Z', 'An older discharge summary that must not be used.');
  await discharge('2026-09-16T12:00:00Z', scenario.discharge_summary);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(modelResponse()), { status: 200 }))
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('consistency Bot', () => {
  test('sends the chart note, newest discharge summary and medication to hosted Jev', async () => {
    const result = await handler(medplum, event(review()));
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(contract.endpoint);
    expect(init.redirect).toBe('error');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ts-test');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual(
      buildRequest(
        ['lisinopril'],
        {
          title: 'Discharge summary',
          date: '2026-09-16',
          author: 'Outside Hospital (synthetic)',
          text: scenario.discharge_summary,
        },
        { title: "Today's visit note", date: '2026-09-23', author: "this clinic's provider", text: NOTE }
      )
    );
    expect(body.model).toBe('jev-latest');
    expect(body.questions.dose_0.instructions).toContain('lisinopril');
    expect(Object.keys(body.questions.dose_0.criteria)).toEqual(contract.labels);
    expect(JSON.stringify(body)).not.toContain('older discharge summary');

    expect(result).toMatchObject({
      status: 'ok',
      model: 'jev-1.13.0',
      input_tokens: 812,
      mentions_hospital_stay: 0.2,
      note_version: impression.meta?.versionId,
      results: [
        {
          medication: 'lisinopril',
          choice: 'potential_conflict',
          confidence: 0.7,
          sentence_outside: splitSentences(scenario.discharge_summary)[2],
          sentence_note: 'Plan: continue lisinopril 10 mg daily.',
        },
      ],
    });
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.documents.map((d) => d.source)).toEqual([
      expect.stringMatching(/^DocumentReference\//),
      `ClinicalImpression/${impression.id}`,
    ]);
  });

  test('never writes to the chart', async () => {
    const writes = [
      vi.spyOn(medplum, 'createResource'),
      vi.spyOn(medplum, 'updateResource'),
      vi.spyOn(medplum, 'patchResource'),
      vi.spyOn(medplum, 'deleteResource'),
    ];
    await handler(medplum, event(review()));
    for (const write of writes) expect(write).not.toHaveBeenCalled();
  });

  test('reads a Binary when the attachment has only a URL', async () => {
    const summaries = await medplum.searchResources('DocumentReference', { type: 'http://loinc.org|18842-5' });
    for (const doc of summaries) await medplum.updateResource({ ...doc, status: 'superseded' });
    vi.spyOn(medplum, 'download').mockResolvedValue(new Blob([scenario.discharge_summary]));
    await discharge('2026-09-16T12:00:00Z', '', {
      content: [{ attachment: { contentType: 'text/plain', url: 'Binary/summary' } }],
    });
    const result = await handler(medplum, event(review()));
    expect(result.status).toBe('ok');
    expect(medplum.download).toHaveBeenCalledWith('Binary/summary');
  });

  test.each([
    ['no note', async () => medplum.updateResource({ ...impression, note: undefined }), 'No chart note has been saved'],
    [
      'no document',
      async () => {
        for (const doc of await medplum.searchResources('DocumentReference', {}))
          await medplum.updateResource({ ...doc, status: 'entered-in-error' });
      },
      'No outside discharge summary',
    ],
    [
      'non-text attachment',
      async () =>
        discharge('2026-09-20T12:00:00Z', 'x', {
          content: [{ attachment: { contentType: 'application/pdf', data: 'eA==' } }],
        }),
      'not plain text',
    ],
    [
      'oversized note',
      async () => medplum.updateResource({ ...impression, note: [{ text: 'x'.repeat(contract.limits.text_max + 1) }] }),
      'too long',
    ],
    [
      'no active medications',
      async () => {
        for (const mr of await medplum.searchResources('MedicationRequest', {}))
          await medplum.updateResource({ ...mr, status: 'stopped' });
      },
      'No active medications',
    ],
  ])('fails before any network call: %s', async (_name, arrange, reason) => {
    await arrange();
    const result = await handler(medplum, event(review()));
    expect(result).toEqual({ status: 'unavailable', reason: expect.stringContaining(reason) });
    expect(fetch).not.toHaveBeenCalled();
  });

  test('reports an inaccessible visit', async () => {
    const result = await handler(medplum, event({ action: 'review_encounter', encounter_id: 'missing' }));
    expect(result).toEqual({ status: 'unavailable', reason: 'This visit is not accessible' });
  });

  test.each([
    { action: 'review_encounter', encounter_id: 'abc', text: 'visitor document' },
    { action: 'check', encounter_id: 'abc' },
    { action: 'review_encounter', encounter_id: '../Patient/1' },
    { action: 'review_encounter', encounter_id: 'x'.repeat(65) },
    { action: 'review_encounter', encounter_id: 5 },
    null,
    [],
  ])('rejects unapproved input %j', async (input) => {
    await expect(handler(medplum, event(input))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  test('rejects a missing caller identity', async () => {
    await expect(handler(medplum, { ...event(review()), requester: undefined })).rejects.toThrow('signed-in');
  });

  test.each([
    [{}, 'CONSISTENCY_BACKEND must be'],
    [{ CONSISTENCY_BACKEND: 'typesafe' }, 'Missing string project secret: TYPESAFE_API_KEY'],
    [{ CONSISTENCY_BACKEND: 'modal', TYPESAFE_API_KEY: 'ts-test' }, 'Modal backend does not accept visit text yet'],
    [{ CONSISTENCY_BACKEND: 'other', TYPESAFE_API_KEY: 'ts-test' }, 'CONSISTENCY_BACKEND must be'],
  ])('chooses the backend from project secrets %j', async (values, reason) => {
    const result = await handler(medplum, event(review(), values));
    expect(result).toEqual({ status: 'unavailable', reason: expect.stringContaining(reason) });
    expect(fetch).not.toHaveBeenCalled();
  });

  test.each([
    [401, 'rejected the project credentials'],
    [422, 'rejected the request format'],
  ])('fails closed on HTTP %i without echoing the key or text', async (status, reason) => {
    vi.mocked(fetch).mockResolvedValue(new Response(`{"detail":"${NOTE} ts-test"}`, { status }));
    const result = await handler(medplum, event(review()));
    expect(result).toEqual({ status: 'unavailable', reason: expect.stringContaining(reason) });
    expect(JSON.stringify(result)).not.toContain('ts-test');
    expect(JSON.stringify(result)).not.toContain('lisinopril 10 mg');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test.each([429, 529])('retries HTTP %i once', async (status) => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response('', { status }))
      .mockResolvedValueOnce(new Response(JSON.stringify(modelResponse())));
    const pending = handler(medplum, event(review()));
    await vi.runAllTimersAsync();
    expect((await pending).status).toBe('ok');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test('gives up after a second overload', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    vi.mocked(fetch).mockImplementation(async () => new Response('', { status: 529 }));
    const pending = handler(medplum, event(review()));
    await vi.runAllTimersAsync();
    expect(await pending).toEqual({ status: 'unavailable', reason: expect.stringContaining('overloaded') });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test.each([
    { dose_0: { type: 'noul', noul: 0.5 } },
    { dose_0: choice({ agreement: 0.5, potential_conflict: 0.5 }) },
    {
      dose_0: {
        ...(choice({ agreement: 0.1, potential_conflict: 0.8, insufficient_information: 0.1 }) as object),
        choice: 'agreement',
      },
    },
    { dose_0: choice({ agreement: 0.5, potential_conflict: 0.8, insufficient_information: 0.1 }) },
    { mentions_hospital_stay: { type: 'noul', noul: 2 } },
  ])('rejects an invalid model answer', async (patch) => {
    const response = modelResponse() as { answers: Record<string, unknown> };
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ ...response, answers: { ...response.answers, ...patch } }))
    );
    expect(await handler(medplum, event(review()))).toEqual({
      status: 'unavailable',
      reason: 'The model returned an invalid answer',
    });
  });

  test('drops an unusable highlight but keeps the result', async () => {
    const response = modelResponse() as { answers: Record<string, unknown> };
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({ ...response, answers: { ...response.answers, sentence_visit_note_0: { type: 'noul' } } })
      )
    );
    const result = await handler(medplum, event(review()));
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.results[0].sentence_note).toBeUndefined();
    expect(result.results[0].sentence_outside).toBeDefined();
  });

  test('extracts the medication name from the RxNorm display', () => {
    expect(
      medicationName({
        resourceType: 'MedicationRequest',
        status: 'active',
        intent: 'order',
        subject: {},
        medicationCodeableConcept: { coding: [{ display: 'Lisinopril 10 MG Oral Tablet' }] },
      })
    ).toBe('lisinopril');
  });
});
