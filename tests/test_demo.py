import json
import math
from dataclasses import replace
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from demo.cases import CASES, model_state
from demo.config import LABELS
from demo.decider_contract import fixture_digest
from demo.config import MAX_CONTEXT_TOKENS, MAX_MODEL_TOKENS, MAX_QUESTIONS, MAX_REQUEST_BYTES
from demo.gpu_api import create_app
from demo.scoring import Rejected, normalize_scores, render_question_rows, softmax_scores


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


def test_softmax_scores_handle_any_option_count():
    probabilities = softmax_scores({7: 0.0, 8: 0.0, 9: 0.0, 10: 0.0, 11: 0.0}, [7, 8, 9, 10, 11], 1.08)
    assert probabilities == pytest.approx([0.2] * 5)
    with pytest.raises(KeyError):
        softmax_scores({7: 0.0}, [7, 8], 1.08)


class WordTokenizer:
    def encode(self, text, add_special_tokens=False):
        return list(range(len(text.split())))


class FakePromptHelper:
    """Stands in for the pinned decider/prompt.py: one token per word, labels 100, 101, ..."""
    def label_table(self, tokenizer):
        return None, list(range(100, 355)), None

    def build(self, example, tokenizer, rng, max_options, max_ctx_tokens):
        question = example.qs[0]
        words = f'{example.context} {question.text} {" ".join(question.options)}'
        return {'ids': tokenizer.encode(words), 'perms': [list(range(len(question.options)))]}


class FakeSystemOne:
    def render_state(self, state):
        return json.dumps(state)

    def render_question(self, spec):
        if spec['type'] == 'noul':
            return {'question': spec['instructions'], 'options': ['no', 'yes'], 'type': 'noul'}
        return {'question': spec['instructions'], 'options': list(spec['criteria']), 'type': 'choice'}


def render(state, questions):
    return render_question_rows(state, questions, WordTokenizer(), FakePromptHelper(), FakeSystemOne())


def test_question_rows_score_only_each_question_options():
    rendered, rows = render(REQUEST['state'], REQUEST['questions'])
    assert list(rendered) == ['dose_0', 'mentions_hospital_stay']
    assert [labels for _, labels in rows] == [[100, 101], [100, 101]]


def test_question_rows_refuse_to_truncate_evidence():
    with pytest.raises(Rejected):
        render('word ' * MAX_CONTEXT_TOKENS, REQUEST['questions'])
    long_question = {'type': 'choice', 'instructions': 'word ' * MAX_MODEL_TOKENS, 'criteria': {'a': '', 'b': ''}}
    with pytest.raises(Rejected):
        render(REQUEST['state'], {'q': long_question})


class FakeEngine:
    def __init__(self):
        self.calls = 0
        self.prepared = []

    def check(self, case):
        self.calls += 1
        return {'case_id': case.id}

    def prepare(self, state, questions):
        if 'too long' in str(state):
            raise Rejected("The documents exceed the model's context limit")
        self.prepared.append((state, questions))
        return questions

    def systemone(self, prepared):
        self.calls += 1
        return {'answers': {key: {'type': 'noul', 'noul': 0.5} for key in prepared}}


QUESTION = {'type': 'choice', 'instructions': 'Do they agree?', 'criteria': {'yes': 'They agree.', 'no': 'They differ.'}}
REQUEST = {'state': {'visit_note': {'text': 'Synthetic note.'}}, 'model': 'jev-latest',
           'questions': {'dose_0': QUESTION, 'mentions_hospital_stay': {'type': 'noul', 'instructions': 'Hospital?'}}}


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


def test_systemone_scores_document_text():
    engine = FakeEngine()
    with TestClient(create_app(engine)) as client:
        response = client.post('/v1/systemone', json=REQUEST)
    assert response.status_code == 200
    assert set(response.json()['answers']) == {'dose_0', 'mentions_hospital_stay'}
    assert engine.prepared == [(REQUEST['state'], REQUEST['questions'])]


@pytest.mark.parametrize('body', [
    {'questions': REQUEST['questions']},
    {**REQUEST, 'extra': True},
    [],
])
def test_systemone_rejects_malformed_requests(body):
    engine = FakeEngine()
    with TestClient(create_app(engine)) as client:
        assert client.post('/v1/systemone', json=body).status_code == 400
        assert client.post('/v1/systemone?x=1', json=REQUEST).status_code == 400
    assert engine.calls == 0


@pytest.mark.parametrize('questions', [
    {},
    {f'q{n}': QUESTION for n in range(MAX_QUESTIONS + 1)},
    {'bad id!': QUESTION},
    {'q': {**QUESTION, 'type': 'score'}},
    {'q': {**QUESTION, 'isolated': False}},
    {'q': {**QUESTION, 'instructions': None}},
])
def test_systemone_rejects_unsupported_questions(questions):
    engine = FakeEngine()
    with TestClient(create_app(engine)) as client:
        response = client.post('/v1/systemone', json={**REQUEST, 'questions': questions})
    assert response.status_code == 422
    assert engine.calls == 0


def test_systemone_rejects_oversize_bodies_and_long_documents_without_failing_closed():
    engine = FakeEngine()
    with TestClient(create_app(engine)) as client:
        big = {**REQUEST, 'state': 'x' * MAX_REQUEST_BYTES}
        assert client.post('/v1/systemone', json=big).status_code == 413
        response = client.post('/v1/systemone', json={**REQUEST, 'state': 'too long Synthetic PHI'})
        assert response.status_code == 422
        assert 'Synthetic PHI' not in response.text
        assert client.get('/health').status_code == 200
        assert client.post('/v1/systemone', json=REQUEST).status_code == 200


def test_systemone_fails_closed_after_an_inference_error():
    engine = FakeEngine()
    def broken(prepared): raise RuntimeError('sensitive error')
    engine.systemone = broken
    with TestClient(create_app(engine)) as client:
        response = client.post('/v1/systemone', json=REQUEST)
        assert response.status_code == 503
        assert 'sensitive' not in response.text
        assert client.get('/health').status_code == 503
        assert client.post('/check', json={'case_id': CASES[0].id}).status_code == 503


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
