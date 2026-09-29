import type { WithId } from '@medplum/core';
import type {
  ClinicalImpression,
  DocumentReference,
  Encounter,
  MedicationRequest,
  Patient,
  Practitioner,
  Provenance,
  Reference,
} from '@medplum/fhirtypes';
import { MockClient } from '@medplum/mock';
import { beforeEach, describe, expect, test } from 'vitest';
import scenario from '../../data/guided-scenario.json';
import { buildSignatureProvenance } from '../../utils/encounter';
import { RUN_IDENTIFIER_SYSTEM, seedScenario, VISIT_TYPE } from './seedScenario';

let medplum: MockClient;
let practitioner: WithId<Practitioner>;
const NOW = new Date('2026-09-23T14:05:30Z');

beforeEach(async () => {
  medplum = new MockClient();
  practitioner = await medplum.createResource<Practitioner>({
    resourceType: 'Practitioner',
    name: [{ given: ['Synthetic'], family: 'Rivera' }],
  });
});

describe('seedScenario', () => {
  test('creates the chart the guided demo needs', async () => {
    const seeded = await seedScenario(medplum, practitioner, NOW);
    const subject = `Patient/${seeded.patientId}`;

    const patient = await medplum.readResource('Patient', seeded.patientId);
    expect(patient.identifier?.[0]).toMatchObject({
      system: RUN_IDENTIFIER_SYSTEM,
      value: expect.stringMatching(/^run-[0-9a-f-]{36}$/),
    });
    expect(patient.name?.[0]?.family).toMatch(/^Lisinopril [0-9a-f]{6}$/);

    const encounters = (await medplum.searchResources('Encounter', { subject })) as WithId<Encounter>[];
    const today = encounters.find((e) => e.id === seeded.encounterId);
    const prior = encounters.find((e) => e.id !== seeded.encounterId);
    expect(today).toMatchObject({ status: 'planned', type: [{ text: VISIT_TYPE }] });
    expect(prior).toMatchObject({
      status: 'finished',
      class: { code: 'AMB' },
      type: [{ text: 'Hypertension follow-up' }],
    });
    expect(new Date(prior?.period?.start ?? '').getTime()).toBeLessThan(NOW.getTime() - 34 * 24 * 3600 * 1000);

    const impressions = (await medplum.searchResources('ClinicalImpression', { subject })) as ClinicalImpression[];
    expect(impressions.find((c) => c.encounter?.reference === `Encounter/${prior?.id}`)).toMatchObject({
      status: 'completed',
      note: [{ text: scenario.prior_note }],
    });
    // Today's note starts empty; the tester writes it.
    expect(impressions.find((c) => c.encounter?.reference === `Encounter/${seeded.encounterId}`)?.note).toBeUndefined();

    const [signature] = (await medplum.searchResources('Provenance', {
      target: `Encounter/${prior?.id}`,
    })) as Provenance[];
    const expected = buildSignatureProvenance(
      prior as Encounter,
      signature.agent[0].who as Reference<Practitioner>,
      signature.recorded
    );
    expect(signature).toMatchObject({ ...expected, target: [{ reference: `Encounter/${prior?.id}` }] });

    const [medication] = (await medplum.searchResources('MedicationRequest', { subject })) as MedicationRequest[];
    expect(medication).toMatchObject({
      status: 'active',
      intent: 'order',
      medicationCodeableConcept: { coding: [{ code: '314076', display: 'lisinopril 10 MG Oral Tablet' }] },
      dosageInstruction: [{ text: '10 mg by mouth once daily' }],
    });

    const summary = (await medplum.readResource('DocumentReference', seeded.documentReferenceId)) as DocumentReference;
    const attachment = summary.content[0].attachment;
    expect(summary).toMatchObject({
      status: 'current',
      type: { coding: [{ system: 'http://loinc.org', code: '18842-5' }] },
      author: [{ display: 'Outside Hospital (synthetic)' }],
    });
    expect(summary.date?.slice(0, 10)).toBe('2026-09-16');
    expect(attachment.contentType).toBe('text/plain');
    expect(attachment.url).toBeTruthy();
    expect(new TextDecoder().decode(Uint8Array.from(atob(attachment.data ?? ''), (c) => c.charCodeAt(0)))).toBe(
      scenario.discharge_summary
    );
  });

  test('creates a new patient on every run', async () => {
    const first = await seedScenario(medplum, practitioner, NOW);
    const second = await seedScenario(medplum, practitioner, NOW);
    expect(second.patientId).not.toBe(first.patientId);
    expect(second.encounterId).not.toBe(first.encounterId);
    const patients = (await medplum.searchResources('Patient', {
      identifier: `${RUN_IDENTIFIER_SYSTEM}|`,
    })) as Patient[];
    expect(new Set(patients.map((p) => p.identifier?.[0]?.value)).size).toBe(patients.length);
  });
});
