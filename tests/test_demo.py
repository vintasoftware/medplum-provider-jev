import json
import math
from dataclasses import replace
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from demo.cases import CASES, model_state
from demo.config import LABELS
from demo.decider_contract import fixture_digest
from demo.gpu_api import create_app
from demo.scoring import normalize_scores


def test_decider_digest_is_unchanged_for_the_deployed_endpoint():
    # The self-hosted endpoint returns this digest; changing it breaks the Modal path.
    assert fixture_digest() == '9d6d3df2219d6f4047f648697d1605ebe5398b2c1709180dc1cde12e288a1c46'


def test_reference_labels_and_notes_do_not_change_model_input():
    case = CASES[0]
    assert model_state(case) == model_state(replace(case, expected='INJECTED', review_note='INJECTED'))
    assert 'INJECTED' not in model_state(case)


def test_processed_logits_temperature_and_large_values():
    result = normalize_scores({1: 1001, 2: 1000, 3: 999}, [1, 2, 3], 2)
    assert result['choice'] == 'agreement'
    assert sum(result['probabilities'].values()) == pytest.approx(1)
    assert result['probabilities'][LABELS[0]] / result['probabilities'][LABELS[1]] == pytest.approx(math.exp(.5))


@pytest.mark.parametrize('scores', [{1: 1, 2: 2}, {1: 1, 2: float('nan'), 3: 3}, {1: 1, 2: 2, 3: float('inf')}])
def test_incomplete_scores_fail(scores):
    with pytest.raises((KeyError, ValueError)):
        normalize_scores(scores, [1, 2, 3], 1.08)


class FakeEngine:
    def __init__(self):
        self.calls = 0

    def check(self, case):
        self.calls += 1
        return {'case_id': case.id}


@pytest.mark.parametrize('body', [{'case_id': 'unknown'}, {'case_id': CASES[0].id, 'text': 'PHI'}, {}, [], {'case_id': 5}])
def test_rejects_visitor_inputs(body):
    engine = FakeEngine()
    with TestClient(create_app(engine)) as client:
        assert client.post('/check', json=body).status_code in (400, 404, 422)
    assert engine.calls == 0


def test_oversize_and_non_json_bodies_rejected():
    engine = FakeEngine()
    with TestClient(create_app(engine)) as client:
        assert client.post('/check', content='x' * 257, headers={'Content-Type': 'application/json'}).status_code == 413
        assert client.post('/check', content='x').status_code == 400
    assert engine.calls == 0


def test_runs_live_each_time_and_stops_after_engine_failure():
    engine = FakeEngine()
    with TestClient(create_app(engine)) as client:
        for _ in range(2): assert client.post('/check', json={'case_id': CASES[0].id}).status_code == 200
        assert engine.calls == 2
        def broken(case): raise RuntimeError('sensitive error')
        engine.check = broken
        response = client.post('/check', json={'case_id': CASES[0].id})
        assert response.status_code == 503
        assert 'sensitive' not in response.text
        assert client.get('/health').status_code == 503


def test_practitioner_policy_never_deletes_clinical_data():
    policy = json.loads(Path('demo/access-policy.json').read_text())
    by_type = {r['resourceType']: r for r in policy['resource']}
    deletable = [t for t, r in by_type.items() if 'delete' in r.get('interaction', [])]
    assert deletable == ['Subscription']
    assert by_type['Subscription']['criteria'].endswith('author=%profile')
    assert by_type['Bot'] == {'resourceType': 'Bot', 'criteria': 'Bot?_id=BOT_ID', 'readonly': True}
    for denied in ('Project', 'ProjectMembership', 'AccessPolicy', 'User', 'ClientApplication', 'AuditEvent'):
        assert denied not in by_type


def test_bot_config_is_local_not_committed():
    # Each checkout deploys to its own Bot; a committed id would send other devs' deploys to ours.
    assert 'provider/medplum.config.json' in Path('.gitignore').read_text().splitlines()


def test_measurement_copy_of_authored_cases_matches_cases_py():
    # provider/scripts/measure-cases.json copies the dose cases for the TypeScript measurement.
    data = json.loads(Path('provider/scripts/measure-cases.json').read_text())
    by_id = {c.id: c for c in CASES}
    for item in data['authored_cases']:
        case = by_id[item['id']]
        assert item['expected'] == case.expected
        for field, doc in zip(('outside_document', 'visit_note'), case.documents):
            assert {k: item[field][k] for k in ('title', 'date', 'text')} == {'title': doc.title, 'date': doc.date, 'text': doc.text}


def test_contract_json_keeps_the_three_labels():
    data = json.loads(Path('provider/src/data/model-contract.json').read_text())
    assert data['labels'] == list(LABELS)
