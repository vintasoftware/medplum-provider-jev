"""Private GPU inference pinned to US compute: Jebadiah 27B behind its own /v1/systemone server.

    HUGGING_FACE_TOKEN=hf_... modal run -m demo.modal_app   # stage and verify the weights
    modal deploy -m demo.modal_app
"""
import hashlib
import json
import os
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

import modal

MODEL_ID = 'frontier-infra/jebadiah-27b'
MODEL_REVISION = '3dd6f22cd54d83c5f665b1ad2f6b7183e8f96bed'
SERVER_COMMIT = 'cc904344061e4ee71d2cb8297eafd2ce1c798f99'  # github.com/getainode/jebadiah
MODEL_PATH = f'/models/{MODEL_REVISION}'
SERVER = '/opt/jebadiah/server'
LOCAL = 'http://127.0.0.1:8000'

app = modal.App('healthcare-consistency')
weights = modal.Volume.from_name('healthcare-jebadiah-weights-v2', create_if_missing=True, version=2)
gpu_image = (modal.Image.debian_slim(python_version='3.12')
    .apt_install('git')
    .pip_install('uv==0.12.21')
    .run_commands(
        f'git clone https://github.com/getainode/jebadiah.git /opt/jebadiah && git -C /opt/jebadiah checkout {SERVER_COMMIT}',
        f'cd {SERVER} && uv sync --frozen --no-dev --extra cuda',
    )
    .env({'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1', 'HF_HUB_DISABLE_TELEMETRY': '1', 'DO_NOT_TRACK': '1'}))
stage_image = modal.Image.debian_slim(python_version='3.12').pip_install('huggingface-hub==1.32.0')

# Anonymous Hub downloads from Modal get rate limited (429); a read token avoids that. Only
# `modal run` needs it, so a deploy without the variable keeps the token out of the app. The
# secret sets the same variable in the container, so both sides define the same objects.
hub_token = [modal.Secret.from_local_environ(['HUGGING_FACE_TOKEN'])] if os.environ.get('HUGGING_FACE_TOKEN') else []


def file_identity(path, sha256):
    """The Hub's identity for a file: SHA-256 for LFS files, the Git blob SHA-1 for the rest."""
    digest = hashlib.sha256() if sha256 else hashlib.sha1()
    if not sha256:
        digest.update(f'blob {path.stat().st_size}\0'.encode())
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(8 * 1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


@app.function(image=stage_image, volumes={'/models': weights}, region='us', timeout=3600,
              cpu=2, memory=4096, max_containers=1, secrets=hub_token)
def stage_model():
    """Download the pinned revision and verify every file; only then mark it servable."""
    from huggingface_hub import HfApi, snapshot_download
    if 'HUGGING_FACE_TOKEN' in os.environ:
        os.environ['HF_TOKEN'] = os.environ.pop('HUGGING_FACE_TOKEN')
    info = HfApi().model_info(MODEL_ID, revision=MODEL_REVISION, files_metadata=True)
    if info.sha != MODEL_REVISION:
        raise ValueError('Model revision changed')
    root = Path(MODEL_PATH)
    root.mkdir(parents=True, exist_ok=True)
    marker = root / 'VERIFIED_REVISION'
    marker.write_text('INCOMPLETE\n')
    snapshot_download(MODEL_ID, revision=MODEL_REVISION, local_dir=root)
    for item in info.siblings:
        expected = item.lfs.sha256 if item.lfs else item.blob_id
        if not expected or file_identity(root / item.rfilename, bool(item.lfs)) != expected:
            raise ValueError('A model file failed integrity verification')
    marker.write_text(MODEL_REVISION + '\n')
    weights.commit()
    return {'revision': MODEL_REVISION, 'verified_files': len(info.siblings)}


def warm_up_requests():
    """Synthetic requests of 1 or 8 two-option questions at five lengths, up to the 4,096-token cap."""
    for sentences in (6, 24, 64, 128, 150):  # about 24 tokens each across both documents
        text = ' '.join(f'Warm-up sentence {n} takes 5 mg daily.' for n in range(sentences))
        for count in (1, 8):
            yield {'model': 'jev-latest',
                   'state': {'outside_document': {'text': text}, 'visit_note': {'text': text}},
                   'questions': {f'q{n}': {'type': 'choice', 'instructions': 'Do the documents agree?',
                                           'criteria': {'yes': 'They agree.', 'no': 'They differ.'}}
                                 for n in range(count)}}


def local(path, body=None):
    """(HTTP status, JSON body) from the local server; (None, None) while it is not listening."""
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(LOCAL + path, data, {'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        try:
            return error.code, json.load(error)
        except ValueError:
            return error.code, None
    except OSError:
        return None, None


# Weights load straight onto the GPU (53 GB of VRAM in use), so host RAM stays near 5 GiB.
@app.server(image=gpu_image, gpu='A100-80GB', cpu=4, memory=8192,
            volumes={'/models': weights.with_mount_options(read_only=True)},
            compute_region='us', routing_region='us-east', startup_timeout=1800,
            target_concurrency=1, min_containers=0, max_containers=1,
            scaledown_window=300, enable_memory_snapshot=False, unauthenticated=False)
class Inference:
    @modal.enter()
    def start(self):
        if Path(MODEL_PATH, 'VERIFIED_REVISION').read_text().strip() != MODEL_REVISION:
            raise ValueError('Stage and verify the pinned model before serving')
        # `jev-latest` is the model name the Bot sends; the server answers only for its one model.
        self.process = subprocess.Popen([
            f'{SERVER}/.venv/bin/jebadiah-serve', '--model', MODEL_PATH, '--host', '0.0.0.0', '--port', '8000',
            '--device', 'cuda', '--dtype', 'bfloat16', '--max-prompt-tokens', '4096',
            '--alias', 'jebadiah', '--alias', 'jev-latest', '--log-level', 'warning'])
        # A failed load (a prompt_contract.json that disagrees with the renderer, out of memory)
        # keeps the server up with /health at 503, so stop on it instead of waiting out the timeout.
        # Its error is exception text from loading; no request has arrived yet.
        while (health := local('/health')[1] or {}).get('status') != 'ready':
            if health.get('status') == 'failed':
                raise RuntimeError(f"jebadiah-serve could not load the model: {health.get('error')}")
            if self.process.poll() is not None:
                raise RuntimeError('jebadiah-serve exited during loading')
            time.sleep(2)
        # The linear-attention kernels compile per shape on first use, which made the first requests
        # take 10–37 s, past the Bot's 8 s timeout. The Server takes traffic only after this returns.
        started = time.monotonic()
        statuses = [local('/v1/systemone', body)[0] for body in warm_up_requests()]
        print(f'warm-up: {len(statuses)} requests, statuses {sorted(set(map(str, statuses)))}, '
              f'{time.monotonic() - started:.0f} s', flush=True)

    @modal.exit()
    def stop(self):
        self.process.terminate()


@app.local_entrypoint()
def main():
    print(stage_model.remote())
