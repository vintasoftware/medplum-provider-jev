"""Request parsing for the private Server: a fixture id on /check, document text on /v1/systemone."""

import json
import re

from fastapi import HTTPException

from demo.cases import BY_ID
from demo.config import MAX_QUESTIONS, MAX_REQUEST_BYTES

QUESTION_ID = re.compile(r"[A-Za-z0-9_]{1,64}")


async def _read_json(request, limit, message):
    if request.query_params or request.headers.get("content-type", "").split(';')[0] != "application/json":
        raise HTTPException(400, message)
    data = bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data) > limit:
            raise HTTPException(413, "Request too large")
    try:
        return json.loads(data)
    except (ValueError, UnicodeError):
        raise HTTPException(400, "Invalid JSON") from None


async def read_case_id(request):
    body = await _read_json(request, 256, "Send only a JSON case_id")
    if not isinstance(body, dict) or set(body) != {"case_id"} or not isinstance(body["case_id"], str):
        raise HTTPException(400, "Send only a JSON case_id")
    if body["case_id"] not in BY_ID:
        raise HTTPException(404, "Unknown synthetic case")
    return body["case_id"]


def _valid_question(spec):
    return (isinstance(spec, dict) and set(spec) <= {"type", "instructions", "criteria"}
            and spec.get("type") in ("choice", "noul") and isinstance(spec.get("instructions"), str))


async def read_systemone(request):
    """TypeSafe's /v1/systemone shape, limited to choice and noul questions. `model` is ignored:
    the Server runs only the pinned checkpoint. Error messages never echo request text."""
    body = await _read_json(request, MAX_REQUEST_BYTES, "Send a JSON state and questions")
    if not isinstance(body, dict) or not {"state", "questions"} <= set(body) <= {"state", "questions", "model"}:
        raise HTTPException(400, "Send a JSON state and questions")
    state, questions = body["state"], body["questions"]
    if not isinstance(state, (str, dict, list)) or not state:
        raise HTTPException(422, "The state must be non-empty text or JSON")
    if (not isinstance(questions, dict) or not 1 <= len(questions) <= MAX_QUESTIONS
            or not all(QUESTION_ID.fullmatch(key) and _valid_question(spec) for key, spec in questions.items())):
        raise HTTPException(422, f"Send 1 to {MAX_QUESTIONS} choice or noul questions")
    return state, questions
