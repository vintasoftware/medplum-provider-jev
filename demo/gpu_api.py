"""Private Modal Server: the platform authenticates callers before this process."""

import asyncio
from fastapi import FastAPI, HTTPException, Request
from demo.cases import BY_ID
from demo.http_contract import read_case_id, read_systemone
from demo.scoring import Rejected


def create_app(engine):
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    lock = asyncio.Lock()
    app.state.failed = False

    def check_available():
        if app.state.failed:
            raise HTTPException(503, "Model unavailable; operator restart required")
        if lock.locked():
            raise HTTPException(429, "Model busy", headers={"Retry-After": "5"})

    async def run(function, *args):
        try:
            return await asyncio.to_thread(function, *args)
        except Exception:
            app.state.failed = True
            raise HTTPException(503, "Inference failed; operator restart required") from None

    @app.get("/health")
    async def health():
        if app.state.failed:
            raise HTTPException(503, "Model unavailable; operator restart required")
        return {"ready": True}

    @app.post("/check")
    async def check(request: Request):
        case_id = await read_case_id(request)
        check_available()
        async with lock:
            return await run(engine.check, BY_ID[case_id])

    @app.post("/v1/systemone")
    async def systemone(request: Request):
        state, questions = await read_systemone(request)
        check_available()
        async with lock:
            try:
                prepared = await asyncio.to_thread(engine.prepare, state, questions)
            except Rejected as err:
                # Input the model cannot score is the caller's problem, not a model failure.
                raise HTTPException(422, str(err)) from None
            except Exception:
                raise HTTPException(422, "The request could not be rendered") from None
            return await run(engine.systemone, prepared)

    return app


if __name__ == "__main__":
    import uvicorn
    from demo.engine import DeciderEngine
    # Load before opening the port so Modal readiness means the model is ready.
    uvicorn.run(create_app(DeciderEngine()), host="0.0.0.0", port=8000, access_log=False)
