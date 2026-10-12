"""HTTP routes for the Historical Update page (program tables)."""

import logging

from fastapi import APIRouter, FastAPI, HTTPException, Request
from pydantic import BaseModel

from agent_server.hist_update import service

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/hist/program")


class UpdateRequest(BaseModel):
    month: str


def _user(request: Request) -> str:
    h = request.headers
    return (h.get("x-forwarded-email") or h.get("x-forwarded-preferred-username")
            or h.get("x-forwarded-user") or "unknown")


def _call(fn, *args):
    try:
        return fn(*args)
    except service.HistUpdateError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:  # noqa: BLE001
        logger.exception("Historical update failed")
        raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {e}") from e


# Plain `def` handlers: FastAPI runs them in a worker thread, so the blocking
# SQL calls do not stall the chat.
@router.get("/months")
def months():
    return {"months": _call(service.list_months)}


@router.get("/snapshot")
def snapshot(month: str):
    return _call(service.snapshot, month)


@router.post("/update")
def update(body: UpdateRequest, request: Request):
    user = _user(request)
    result = _call(service.update, body.month, user)
    logger.info("Historical update %s by %s: %s inserted, %s updated",
                result["month"], user, result["inserted"], result["updated"])
    return result


def register(app: FastAPI) -> None:
    """Add the routes ahead of the chat UI proxy, which otherwise catches every path."""
    before = len(app.router.routes)
    app.include_router(router)
    added = app.router.routes[before:]
    del app.router.routes[before:]
    app.router.routes[0:0] = added
