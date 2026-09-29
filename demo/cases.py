"""Authored synthetic fixtures; expected labels are never model inputs."""

from dataclasses import dataclass


@dataclass(frozen=True)
class Document:
    title: str
    date: str
    text: str


@dataclass(frozen=True)
class Case:
    id: str
    title: str
    topic: str
    documents: tuple[Document, Document]
    question: str
    expected: str
    review_note: str


CASES = (
    Case("dose-conflict", "Two doses, same discharge", "Medication dose", (
        Document("Discharge medication list", "2026-08-12", "Synthetic patient A. Current discharge prescription: lisinopril 10 mg by mouth once daily."),
        Document("Discharge instructions", "2026-08-12", "Synthetic patient A. Take lisinopril 20 mg by mouth once daily after this discharge."),
    ), "Are the two discharge records consistent about the prescribed lisinopril dose?", "potential_conflict",
         "The records give different doses for the same discharge. A clinician must resolve the discrepancy; neither record establishes the correct dose."),
    Case("dose-agreement", "Same dose, different wording", "Medication dose", (
        Document("Medication list", "2026-08-12", "Synthetic patient B. Metformin: one 500 mg tablet by mouth twice daily."),
        Document("Visit summary", "2026-08-12", "Synthetic patient B. Metformin 500 mg orally in the morning and 500 mg in the evening."),
    ), "Are the documents consistent about the metformin dose and frequency?", "agreement",
         "Both state 500 mg twice daily. This checks agreement, not whether the prescription is appropriate."),
    Case("dose-dated-change", "An explicit dose change", "Medication dose", (
        Document("Earlier medication list", "2026-08-01", "Synthetic patient C. Amlodipine 5 mg once daily."),
        Document("Follow-up medication plan", "2026-08-15", "Synthetic patient C. Increase amlodipine from 5 mg once daily to 10 mg once daily starting today; the old 5 mg dose is superseded."),
    ), "Do these dated records describe a compatible medication history, accounting for explicit changes?", "agreement",
         "The later note explicitly explains the change. Different doses on different dates are not automatically a conflict."),
    Case("dose-missing", "A medication with no dose", "Medication dose", (
        Document("Medication list", "2026-08-12", "Synthetic patient D. Losartan 50 mg once daily."),
        Document("Transfer note", "2026-08-12", "Synthetic patient D. Continue losartan. Dose and frequency are not recorded in this note."),
    ), "Is there enough information to determine whether both documents agree about the losartan dose and frequency?", "insufficient_information",
         "The transfer note omits dose and frequency. Omission is not evidence of either agreement or a contradictory prescription."),
    Case("allergy-conflict", "An allergy and a denial", "Allergies", (
        Document("Allergy list", "2026-08-12", "Synthetic patient E. Active allergy: penicillin; reaction recorded as hives."),
        Document("Same-day intake", "2026-08-12", "Synthetic patient E. No known drug allergies. No allergy reassessment is documented."),
    ), "Are the same-day records consistent about whether a drug allergy is recorded?", "potential_conflict",
         "An active allergy and an explicit denial conflict. A clinician must investigate; the demo must not delete either claim."),
    Case("allergy-agreement", "The same allergy in both records", "Allergies", (
        Document("Allergy list", "2026-08-12", "Synthetic patient F. Sulfonamide antibiotic allergy: rash."),
        Document("Clinic note", "2026-08-12", "Synthetic patient F. Reports rash after a sulfonamide antibiotic; allergy remains listed."),
    ), "Are the records consistent about the listed sulfonamide antibiotic allergy?", "agreement",
         "Both records explicitly describe the same listed allergy and reaction."),
    Case("allergy-missing", "An allergy section left blank", "Allergies", (
        Document("Allergy list", "2026-08-12", "Synthetic patient G. Penicillin allergy: hives."),
        Document("Transfer form", "2026-08-12", "Synthetic patient G. Allergy section: not completed."),
    ), "Is there enough information to determine whether the records agree about penicillin allergy status?", "insufficient_information",
         "A blank section is not an explicit statement of no allergies."),
    Case("allergy-dated-change", "A documented allergy reassessment", "Allergies", (
        Document("Older allergy list", "2026-07-01", "Synthetic patient H. Penicillin allergy is listed."),
        Document("Later allergy note", "2026-08-20", "Synthetic patient H. The clinician documents a completed reassessment and explicitly removes the prior penicillin allergy label today. This note supersedes the older list."),
    ), "Do the records describe a compatible dated history, accounting for the explicit reassessment?", "agreement",
         "The later note explains the changed record. The demo does not verify that the reassessment was clinically adequate."),
    Case("dose-dates-unexplained", "Different dates, no explanation", "Medication dose", (
        Document("Earlier medication list", "2026-08-01", "Synthetic patient I. Atenolol 25 mg once daily."),
        Document("Later medication list", "2026-08-20", "Synthetic patient I. Atenolol 50 mg once daily. No treatment-change history or explanation accompanies this list."),
    ), "Can these documents establish whether the different atenolol doses reflect an intended change or a documentation conflict?", "insufficient_information",
         "Dates alone do not explain whether the change was intentional. The clinician needs additional information."),
)
BY_ID = {case.id: case for case in CASES}


def model_state(case: Case) -> str:
    return "\n\n".join(
        f"Document {i}: {doc.title}\nDate: {doc.date}\n{doc.text}"
        for i, doc in enumerate(case.documents, 1)
    )
