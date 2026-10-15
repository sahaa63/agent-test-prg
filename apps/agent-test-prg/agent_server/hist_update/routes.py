"""HTTP routes for the Historical Update page (program and daypart tables)."""

import logging
import os

import httpx
from fastapi import FastAPI, HTTPException, Request, Response
from pydantic import BaseModel

from agent_server.hist_update import daypart, service

logger = logging.getLogger(__name__)
PREFIX = "/api/hist/program"
DAYPART_PREFIX = "/api/hist/daypart"


class UpdateRequest(BaseModel):
    month: str
    # Optional 'YYYY-MM-DD' dates inside the month; omitted means the full broadcast month.
    start: str | None = None
    end: str | None = None


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
def months():
    return {"months": _call(service.list_months)}


def snapshot(month: str, start: str | None = None, end: str | None = None):
    """start / end are optional 'YYYY-MM-DD' dates inside the month; omitted means the full month."""
    return _call(service.snapshot, month, start, end)


def update(body: UpdateRequest, request: Request):
    user = _user(request)
    result = _call(service.update, body.month, user, body.start, body.end)
    logger.info("Historical update %s (%s to %s%s) by %s: %s inserted, %s updated",
                result["month"], result["period_start"], result["period_end"],
                ", custom range" if result["custom_range"] else "", user,
                result["inserted"], result["updated"])
    return result


class DaypartUpdateRequest(BaseModel):
    table: str
    period: str
    start: str | None = None
    end: str | None = None


def daypart_tables():
    return {"tables": _call(daypart.list_tables), "list_table": _call(daypart.list_table)}


def daypart_periods(table: str):
    return {"periods": _call(daypart.list_periods, table)}


def daypart_snapshot(table: str, period: str, start: str | None = None, end: str | None = None):
    return _call(daypart.snapshot, table, period, start, end)


def daypart_update(body: DaypartUpdateRequest, request: Request):
    user = _user(request)
    result = _call(daypart.update, body.table, body.period, user, body.start, body.end)
    logger.info("Daypart update %s %s (%s to %s) by %s: %s inserted, %s updated",
                result["table"], result["period"], result["period_start"], result["period_end"], user,
                result["inserted"], result["updated"])
    return result


def status():
    """Shows that these routes are live and which settings they use. Runs no SQL."""
    def setting(name):
        try:
            return service.table(name)
        except service.HistUpdateError as e:
            return f"INVALID: {e}"

    return {
        "ok": True,
        "warehouse_configured": bool((os.environ.get("HIST_SQL_WAREHOUSE_ID")
                                      or os.environ.get("DATABRICKS_WAREHOUSE_ID") or "").strip()),
        "tables": {name: setting(name) for name in service.DEFAULT_TABLES},
    }


async def history_page():
    """Serve the chat UI shell for /history, so a browser refresh on the page works.

    The chat proxy only forwards a fixed list of paths to the UI, and /history is not on it.
    """
    port = os.environ.get("CHAT_APP_PORT", "3000")
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.get(f"http://localhost:{port}/")
    return Response(content=r.content, status_code=r.status_code,
                    media_type=r.headers.get("content-type", "text/html"))


def register(app: FastAPI) -> None:
    """Register each route directly on the app.

    The chat proxy forwards any path that is not a plain route on `app.routes` to the
    chat UI. Routes added with include_router() are wrapped in an object the proxy does
    not recognise, so they must be added one by one with add_api_route().
    """
    app.add_api_route(f"{PREFIX}/status", status, methods=["GET"])
    app.add_api_route(f"{PREFIX}/months", months, methods=["GET"])
    app.add_api_route(f"{PREFIX}/snapshot", snapshot, methods=["GET"])
    app.add_api_route(f"{PREFIX}/update", update, methods=["POST"])
    app.add_api_route(f"{DAYPART_PREFIX}/tables", daypart_tables, methods=["GET"])
    app.add_api_route(f"{DAYPART_PREFIX}/periods", daypart_periods, methods=["GET"])
    app.add_api_route(f"{DAYPART_PREFIX}/snapshot", daypart_snapshot, methods=["GET"])
    app.add_api_route(f"{DAYPART_PREFIX}/update", daypart_update, methods=["POST"])
    app.add_api_route("/history", history_page, methods=["GET"], include_in_schema=False)
