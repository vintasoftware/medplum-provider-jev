"""Private GPU inference pinned to US compute."""
import subprocess
import sys
import modal

from demo.config import VLLM_IMAGE

app = modal.App('healthcare-consistency')
weights = modal.Volume.from_name('healthcare-decider-weights-v2', create_if_missing=True, version=2)
# The pinned vLLM runtime provides python3; Modal also requires a python alias.
gpu_image = (modal.Image.from_registry(VLLM_IMAGE, setup_dockerfile_commands=[
    'RUN ln -s /usr/bin/python3 /usr/local/bin/python && python -m pip --version',
]).entrypoint([])
    .pip_install('fastapi==0.141.1', 'uvicorn==0.53.0', 'httpx==0.28.1')
    .run_commands(
        '''python -c "import fastapi, httpx, uvicorn; from importlib.metadata import version; assert version('vllm').split('+')[0] == '0.29.0'; print('vLLM', version('vllm'), 'torch', version('torch'))"'''
    )
    .env({'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1', 'VLLM_NO_USAGE_STATS': '1',
          'DO_NOT_TRACK': '1', 'HF_HUB_DISABLE_TELEMETRY': '1'})
    .add_local_python_source('demo'))
stage_image = (modal.Image.debian_slim(python_version='3.12')
    .pip_install('huggingface-hub==1.32.0').add_local_python_source('demo'))


@app.function(image=stage_image, volumes={'/models': weights}, region='us', timeout=3600,
              cpu=2, memory=4096, max_containers=1)
def stage_model():
    from demo.stage import stage
    result = stage()
    weights.commit()
    return result


@app.server(image=gpu_image, gpu='RTX-PRO-6000', cpu=4, memory=65536,
            volumes={'/models': weights.with_mount_options(read_only=True)},
            compute_region='us', routing_region='us-east', startup_timeout=1800,
            target_concurrency=1, min_containers=0, max_containers=1,
            scaledown_window=300, enable_memory_snapshot=False, unauthenticated=False)
class Inference:
    @modal.enter()
    def start(self):
        self.process = subprocess.Popen([sys.executable, '-m', 'demo.gpu_api'])

    @modal.exit()
    def stop(self):
        self.process.terminate()


@app.local_entrypoint()
def main():
    print(stage_model.remote())
