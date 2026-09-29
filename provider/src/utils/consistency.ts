import type { MedplumClient, WithId } from '@medplum/core';
import { createReference, getReferenceString } from '@medplum/core';
import type {
  ClinicalImpression,
  DetectedIssue,
  DocumentReference,
  Encounter,
  Patient,
  Practitioner,
  Reference,
} from '@medplum/fhirtypes';
import type { ReviewOutput, ReviewResult } from '../../bots/consistency';
import { splitSentences } from '../../bots/consistency';
import contract from '../data/model-contract.json';

export { splitSentences };
export type { ReviewOutput };
export type ReviewLabel = ReviewResult['choice'];
export type ReviewSuccess = Extract<ReviewOutput, { status: 'ok' }>;

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

/** The result the card leads with: any conflict first, then missing information. */
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
  const noteReference = review.note_version ? `${note.source}/_history/${review.note_version}` : note.source;
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
    implicated: [createReference(encounter), { reference: noteReference }, { reference: outside.source }],
    detail: review.results
      .map(
        (r) =>
          `${REVIEW_LABELS[r.choice]} (${r.medication}): ` +
          contract.labels
            .map((l) => `${REVIEW_LABELS[l as ReviewLabel]} ${percent(r.probabilities[l as ReviewLabel])}`)
            .join(', ') +
          (r.label_rule === 'no_dose_sentence' ? ' (label set by rule: no dose sentence in one document)' : '')
      )
      .join('; '),
    evidence: [
      {
        detail: [
          { reference: outside.source, display: outside.title },
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

/** The implicated note reference, e.g. `ClinicalImpression/1/_history/3`. */
export function implicatedNote(issue: DetectedIssue): { id: string; versionId?: string } | undefined {
  const match = issue.implicated
    ?.map((r) => r.reference ?? '')
    .map((ref) => /^ClinicalImpression\/([^/]+)(?:\/_history\/([^/]+))?$/.exec(ref))
    .find(Boolean);
  return match ? { id: match[1], versionId: match[2] } : undefined;
}

export function implicatedDocument(issue: DetectedIssue): string | undefined {
  return issue.implicated?.map((r) => r.reference).find((ref) => ref?.startsWith('DocumentReference/'));
}

export async function findLatestCheck(
  medplum: MedplumClient,
  encounter: WithId<Encounter>
): Promise<WithId<DetectedIssue> | undefined> {
  return medplum.searchOne(
    'DetectedIssue',
    // Sort by identification time: adding a mitigation changes _lastUpdated of an older check.
    { implicated: getReferenceString(encounter), code: `${CHECK_CODE_SYSTEM}|${CHECK_CODE}`, _sort: '-identified' },
    { cache: 'no-cache' }
  );
}

export function decodeAttachment(doc: DocumentReference): string | undefined {
  const data = doc.content?.[0]?.attachment?.data;
  if (!data) {
    return undefined;
  }
  return new TextDecoder().decode(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));
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
