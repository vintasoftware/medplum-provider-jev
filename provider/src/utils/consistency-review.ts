// Definitions shared by the consistency Bot and the app. Both bundles include this module, so it
// must stay free of browser and Node specifics, and a change here needs `npm --prefix provider run deploy:bot`.
import contract from '../data/model-contract.json' with { type: 'json' };

export type ReviewLabel = (typeof contract.labels)[number];

export interface ReviewResult {
  medication: string;
  choice: ReviewLabel;
  probabilities: Record<ReviewLabel, number>;
  confidence: number;
  sentence_outside?: string;
  sentence_note?: string;
  /** Set when a rule, not the model's top score, chose `choice`; `probabilities` and `confidence` stay the model's. */
  label_rule?: 'no_dose_sentence';
}

export type ReviewOutput =
  | {
      status: 'ok';
      checked_at: string;
      model: string;
      input_tokens: number;
      results: ReviewResult[];
      mentions_hospital_stay: number;
      documents: { title: string; date: string; text: string; source: string }[];
      note_version: string;
      outside_version: string;
    }
  | { status: 'unavailable'; reason: string };

export type ReviewSuccess = Extract<ReviewOutput, { status: 'ok' }>;

/**
 * The search that picks a visit's note: the most recently updated ClinicalImpression for the
 * encounter and its patient. The editor, the Bot and the tutorial use it so they read the same note.
 *
 * @param encounter - Encounter reference string.
 * @param subject - Patient reference string.
 * @returns Search parameters for `ClinicalImpression`.
 */
export function noteSearch(encounter: string, subject: string): Record<string, string> {
  return { encounter, subject, _sort: '-_lastUpdated', _count: '1' };
}

/**
 * Splits text into the sentences the highlight questions list. The Bot and the card must split
 * the same way, since a stored check refers to sentences by position.
 *
 * @param text - Document text.
 * @returns Trimmed, non-empty sentences.
 */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
