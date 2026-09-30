import type { BotEvent, MedplumRequestOptions, WithId } from '@medplum/core';
import { ReadablePromise } from '@medplum/core';
import type { ClinicalImpression, DocumentReference, Encounter, Patient } from '@medplum/fhirtypes';
import { MockClient } from '@medplum/mock';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import scenario from '../src/data/guided-scenario.json';
import contract from '../src/data/model-contract.json';
import { buildRequest, handler, modalOrigin, resolveMedications, splitSentences } from './consistency';

const NOTE = scenario.variants[0].note;
let medplum: MockClient;
let lookupMock = vi.fn<(url: URL, options?: MedplumRequestOptions) => Promise<unknown>>();
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
  lookupMock = vi.fn(async (url: URL) => {
    const code = new URL(url).searchParams.get('code');
    if (code === '314076') return terminology('lisinopril 10 MG Oral Tablet', 'SCD', ['{316151} 29046']);
    if (code === '29046') return terminology('lisinopril', 'IN');
    throw new Error('Unexpected lookup');
  });
  const originalGet = medplum.get.bind(medplum);
  vi.spyOn(medplum, 'get').mockImplementation((url, options) => {
    const parsed = new URL(url);
    return parsed.pathname.endsWith('/CodeSystem/$lookup')
      ? new ReadablePromise(lookupMock(parsed, options))
      : originalGet(url, options);
  });
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
    const summary = await medplum.readReference<DocumentReference>({ reference: result.documents[0].source });
    expect(result.outside_version).toBe(summary.meta?.versionId);
  });

  test("reads the newest note of this visit's patient", async () => {
    const searchOne = vi.spyOn(medplum, 'searchOne');
    const older = await medplum.createResource<ClinicalImpression>({
      ...impression,
      id: undefined,
      meta: undefined,
      note: [{ text: 'An older note for this visit.' }],
    });
    // Saving the note makes it the newest again.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await medplum.updateResource({ ...impression, note: [{ text: NOTE }] });
    // A note that names this encounter but another patient is never read.
    await medplum.createResource<ClinicalImpression>({
      ...impression,
      id: undefined,
      meta: undefined,
      subject: { reference: 'Patient/someone-else' },
      note: [{ text: 'A note for another patient.' }],
    });

    const result = await handler(medplum, event(review()));
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.documents[1]).toMatchObject({ source: `ClinicalImpression/${impression.id}`, text: NOTE });
    expect(result.documents[1].source).not.toContain(older.id);
    expect(searchOne).toHaveBeenCalledWith(
      'ClinicalImpression',
      {
        encounter: `Encounter/${encounter.id}`,
        subject: `Patient/${patient.id}`,
        _sort: '-_lastUpdated',
        _count: '1',
      },
      expect.objectContaining({ maxRetries: 0 })
    );
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
    expect(medplum.download).toHaveBeenCalledWith(
      'Binary/summary',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
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
});

function terminology(name: string, tty: string, ai: string[] = [], related: string[] = []): unknown {
  return {
    resourceType: 'Parameters',
    parameter: [
      { name: 'display', valueString: name },
      ...[
        ['tty', tty],
        ...ai.map((value) => ['RXN_AI', value]),
        ...related.map((value) => ['ingredient_of', value]),
      ].map(([code, value]) => ({
        name: 'property',
        part: [
          { name: 'code', valueCode: code },
          { name: 'value', [code === 'RXN_AI' ? 'valueString' : 'valueCode']: value },
        ],
      })),
    ],
  };
}

/** A request that never answers and rejects when its signal aborts, as MedplumClient and fetch do. */
function stalled(signal: AbortSignal | null | undefined): Promise<never> {
  return new Promise((_, reject) =>
    signal?.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')))
  );
}

function medication(code?: string): import('@medplum/fhirtypes').MedicationRequest {
  return {
    resourceType: 'MedicationRequest',
    status: 'active',
    intent: 'order',
    subject: {},
    medicationCodeableConcept: {
      coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code, display: 'Wrong 123 display' }],
    },
  };
}

describe('RxNorm ingredient resolution', () => {
  test('ignores display and deduplicates drug strengths and direct ingredient codes', async () => {
    lookupMock.mockImplementation(async (url) => {
      const code = new URL(url).searchParams.get('code');
      return code === '29046'
        ? terminology('lisinopril', 'IN')
        : terminology('wrong display', 'SCD', ['{316151} 29046']);
    });
    expect(
      await resolveMedications(medplum, [
        medication('314076'),
        medication('314076'),
        medication('314077'),
        medication('29046'),
      ])
    ).toEqual(['lisinopril']);
    expect(lookupMock).toHaveBeenCalledTimes(3);
    await resolveMedications(medplum, [medication('29046')]);
    expect(lookupMock).toHaveBeenCalledTimes(4);
  });

  test('keeps every combination ingredient in one target and deduplicates by the sorted code set', async () => {
    lookupMock.mockImplementation(async (url) => {
      const code = new URL(url).searchParams.get('code');
      if (code === '2264108') return terminology('fibrinogen, human', 'PIN');
      if (code === '825006') return terminology('thrombin, human', 'PIN');
      const ai = ['{2572161} 2264108', '{2572162} 825006'];
      return terminology('TachoSil 171 MG', 'SBD', code === '1014305' ? ai : ai.reverse());
    });
    expect(await resolveMedications(medplum, [medication('1014305'), medication('1001593')])).toEqual([
      'fibrinogen, human + thrombin, human',
    ]);
    expect(lookupMock).toHaveBeenCalledTimes(4);
  });

  test('sends a combination as one model question and returns one result', async () => {
    const [request] = await medplum.searchResources('MedicationRequest', {});
    await medplum.updateResource({
      ...request,
      medicationCodeableConcept: medication('1014305').medicationCodeableConcept,
    });
    lookupMock.mockImplementation(async (url) => {
      const code = url.searchParams.get('code');
      if (code === '2264108') return terminology('fibrinogen, human', 'PIN');
      if (code === '825006') return terminology('thrombin, human', 'PIN');
      return terminology('TachoSil', 'SBD', ['{2572161} 2264108', '{2572162} 825006']);
    });
    const result = await handler(medplum, event(review()));
    expect(result).toMatchObject({ status: 'ok', results: [{ medication: 'fibrinogen, human + thrombin, human' }] });
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string);
    expect(body.state.active_medications).toEqual(['fibrinogen, human + thrombin, human']);
    expect(body.questions.dose_0.instructions).toContain('fibrinogen, human + thrombin, human');
    expect(body.questions.dose_1).toBeUndefined();
  });

  test('rejects a paginated medication list rather than checking only its first page', async () => {
    const requests = await medplum.searchResources('MedicationRequest', {});
    requests.bundle.link = [{ relation: 'next', url: 'MedicationRequest?_offset=100' }];
    const originalSearch = medplum.searchResources.bind(medplum);
    vi.spyOn(medplum, 'searchResources').mockImplementation((type, query, options) =>
      type === 'MedicationRequest'
        ? new ReadablePromise(Promise.resolve(requests))
        : originalSearch(type, query, options)
    );
    expect(await handler(medplum, event(review()))).toEqual({
      status: 'unavailable',
      reason: 'The active medication list exceeds the review search limit',
    });
    expect(lookupMock).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  test('caps product codes before making any lookups', async () => {
    await expect(
      resolveMedications(
        medplum,
        Array.from({ length: 21 }, (_, i) => medication(String(i + 1)))
      )
    ).rejects.toThrow('Too many active RxNorm codes');
    expect(lookupMock).not.toHaveBeenCalled();
  });

  test('caps all lookups even when each product has different ingredients', async () => {
    // Ingredient lookups are still in flight when the cap is hit; the review cancels them without an unhandled rejection.
    lookupMock.mockImplementation(async (url, options) => {
      const code = Number(url.searchParams.get('code'));
      return code > 100
        ? stalled(options?.signal)
        : terminology('product', 'SCD', [`{1} ${code + 100}`, `{2} ${code + 200}`, `{3} ${code + 300}`]);
    });
    await expect(
      resolveMedications(
        medplum,
        Array.from({ length: 20 }, (_, i) => medication(String(i + 1)))
      )
    ).rejects.toThrow('Too many medication terminology lookups');
    expect(lookupMock.mock.calls.length).toBeLessThanOrEqual(40);
  });

  test.each(['IN', 'PIN'])('uses %s concept itself, including names containing digits', async (tty) => {
    lookupMock.mockResolvedValue(terminology('vitamin B12', tty));
    expect(await resolveMedications(medplum, [medication('29046')])).toEqual(['vitamin B12']);
    expect(lookupMock).toHaveBeenCalledTimes(1);
  });

  test.each(['SCDC', 'SCDF'])('resolves verified %s ingredient_of relations', async (tty) => {
    lookupMock.mockImplementation(async (url) =>
      new URL(url).searchParams.get('code') === '29046'
        ? terminology('lisinopril', 'IN')
        : terminology('lisinopril formulation', tty, [], ['29046'])
    );
    expect(await resolveMedications(medplum, [medication('316151')])).toEqual(['lisinopril']);
  });

  test('deduplicates targets by name, the identity the model questions and the review card use', async () => {
    lookupMock.mockResolvedValue(terminology('same name', 'IN'));
    expect(await resolveMedications(medplum, [medication('1'), medication('2')])).toEqual(['same name']);
  });

  test('keeps products with more than ten ingredients', async () => {
    lookupMock.mockImplementation(async (url) => {
      const code = Number(url.searchParams.get('code'));
      return code > 100
        ? terminology(`vitamin ${code}`, 'IN')
        : terminology(
            'multivitamin',
            'SCD',
            Array.from({ length: 12 }, (_, i) => `{${i + 1}} ${i + 101}`)
          );
    });
    const [name] = await resolveMedications(medplum, [medication('1')]);
    expect(name.split(' + ')).toHaveLength(12);
  });

  test.each([
    undefined,
    terminology('drug', 'SCD', ['{316151} broken']),
    terminology('drug', 'SCD', ['{316151} 29046', 'bad']),
    terminology('drug', 'SCD', [], ['29046']),
    terminology('brand', 'BN'),
    terminology('multiple ingredient', 'MIN'),
  ])('fails the entire review on malformed or unsupported terminology', async (response) => {
    lookupMock.mockResolvedValue(response);
    const result = await handler(medplum, event(review()));
    expect(result.status).toBe('unavailable');
    expect(fetch).not.toHaveBeenCalled();
  });

  test('does not omit uncoded or referenced active medications', async () => {
    for (const request of [medication(), { ...medication(), medicationReference: { reference: 'Medication/1' } }]) {
      await medplum.createResource({ ...request, subject: { reference: `Patient/${patient.id}` } });
      expect((await handler(medplum, event(review()))).status).toBe('unavailable');
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  test('hides lookup error details and fails if an ingredient lookup fails', async () => {
    lookupMock.mockImplementation(async (url) => {
      if (new URL(url).searchParams.get('code') === '314076') return terminology('drug', 'SCD', ['{316151} 29046']);
      throw new Error(`${NOTE} ts-test`);
    });
    expect(await handler(medplum, event(review()))).toEqual({
      status: 'unavailable',
      reason: 'Medication terminology is unavailable; retry later',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  test('rejects a referenced ingredient that is actually a product', async () => {
    lookupMock.mockResolvedValue(terminology('product', 'SCD', ['{316151} 29046']));
    await expect(resolveMedications(medplum, [medication('314076')])).rejects.toThrow('invalid response');
  });

  test('bounds stalled terminology and disables retries', async () => {
    vi.useFakeTimers();
    lookupMock.mockImplementation((_, options) => stalled(options?.signal));
    const pending = handler(medplum, event(review()));
    await vi.advanceTimersByTimeAsync(1500);
    expect(await pending).toEqual({
      status: 'unavailable',
      reason: 'Medication terminology did not answer in time; retry later',
    });
    expect(lookupMock).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ maxRetries: 0, signal: expect.any(AbortSignal) })
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  test('bounds stalled chart reads before terminology starts', async () => {
    vi.useFakeTimers();
    vi.spyOn(medplum, 'readResource').mockImplementation(
      (_type, _id, options) => new ReadablePromise(stalled(options?.signal))
    );
    const pending = handler(medplum, event(review()));
    await vi.advanceTimersByTimeAsync(3500);
    expect(await pending).toEqual({
      status: 'unavailable',
      reason: 'Chart preparation did not finish in time; retry later',
    });
    expect(lookupMock).not.toHaveBeenCalled();
  });

  test('bounds model execution using the remaining review time', async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockImplementation((_, init) => stalled(init?.signal));
    const pending = handler(medplum, event(review()));
    await vi.advanceTimersByTimeAsync(9000);
    expect(await pending).toEqual({
      status: 'unavailable',
      reason: 'The model service could not be reached; retry later',
    });
  });
});
