import type { BotEvent, WithId } from '@medplum/core';
import type { ClinicalImpression, DocumentReference, Encounter, Patient } from '@medplum/fhirtypes';
import { MockClient } from '@medplum/mock';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import scenario from '../src/data/guided-scenario.json';
import contract from '../src/data/model-contract.json';
import { buildRequest, handler, medicationName, modalOrigin, splitSentences } from './consistency';

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
const MODAL = {
  CONSISTENCY_BACKEND: 'modal',
  CONSISTENCY_MODEL_URL: 'https://example--healthcare-consistency-inference.us-east.modal.direct',
  CONSISTENCY_MODAL_KEY: 'wk-test',
  CONSISTENCY_MODAL_SECRET: 'ws-test',
};

function choice(probabilities: Record<string, number>): unknown {
  const best = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0];
  return { type: 'choice', choice: best, probabilities, confidence: 0.7 };
}

function sentenceChoice(count: number, picked: number | 'none'): unknown {
  // 0.9 on the picked option, the rest spread over the other options.
  const rest = 0.1 / count;
  return choice({
    ...Object.fromEntries(Array.from({ length: count }, (_, n) => [`s${n + 1}`, n === picked ? 0.9 : rest])),
    none: picked === 'none' ? 0.9 : rest,
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
        { title: "Today's visit note", date: '2026-09-23', author: "this clinic's provider", text: NOTE },
        contract.limits.max_sentences
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
    [
      { CONSISTENCY_BACKEND: 'modal', TYPESAFE_API_KEY: 'ts-test' },
      'Missing string project secret: CONSISTENCY_MODEL_URL',
    ],
    [{ ...MODAL, CONSISTENCY_MODAL_SECRET: undefined }, 'Missing string project secret: CONSISTENCY_MODAL_SECRET'],
    [{ ...MODAL, CONSISTENCY_MODEL_URL: 'https://example.modal.run/v1/systemone' }, 'HTTPS Modal Server origin'],
    [{ CONSISTENCY_BACKEND: 'other', TYPESAFE_API_KEY: 'ts-test' }, 'CONSISTENCY_BACKEND must be'],
  ])('chooses the backend from project secrets %j', async (values, reason) => {
    const result = await handler(medplum, event(review(), values));
    expect(result).toEqual({ status: 'unavailable', reason: expect.stringContaining(reason) });
    expect(fetch).not.toHaveBeenCalled();
  });

  function noDoseResponse(
    noteAnswer: unknown,
    dose: Record<string, number> = { agreement: 0.78, potential_conflict: 0.02, insufficient_information: 0.2 }
  ): unknown {
    const response = modelResponse() as { answers: Record<string, unknown> };
    const note = splitSentences(NOTE);
    return {
      ...response,
      answers: {
        ...response.answers,
        dose_0: choice(dose),
        sentence_visit_note_0: noteAnswer ?? sentenceChoice(note.length, 'none'),
      },
    };
  }

  test.each([
    ['hosted Jev', { TYPESAFE_API_KEY: 'ts-test' }],
    ['Modal', MODAL],
  ])('on %s, a document with no dose sentence makes an agreement insufficient information', async (_name, values) => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(noDoseResponse(undefined))));
    const result = await handler(medplum, event(review(), values));
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.results[0]).toMatchObject({
      choice: 'insufficient_information',
      label_rule: 'no_dose_sentence',
      probabilities: { agreement: 0.78, potential_conflict: 0.02, insufficient_information: 0.2 },
    });
    expect(result.results[0].sentence_note).toBeUndefined();
  });

  test('keeps the model label for an unusable highlight answer', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(noDoseResponse({ type: 'noul', noul: 0.5 }))));
    const result = await handler(medplum, event(review(), MODAL));
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.results[0].choice).toBe('agreement');
    expect(result.results[0].label_rule).toBeUndefined();
  });

  test('on Modal, never downgrades a potential conflict', async () => {
    const conflict = { agreement: 0.1, potential_conflict: 0.8, insufficient_information: 0.1 };
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(noDoseResponse(undefined, conflict))));
    const result = await handler(medplum, event(review(), MODAL));
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.results[0].choice).toBe('potential_conflict');
    expect(result.results[0].label_rule).toBeUndefined();
  });

  test('on Modal, drops the highlight of a document longer than the server takes, not the check', async () => {
    // Jebadiah's server refuses a choice with more than 20 criteria: 20 sentences plus `none`.
    const long = Array.from({ length: 20 }, (_, n) => `Line ${n + 1} of the plan.`).join(' ');
    await discharge('2026-09-17T12:00:00Z', `${long} Lisinopril 20 mg daily.`);
    await handler(medplum, event(review(), MODAL));
    const modal = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string);
    expect(modal.questions.sentence_outside_document_0).toBeUndefined();
    expect(modal.questions.sentence_visit_note_0).toBeDefined();
    await handler(medplum, event(review()));
    const hosted = JSON.parse(vi.mocked(fetch).mock.calls[1][1]?.body as string);
    expect(Object.keys(hosted.questions.sentence_outside_document_0.criteria)).toHaveLength(22);
  });

  test('on Modal, keeps the label when both documents have a dose sentence', async () => {
    const result = await handler(medplum, event(review(), MODAL));
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.results[0].choice).toBe('potential_conflict');
    expect(result.results[0].label_rule).toBeUndefined();
  });

  test('sends the same request to the self-hosted Modal Server with its proxy token', async () => {
    const result = await handler(medplum, event(review(), MODAL));
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${MODAL.CONSISTENCY_MODEL_URL}/v1/systemone`);
    expect(init.redirect).toBe('error');
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      'Modal-Key': 'wk-test',
      'Modal-Secret': 'ws-test',
    });
    const typesafe = vi.mocked(fetch).mock.calls.length;
    await handler(medplum, event(review()));
    expect(init.body).toBe(vi.mocked(fetch).mock.calls[typesafe][1]?.body);
    expect(result.status).toBe('ok');
  });

  test.each([
    [503, 'starting or unavailable'],
    [403, 'rejected the project credentials'],
    [422, 'may be too long'],
  ])('reports Modal HTTP %i without echoing the token or text', async (status, reason) => {
    vi.mocked(fetch).mockResolvedValue(new Response(`{"detail":"${NOTE} ws-test"}`, { status }));
    const result = await handler(medplum, event(review(), MODAL));
    expect(result).toEqual({ status: 'unavailable', reason: expect.stringContaining(reason) });
    expect(JSON.stringify(result)).not.toContain('ws-test');
    expect(JSON.stringify(result)).not.toContain('lisinopril 10 mg');
  });

  test('reports a Modal cold start that outlasts the Bot', async () => {
    vi.mocked(fetch).mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
    const result = await handler(medplum, event(review(), MODAL));
    expect(result).toEqual({ status: 'unavailable', reason: expect.stringContaining('may be starting') });
  });

  test.each([
    ['https://example.modal.run', 'https://example.modal.run'],
    ['https://example.us-east.modal.direct/', 'https://example.us-east.modal.direct'],
    ['http://example.modal.run', undefined],
    ['https://example.modal.run.evil.invalid', undefined],
    ['https://user:pw@example.modal.run', undefined],
    ['https://example.modal.run:8443', undefined],
    ['https://example.modal.run/check', undefined],
    ['https://example.modal.run?x=1', undefined],
    ['https://example.modal.run#x', undefined],
    ['`https://example.modal.run`', undefined],
  ])('accepts only a Modal Server origin: %s', (value, origin) => {
    expect(modalOrigin(value)).toBe(origin);
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
