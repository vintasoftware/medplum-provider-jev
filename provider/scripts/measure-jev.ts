// Measures hosted Jev on the authored dose cases and the guided-scenario notes, with exactly
// the state and questions the Bot sends (built by the Bot's own buildRequest).
//
//   npm --prefix provider run measure                 # one round
//   npm --prefix provider run measure -- --rounds 3
//
// Needs TYPESAFE_API_KEY in the environment or the root .env. Writes
// artifacts/typesafe-run-<UTC>.jsonl and stops on the first failed or invalid response; it
// never substitutes an authored label for a model answer.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { buildRequest, splitSentences } from '../bots/consistency.ts';
import scenario from '../src/data/guided-scenario.json' with { type: 'json' };
import contract from '../src/data/model-contract.json' with { type: 'json' };
import { REPO_ROOT } from './configure-provider.ts';
import { readEnv } from './env-file.ts';

const CASES_FILE = join(REPO_ROOT, 'provider', 'scripts', 'measure-cases.json');
const REFERENCE = 'Authored synthetic reference; not clinician-validated';

type Doc = { title: string; date: string; author: string; text: string };

export interface MeasurementCase {
  id: string;
  expected: string;
  medication: string;
  outside: Doc;
  note: Doc;
  /** Substring of the sentence a reader expects highlighted, or null when none gives a dose. */
  highlight: { outside: string | null; note: string | null };
}

export function measurementCases(file = CASES_FILE): MeasurementCase[] {
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const authored: MeasurementCase[] = data.authored_cases.map((c: any) => ({
    id: c.id,
    expected: c.expected,
    medication: c.medication,
    outside: c.outside_document,
    note: c.visit_note,
    highlight: { outside: c.highlight.outside_document, note: c.highlight.visit_note },
  }));
  const s = data.scenario;
  const outside: Doc = {
    title: 'Discharge summary',
    date: s.discharge_date,
    author: 'Outside Hospital (synthetic)',
    text: scenario.discharge_summary,
  };
  const variants: MeasurementCase[] = scenario.variants.map((v) => ({
    id: `scenario-${v.id}`,
    expected: v.expected,
    medication: s.medication,
    outside,
    note: { title: "Today's visit note", date: s.visit_date, author: "this clinic's provider", text: v.note },
    highlight: { outside: s.highlight.outside_document, note: s.highlight.visit_note[v.id] ?? null },
  }));
  return [...authored, ...variants];
}

function sentenceFor(answer: any, text: string): string | null | undefined {
  if (answer?.type !== 'choice') {
    return undefined;
  }
  return answer.choice === 'none'
    ? null
    : (splitSentences(text)[Number(String(answer.choice).slice(1)) - 1] ?? undefined);
}

function highlightOk(expected: string | null, picked: string | null | undefined): boolean {
  return expected === null ? picked === null : !!picked?.includes(expected);
}

function validDose(answer: any): boolean {
  const p = answer?.probabilities ?? {};
  const values = Object.values(p) as number[];
  return (
    answer?.type === 'choice' &&
    Object.keys(p).sort().join(',') === [...contract.labels].sort().join(',') &&
    contract.labels.includes(answer.choice) &&
    Math.abs(values.reduce((a, b) => a + b, 0) - 1) < 0.01 &&
    p[answer.choice] === Math.max(...values)
  );
}

export interface MeasureOptions {
  rounds: number;
  apiKey: string;
  outFile: string;
  cases?: MeasurementCase[];
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

/** Runs the measurement; returns the number of successful answers. */
export async function measure(options: MeasureOptions): Promise<number> {
  const { rounds, apiKey, outFile } = options;
  const log = options.log ?? console.log;
  const doFetch = options.fetch ?? fetch;
  const cases = options.cases ?? measurementCases();
  writeFileSync(outFile, '', { flag: 'wx' });
  let successful = 0;
  for (let round = 1; round <= rounds; round++) {
    for (const item of cases) {
      const started = performance.now();
      const row: Record<string, unknown> = {
        round,
        case_id: item.id,
        expected: item.expected,
        reference_provenance: REFERENCE,
      };
      let failed = false;
      try {
        const response = await doFetch(contract.endpoint, {
          method: 'POST',
          redirect: 'error',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(buildRequest([item.medication], item.outside, item.note)),
        });
        row.http_status = response.status;
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const data = (await response.json()) as any;
        const dose = data?.answers?.dose_0;
        if (typeof data?.model !== 'string' || !validDose(dose)) {
          throw new Error('Unrecognized model response');
        }
        const outside = sentenceFor(data.answers.sentence_outside_document_0, item.outside.text);
        const note = sentenceFor(data.answers.sentence_visit_note_0, item.note.text);
        row.result = {
          model: data.model,
          choice: dose.choice,
          probabilities: dose.probabilities,
          confidence: dose.confidence,
          mentions_hospital_stay: data.answers.mentions_hospital_stay?.noul,
          usage: data.usage,
          highlight: {
            outside: outside ?? null,
            note: note ?? null,
            outside_ok: highlightOk(item.highlight.outside, outside),
            note_ok: highlightOk(item.highlight.note, note),
          },
        };
        row.matches_reference = dose.choice === item.expected;
        successful++;
      } catch {
        // Never log the response body: it can echo the request.
        row.error = 'Request or response validation failed';
        failed = true;
      }
      row.elapsed_ms = Math.round((performance.now() - started) * 10) / 10;
      appendFileSync(outFile, JSON.stringify(row) + '\n');
      const r = row.result as any;
      log(
        r
          ? `  ${item.id.padEnd(30)} ${r.choice.padEnd(25)} ${(r.probabilities[r.choice] as number).toFixed(2)}` +
              `  ${row.matches_reference ? 'matches' : 'DIFFERS'}  highlights ${r.highlight.outside_ok ? 'ok' : 'X'}/${r.highlight.note_ok ? 'ok' : 'X'}`
          : `  ${item.id.padEnd(30)} failed (HTTP ${row.http_status ?? '-'})`
      );
      if (failed) {
        log(`Incomplete run saved to ${outFile}. Resolve auth or service errors before retrying.`);
        return successful;
      }
    }
  }
  log(`Recorded ${successful} live hosted Jev answers in ${outFile}.`);
  return successful;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { rounds: { type: 'string', default: '1' } } });
  const rounds = Number(values.rounds);
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 5) {
    throw new Error('Use 1 to 5 rounds per deliberate measurement run');
  }
  const apiKey = (process.env.TYPESAFE_API_KEY ?? readEnv(join(REPO_ROOT, '.env')).TYPESAFE_API_KEY ?? '').trim();
  if (!apiKey) {
    throw new Error('Set TYPESAFE_API_KEY in the root .env');
  }
  const dir = join(REPO_ROOT, 'artifacts');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  console.log('  case                           choice                    p     reference  highlights (outside/note)');
  await measure({ rounds, apiKey, outFile: join(dir, `typesafe-run-${stamp}.jsonl`) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
