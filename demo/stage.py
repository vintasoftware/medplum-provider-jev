"""Fetch the exact public release and verify Hub file identities before serving."""
import hashlib
from pathlib import Path


def file_identity(path, sha256):
    digest = hashlib.sha256() if sha256 else hashlib.sha1()
    if not sha256:
        digest.update(f'blob {path.stat().st_size}\0'.encode())
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(8 * 1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def stage_snapshot(model_id, revision, root):
    """Download one pinned Hub revision into root and verify every file; returns the file count."""
    from huggingface_hub import HfApi, snapshot_download
    info = HfApi().model_info(model_id, revision=revision, files_metadata=True)
    if info.sha != revision:
        raise ValueError('Model revision changed')
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    (root / 'VERIFIED_REVISION').write_text('INCOMPLETE\n')
    root = Path(snapshot_download(model_id, revision=revision, local_dir=root))
    checked = 0
    for item in info.siblings:
        path = root / item.rfilename
        expected = item.lfs.sha256 if item.lfs else item.blob_id
        if not expected or file_identity(path, bool(item.lfs)) != expected:
            raise ValueError('A model file failed integrity verification')
        checked += 1
    return checked

