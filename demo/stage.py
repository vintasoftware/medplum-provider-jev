"""Fetch the exact public release and verify Hub file identities before serving."""
import hashlib
from pathlib import Path
from demo.config import MODEL_ID, MODEL_PATH, MODEL_REVISION
from demo.scoring import load_prompt_helper


def file_identity(path, sha256):
    digest = hashlib.sha256() if sha256 else hashlib.sha1()
    if not sha256:
        digest.update(f'blob {path.stat().st_size}\0'.encode())
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(8 * 1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def stage():
    from huggingface_hub import HfApi, snapshot_download
    info = HfApi().model_info(MODEL_ID, revision=MODEL_REVISION, files_metadata=True)
    if info.sha != MODEL_REVISION:
        raise ValueError('Model revision changed')
    root = Path(MODEL_PATH)
    root.mkdir(parents=True, exist_ok=True)
    (root / 'VERIFIED_REVISION').write_text('INCOMPLETE\n')
    root = Path(snapshot_download(MODEL_ID, revision=MODEL_REVISION, local_dir=MODEL_PATH))
    checked = 0
    for item in info.siblings:
        path = root / item.rfilename
        expected = item.lfs.sha256 if item.lfs else item.blob_id
        if not expected or file_identity(path, bool(item.lfs)) != expected:
            raise ValueError('A model file failed integrity verification')
        checked += 1
    load_prompt_helper(root / 'decider/prompt.py')
    (root / 'VERIFIED_REVISION').write_text(MODEL_REVISION + '\n')
    return {'revision': MODEL_REVISION, 'verified_files': checked}
