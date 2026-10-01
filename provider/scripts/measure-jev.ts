// Measures the model on the guided-scenario notes, or on a larger generated case batch, with
// exactly the state and questions the Bot sends (built by the Bot's own buildRequest).
//
//   npm --prefix provider run measure           # hosted Jev, the demo's 4 scenario notes, one round
//   npm --prefix provider run measure:generated # hosted Jev, the 96-case generated benchmark
//   npm --prefix provider run measure -- --rounds 3
//   npm --prefix provider run measure -- --backend modal  # the self-hosted model on the private Modal Server
//   npm --prefix provider run measure -- --cases scripts/gen-cases/generated-cases.json
//
// The generated batch (scripts/gen-cases/, see its README.md or the regenerate-measure-cases
// skill to add more) is the benchmark; the scenario notes stay here so a question or contract
// change is checked against the exact notes the guided demo sends before its e2e cassettes are
// re-recorded.
//
// Hosted Jev needs TYPESAFE_API_KEY; Modal needs CONSISTENCY_MODEL_URL, CONSISTENCY_MODAL_KEY
// and CONSISTENCY_MODAL_SECRET, in the environment or the root .env. Writes
// artifacts/<backend>-run-<UTC>.jsonl and stops on the first failed or invalid response; it
// never substitutes an authored label for a model answer.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { ModelService } from '../bots/consistency.ts';
import { buildRequest, doseResult, modelService, readSentence } from '../bots/consistency.ts';
import scenario from '../src/data/guided-scenario.json' with { type: 'json' };
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
  // A generated batch (see scripts/gen-cases/) uses `cases`; legacy files used `authored_cases`.
  // Neither has a `scenario` to append.
  const authored: MeasurementCase[] = (data.cases ?? data.authored_cases ?? []).map((c: any) => ({
    id: c.id,
    expected: c.expected,
    medication: c.medication,
    outside: c.outside_document,
    note: c.visit_note,
    highlight: { outside: c.highlight.outside_document, note: c.highlight.visit_note },
  }));
  if (!data.scenario) {
    return authored;
  }
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

function highlightOk(expected: string | null, picked: string | null | undefined): boolean {
  return expected === null ? picked === null : !!picked?.includes(expected);
}

export interface MeasureOptions {
  rounds: number;
  service: ModelService;
  outFile: string;
  cases?: MeasurementCase[];
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

/**
 * Runs the measurement.
 * @param options - Rounds, service, cases and output file.
 * @returns The number of successful answers.
 */
export async function measure(options: MeasureOptions): Promise<number> {
  const { rounds, service, outFile } = options;
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
      let httpStatus: number | undefined;
      try {
        const response = await doFetch(service.url, {
          method: 'POST',
          redirect: 'error',
          headers: { 'Content-Type': 'application/json', ...service.headers },
          body: JSON.stringify(buildRequest([item.medication], item.outside, item.note, service.maxSentences)),
        });
        httpStatus = response.status;
        row.http_status = httpStatus;
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const data = await response.json();
        if (typeof data?.model !== 'string') {
          throw new Error('Unrecognized model response');
        }
        const answers = data.answers ?? {};
        const result = doseResult(answers, 0, item.medication, item.outside.text, item.note.text);
        const outside = readSentence(answers.sentence_outside_document_0, item.outside.text);
        const note = readSentence(answers.sentence_visit_note_0, item.note.text);
        const choice = result.choice;
        const modelChoice = Object.entries(result.probabilities).reduce((a, b) => (b[1] > a[1] ? b : a))[0];
        row.result = {
          model: data.model,
          choice,
          ...(result.label_rule ? { model_choice: modelChoice, label_rule: result.label_rule } : {}),
          probabilities: result.probabilities,
          confidence: result.confidence,
          mentions_hospital_stay: answers.mentions_hospital_stay?.noul,
          usage: data.usage,
          highlight: {
            outside: outside ?? null,
            note: note ?? null,
            outside_ok: highlightOk(item.highlight.outside, outside),
            note_ok: highlightOk(item.highlight.note, note),
          },
        };
        row.matches_reference = choice === item.expected;
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
          ? `  ${item.id.padEnd(30)} ${r.choice.padEnd(25)} ${(r.probabilities[r.model_choice ?? r.choice] as number).toFixed(2)}` +
              `  ${row.matches_reference ? 'matches' : 'DIFFERS'}  highlights ${r.highlight.outside_ok ? 'ok' : 'X'}/${r.highlight.note_ok ? 'ok' : 'X'}` +
              (r.label_rule ? `  (rule; model said ${r.model_choice})` : '')
          : `  ${item.id.padEnd(30)} failed (HTTP ${httpStatus ?? '-'})`
      );
      if (failed) {
        log(`Incomplete run saved to ${outFile}. Resolve auth or service errors before retrying.`);
        return successful;
      }
    }
  }
  log(`Recorded ${successful} live answers in ${outFile}.`);
  return successful;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      rounds: { type: 'string', default: '1' },
      backend: { type: 'string', default: 'typesafe' },
      cases: { type: 'string' },
    },
  });
  const rounds = Number(values.rounds);
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 5) {
    throw new Error('Use 1 to 5 rounds per deliberate measurement run');
  }
  const env = readEnv(join(REPO_ROOT, '.env'));
  // The Bot's own service choice, with --backend in place of the CONSISTENCY_BACKEND secret.
  const service = modelService((name) => {
    if (name === 'CONSISTENCY_BACKEND') {
      return values.backend;
    }
    const value = (process.env[name] ?? env[name] ?? '').trim();
    if (!value) {
      throw new Error(`Set ${name} in the root .env`);
    }
    return value;
  });
  const dir = join(REPO_ROOT, 'artifacts');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  console.log('  case                           choice                    p     reference  highlights (outside/note)');
  const cases = values.cases ? measurementCases(join(REPO_ROOT, 'provider', values.cases)) : undefined;
  await measure({ rounds, service, outFile: join(dir, `${values.backend}-run-${stamp}.jsonl`), cases });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
