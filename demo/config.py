"""Reviewed artifact identities and the bounded decision contract."""

MODEL_ID = "Mapika/decider-35b-a3b-nvfp4"
MODEL_REVISION = "798555c06e419c4638c9ebd06c78ed8b5e92c868"
PROMPT_SHA256 = "5a42134cf470c566e34ac38fb10e63851c21a4bb739475eef797849bcfe460a3"
VLLM_IMAGE = (
    "vllm/vllm-openai@sha256:082ca6f035279109041ffd3fe0695cb568b29bc"
    "580b35c4f297a66a08b216c1b"
)
MODEL_PATH = f"/models/{MODEL_REVISION}"
MAX_CONTEXT_TOKENS = 3500
MAX_MODEL_TOKENS = 4096
LABELS = ("agreement", "potential_conflict", "insufficient_information")
OPTIONS = (
    "Agreement: both documents explicitly support compatible information, including an explicitly documented change over time.",
    "Potential conflict: both documents make incompatible claims about the same subject and relevant time, without an explicit explanation.",
    "Insufficient information: at least one document lacks the detail needed to decide whether the claims agree or conflict.",
)
