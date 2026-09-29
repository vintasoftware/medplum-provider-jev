"""Record live outputs of the self-hosted Decider endpoint; never replace failures with fixture labels.

Calls the private Modal Server by case ID (article evidence). Hosted Jev is measured with
`npm --prefix provider run measure` instead.
"""
import argparse
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx
from dotenv import load_dotenv
from demo.cases import CASES
from demo.config import LABELS, MODEL_ID, MODEL_REVISION
from demo.decider_contract import fixture_digest

REFERENCE_PROVENANCE = 'Authored synthetic reference; not clinician-validated'

def measure_modal(rounds, path):
    origin = os.environ['CONSISTENCY_MODEL_URL'].rstrip('/')
    url = httpx.URL(origin)
    if (url.scheme != 'https' or not url.host.endswith(('.modal.run', '.modal.direct')) or
            url.path != '/' or url.query or url.fragment or url.userinfo or url.port):
        raise SystemExit('Set the HTTPS Modal Server origin')
    headers = {'Modal-Key': os.environ['CONSISTENCY_MODAL_KEY'], 'Modal-Secret': os.environ['CONSISTENCY_MODAL_SECRET']}
    successful = 0
    with path.open('x') as log, httpx.Client(timeout=100, follow_redirects=False, trust_env=False) as client:
        for run in range(rounds):
            for case in CASES:
                started = time.perf_counter()
                row = {'round': run + 1, 'case_id': case.id, 'expected': case.expected,
                       'reference_provenance': REFERENCE_PROVENANCE}
                try:
                    response = client.post(origin + '/check', headers=headers, json={'case_id': case.id})
                    row['http_status'] = response.status_code
                    if response.status_code == 200:
                        data = response.json()
                        valid = (data.get('model') == MODEL_ID and data.get('revision') == MODEL_REVISION and
                                 data.get('fixtures_sha256') == fixture_digest() and data.get('case_id') == case.id and
                                 set(data.get('probabilities', {})) == set(LABELS) and data.get('choice') in LABELS)
                        if not valid: raise ValueError('Unrecognized model response')
                        row['result'] = data
                        row['matches_reference'] = data['choice'] == case.expected
                        successful += 1
                except (httpx.HTTPError, ValueError):
                    row['error'] = 'Request or response validation failed'
                row['elapsed_ms'] = round((time.perf_counter() - started) * 1000, 1)
                log.write(json.dumps(row) + '\n'); log.flush()
                if row.get('http_status') != 200 or 'error' in row:
                    print(f'Incomplete run saved to {path}. Resolve startup/auth/service errors before retrying.')
                    return
    print(f'Recorded {successful} live outputs in {path}. Add actual Modal usage/cost from the dashboard.')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--rounds', type=int, default=1)
    args = parser.parse_args()
    if not 1 <= args.rounds <= 5:
        raise SystemExit('Use 1–5 rounds per deliberate measurement run')
    load_dotenv()
    path = Path('artifacts') / ('gpu-run-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '.jsonl')
    path.parent.mkdir(exist_ok=True)
    measure_modal(args.rounds, path)


if __name__ == '__main__':
    main()
