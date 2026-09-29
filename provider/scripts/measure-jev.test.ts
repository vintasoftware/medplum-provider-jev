import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { buildRequest, splitSentences } from '../bots/consistency';
import contract from '../src/data/model-contract.json';
import type { MeasurementCase } from './measure-jev';
import { measure, measurementCases, modalEndpoint, typesafeEndpoint } from './measure-jev';

function answer(item: MeasurementCase, pickNote: boolean): unknown {
  const noteSentences = splitSentences(item.note.text);
  const idx = noteSentences.findIndex((s) => item.highlight.note && s.includes(item.highlight.note));
  return {
    model: 'jev-1.13.0',
    usage: { input_tokens: 900 },
    answers: {
      mentions_hospital_stay: { type: 'noul', noul: 0.1 },
      dose_0: {
        type: 'choice',
        choice: 'agreement',
        confidence: 0.9,
        probabilities: { agreement: 0.9, potential_conflict: 0.05, insufficient_information: 0.05 },
      },
      sentence_visit_note_0: { type: 'choice', choice: pickNote && idx >= 0 ? `s${idx + 1}` : 'none' },
    },
  };
}

function outFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'measure-')), 'run.jsonl');
}

describe('measure-jev', () => {
  test('covers the authored dose cases and every scenario variant', () => {
    const ids = measurementCases().map((c) => c.id);
    expect(ids).toEqual([
      'dose-conflict',
      'dose-agreement',
      'dose-dated-change',
      'dose-missing',
      'dose-dates-unexplained',
      'scenario-shortcut-from-chart',
      'scenario-resolved-after-edit',
      'scenario-no-dose',
      'scenario-unexplained-40mg',
    ]);
    for (const c of measurementCases()) {
      for (const [field, expected] of [
        ['outside', c.highlight.outside],
        ['note', c.highlight.note],
      ] as const) {
        if (expected) {
          const text = field === 'outside' ? c.outside.text : c.note.text;
          expect(
            splitSentences(text).some((s) => s.includes(expected)),
            `${c.id} ${field}`
          ).toBe(true);
        }
      }
    }
  });

  test('sends the Bot request, scores labels and highlights, and never logs the key', async () => {
    const cases = measurementCases().slice(0, 2);
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      const item = cases.find((c) => c.note.text === body.state.visit_note.text) as MeasurementCase;
      expect(body).toEqual(buildRequest([item.medication], item.outside, item.note));
      return new Response(JSON.stringify(answer(item, true)));
    });
    const file = outFile();
    const log: string[] = [];
    const ok = await measure({
      rounds: 1,
      endpoint: typesafeEndpoint('ts-secret'),
      outFile: file,
      cases,
      fetch: fetchMock as any,
      log: (l) => log.push(l),
    });
    expect(ok).toBe(2);
    expect(fetchMock.mock.calls[0][0]).toBe(contract.endpoint);
    expect((fetchMock.mock.calls[0][1].headers as Record<string, string>).Authorization).toBe('Bearer ts-secret');
    const rows = readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(rows[0]).toMatchObject({ case_id: 'dose-conflict', matches_reference: false });
    expect(rows[1]).toMatchObject({ case_id: 'dose-agreement', matches_reference: true });
    expect(rows[1].result.highlight.note_ok).toBe(true);
    expect(rows[1].result.highlight.outside_ok).toBe(false);
    expect(readFileSync(file, 'utf8') + log.join('\n')).not.toContain('ts-secret');
  });

  test('stops at the first failure and keeps the partial run', async () => {
    const cases = measurementCases().slice(0, 3);
    const fetchMock = vi.fn(async () => new Response('{"detail":"echo of request"}', { status: 401 }));
    const file = outFile();
    const ok = await measure({
      rounds: 1,
      endpoint: typesafeEndpoint('k'),
      outFile: file,
      cases,
      fetch: fetchMock as any,
      log: () => undefined,
    });
    expect(ok).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const rows = readFileSync(file, 'utf8').trim().split('\n');
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toContain('echo of request');
  });

  test('rejects an answer with the wrong labels', async () => {
    const cases = measurementCases().slice(0, 1);
    const bad = { model: 'jev', answers: { dose_0: { type: 'choice', choice: 'yes', probabilities: { yes: 1 } } } };
    const file = outFile();
    const ok = await measure({
      rounds: 1,
      endpoint: typesafeEndpoint('k'),
      outFile: file,
      cases,
      fetch: (async () => new Response(JSON.stringify(bad))) as any,
      log: () => undefined,
    });
    expect(ok).toBe(0);
    expect(JSON.parse(readFileSync(file, 'utf8')).error).toBe('Request or response validation failed');
  });

  test('sends the same request to the Modal Server with its proxy token', async () => {
    const [item] = measurementCases();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(answer(item, true))));
    await measure({
      rounds: 1,
      endpoint: modalEndpoint('https://example.us-east.modal.direct/', 'wk-a', 'ws-b'),
      outFile: outFile(),
      cases: [item],
      fetch: fetchMock as any,
      log: () => undefined,
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://example.us-east.modal.direct/v1/systemone');
    expect(init.headers).toMatchObject({ 'Modal-Key': 'wk-a', 'Modal-Secret': 'ws-b' });
    expect(JSON.parse(init.body as string)).toEqual(buildRequest([item.medication], item.outside, item.note));
    expect(() => modalEndpoint('https://example.modal.run/check', 'k', 's')).toThrow('HTTPS Modal Server origin');
  });

  test('applies the no-dose rule for the Modal backend only and records the model label', async () => {
    const item = measurementCases().find((c) => c.id === 'scenario-no-dose') as MeasurementCase;
    const count = splitSentences(item.note.text).length;
    const none = {
      type: 'choice',
      choice: 'none',
      probabilities: {
        ...Object.fromEntries(Array.from({ length: count }, (_, n) => [`s${n + 1}`, 0.1 / count])),
        none: 0.9,
      },
    };
    const response = answer(item, false) as { answers: Record<string, unknown> };
    const body = JSON.stringify({ ...response, answers: { ...response.answers, sentence_visit_note_0: none } });
    const rows = [];
    for (const endpoint of [modalEndpoint('https://example.modal.run', 'k', 's'), typesafeEndpoint('k')]) {
      const file = outFile();
      await measure({
        rounds: 1,
        endpoint,
        outFile: file,
        cases: [item],
        fetch: (async () => new Response(body)) as any,
        log: () => undefined,
      });
      rows.push(JSON.parse(readFileSync(file, 'utf8')));
    }
    expect(rows[0].result).toMatchObject({
      choice: 'insufficient_information',
      model_choice: 'agreement',
      label_rule: 'no_dose_sentence',
    });
    expect(rows[0].matches_reference).toBe(true);
    expect(rows[1].result.choice).toBe('agreement');
    expect(rows[1].result.label_rule).toBeUndefined();
  });
});
