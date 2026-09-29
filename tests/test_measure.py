import json
import sys

import httpx
import pytest

from demo import measure


@pytest.fixture
def measurement(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(sys, 'argv', ['measure', '--rounds', '1'])
    monkeypatch.setattr(measure, 'load_dotenv', lambda: None)
    monkeypatch.setenv('CONSISTENCY_MODEL_URL', 'https://example.us-east.modal.direct')
    monkeypatch.setenv('CONSISTENCY_MODAL_KEY', 'wk-test')
    monkeypatch.setenv('CONSISTENCY_MODAL_SECRET', 'ws-test')
    original_client = httpx.Client
    calls = []

    def install(handler):
        def respond(request):
            calls.append(request)
            return handler(request)

        monkeypatch.setattr(
            measure.httpx, 'Client',
            lambda **kwargs: original_client(transport=httpx.MockTransport(respond), **kwargs),
        )
        return calls

    return install, tmp_path


@pytest.mark.parametrize('origin', ['https://example.us-east.modal.direct', 'https://example.modal.run'])
def test_measure_records_all_cases_from_supported_origins(measurement, monkeypatch, origin):
    install, directory = measurement
    monkeypatch.setenv('CONSISTENCY_MODEL_URL', origin)

    def respond(request):
        case_id = json.loads(request.content)['case_id']
        return httpx.Response(200, json={
            'model': measure.MODEL_ID, 'revision': measure.MODEL_REVISION,
            'fixtures_sha256': measure.fixture_digest(), 'case_id': case_id,
            'choice': 'agreement', 'probabilities': {
                'agreement': 0.8, 'potential_conflict': 0.1, 'insufficient_information': 0.1,
            },
        })

    calls = install(respond)
    measure.main()
    rows = list((directory / 'artifacts').glob('*.jsonl'))[0].read_text().splitlines()
    assert len(rows) == len(calls) == len(measure.CASES)
    assert str(calls[0].url) == origin + '/check'
    assert calls[0].headers['Modal-Key'] == 'wk-test'
    assert all('result' in json.loads(row) for row in rows)


@pytest.mark.parametrize('origin', [
    'https://example.modal.direct.evil.invalid',
    'https://user:password@example.modal.direct',
    'https://example.modal.direct#fragment',
])
def test_measure_rejects_invalid_origin_before_sending_credentials(measurement, monkeypatch, origin):
    install, _ = measurement
    monkeypatch.setenv('CONSISTENCY_MODEL_URL', origin)
    calls = install(lambda request: httpx.Response(200))
    with pytest.raises(SystemExit, match='HTTPS Modal Server origin'):
        measure.main()
    assert not calls


@pytest.mark.parametrize('status', [200, 503])
def test_measure_stops_after_failed_or_invalid_response(measurement, status, capsys):
    install, directory = measurement
    calls = install(lambda request: httpx.Response(status, json={}))
    measure.main()
    rows = list((directory / 'artifacts').glob('*.jsonl'))[0].read_text().splitlines()
    assert len(calls) == len(rows) == 1
    assert 'result' not in json.loads(rows[0])
    assert 'Incomplete run' in capsys.readouterr().out
