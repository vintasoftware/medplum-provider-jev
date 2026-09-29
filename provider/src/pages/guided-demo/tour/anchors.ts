// `data-tour` values the tutorial overlays point at. Kept in one place so drift in the
// upstream markup they are attached to can be found with one grep.
export const TOUR = {
  patientSummary: 'patient-summary',
  documentDetail: 'document-detail',
  visitStatus: 'visit-status',
  visitSign: 'visit-sign',
  chartNote: 'chart-note',
  checkNote: 'check-note',
  reviewCard: 'review-card',
  reviewActions: 'review-actions',
} as const;

export type TourAnchor = (typeof TOUR)[keyof typeof TOUR];

export function tourSelector(anchor: TourAnchor): string {
  return `[data-tour="${anchor}"]`;
}

// Upstream LinkTabs renders each patient tab as an anchor ending in the tab URL.
export const PATIENT_TAB_SELECTORS = {
  documents: '.pill-tabs a[href$="/DocumentReference"]',
  visits: '.pill-tabs a[href$="/Encounter"]',
} as const;
