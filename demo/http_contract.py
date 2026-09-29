"""The public API accepts a fixture identifier, never document text."""

import json

from fastapi import HTTPException

from demo.cases import BY_ID


async def read_case_id(request):
    if request.query_params or request.headers.get("content-type", "").split(';')[0] != "application/json":
        raise HTTPException(400, "Send only a JSON case_id")
    data = bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data) > 256:
            raise HTTPException(413, "Request too large")
    try:
        body = json.loads(data)
    except (ValueError, UnicodeError):
        raise HTTPException(400, "Invalid JSON") from None
    if not isinstance(body, dict) or set(body) != {"case_id"} or not isinstance(body["case_id"], str):
        raise HTTPException(400, "Send only a JSON case_id")
    if body["case_id"] not in BY_ID:
        raise HTTPException(404, "Unknown synthetic case")
    return body["case_id"]
