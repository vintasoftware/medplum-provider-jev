import type { MedplumClient, WithId } from '@medplum/core';
import { createReference } from '@medplum/core';
import type {
  ClinicalImpression,
  DetectedIssue,
  DocumentReference,
  Encounter,
  ExtractResource,
  Patient,
  Practitioner,
  Reference,
} from '@medplum/fhirtypes';
import contract from '../data/model-contract.json';
import type { ReviewLabel, ReviewOutput, ReviewResult, ReviewSuccess } from './consistency-review';
import { splitSentences } from './consistency-review';

export const REVIEW_LABELS: Record<ReviewLabel, string> = {
  agreement: 'Agreement',
  potential_conflict: 'Potential conflict',
  insufficient_information: 'Insufficient information',
};
export const REVIEW_LABEL_COLORS: Record<ReviewLabel, string> = {
  agreement: 'teal',
  potential_conflict: 'orange',
  insufficient_information: 'yellow',
};

export const CHECK_CODE_SYSTEM = 'urn:jev-healthcare:guided-demo';
export const CHECK_CODE = 'cross-document-consistency';
export const CHECK_RESULT_EXTENSION = 'urn:jev-healthcare:guided-demo:consistency-result';
export const SIGNED_WITH_REASON = 'Signed with documented reason';
export const RECONCILIATION_TASK_CREATED = 'Reconciliation task created';

export async function reviewEncounter(medplum: MedplumClient, encounterId: string): Promise<ReviewOutput> {
  const botId = import.meta.env.MEDPLUM_CONSISTENCY_BOT_ID;
  const projectId = import.meta.env.MEDPLUM_PROJECT_ID;
  if (!botId) {
    return { status: 'unavailable', reason: 'The consistency Bot is not configured yet' };
  }
  if (!projectId || medplum.getProject()?.id !== projectId) {
    return { status: 'unavailable', reason: 'Sign in to the configured synthetic demo project' };
  }
  const result = (await medplum.executeBot(
    botId,
    { action: 'review_encounter', encounter_id: encounterId },
    'application/json'
  )) as ReviewOutput;
  if (result?.status !== 'ok' && result?.status !== 'unavailable') {
    return { status: 'unavailable', reason: 'The check returned an unexpected response' };
  }
  return result;
}

const SEVERITY: ReviewLabel[] = ['potential_conflict', 'insufficient_information', 'agreement'];

/**
 * The result the card leads with: any conflict first, then missing information.
 * @param results - The results of one check.
 * @returns The result to lead with.
 */
export function headlineResult<T extends Pick<ReviewResult, 'choice'>>(results: T[]): T | undefined {
  return [...results].sort((a, b) => SEVERITY.indexOf(a.choice) - SEVERITY.indexOf(b.choice))[0];
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/**
 * Stored form of a check. Holds labels, scores and sentence positions but no chart text:
 * passages are re-read from the versioned sources when the card reloads.
 */
export interface StoredCheck {
  model: string;
  input_tokens: number;
  checked_at: string;
  mentions_hospital_stay: number;
  results: (Omit<ReviewResult, 'sentence_outside' | 'sentence_note'> & {
    sentence_outside_index?: number;
    sentence_note_index?: number;
  })[];
}

function sentenceIndex(text: string, sentence: string | undefined): number | undefined {
  if (!sentence) {
    return undefined;
  }
  const index = splitSentences(text).indexOf(sentence);
  return index >= 0 ? index : undefined;
}

export function buildDetectedIssue(
  review: ReviewSuccess,
  patient: Reference<Patient>,
  encounter: WithId<Encounter>,
  author: Reference<Practitioner>
): DetectedIssue {
  const [outside, note] = review.documents;
  const stored: StoredCheck = {
    model: review.model,
    input_tokens: review.input_tokens,
    checked_at: review.checked_at,
    mentions_hospital_stay: review.mentions_hospital_stay,
    results: review.results.map(({ sentence_outside, sentence_note, ...rest }) => ({
      ...rest,
      sentence_outside_index: sentenceIndex(outside.text, sentence_outside),
      sentence_note_index: sentenceIndex(note.text, sentence_note),
    })),
  };
  const noteReference = `${note.source}/_history/${review.note_version}`;
  const outsideReference = `${outside.source}/_history/${review.outside_version}`;
  return {
    resourceType: 'DetectedIssue',
    status: 'preliminary',
    code: {
      coding: [{ system: CHECK_CODE_SYSTEM, code: CHECK_CODE, display: 'Cross-document consistency check' }],
      text: 'Cross-document consistency check',
    },
    patient,
    identifiedDateTime: review.checked_at,
    author,
    implicated: [createReference(encounter), { reference: noteReference }, { reference: outsideReference }],
    detail: review.results
      .map(
        (r) =>
          `${REVIEW_LABELS[r.choice]} (${r.medication}): ` +
          contract.labels.map((l) => `${REVIEW_LABELS[l]} ${percent(r.probabilities[l])}`).join(', ') +
          (r.label_rule === 'no_dose_sentence' ? ' (label set by rule: no dose sentence in one document)' : '')
      )
      .join('; '),
    evidence: [
      {
        detail: [
          { reference: outsideReference, display: outside.title },
          { reference: noteReference, display: note.title },
        ],
      },
    ],
    extension: [{ url: CHECK_RESULT_EXTENSION, valueString: JSON.stringify(stored) }],
  };
}

export function readStoredCheck(issue: DetectedIssue): StoredCheck | undefined {
  const value = issue.extension?.find((e) => e.url === CHECK_RESULT_EXTENSION)?.valueString;
  try {
    return value ? (JSON.parse(value) as StoredCheck) : undefined;
  } catch {
    return undefined;
  }
}

/** A versioned reference implicated by a check, e.g. `ClinicalImpression/1/_history/3`. */
export interface ImplicatedSource {
  reference: string;
  id: string;
  versionId: string;
}

function implicatedSource(issue: DetectedIssue, resourceType: string): ImplicatedSource | undefined {
  const pattern = new RegExp(`^${resourceType}/([^/]+)/_history/([^/]+)$`);
  const match = issue.implicated?.map((r) => pattern.exec(r.reference ?? '')).find(Boolean);
  return match ? { reference: match[0], id: match[1], versionId: match[2] } : undefined;
}

export function implicatedNote(issue: DetectedIssue): ImplicatedSource | undefined {
  return implicatedSource(issue, 'ClinicalImpression');
}

export function implicatedDocument(issue: DetectedIssue): ImplicatedSource | undefined {
  return implicatedSource(issue, 'DocumentReference');
}

/**
 * The version of a source that a check read, or undefined when it cannot be loaded.
 *
 * @param medplum - The Medplum client.
 * @param resourceType - The source's resource type.
 * @param reference - The versioned reference, as `implicatedNote` or `implicatedDocument` return it.
 * @returns The source at that version.
 */
export async function readCheckedVersion<K extends 'ClinicalImpression' | 'DocumentReference'>(
  medplum: MedplumClient,
  resourceType: K,
  reference: string
): Promise<ExtractResource<K> | undefined> {
  const [, id, , versionId] = reference.split('/');
  try {
    return await medplum.readVersion(resourceType, id, versionId);
  } catch {
    return undefined;
  }
}

export async function findLatestCheck(
  medplum: MedplumClient,
  encounterId: string
): Promise<WithId<DetectedIssue> | undefined> {
  return medplum.searchOne(
    'DetectedIssue',
    // Sort by identification time: adding a mitigation changes _lastUpdated of an older check.
    { implicated: `Encounter/${encounterId}`, code: `${CHECK_CODE_SYSTEM}|${CHECK_CODE}`, _sort: '-identified' },
    { cache: 'no-cache' }
  );
}

/**
 * The text of a document's first attachment, inline (`data`) or by URL (e.g. a Binary).
 * @param medplum - The Medplum client.
 * @param doc - The document.
 * @returns The text, or undefined without an attachment.
 */
export async function attachmentText(medplum: MedplumClient, doc: DocumentReference): Promise<string | undefined> {
  const attachment = doc.content?.[0]?.attachment;
  if (attachment?.data) {
    return new TextDecoder().decode(Uint8Array.from(atob(attachment.data), (c) => c.charCodeAt(0)));
  }
  if (attachment?.url) {
    return (await medplum.download(attachment.url)).text();
  }
  return undefined;
}

export function noteText(impression: ClinicalImpression | undefined): string {
  return impression?.note?.[0]?.text ?? '';
}

export async function appendMitigation(
  medplum: MedplumClient,
  issue: WithId<DetectedIssue>,
  action: string,
  author: Reference<Practitioner>,
  finalize: boolean
): Promise<WithId<DetectedIssue>> {
  const mitigation = { action: { text: action }, date: new Date().toISOString(), author };
  return medplum.patchResource('DetectedIssue', issue.id, [
    {
      op: 'add',
      path: issue.mitigation ? '/mitigation/-' : '/mitigation',
      value: issue.mitigation ? mitigation : [mitigation],
    },
    ...(finalize ? [{ op: 'replace' as const, path: '/status', value: 'final' }] : []),
  ]);
}
