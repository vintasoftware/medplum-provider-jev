"""Guards on committed files that setup and the Bot deploy as-is."""
import json
from pathlib import Path


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


def test_contract_json_keeps_the_three_labels():
    # The card, tour and DetectedIssue code name these labels directly.
    data = json.loads(Path('provider/src/data/model-contract.json').read_text())
    assert data['labels'] == ['agreement', 'potential_conflict', 'insufficient_information']
