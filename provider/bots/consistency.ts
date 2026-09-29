import type { BotEvent, MedplumClient } from '@medplum/core';
import type { ClinicalImpression, DocumentReference, Encounter, MedicationRequest } from '@medplum/fhirtypes';
import contract from '../src/data/model-contract.json' with { type: 'json' };

// Reads the visit note, the newest outside discharge summary and the active medications
// as the signed-in user (the Bot runs with runAsUser), asks hosted Jev whether the two
// documents agree about each medication's dose, and returns the result. It writes nothing:
// the review card stores the result as a DetectedIssue under the user's own access.

const DISCHARGE_SUMMARY_TYPE = 'http://loinc.org|18842-5';
const ID_PATTERN = /^[A-Za-z0-9.-]{1,64}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const { limits, labels } = contract;

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
  note: SourceDocument
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
      if (sentences.length < 1 || sentences.length > limits.max_sentences) continue;
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
    medplum.searchOne('ClinicalImpression', { encounter: `Encounter/${encounterId}`, _sort: '-_lastUpdated' }),
    medplum.searchResources('MedicationRequest', { subject, status: 'active' }),
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
  };
}

async function callTypeSafe(apiKey: string, body: unknown): Promise<Record<string, any>> {
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(contract.endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      });
    } catch {
      throw new Unavailable('The model service could not be reached; retry later');
    }
    if (response.ok) return response.json();
    if ((response.status === 429 || response.status === 529) && attempt === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      continue;
    }
    // Plain messages only: the response body can echo the request, which holds chart text.
    const messages: Record<number, string> = {
      401: 'The model service rejected the project credentials',
      422: 'The model service rejected the request format',
      429: 'The model service is rate limited; retry shortly',
      529: 'The model service is overloaded; retry shortly',
    };
    throw new Unavailable(messages[response.status] ?? 'The model service is unavailable');
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

function selectedSentence(answer: any, text: string): string | undefined {
  // Highlighting is optional: an unusable answer drops the highlight, not the check.
  if (!answer) return undefined;
  const sentences = splitSentences(text);
  try {
    const { choice } = readChoice(answer, [...sentences.map((_, n) => `s${n + 1}`), 'none']);
    return choice === 'none' ? undefined : sentences[Number(choice.slice(1)) - 1];
  } catch {
    return undefined;
  }
}

export async function review(medplum: MedplumClient, event: BotEvent, encounterId: string): Promise<ReviewOutput> {
  const apiKey = optionalSecret(event, 'TYPESAFE_API_KEY');
  const backend = optionalSecret(event, 'CONSISTENCY_BACKEND') ?? (apiKey ? 'typesafe' : undefined);
  if (backend === 'modal') {
    throw new Unavailable(
      'The self-hosted Modal backend does not accept visit text yet; set CONSISTENCY_BACKEND to typesafe'
    );
  }
  if (backend !== 'typesafe') throw new Unavailable('Project secret CONSISTENCY_BACKEND must be typesafe or modal');
  if (!apiKey) throw new Unavailable('Missing string project secret: TYPESAFE_API_KEY');

  const chart = await readChart(medplum, encounterId);
  const body = buildRequest(chart.medications, chart.outside, chart.note);
  const response = await callTypeSafe(apiKey, body);
  const answers = response?.answers ?? {};

  const results = chart.medications.map((medication, i): ReviewResult => {
    const { choice, probabilities } = readChoice(answers[`dose_${i}`], labels);
    const confidence = answers[`dose_${i}`].confidence;
    if (!isProbability(confidence)) throw new Unavailable('The model returned an invalid answer');
    return {
      medication,
      choice: choice as Label,
      probabilities: probabilities as Record<Label, number>,
      confidence,
      sentence_outside: selectedSentence(answers[`sentence_outside_document_${i}`], chart.outside.text),
      sentence_note: selectedSentence(answers[`sentence_visit_note_${i}`], chart.note.text),
    };
  });
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
