import type { BotEvent, MedplumClient } from '@medplum/core';
import type {
  ClinicalImpression,
  DocumentReference,
  Encounter,
  MedicationRequest,
  Parameters,
} from '@medplum/fhirtypes';
import contract from '../src/data/model-contract.json' with { type: 'json' };
import type { ReviewLabel, ReviewOutput, ReviewResult } from '../src/utils/consistency-review.ts';
import { noteSearch, splitSentences } from '../src/utils/consistency-review.ts';

// Reads the visit note, the newest outside discharge summary and the active medications
// as the signed-in user (the Bot runs with runAsUser), asks the model whether the two
// documents agree about each medication's dose, and returns the result. It writes nothing:
// the review card stores the result as a DetectedIssue under the user's own access.
//
// The model is hosted Jev or Jebadiah on a private Modal Server (see SELF-HOSTING.md). Both
// take the same /v1/systemone request; the CONSISTENCY_BACKEND project secret picks one.

const DISCHARGE_SUMMARY_TYPE = 'http://loinc.org|18842-5';
const ID_PATTERN = /^[A-Za-z0-9.-]{1,64}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const { limits, labels } = contract;

type SourceDocument = { title: string; date: string; author: string; text: string };
type Question = { type: 'choice' | 'noul'; instructions: string; criteria?: Record<string, string> };

/** A problem the card shows as-is. Never include document text or secrets in the message. */
class Unavailable extends Error {}

function parseInput(input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid review request');
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).sort().join(',') !== 'action,encounter_id' ||
    value.action !== 'review_encounter' ||
    typeof value.encounter_id !== 'string' ||
    !ID_PATTERN.test(value.encounter_id)
  ) {
    throw new Error('Only { action: "review_encounter", encounter_id } is accepted');
  }
  return value.encounter_id;
}

function optionalSecret(event: BotEvent, name: string): string | undefined {
  const value = event.secrets?.[name]?.valueString;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function cleanText(text: string): string {
  // Drop carriage returns and control characters except newline and tab.
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
}

const RXNORM = 'http://www.nlm.nih.gov/research/umls/rxnorm';
const RXCUI = /^[1-9]\d{0,9}$/;
const TERMINOLOGY_INVALID = 'Medication terminology returned an invalid response';

type RxConcept = { name: string; tty: string[]; ai: string[]; ingredientOf: string[] };

/** The display and the `$lookup` properties that ingredient resolution reads. */
function rxConcept(params: Parameters | undefined): RxConcept {
  const property = (code: string): string[] =>
    (params?.parameter ?? []).flatMap(({ name, part = [] }) => {
      const value = part.find((p) => p.name === 'value');
      return name === 'property' && part.find((p) => p.name === 'code')?.valueCode === code
        ? (value?.valueCode ?? value?.valueString ?? [])
        : [];
    });
  const display = params?.parameter?.find((parameter) => parameter.name === 'display')?.valueString;
  return {
    name: cleanText(display ?? ''),
    tty: property('tty'),
    ai: property('RXN_AI'),
    ingredientOf: property('ingredient_of'),
  };
}

const isIngredient = (concept: RxConcept): boolean => concept.tty.some((tty) => tty === 'IN' || tty === 'PIN');

/**
 * Runs `work` with a signal that aborts after `ms` or when `parent` aborts. Once it aborts, any failure
 * reports the budget that ran out, not the error the cancelled request raised. Requests still running
 * when `work` settles are cancelled.
 */
async function withBudget<T>(
  ms: number,
  reason: string,
  work: (signal: AbortSignal) => Promise<T>,
  parent?: AbortSignal
): Promise<T> {
  const controller = new AbortController();
  // A timer rather than AbortSignal.timeout, so tests can drive budgets with fake timers.
  const timer = setTimeout(() => controller.abort(new Unavailable(reason)), Math.max(1, ms));
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
  try {
    return await work(signal);
  } catch (err) {
    signal.throwIfAborted();
    throw err;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/** One name per distinct ingredient set, e.g. "fibrinogen, human + thrombin, human". Lookups are shared within a review. */
export async function resolveMedications(
  medplum: MedplumClient,
  requests: MedicationRequest[],
  chartSignal?: AbortSignal
): Promise<string[]> {
  if (!requests.length) throw new Unavailable('No active medications to compare');
  const codes = [
    ...new Set(
      requests.map((request) => {
        if (request.medicationReference)
          throw new Unavailable('An active medication uses medicationReference; RxNorm coding is required');
        const rxCodes = [
          ...new Set(
            request.medicationCodeableConcept?.coding
              ?.filter((coding) => coding.system === RXNORM)
              .map((coding) => coding.code) ?? []
          ),
        ];
        if (rxCodes.length !== 1 || !rxCodes[0] || !RXCUI.test(rxCodes[0]))
          throw new Unavailable('An active medication has missing, invalid or ambiguous RxNorm coding');
        return rxCodes[0];
      })
    ),
  ];
  if (codes.length > 20) throw new Unavailable('Too many active RxNorm codes for the demo check');
  // Chart preparation has a 3.5 s budget; terminology gets at most 1.5 s of it.
  const names = await withBudget(
    1500,
    'Medication terminology did not answer in time; retry later',
    (signal) => {
      const cache = new Map<string, Promise<RxConcept>>();
      const lookup = async (code: string): Promise<RxConcept> => {
        let pending = cache.get(code);
        if (!pending) {
          if (cache.size >= 40) throw new Unavailable('Too many medication terminology lookups for the demo check');
          pending = medplum
            .get<Parameters>(medplum.fhirUrl('CodeSystem/$lookup?' + new URLSearchParams({ system: RXNORM, code })), {
              signal,
              maxRetries: 0,
            })
            .then(rxConcept, () => {
              throw new Unavailable('Medication terminology is unavailable; retry later');
            });
          cache.set(code, pending);
        }
        return pending;
      };
      return Promise.all(
        codes.map(async (code) => {
          const concept = await lookup(code);
          let ingredients: string[];
          if (isIngredient(concept)) {
            ingredients = [code];
          } else if (concept.ai.length) {
            ingredients = concept.ai.map((value) => {
              const match = /^\{\d+\} (\d+)$/.exec(value);
              if (!match) throw new Unavailable(TERMINOLOGY_INVALID);
              return match[1];
            });
          } else if (concept.tty.some((tty) => tty === 'SCDC' || tty === 'SCDF')) {
            // Medplum's imported RxNorm relations point from these concepts to IN/PIN via ingredient_of.
            ingredients = concept.ingredientOf;
          } else {
            throw new Unavailable('An active RxNorm concept has no supported ingredient resolution');
          }
          if (!ingredients.length) throw new Unavailable(TERMINOLOGY_INVALID);
          const resolved = await Promise.all([...new Set(ingredients)].map(lookup));
          if (!resolved.every((item) => isIngredient(item) && item.name)) throw new Unavailable(TERMINOLOGY_INVALID);
          return [...new Set(resolved.map((item) => item.name))].sort().join(' + ');
        })
      );
    },
    chartSignal
  );
  const medications = [...new Set(names)];
  if (medications.length > limits.max_medications)
    throw new Unavailable('Too many active medications for the demo check');
  return medications;
}

function fill(template: string, names: Record<string, string>): string {
  return Object.entries(names).reduce((text, [key, name]) => text.replaceAll(`{${key}}`, name), template);
}

export function buildRequest(
  medications: string[],
  outside: SourceDocument,
  note: SourceDocument,
  maxSentences: number
): { state: unknown; model: string; questions: Record<string, Question> } {
  const { dose, hospital, sentence } = contract.questions;
  const questions: Record<string, Question> = {
    mentions_hospital_stay: { type: 'noul', instructions: hospital.instructions },
  };
  medications.forEach((medication, i) => {
    questions[`dose_${i}`] = {
      type: 'choice',
      instructions: fill(dose.instructions, { medication }),
      criteria: Object.fromEntries(Object.entries(dose.criteria).map(([k, v]) => [k, fill(v, { medication })])),
    };
    for (const [field, doc] of [
      ['outside_document', outside],
      ['visit_note', note],
    ] as const) {
      const sentences = splitSentences(doc.text);
      // Past the service's limit the check keeps the label and drops that highlight.
      if (sentences.length < 1 || sentences.length > maxSentences) continue;
      questions[`sentence_${field}_${i}`] = {
        type: 'choice',
        instructions: fill(sentence.instructions, { field, medication }),
        criteria: {
          ...Object.fromEntries(sentences.map((s, n) => [`s${n + 1}`, s])),
          none: fill(sentence.none, { medication }),
        },
      };
    }
  });
  return {
    state: { active_medications: medications, outside_document: outside, visit_note: note },
    model: contract.model,
    questions,
  };
}

function checkDocument(doc: SourceDocument): SourceDocument {
  const text = cleanText(doc.text);
  if (!text) throw new Unavailable('A document to compare is empty');
  if (text.length > limits.text_max) throw new Unavailable('The note is too long for the demo check');
  if (!DATE_PATTERN.test(doc.date)) throw new Unavailable('A document to compare has no valid date');
  return { ...doc, title: cleanText(doc.title).slice(0, limits.title_max), text };
}

async function attachmentText(medplum: MedplumClient, doc: DocumentReference, signal: AbortSignal): Promise<string> {
  const attachment = doc.content?.[0]?.attachment;
  if (!attachment?.contentType?.startsWith('text/plain')) {
    throw new Unavailable('The discharge summary is not plain text');
  }
  if (attachment.data) return Buffer.from(attachment.data, 'base64').toString('utf8');
  if (attachment.url) return (await medplum.download(attachment.url, { signal, maxRetries: 0 })).text();
  throw new Unavailable('The discharge summary has no text');
}

async function readChart(
  medplum: MedplumClient,
  encounterId: string,
  signal: AbortSignal
): Promise<{
  medications: string[];
  outside: SourceDocument;
  note: SourceDocument;
  sources: string[];
  noteVersion: string;
  outsideVersion: string;
}> {
  let encounter: Encounter;
  try {
    encounter = await medplum.readResource('Encounter', encounterId, { signal, maxRetries: 0 });
  } catch {
    throw new Unavailable('This visit is not accessible');
  }
  const subject = encounter.subject?.reference;
  if (!subject?.startsWith('Patient/')) throw new Unavailable('This visit is not accessible');

  const [impression, requests, summaries] = await Promise.all([
    medplum.searchOne('ClinicalImpression', noteSearch(`Encounter/${encounterId}`, subject), {
      signal,
      maxRetries: 0,
    }),
    medplum.searchResources(
      'MedicationRequest',
      { subject, status: 'active', _count: '100' },
      { signal, maxRetries: 0 }
    ),
    medplum.searchResources(
      'DocumentReference',
      {
        subject,
        type: DISCHARGE_SUMMARY_TYPE,
        status: 'current',
        _sort: '-date',
        _count: '1',
      },
      { signal, maxRetries: 0 }
    ),
  ]);

  const noteText = (impression as ClinicalImpression | undefined)?.note?.[0]?.text?.trim();
  if (!impression || !noteText) throw new Unavailable('No chart note has been saved for this visit yet');
  if (
    requests.bundle.link?.some((link) => link.relation === 'next') ||
    (requests.bundle.total !== undefined && requests.bundle.total > requests.length)
  )
    throw new Unavailable('The active medication list exceeds the review search limit');
  const medications = await resolveMedications(medplum, requests, signal);
  const summary = summaries[0];
  if (!summary) throw new Unavailable('No outside discharge summary is on file');

  const outside = checkDocument({
    title: summary.description ?? summary.type?.text ?? 'Discharge summary',
    date: summary.date?.slice(0, 10) ?? '',
    author: summary.author?.[0]?.display ?? 'outside organization',
    text: await attachmentText(medplum, summary, signal),
  });
  const note = checkDocument({
    title: "Today's visit note",
    date: (encounter.period?.start ?? impression.date ?? impression.meta?.lastUpdated ?? '').slice(0, 10),
    author: "this clinic's provider",
    text: noteText,
  });
  if (outside.text.length + note.text.length > limits.total_text_max) {
    throw new Unavailable('The note is too long for the demo check');
  }
  return {
    medications,
    outside,
    note,
    sources: [`DocumentReference/${summary.id}`, `ClinicalImpression/${impression.id}`],
    // The server versions every resource it returns.
    noteVersion: impression.meta?.versionId as string,
    outsideVersion: summary.meta?.versionId as string,
  };
}

export type ModelService = {
  url: string;
  headers: Record<string, string>;
  timeoutMs: number;
  messages: Record<number, string>;
  /** Most sentences a highlight question may list; `none` is one more option. */
  maxSentences: number;
};

// Plain messages only: the response body can echo the request, which holds chart text.
const TYPESAFE_MESSAGES: Record<number, string> = {
  0: 'The model service could not be reached; retry later',
  401: 'The model service rejected the project credentials',
  422: 'The model service rejected the request format',
  429: 'The model service is rate limited; retry shortly',
  529: 'The model service is overloaded; retry shortly',
};
const MODAL_MESSAGES: Record<number, string> = {
  // The Bot's Lambda stops after 10 seconds. A cold Server answers 503 at once, and that request schedules a GPU.
  0: 'The self-hosted model did not answer in time; it may be starting, retry in a few minutes',
  401: 'The self-hosted model rejected the project credentials',
  403: 'The self-hosted model rejected the project credentials',
  422: 'The self-hosted model could not check this note; it may be too long',
  429: 'The self-hosted model is busy; retry shortly',
  503: 'The self-hosted model is starting or unavailable; retry in a few minutes',
};

/** The HTTPS origin of a Modal Server, or undefined for anything else (paths, credentials, other hosts). */
export function modalOrigin(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  const valid =
    url.protocol === 'https:' &&
    /\.modal\.(run|direct)$/.test(url.hostname) &&
    url.pathname === '/' &&
    !url.search &&
    !url.hash &&
    !url.username &&
    !url.password &&
    !url.port;
  return valid ? url.origin : undefined;
}

/** The backend `setting` names: the Bot reads project secrets, the measure script the root .env. */
export function modelService(setting: (name: string) => string | undefined): ModelService {
  const backend = setting('CONSISTENCY_BACKEND') ?? (setting('TYPESAFE_API_KEY') ? 'typesafe' : undefined);
  if (backend === 'typesafe') {
    const apiKey = setting('TYPESAFE_API_KEY');
    if (!apiKey) throw new Unavailable('Missing string project secret: TYPESAFE_API_KEY');
    return {
      url: contract.endpoint,
      headers: { Authorization: `Bearer ${apiKey}` },
      timeoutMs: 30000,
      messages: TYPESAFE_MESSAGES,
      maxSentences: limits.max_sentences,
    };
  }
  if (backend === 'modal') {
    const [url, key, secret] = ['CONSISTENCY_MODEL_URL', 'CONSISTENCY_MODAL_KEY', 'CONSISTENCY_MODAL_SECRET'].map(
      (name) => {
        const value = setting(name);
        if (!value) throw new Unavailable(`Missing string project secret: ${name}`);
        return value;
      }
    );
    const origin = modalOrigin(url);
    if (!origin) throw new Unavailable('CONSISTENCY_MODEL_URL must be the HTTPS Modal Server origin');
    return {
      url: `${origin}/v1/systemone`,
      headers: { 'Modal-Key': key, 'Modal-Secret': secret },
      timeoutMs: 8000,
      messages: MODAL_MESSAGES,
      // Jebadiah's server refuses a choice with more than 20 criteria.
      maxSentences: 19,
    };
  }
  throw new Unavailable('Project secret CONSISTENCY_BACKEND must be typesafe or modal');
}

async function callModel(service: ModelService, body: unknown, deadline: number): Promise<Record<string, any>> {
  return withBudget(Math.min(service.timeoutMs, deadline - Date.now()), service.messages[0], async (signal) => {
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await fetch(service.url, {
          method: 'POST',
          redirect: 'error',
          signal,
          headers: { 'Content-Type': 'application/json', ...service.headers },
          body: JSON.stringify(body),
        });
      } catch {
        throw new Unavailable(service.messages[0]);
      }
      if (response.ok) return response.json();
      if ((response.status === 429 || response.status === 529) && attempt === 0 && deadline - Date.now() > 2000) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        continue;
      }
      throw new Unavailable(service.messages[response.status] ?? 'The model service is unavailable');
    }
  });
}

function isProbability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function readChoice(
  answer: any,
  options: readonly string[]
): { choice: string; probabilities: Record<string, number> } {
  const scores = answer?.probabilities;
  if (
    answer?.type !== 'choice' ||
    !scores ||
    Object.keys(scores).sort().join(',') !== [...options].sort().join(',') ||
    !Object.values(scores).every(isProbability) ||
    Math.abs(Object.values(scores as Record<string, number>).reduce((sum, n) => sum + n, 0) - 1) > 0.01 ||
    !options.includes(answer.choice) ||
    scores[answer.choice] !== Math.max(...(Object.values(scores) as number[]))
  ) {
    throw new Unavailable('The model returned an invalid answer');
  }
  return { choice: answer.choice, probabilities: scores };
}

/**
 * The sentence a highlight answer picked: `null` when it answered that no sentence states a dose,
 * `undefined` when the answer is missing or unusable. Highlighting is optional: an unusable
 * answer drops the highlight, not the check.
 */
export function readSentence(answer: any, text: string): string | null | undefined {
  if (!answer) return undefined;
  const sentences = splitSentences(text);
  try {
    const { choice } = readChoice(answer, [...sentences.map((_, n) => `s${n + 1}`), 'none']);
    return choice === 'none' ? null : sentences[Number(choice.slice(1)) - 1];
  } catch {
    return undefined;
  }
}

/**
 * Medication `i`'s result from the model's answers.
 *
 * The no-dose rule: Jebadiah, AutoJev and Decider each labeled a note with no dose `agreement`
 * while their own highlight question found no dose sentence. The dose criteria say a missing
 * dose is insufficient information, so the Bot trusts the highlight answer over an `agreement`
 * label. It never downgrades `potential_conflict`. Hosted Jev labels that note correctly itself.
 */
export function doseResult(
  answers: Record<string, any>,
  i: number,
  medication: string,
  outsideText: string,
  noteText: string
): ReviewResult {
  const { choice, probabilities } = readChoice(answers[`dose_${i}`], labels);
  const confidence = answers[`dose_${i}`].confidence;
  if (!isProbability(confidence)) throw new Unavailable('The model returned an invalid answer');
  const outside = readSentence(answers[`sentence_outside_document_${i}`], outsideText);
  const note = readSentence(answers[`sentence_visit_note_${i}`], noteText);
  const ruled = choice === 'agreement' && (outside === null || note === null);
  return {
    medication,
    choice: ruled ? 'insufficient_information' : (choice as ReviewLabel),
    probabilities: probabilities as Record<ReviewLabel, number>,
    confidence,
    sentence_outside: outside ?? undefined,
    sentence_note: note ?? undefined,
    ...(ruled ? { label_rule: 'no_dose_sentence' as const } : {}),
  };
}

export async function review(medplum: MedplumClient, event: BotEvent, encounterId: string): Promise<ReviewOutput> {
  // Leave 1 s for answer validation and the hosted Bot's response handling before its 10 s stop.
  const deadline = Date.now() + 9000;
  const service = modelService((name) => optionalSecret(event, name));
  const chart = await withBudget(3500, 'Chart preparation did not finish in time; retry later', (signal) =>
    readChart(medplum, encounterId, signal)
  );
  const body = buildRequest(chart.medications, chart.outside, chart.note, service.maxSentences);
  const response = await callModel(service, body, deadline);
  const answers = response?.answers ?? {};

  const results = chart.medications.map((medication, i) =>
    doseResult(answers, i, medication, chart.outside.text, chart.note.text)
  );
  const hospital = answers.mentions_hospital_stay;
  if (hospital?.type !== 'noul' || !isProbability(hospital.noul)) {
    throw new Unavailable('The model returned an invalid answer');
  }
  const inputTokens = response?.usage?.input_tokens;
  if (typeof response?.model !== 'string' || !Number.isInteger(inputTokens) || inputTokens < 1) {
    throw new Unavailable('The model returned an invalid answer');
  }

  return {
    status: 'ok',
    checked_at: new Date().toISOString(),
    model: response.model,
    input_tokens: inputTokens,
    results,
    mentions_hospital_stay: hospital.noul,
    documents: [
      { title: chart.outside.title, date: chart.outside.date, text: chart.outside.text, source: chart.sources[0] },
      { title: chart.note.title, date: chart.note.date, text: chart.note.text, source: chart.sources[1] },
    ],
    note_version: chart.noteVersion,
    outside_version: chart.outsideVersion,
  };
}

export async function handler(medplum: MedplumClient, event: BotEvent): Promise<ReviewOutput> {
  if (!event.requester) throw new Error('A signed-in demo user is required');
  const encounterId = parseInput(event.input);
  try {
    return await review(medplum, event, encounterId);
  } catch (err) {
    if (err instanceof Unavailable) return { status: 'unavailable', reason: err.message };
    // Unknown failures can carry request details; return a fixed message instead.
    return { status: 'unavailable', reason: 'The check could not be completed' };
  }
}
