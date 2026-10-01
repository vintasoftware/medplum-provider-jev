import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import type { ModelService } from '../bots/consistency';
import { buildRequest, modelService } from '../bots/consistency';
import contract from '../src/data/model-contract.json';
import { splitSentences } from '../src/utils/consistency-review';
import { highlightIssues } from './gen-cases/validate-cases';
import type { MeasurementCase } from './measure-jev';
import { measure, measurementCases } from './measure-jev';

const typesafe = (key: string): ModelService =>
  modelService((name) => ({ CONSISTENCY_BACKEND: 'typesafe', TYPESAFE_API_KEY: key })[name]);
const modal = (url: string, key: string, secret: string): ModelService =>
  modelService(
    (name) =>
      ({
        CONSISTENCY_BACKEND: 'modal',
        CONSISTENCY_MODEL_URL: url,
        CONSISTENCY_MODAL_KEY: key,
        CONSISTENCY_MODAL_SECRET: secret,
      })[name]
  );

// A highlight answer over `text`'s sentences: 0.9 on the picked option.
function sentenceAnswer(text: string, picked: number | 'none'): unknown {
  const count = splitSentences(text).length;
  const option = picked === 'none' ? 'none' : `s${picked + 1}`;
  return {
    type: 'choice',
    choice: option,
    probabilities: {
      ...Object.fromEntries(Array.from({ length: count }, (_, n) => [`s${n + 1}`, 0.1 / count])),
      none: 0.1 / count,
      [option]: 0.9,
    },
  };
}

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
      sentence_visit_note_0: sentenceAnswer(item.note.text, pickNote && idx >= 0 ? idx : 'none'),
    },
  };
}

function outFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'measure-')), 'run.jsonl');
}

describe('measure-jev', () => {
  test('runs the scenario notes first, then every generated case, each once', () => {
    const ids = measurementCases().map((c) => c.id);
    expect(ids.slice(0, 4)).toEqual([
      'scenario-shortcut-from-chart',
      'scenario-resolved-after-edit',
      'scenario-no-dose',
      'scenario-unexplained-40mg',
    ]);
    expect(ids).toHaveLength(100);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('every expected highlight names exactly one sentence, as the scorer assumes', () => {
    for (const c of measurementCases()) {
      expect(highlightIssues(c.id, 'outside_document', c.outside.text, c.highlight.outside)).toEqual([]);
      expect(highlightIssues(c.id, 'visit_note', c.note.text, c.highlight.note)).toEqual([]);
    }
  });

  test('sends the Bot request, scores labels and highlights, and never logs the key', async () => {
    const cases = measurementCases().slice(0, 2);
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      const item = cases.find((c) => c.note.text === body.state.visit_note.text) as MeasurementCase;
      expect(body).toEqual(buildRequest([item.medication], item.outside, item.note, contract.limits.max_sentences));
      return new Response(JSON.stringify(answer(item, true)));
    });
    const file = outFile();
    const log: string[] = [];
    const ok = await measure({
      rounds: 1,
      service: typesafe('ts-secret'),
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
    expect(rows[0]).toMatchObject({ case_id: 'scenario-shortcut-from-chart', matches_reference: false });
    expect(rows[1]).toMatchObject({ case_id: 'scenario-resolved-after-edit', matches_reference: true });
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
      service: typesafe('k'),
      outFile: file,
      cases,
      fetch: fetchMock,
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
      service: typesafe('k'),
      outFile: file,
      cases,
      fetch: async () => new Response(JSON.stringify(bad)),
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
      service: modal('https://example.us-east.modal.direct/', 'wk-a', 'ws-b'),
      outFile: outFile(),
      cases: [item],
      fetch: fetchMock,
      log: () => undefined,
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://example.us-east.modal.direct/v1/systemone');
    expect(init.headers).toMatchObject({ 'Modal-Key': 'wk-a', 'Modal-Secret': 'ws-b' });
    expect(JSON.parse(init.body as string)).toEqual(buildRequest([item.medication], item.outside, item.note, 19));
  });

  test('applies the no-dose rule for both backends and records the model label', async () => {
    const item = measurementCases().find((c) => c.id === 'scenario-no-dose') as MeasurementCase;
    const body = JSON.stringify(answer(item, false));
    const rows = [];
    for (const service of [modal('https://example.modal.run', 'k', 's'), typesafe('k')]) {
      const file = outFile();
      await measure({
        rounds: 1,
        service,
        outFile: file,
        cases: [item],
        fetch: async () => new Response(body),
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
    expect(rows[1].result).toEqual(rows[0].result);
  });
});
