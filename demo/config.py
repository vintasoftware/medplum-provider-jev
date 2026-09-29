"""Reviewed artifact identities and the bounded decision contract."""

MODEL_ID = "Mapika/decider-35b-a3b-nvfp4"
MODEL_REVISION = "798555c06e419c4638c9ebd06c78ed8b5e92c868"
PROMPT_SHA256 = "5a42134cf470c566e34ac38fb10e63851c21a4bb739475eef797849bcfe460a3"
SYSTEMONE_SHA256 = "627fc365583c92328b7b21d481b307eb4d2bfd27411d38cd6710ab3adf629a9a"
VLLM_IMAGE = (
    "vllm/vllm-openai@sha256:082ca6f035279109041ffd3fe0695cb568b29bc"
    "580b35c4f297a66a08b216c1b"
)
MODEL_PATH = f"/models/{MODEL_REVISION}"
MAX_CONTEXT_TOKENS = 3500
MAX_MODEL_TOKENS = 4096
# /v1/systemone: the Bot sends at most 1 + 3 * 5 questions over 7,000 characters of text.
MAX_REQUEST_BYTES = 65536
MAX_QUESTIONS = 16
LABELS = ("agreement", "potential_conflict", "insufficient_information")
OPTIONS = (
    "Agreement: both documents explicitly support compatible information, including an explicitly documented change over time.",
    "Potential conflict: both documents make incompatible claims about the same subject and relevant time, without an explicit explanation.",
    "Insufficient information: at least one document lacks the detail needed to decide whether the claims agree or conflict.",
)
