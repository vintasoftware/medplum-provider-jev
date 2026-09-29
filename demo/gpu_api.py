"""Private Modal Server: the platform authenticates callers before this process."""

import asyncio
from fastapi import FastAPI, HTTPException, Request
from demo.cases import BY_ID
from demo.http_contract import read_case_id


def create_app(engine):
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    lock = asyncio.Lock()
    app.state.failed = False

    @app.get("/health")
    async def health():
        if app.state.failed:
            raise HTTPException(503, "Model unavailable; operator restart required")
        return {"ready": True}

    @app.post("/check")
    async def check(request: Request):
        case_id = await read_case_id(request)
        if app.state.failed:
            raise HTTPException(503, "Model unavailable; operator restart required")
        if lock.locked():
            raise HTTPException(429, "Model busy", headers={"Retry-After": "5"})
        async with lock:
            try:
                return await asyncio.to_thread(engine.check, BY_ID[case_id])
            except Exception:
                app.state.failed = True
                raise HTTPException(503, "Inference failed; operator restart required") from None

    return app


if __name__ == "__main__":
    import uvicorn
    from demo.engine import DeciderEngine
    # Load before opening the port so Modal readiness means the model is ready.
    uvicorn.run(create_app(DeciderEngine()), host="0.0.0.0", port=8000, access_log=False)
