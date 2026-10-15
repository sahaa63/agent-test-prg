"""HTTP routes for the Flag Table Update page."""

import logging

from fastapi import FastAPI, Request
from pydantic import BaseModel

from agent_server.flag_update import service
from agent_server.hist_update.routes import _call, _user, history_page

logger = logging.getLogger(__name__)
PREFIX = "/api/flags"


class FlagRow(BaseModel):
    network: str
    daypart: str
    program: str
    daypart_type: str
    start_time: str
    end_time: str
    flag: str | None = None
    dow_array: list[int] = []


class UploadRequest(BaseModel):
    month: str
    rows: list[FlagRow]
    start: str | None = None
    end: str | None = None


def config():
    """Settings the page shows (no SQL runs)."""
    return {"function": _call(service.summary_function), "genie_url": service.genie_url()}


def months():
    return {"months": _call(service.list_months)}


def generate(month: str, start: str | None = None, end: str | None = None):
    return _call(service.generate, month, start, end)


def upload(body: UploadRequest, request: Request):
    user = _user(request)
    rows = [r.model_dump() for r in body.rows]
    result = _call(service.upload, body.month, rows, user, body.start, body.end)
    logger.info("Flag upload %s by %s: %s rows, %s inserted, %s updated",
                result["month"], user, result["rows"], result["inserted"], result["updated"])
    return result


def register(app: FastAPI) -> None:
    """Plain routes on the app (see hist_update.routes.register for why not include_router)."""
    app.add_api_route(f"{PREFIX}/config", config, methods=["GET"])
    app.add_api_route(f"{PREFIX}/months", months, methods=["GET"])
    app.add_api_route(f"{PREFIX}/generate", generate, methods=["GET"])
    app.add_api_route(f"{PREFIX}/upload", upload, methods=["POST"])
    # Same UI shell as /history, so a browser refresh on /flags works.
    app.add_api_route("/flags", history_page, methods=["GET"], include_in_schema=False)
