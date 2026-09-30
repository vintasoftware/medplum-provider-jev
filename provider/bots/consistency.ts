import type { BotEvent, MedplumClient } from '@medplum/core';
import type { ClinicalImpression, DocumentReference, Encounter, MedicationRequest } from '@medplum/fhirtypes';
import { COMPLETE_LIST_COUNT } from '../src/config/constants';
import contract from '../src/data/model-contract.json' with { type: 'json' };

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

/**
 * The search that picks a visit's note: the most recently updated ClinicalImpression for the
 * encounter and its patient. The editor, the Bot and the tutorial use it so they read the same note.
 */
export function noteSearch(encounter: string, subject: string): Record<string, string> {
  return { encounter, subject, _sort: '-_lastUpdated', _count: '1' };
}

type Label = (typeof contract.labels)[number];
type SourceDocument = { title: string; date: string; author: string; text: string };
type Question = { type: 'choice' | 'noul'; instructions: string; criteria?: Record<string, string> };

export type ReviewResult = {
  medication: string;
  choice: Label;
  probabilities: Record<Label, number>;
  confidence: number;
  sentence_outside?: string;
  sentence_note?: string;
  /** Set when a rule, not the model's top score, chose `choice`; `probabilities` and `confidence` stay the model's. */
  label_rule?: 'no_dose_sentence';
};

export type ReviewOutput =
  | {
      status: 'ok';
      checked_at: string;
      model: string;
      input_tokens: number;
      results: ReviewResult[];
      mentions_hospital_stay: number;
      documents: { title: string; date: string; text: string; source: string }[];
      note_version: string | undefined;
      /** Version of the discharge summary that was checked. Missing in Bot responses before it was added. */
      outside_version?: string;
    }
  | { status: 'unavailable'; reason: string };

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

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function medicationName(request: MedicationRequest): string | undefined {
  const concept = request.medicationCodeableConcept;
  const display =
    concept?.coding?.find((c) => c.system === 'http://www.nlm.nih.gov/research/umls/rxnorm')?.display ??
    concept?.coding?.[0]?.display ??
    concept?.text;
  // "lisinopril 10 MG Oral Tablet" -> "lisinopril": the strength is what the check compares.
  const name = display?.toLowerCase().split(/\d/)[0].trim();
  return name && name.length <= 80 ? name : undefined;
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

async function attachmentText(medplum: MedplumClient, doc: DocumentReference): Promise<string> {
  const attachment = doc.content?.[0]?.attachment;
  if (!attachment?.contentType?.startsWith('text/plain')) {
    throw new Unavailable('The discharge summary is not plain text');
  }
  if (attachment.data) return Buffer.from(attachment.data, 'base64').toString('utf8');
  if (attachment.url) return (await medplum.download(attachment.url)).text();
  throw new Unavailable('The discharge summary has no text');
}

async function readChart(
  medplum: MedplumClient,
  encounterId: string
): Promise<{
  medications: string[];
  outside: SourceDocument;
  note: SourceDocument;
  sources: string[];
  noteVersion?: string;
  outsideVersion?: string;
}> {
  let encounter: Encounter;
  try {
    encounter = await medplum.readResource('Encounter', encounterId);
  } catch {
    throw new Unavailable('This visit is not accessible');
  }
  const subject = encounter.subject?.reference;
  if (!subject?.startsWith('Patient/')) throw new Unavailable('This visit is not accessible');

  const [impression, requests, summaries] = await Promise.all([
    medplum.searchOne('ClinicalImpression', noteSearch(`Encounter/${encounterId}`, subject)),
    medplum.searchResources('MedicationRequest', { subject, status: 'active', _count: COMPLETE_LIST_COUNT }),
    medplum.searchResources('DocumentReference', {
      subject,
      type: DISCHARGE_SUMMARY_TYPE,
      status: 'current',
      _sort: '-date',
      _count: '1',
    }),
  ]);

  const noteText = (impression as ClinicalImpression | undefined)?.note?.[0]?.text?.trim();
  if (!impression || !noteText) throw new Unavailable('No chart note has been saved for this visit yet');
  const medications = [...new Set(requests.map(medicationName).filter((m): m is string => !!m))];
  if (medications.length === 0) throw new Unavailable('No active medications to compare');
  if (medications.length > limits.max_medications)
    throw new Unavailable('Too many active medications for the demo check');
  const summary = summaries[0];
  if (!summary) throw new Unavailable('No outside discharge summary is on file');

  const outside = checkDocument({
    title: summary.description ?? summary.type?.text ?? 'Discharge summary',
    date: summary.date?.slice(0, 10) ?? '',
    author: summary.author?.[0]?.display ?? 'outside organization',
    text: await attachmentText(medplum, summary),
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
    noteVersion: impression.meta?.versionId,
    outsideVersion: summary.meta?.versionId,
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

async function callModel(service: ModelService, body: unknown): Promise<Record<string, any>> {
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(service.url, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(service.timeoutMs),
        headers: { 'Content-Type': 'application/json', ...service.headers },
        body: JSON.stringify(body),
      });
    } catch {
      throw new Unavailable(service.messages[0]);
    }
    if (response.ok) return response.json();
    if ((response.status === 429 || response.status === 529) && attempt === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      continue;
    }
    throw new Unavailable(service.messages[response.status] ?? 'The model service is unavailable');
  }
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
    choice: ruled ? 'insufficient_information' : (choice as Label),
    probabilities: probabilities as Record<Label, number>,
    confidence,
    sentence_outside: outside ?? undefined,
    sentence_note: note ?? undefined,
    ...(ruled ? { label_rule: 'no_dose_sentence' as const } : {}),
  };
}

export async function review(medplum: MedplumClient, event: BotEvent, encounterId: string): Promise<ReviewOutput> {
  const service = modelService((name) => optionalSecret(event, name));
  const chart = await readChart(medplum, encounterId);
  const body = buildRequest(chart.medications, chart.outside, chart.note, service.maxSentences);
  const response = await callModel(service, body);
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
