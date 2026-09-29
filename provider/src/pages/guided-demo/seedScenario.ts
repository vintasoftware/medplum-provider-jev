import type { MedplumClient, WithId } from '@medplum/core';
import { createReference } from '@medplum/core';
import type { Coding, DocumentReference, Encounter, Patient, Practitioner, Reference } from '@medplum/fhirtypes';
import scenario from '../../data/guided-scenario.json';
import { buildSignatureProvenance, createAppointment, createEncounter } from '../../utils/encounter';

// Seeds one synthetic post-discharge follow-up per click. Every run creates a new Patient
// instead of resetting an old one, so nothing is ever deleted.

export const RUN_IDENTIFIER_SYSTEM = 'urn:jev-healthcare:demo';
export const DISCHARGE_SUMMARY_CODING: Coding = {
  system: 'http://loinc.org',
  code: '18842-5',
  display: 'Discharge summary',
};
export const LISINOPRIL_10MG: Coding = {
  system: 'http://www.nlm.nih.gov/research/umls/rxnorm',
  code: '314076',
  display: 'lisinopril 10 MG Oral Tablet',
};
export const AMBULATORY: Coding = {
  system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
  code: 'AMB',
  display: 'ambulatory',
};
export const VISIT_TYPE = 'Post-discharge follow-up';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SeededScenario {
  patientId: string;
  encounterId: string;
  documentReferenceId: string;
}

function daysAgo(now: Date, days: number, hour: number): Date {
  const date = new Date(now.getTime() - days * DAY_MS);
  date.setHours(hour, 0, 0, 0);
  return date;
}

function base64(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

export async function seedScenario(
  medplum: MedplumClient,
  practitioner: WithId<Practitioner>,
  now = new Date()
): Promise<SeededScenario> {
  const runId = crypto.randomUUID();
  const practitionerRef = createReference(practitioner) as Reference<Practitioner>;

  const patient = await medplum.createResource<Patient>({
    resourceType: 'Patient',
    active: true,
    identifier: [{ system: RUN_IDENTIFIER_SYSTEM, value: `run-${runId}` }],
    name: [{ given: ['Demo'], family: `Lisinopril ${runId.slice(0, 6)}` }],
    gender: 'unknown',
    birthDate: '1961-04-12',
  });
  const patientRef = createReference(patient);

  // Prior signed visit, created directly because createEncounter forces `planned` and today.
  const priorStart = daysAgo(now, 35, 9);
  const priorEnd = new Date(priorStart.getTime() + 30 * 60 * 1000);
  const priorAppointment = await medplum.createResource({
    resourceType: 'Appointment',
    status: 'fulfilled',
    start: priorStart.toISOString(),
    end: priorEnd.toISOString(),
    participant: [
      { actor: patientRef, status: 'accepted' },
      { actor: practitionerRef, status: 'accepted' },
    ],
  });
  const priorEncounter = await medplum.createResource<Encounter>({
    resourceType: 'Encounter',
    status: 'finished',
    class: AMBULATORY,
    type: [{ text: 'Hypertension follow-up' }],
    subject: patientRef,
    appointment: [createReference(priorAppointment)],
    participant: [{ individual: practitionerRef }],
    period: { start: priorStart.toISOString(), end: priorEnd.toISOString() },
  });
  await medplum.createResource({
    resourceType: 'ClinicalImpression',
    status: 'completed',
    description: 'Initial clinical impression',
    subject: patientRef,
    encounter: createReference(priorEncounter),
    date: priorStart.toISOString(),
    note: [{ text: scenario.prior_note }],
  });
  await medplum.createResource(buildSignatureProvenance(priorEncounter, practitionerRef, priorEnd.toISOString()));

  await medplum.createResource({
    resourceType: 'MedicationRequest',
    status: 'active',
    intent: 'order',
    medicationCodeableConcept: { coding: [LISINOPRIL_10MG], text: LISINOPRIL_10MG.display },
    subject: patientRef,
    encounter: createReference(priorEncounter),
    requester: practitionerRef,
    authoredOn: priorStart.toISOString(),
    dosageInstruction: [{ text: '10 mg by mouth once daily' }],
  });

  // Outside discharge summary: inline data for the Bot, plus a Binary URL so the Documents
  // tab can preview it (the detail panel previews only attachments with a URL).
  const dischargeDate = daysAgo(now, 7, 12);
  const binary = await medplum.createAttachment({
    data: scenario.discharge_summary,
    contentType: 'text/plain',
    filename: 'discharge-summary.txt',
  });
  const summary = await medplum.createResource<DocumentReference>({
    resourceType: 'DocumentReference',
    status: 'current',
    type: { coding: [DISCHARGE_SUMMARY_CODING], text: 'Discharge summary' },
    subject: patientRef,
    date: dischargeDate.toISOString(),
    description: 'Discharge summary',
    author: [{ display: 'Outside Hospital (synthetic)' }],
    content: [
      {
        attachment: {
          contentType: 'text/plain',
          title: 'Discharge summary',
          url: binary.url,
          data: base64(scenario.discharge_summary),
        },
      },
    ],
  });

  // Today's visit through the app's own helpers (no care template), then name it.
  const start = new Date(now);
  start.setSeconds(0, 0);
  const appointment = await createAppointment(
    medplum,
    start,
    new Date(start.getTime() + 30 * 60 * 1000),
    patientRef,
    practitionerRef
  );
  const encounter = await createEncounter(medplum, AMBULATORY, patientRef, undefined, appointment, practitionerRef);
  await medplum.patchResource('Encounter', encounter.id, [{ op: 'add', path: '/type', value: [{ text: VISIT_TYPE }] }]);

  return { patientId: patient.id, encounterId: encounter.id, documentReferenceId: summary.id };
}
