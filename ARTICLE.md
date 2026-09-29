# A Jev-like AI for healthcare: checking visit notes against discharge summaries in Medplum

*Updated September 29, 2026. This demo uses synthetic data only.*

A patient comes back to primary care one week after a hospital stay for high blood pressure. The hospital raised their lisinopril from 10 mg to 20 mg. The clinic's chart still lists 10 mg, and a busy provider copies that dose into the visit plan.

![The chart lists lisinopril 10 MG, the visit note copies "continue lisinopril 10 mg daily", and the outside discharge summary says the dose was increased to 20 mg.](article/images/problem.png)

The discharge summary has the information the provider needs, but it sits in a separate document. Catching the discrepancy means reading that document alongside the new note, before the old dose becomes part of another signed plan.

This project adds that check to the open-source [Medplum Provider App](https://github.com/medplum/medplum/tree/main/examples/medplum-provider). When the provider finishes a visit, a Medplum Bot asks a decision model whether the note and the latest outside discharge summary agree on each active medication's dose. A review card shows the answer beside both passages. The provider can then correct the note, explain why the plan differs, or ask someone to reconcile the medication. The model never changes the chart, blocks signing or chooses a treatment.

The guided demo runs end to end with TypeSafe's hosted Jev. It lets us test both the document comparison and what happens after a provider sees the result. An open, self-hosted model runs the same demo and is under evaluation.

## Following the discrepancy through a visit

In the demo, **Start scenario** creates a new synthetic patient with that history. A signed visit from 35 days ago lists lisinopril 10 mg, and the active order still has that dose. The discharge summary from a week ago raises it to 20 mg. Today's follow-up is ready to begin. The video follows the provider through that visit in the real app, connected to a hosted Medplum project.

[![Watch the full guided demo, about two minutes.](article/images/demo-poster.png)](https://github.com/user-attachments/assets/ce413f25-983d-4384-9b5a-30054e6a4ebd)

The provider reads the discharge summary, writes the visit note and sets the visit to **Finished**. That saves the note and runs the check once. If the plan says "continue lisinopril 10 mg daily", the card reports a potential conflict and highlights the dose in each document.

From there, the provider can edit the plan to acknowledge the hospital's increase to 20 mg, then press **Check note** to review the revised text. They can also sign with a documented reason or create a reconciliation task. There is no Dismiss button, but the card never prevents signing. Each choice is stored in the chart as FHIR records.

Changing the note shows what the check is looking for. A note that acknowledges the discharge dose produces agreement. "Continue lisinopril", with no dose, leaves too little information to compare. An unexplained increase to 40 mg produces another potential conflict: the model flags the difference for review without deciding whether 40 mg is an appropriate treatment.

![Four notes, three answers: "continue lisinopril 10 mg daily" is a potential conflict; "increased to 20 mg daily at discharge; continue 20 mg" is agreement; "continue lisinopril" is insufficient information; "increase lisinopril to 40 mg daily" is a potential conflict.](article/images/side-paths.png)

A [Driver.js](https://driverjs.com/) tutorial points to the next control throughout the visit. Its progress follows server state, so the provider can hide the tips, work unguided or reload the page and resume at the right step. Esc, a click outside or **Skip tutorial** dismisses the current guidance.

## Why compare these two documents?

The Provider App shaped the choice of workflow. Its visit note is a single free-text box, saved to `ClinicalImpression.note` shortly after typing. There is no template or generated summary. The medication dialog records a coded RxNorm order and a status, with the dose appearing only in a product name such as "lisinopril 10 MG Oral Tablet". There is no separate dose field to compare against the discharge instructions.

Outside documents already arrive as `DocumentReference`s in the Documents tab. Because another organization writes them, they can contain information the clinic's chart has not caught up with. A C-CDA export or claim PDF would be a poor substitute: both are generated from the chart itself, so a conflict would have to be staged for the demo.

The visit also provides a natural time to check. It moves from Planned to In Progress to Finished, and signing requires Finished. Running the comparison at that transition gives the provider a chance to review it before signing. Sign & Lock then completes the note and every open Task linked to the visit, a detail that matters when we record a reconciliation request.

## Turning the comparison into a typed answer

If both documents stored the dose in a separate field, the app could compare the values directly. Here, the dose is part of a sentence. The check has to distinguish an old prescription from a new plan and recognize when the provider has acknowledged a change.

We use Jev, TypeSafe's proprietary System One decision model, to read those sentences. We send it the documents as named JSON state, along with a question and the allowed answers. For a Choice question, Jev picks one of those answers and returns a probability for each option. The Bot can use the selected value directly, without having to interpret a written explanation. [TypeSafe documentation](https://docs.typesafe.ai/).

![Jev reads the note and the discharge summary, answers "Do the note and the discharge summary agree on the lisinopril dose?" with Agreement 0.00, Potential conflict 1.00 and Insufficient information 0.00, and returns dose_0 = "potential_conflict".](article/images/typed-answer.png)

For this check, the choices are `agreement`, `potential_conflict` and `insufficient_information`. We also tell the model what each answer means. Different doses count as a potential conflict when the later note does not acknowledge a change. A note that explicitly acknowledges the change can count as agreement. These definitions travel with the question in every request.

"Jev-like" describes the kind of open model we are evaluating alongside Jev: weights trained to choose between options. Merely constraining a general model's output format would not meet that definition.

The Bot gathers the evidence for these questions from Medplum. It accepts only `{ "action": "review_encounter", "encounter_id": ... }` and runs as the signed-in user through [`runAsUser`](https://www.medplum.com/docs/bots/bot-run-as-user). It can therefore read only what the provider can read. It loads the visit, newest note, active medications and newest current discharge summary, then enforces text limits before sending a request.

![Architecture: (1) the Provider App triggers the check; (2) a Medplum Bot running as the signed-in user reads the note, active medications and discharge summary and writes nothing; (3) hosted Jev, or Decider on Modal, answers typed questions; (4) the review card shows the result; (5) FHIR records are written as the provider.](article/images/architecture.png)

That request asks three kinds of questions. One Choice per medication supplies the dose label. A yes/no question asks whether the note mentions the hospital stay, which affects the card's wording. Further Choice questions select from numbered sentences in each document, giving the card its highlights. The card also exposes the label probabilities so the provider can inspect the model's answer alongside the source text.

![The review card for a potential conflict, annotated: (1) the label comes from one Choice question per medication; (2) the wording comes from a yes/no question on whether the note mentions the hospital stay; (3) the highlights come from one Choice per document over its numbered sentences; (4) the scores are Jev's distribution over the three labels; (5) the decision is always the provider's.](article/images/review-card.png)

Here is an abbreviated request. The Bot, app and measurement script all read the same question wording from `provider/src/data/model-contract.json`:

```json
{
  "model": "jev-latest",
  "state": {
    "active_medications": ["lisinopril"],
    "outside_document": { "title": "Discharge summary", "date": "...", "author": "...", "text": "..." },
    "visit_note": { "title": "Today's visit note", "date": "...", "author": "...", "text": "..." }
  },
  "questions": {
    "dose_0": {
      "type": "choice",
      "instructions": "Do `outside_document.text` and `visit_note.text` agree about the current dose and frequency of lisinopril? `visit_note` was written after `outside_document`.",
      "criteria": {
        "agreement": "Both documents state a compatible dose and frequency for lisinopril, or the later document explicitly acknowledges the change described in the earlier one.",
        "potential_conflict": "The documents state different doses or frequencies for lisinopril as the current plan, and the later document does not acknowledge a change.",
        "insufficient_information": "At least one document does not state a dose or frequency for lisinopril, or does not mention it."
      }
    },
    "mentions_hospital_stay": { "type": "noul", "instructions": "..." },
    "sentence_visit_note_0": { "type": "choice", "instructions": "...", "criteria": { "s1": "...", "s2": "...", "none": "..." } }
  }
}
```

Before returning a result, the Bot validates every answer's shape. If a check fails, it returns a plain reason such as "The note is too long for the demo check". The Bot writes nothing to the chart. Its TypeSafe key stays in a Medplum [project secret](https://www.medplum.com/docs/bots/bot-secrets), accessible to the Bot without reaching the browser, logs or Bot output. The request format is documented in the [TypeSafe API](https://docs.typesafe.ai/api).

## Keeping the check with the provider's decision

Once the Bot returns a valid result, the app saves it as a `DetectedIssue` under the provider's access. It stores the labels, probabilities and sentence positions without copying chart text. Reloading the card reads that record rather than asking the model again.

If the provider edits the note, the old check becomes stale until they press **Check note** and save a new result. The card compares the note's text to detect this, because signing alone creates a new version with unchanged text. After signing, both the signature and the check remain visible on the visit.

![Every check stores a DetectedIssue with labels, probabilities and sentence positions but no copied chart text. Editing the note marks the old check stale and Check note stores a new one; signing with a reason puts it on the signature Provenance and adds a mitigation; creating a task makes a reconciliation Task without Task.encounter, so Sign & Lock leaves it open.](article/images/fhir-records.png)

The provider's response is recorded with the result. Signing with a reason puts that reason on the signature's `Provenance` and adds a mitigation to the `DetectedIssue`. Creating a reconciliation task also records a mitigation, but deliberately leaves `Task.encounter` unset. Otherwise Sign & Lock would complete the task along with the visit, closing the request before anyone had reconciled the medication.

## What the tests tell us

To check the model's answers, `npm --prefix provider run measure` sends five authored dose cases and the four scenario notes to hosted Jev using exactly the Bot's request. On September 24, 2026, model `jev-1.13.0` matched the author's expected label on eight of the nine inputs and selected the expected sentence for all 18 highlights. A run the previous day gave the same eight label matches.

![Hosted Jev, September 24, 2026, model jev-1.13.0: 8 of 9 labels match the expected answer and 18 of 18 highlights land on the right sentence. The one miss is "Dated lists, unexplained change": Jev answered potential conflict (1.00) where the author expected insufficient information.](article/images/results.png)

The remaining case exposed a disagreement between the authored reference and the question's criteria. It contained two dated lists with different doses and no explanation of the change. The author had labeled that `insufficient_information`; the Bot's criteria define different current doses without acknowledgment as `potential_conflict`. Jev returned the latter with a probability of 1.00, following the criteria it received.

That result makes the definition of "conflict" part of the work still to evaluate. These nine synthetic inputs show how the model responds to our questions; they do not establish clinical accuracy. A clinical evaluation needs clinician-reviewed labels and must treat false agreements, which miss a dose error, differently from false conflicts, which cost the provider a review. The displayed scores are a distribution over the available answers, not a measure of clinical correctness.

The highlights showed how much a small wording change can matter. Our first question asked for the sentence stating the *current* dose. For "increase lisinopril to 40 mg daily", Jev consistently chose `none`, with probabilities from 0.83 to 0.89 over five identical calls. The wording appears to have excluded a proposed change from what counted as current. We tried four versions on the same nine inputs:

![Correct highlights out of 18 per wording: "the current dose" 17, "going forward, including a new or changed dose" 16, "the dose as the plan, whether continued, new or changed" 18 (used by the Bot), "a dose" 18.](article/images/highlight-wording.png)

The Bot now asks for the dose "as the plan, whether continued, new or changed". That wording selected all 18 expected sentences and is intended to favor the plan over a sentence mentioning an old dose. These examples worked with Choice questions alone; we did not need to extract the numbers in a separate step. Even so, the four wordings produced between 16 and 18 correct highlights. A wording change needs another measurement run.

We tested the surrounding workflow separately. Eight Playwright tests cover the full tutorial, signing with a reason, creating a reconciliation task, the three side paths, the stale-check badge, and hiding the tutorial before reloading and resuming. All eight pass against a hosted project and inspect the resulting FHIR resources. They replay Jev answers recorded earlier, refusing recordings made under different questions. These tests check the app's behavior with those answers; they are not eight fresh evaluations of the model. They also caught a practical problem: the tutorial's floating bar covered the card's buttons, so it now sits in the page flow.

Testing as the invited practitioner found an access problem that an admin account did not encounter. The app shell's DoseSpot check reads `PractitionerRole`, and the patient summary reads a dozen clinical types. The policy now allows those reads while still denying deletion of clinical resources. A sweep of the demo pages as the practitioner finds no denied requests. The setup command deploys the Bot, secrets, policy and practitioner invite, changes nothing on a second run and never deletes resources.

There are still checks to complete. The policy's refusals for secrets, admin routes, other Bots and deletes need verification on the server, since mock clients do not enforce access policies. The tutorial has not been checked in dark mode. A clinician also needs to review the synthetic documents and decide whether signing with a reason is sufficient, whether an addendum should be required, and whether reconciliation tasks belong with the prescriber or nursing.

## Evaluating an open model

Hosted Jev runs the working demo. To explore running the model in our own account, we also deployed the Apache-2.0 Decider model on a private Modal GPU. That endpoint has produced one verified prediction: for two same-day discharge documents listing 10 mg and 20 mg, it returned `potential_conflict` at 0.711, using 186 input tokens and 829.1 ms of server-side inference. It now also accepts the Bot's own request, so the guided visit runs on it. On the five authored dose cases and four scenario notes, every highlight picked the expected sentence and seven labels matched the authored reference. It flagged both dated dose changes as conflicts, and it labeled the note with no dose `agreement` even though its own highlight found no dose sentence; for this backend the Bot reports that case as insufficient information. Warm checks took about 0.4 s. [SELF-HOSTING.md](SELF-HOSTING.md) describes that deployment and its limits.

![One project secret, CONSISTENCY_BACKEND, switches between hosted Jev (the default, which runs the guided demo: an API key, per-request cost, PHI needs a BAA or DPA with TypeSafe) and Decider on Modal (under evaluation: the same request, an open checkpoint on a private GPU Server, about $4.29 per warm GPU hour and scaling to zero, PHI under Modal's Enterprise BAA plus Medplum's BAA plan).](article/images/backends.png)

We chose Decider after inspecting all 31 open entries in the September 22 Decision Index snapshot. Among trained entries, its NVFP4 configuration led the headline index:

| Trained candidate | Decision Index | ContractNLI F1 | NLI4CT F1 |
| --- | ---: | ---: | ---: |
| Decider-35B-A3B NVFP4 | 54.34 | 0.7496 | 0.7847 |
| Kev-9B, raised limits | 50.48 | 0.5777 | 0.7486 |
| Solomon, BF16 encoding | 47.51 | 0.7153 | **0.8176** |
| Decider-2B, FP8 HTTP | 44.00 | 0.6340 | 0.6547 |

Decider fine-tunes part of a mixture-of-experts base model while freezing the routed experts, then scores option tokens at a trained answer position. The "35B-A3B" name means roughly 35 billion parameters with 3 billion active per token. It still needs memory for the full 35B model. Its Apache-2.0 license makes it suitable for a reproducible open implementation. [Decider](https://github.com/Mapika/decider), [model card](https://huggingface.co/Mapika/decider-35b-a3b).

The index helped narrow the candidates, but it does not answer which one is best for this check. ContractNLI measures legal document entailment; NLI4CT measures clinical-trial statements. Neither measures medication reconciliation, and the entries use different hardware. Decider's own evidence shows weaker temporal and numerical reasoning, both relevant to deciding which dose a document describes. That is another reason to keep both passages visible to the provider. The [index data](https://huggingface.co/spaces/multimodalart/jev-decision-index/blob/main/data/index.json) and [methodology](https://huggingface.co/spaces/multimodalart/jev-decision-index/blob/main/data/methodology.json) provide the comparison's context.

There are alternatives worth testing on the same task. [Kev-9B](https://huggingface.co/jaredpalmer/kev-9b) is smaller, though its author documents date-related weaknesses. ZefanCai's [Open-Jev-9B](https://huggingface.co/ZefanCai/Open-Jev-9B) and 27B-v1.1 publish held-out results but were absent from the snapshot.

[DoccyHealth's Solomon](https://huggingface.co/DoccyHealth/Solomon) deserves a closer comparison because it outperforms Decider on NLI4CT and was built for document-grounded healthcare questions. It uses trained answer heads and an adapter, with reusable document states and optional evidence pointers. Adopting it would require its own runtime and state-cache hosting. Its published validation covers 802 questions over 54 real documents, with AI-generated labels that were not human-verified, so it too needs a task-specific evaluation with clinicians.

A separate group of projects explores decision-oriented inference with existing weights, without training a new checkpoint. [JevFire](https://github.com/kikoncuo/jevfire) and [Simple Jev](https://github.com/featherless-ai/simple-jev) take this approach. JevFire's announcement claims a large speedup, browser execution and image support, but those claims refer to different configurations and are not measurements of this demo.

## What would have to change for patient data?

The current project contains only synthetic records. Moving to patient documents would require a separate access-controlled project, BAA coverage for every service that sees the text, and tested retention, deletion and incident handling. The demo's practitioner policy grants access by resource type across the project; a real deployment needs patient- or tenant-scoped access. Bot audit events also reach Medplum server logs, so document text and secrets must stay out of Bot output.

Those requirements influenced the self-hosted deployment. Modal documents Enterprise BAAs and HIPAA support, with Volumes v2 covered but Volumes v1, user code, memory snapshots and most images excluded. Modal Servers proxy payloads without storing them, whereas Functions can keep inputs and outputs for up to seven days. The endpoint therefore uses a Server with snapshots off and weights on a v2 Volume. [Modal security](https://modal.com/docs/guide/security).

The Medplum side needs coverage too. Its hosted Production plan advertises a BAA and Bots at $2,000 per month; the free plan has no Bots. Baseten, Runpod and Atlantic.Net are other managed options we have not verified with this model. Runpod lists a $3,000 monthly commitment for custom agreements. [Medplum pricing](https://www.medplum.com/pricing).

Those agreements would cover only part of the work needed for patient data. The application would still need the access and data-handling controls described above. Keeping everything in the US was this project's choice; HHS imposes no blanket US-only rule. [HHS cloud guidance](https://www.hhs.gov/hipaa/for-professionals/special-topics/health-information-technology/cloud-computing/index.html).

## Taking the demo further

The immediate next step for Decider is a larger evaluation on the same workflow as hosted Jev, with clinician-reviewed labels. The first run already shows where to look: missing doses and dated changes. [SELF-HOSTING.md](SELF-HOSTING.md#5-run-the-guided-demo-on-it) shows how to switch the demo to it.

The workflow could also support a different check: whether a signed note and its addenda support the diagnoses submitted on a claim. Before **Submit Claim** in Details & Billing, a Bot could ask one Choice per diagnosis the provider added: `supported`, `not_supported` or `insufficient_documentation`. The provider would resolve each result with an addendum or by removing the diagnosis; the model would never propose or change a code. We estimate two to three days of implementation on top of this demo.

As with the dose check, the provider would see the relevant passages before completing the work, and their decision would stay in the chart with the check.

To try the working dose check, start with the [README](README.md). It takes a Medplum project with Bots enabled, a TypeSafe API key and four commands. The figures come from [`article/figures.html`](article/figures.html); `python article/render_figures.py` re-renders them.
