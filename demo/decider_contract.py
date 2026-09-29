"""Digest of the authored cases that the self-hosted Decider endpoint serves by case ID.

The Modal `/check` contract identifies a case by ID and proves the catalog with this
digest. The hosted Jev path does not use it. Keep the projection byte-for-byte stable:
changing it changes the digest the deployed endpoint returns.
"""
import base64
import hashlib
import json
from dataclasses import asdict

from demo.cases import CASES
from demo.config import LABELS, MODEL_ID, MODEL_REVISION

IDENTIFIER_SYSTEM = "urn:jev-healthcare:synthetic-v1"


def _resources_for(case):
    patient = {"resourceType": "Patient", "active": True,
               "identifier": [{"system": IDENTIFIER_SYSTEM, "value": f"{case.id}-patient"}],
               "name": [{"family": "Synthetic", "given": [case.id]}]}
    docs = []
    for index, doc in enumerate(case.documents, 1):
        docs.append({"resourceType": "DocumentReference", "status": "current",
                     "identifier": [{"system": IDENTIFIER_SYSTEM, "value": f"{case.id}-doc-{index}"}],
                     "date": doc.date + "T12:00:00Z", "description": doc.title,
                     "content": [{"attachment": {"contentType": "text/plain", "title": doc.title,
                                  "data": base64.b64encode(doc.text.encode()).decode()}}]})
    return patient, docs


def catalog():
    cases = []
    for case in CASES:
        patient, documents = _resources_for(case)
        cases.append({**asdict(case), 'patient': patient, 'fhir_documents': documents})
    return {'model': MODEL_ID, 'revision': MODEL_REVISION, 'labels': LABELS, 'cases': cases}


def fixture_digest():
    return hashlib.sha256(json.dumps(catalog(), sort_keys=True, separators=(',', ':')).encode()).hexdigest()
