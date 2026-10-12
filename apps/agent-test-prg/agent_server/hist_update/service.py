"""Program history update: snapshot (calculate + compare) and upsert.

The calculation lives in sql/program_weekday.sql and sql/program_weekend.sql.
This module wraps each script in a comparison query (snapshot) or a MERGE
(update) and runs it on a SQL warehouse as the app's service principal.

SQL building is kept free of Databricks imports so it can be unit tested.
"""

import os
import re
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

SQL_DIR = Path(__file__).parent / "sql"

MONTHS = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE",
          "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"]

# Columns produced by both scripts. A target table only receives the ones it has.
SOURCE_COLS = ["Month", "Network", "Daypart", "Program", "Start", "End", "Demo", "TCs", "Dur",
               "Impressions", "MSNBC_Show", "Source", "start_day", "end_day"]
KEY_COLS = ["Month", "Network", "Daypart", "Program", "Demo"]
VALUE_COLS = ["Impressions", "Dur", "TCs"]
CREATED_COLS = ("created_ts", "created_at")
UPDATED_COLS = ("updated_ts", "updated_at")
# Not in the tables yet. When one of these columns is added, it is filled automatically.
USER_COLS = ("user_id", "updated_by")

DEFAULT_TABLES = {
    "HIST_MDE_TABLE": "nielsen_prod.gold.mde_program_qtr_hour",
    "HIST_CALENDAR_TABLE": "nielsen_prod.intermediate_tables.broadcast_date_calendar_v",
    "HIST_FLAGS_TABLE": "genai_dev.bronze.disa_news_monthly_program_dayparts",
    "HIST_PROGRAM_WEEKDAY_TABLE": "genai_dev.silver.disa_news_historical_nielsen_monthly_extract",
    "HIST_PROGRAM_WEEKEND_TABLE": "genai_dev.silver.disa_news_historical_nielsen_monthly_weekend_extract",
}
_TABLE_NAME = re.compile(r"^[A-Za-z0-9_]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+$")
_MONTH_LABEL = re.compile(r"^([A-Za-z]{3})-(\d{2})$")


class HistUpdateError(Exception):
    """A problem the user can act on (bad input, missing setting, SQL failure)."""


# ---------------------------------------------------------------- pure helpers
def table(setting: str) -> str:
    name = (os.environ.get(setting) or DEFAULT_TABLES[setting]).strip()
    if not _TABLE_NAME.match(name):
        raise HistUpdateError(f"{setting} must be a catalog.schema.table name, got '{name}'.")
    return name


def parse_month_label(label: str) -> tuple[str, int]:
    """'Sep-26' -> ('SEPTEMBER', 2026)."""
    m = _MONTH_LABEL.match((label or "").strip())
    if not m:
        raise HistUpdateError(f"Month must look like 'Sep-26', got '{label}'.")
    matches = [name for name in MONTHS if name.startswith(m.group(1).upper())]
    if len(matches) != 1:
        raise HistUpdateError(f"Unknown month '{m.group(1)}'.")
    return matches[0], 2000 + int(m.group(2))


def month_label(month_name: str, year: int) -> str:
    return f"{month_name[:3].title()}-{str(year)[2:]}"


def calc_sql(kind: str) -> str:
    """The weekday or weekend calculation script with table names filled in."""
    sql = (SQL_DIR / f"program_{kind}.sql").read_text(encoding="utf-8")
    return (sql.replace("{calendar_table}", table("HIST_CALENDAR_TABLE"))
               .replace("{flags_table}", table("HIST_FLAGS_TABLE"))
               .replace("{mde_table}", table("HIST_MDE_TABLE")))


def _q(col: str) -> str:
    return f"`{col}`"


def _resolve(target_cols: list[str]):
    """Map our column names onto the target table's actual columns (case-insensitive)."""
    actual = {c.lower(): c for c in target_cols}
    missing = [k for k in KEY_COLS if k.lower() not in actual]
    if missing:
        raise HistUpdateError(f"Target table is missing key column(s): {', '.join(missing)}.")
    values = [v for v in VALUE_COLS if v.lower() in actual]
    if not values:
        raise HistUpdateError("Target table has none of the value columns Impressions, Dur, TCs.")
    return actual, values


def _on(actual: dict) -> str:
    return " AND ".join(f"t.{_q(actual[k.lower()])} <=> s.{_q(k)}" for k in KEY_COLS)


def _changed(actual: dict, values: list[str]) -> str:
    return " OR ".join(
        f"NOT (CAST(t.{_q(actual[v.lower()])} AS DOUBLE) <=> CAST(s.{_q(v)} AS DOUBLE))" for v in values)


def build_snapshot_sql(calc: str, target: str, target_cols: list[str]) -> str:
    """Calculated rows joined to the target, with old values and a status per row."""
    actual, values = _resolve(target_cols)
    first_key = _q(actual[KEY_COLS[1].lower()])
    olds = ", ".join(
        (f"t.{_q(actual[v.lower()])}" if v.lower() in actual else "NULL") + f" AS old_{v.lower()}"
        for v in VALUE_COLS)
    cols = ", ".join(f"s.{_q(c)}" for c in SOURCE_COLS)
    return (
        f"SELECT {cols}, {olds},\n"
        f"       CASE WHEN t.{first_key} IS NULL THEN 'New'\n"
        f"            WHEN {_changed(actual, values)} THEN 'Changed'\n"
        f"            ELSE 'Unchanged' END AS status\n"
        f"FROM (\n{calc}\n) s\n"
        f"LEFT JOIN {target} t ON {_on(actual)}\n"
        f"ORDER BY s.`Network`, s.`Daypart`, s.`Program`, s.`Demo`"
    )


def build_merge_sql(calc: str, target: str, target_cols: list[str]) -> str:
    """Upsert: insert new keys, update keys whose values changed, leave the rest."""
    actual, values = _resolve(target_cols)
    source = {c.lower(): c for c in SOURCE_COLS}

    sets = [f"t.{_q(actual[v.lower()])} = s.{_q(v)}" for v in values]
    sets += [f"t.{_q(actual[c])} = current_timestamp()" for c in UPDATED_COLS if c in actual]
    sets += [f"t.{_q(actual[c])} = :user_id" for c in USER_COLS if c in actual]

    insert_cols, insert_vals = [], []
    for low, name in actual.items():
        if low in source:
            expr = f"s.{_q(source[low])}"
        elif low in CREATED_COLS or low in UPDATED_COLS:
            expr = "current_timestamp()"
        elif low in USER_COLS:
            expr = ":user_id"
        else:
            continue  # column we do not produce: left NULL
        insert_cols.append(_q(name))
        insert_vals.append(expr)

    return (
        f"MERGE INTO {target} t\n"
        f"USING (\n{calc}\n) s\n"
        f"ON {_on(actual)}\n"
        f"WHEN MATCHED AND ({_changed(actual, values)}) THEN UPDATE SET\n  " + ",\n  ".join(sets) + "\n"
        f"WHEN NOT MATCHED THEN INSERT ({', '.join(insert_cols)})\n"
        f"  VALUES ({', '.join(insert_vals)})"
    )


# ---------------------------------------------------------------- execution
def _warehouse_id() -> str:
    wid = (os.environ.get("HIST_SQL_WAREHOUSE_ID") or os.environ.get("DATABRICKS_WAREHOUSE_ID") or "").strip()
    if not wid:
        raise HistUpdateError("No SQL warehouse configured. Set HIST_SQL_WAREHOUSE_ID in app.yaml.")
    return wid


def run_sql(statement: str, params: dict | None = None) -> tuple[list[str], list[list]]:
    """Run one statement as the app's service principal. Returns (column names, rows)."""
    from databricks.sdk import WorkspaceClient
    from databricks.sdk.service.sql import (
        Disposition, ExecuteStatementRequestOnWaitTimeout, Format, StatementParameterListItem, StatementState)

    items = [
        StatementParameterListItem(name=k, value=None if v is None else str(v),
                                   type="INT" if isinstance(v, int) else "STRING")
        for k, v in (params or {}).items() if f":{k}" in statement
    ]
    client = WorkspaceClient()
    resp = client.statement_execution.execute_statement(
        statement=statement, warehouse_id=_warehouse_id(), parameters=items or None,
        wait_timeout="50s", on_wait_timeout=ExecuteStatementRequestOnWaitTimeout.CONTINUE,
        disposition=Disposition.INLINE, format=Format.JSON_ARRAY)
    deadline = time.time() + 600
    while resp.status.state in (StatementState.PENDING, StatementState.RUNNING):
        if time.time() > deadline:
            client.statement_execution.cancel_execution(resp.statement_id)
            raise HistUpdateError("The query ran for more than 10 minutes and was cancelled.")
        time.sleep(2)
        resp = client.statement_execution.get_statement(resp.statement_id)
    if resp.status.state != StatementState.SUCCEEDED:
        msg = resp.status.error.message if resp.status.error else str(resp.status.state)
        raise HistUpdateError(f"SQL failed: {msg}")
    cols = [c.name for c in (resp.manifest.schema.columns or [])] if resp.manifest and resp.manifest.schema else []
    rows = (resp.result.data_array or []) if resp.result else []
    return cols, rows


def target_columns(target: str) -> list[str]:
    _, rows = run_sql(f"DESCRIBE TABLE {target}")
    cols = []
    for row in rows:
        name = (row[0] or "").strip()
        if not name or name.startswith("#"):
            break
        cols.append(name)
    return cols


def _num(v):
    if v is None:
        return None
    try:
        f = float(v)
        return int(f) if f.is_integer() else f
    except (TypeError, ValueError):
        return v


TARGETS = {"weekday": "HIST_PROGRAM_WEEKDAY_TABLE", "weekend": "HIST_PROGRAM_WEEKEND_TABLE"}


def list_months() -> list[dict]:
    _, rows = run_sql(f"SELECT DISTINCT year, month FROM {table('HIST_FLAGS_TABLE')} ORDER BY year DESC, month DESC")
    out = []
    for y, m in rows:
        name = MONTHS[int(m) - 1]
        out.append({"label": month_label(name, int(y)), "month_name": name, "year": int(y)})
    return out


def _snapshot_one(kind: str, params: dict) -> dict:
    target = table(TARGETS[kind])
    tcols = target_columns(target)
    cols, rows = run_sql(build_snapshot_sql(calc_sql(kind), target, tcols), params)
    numeric = {"TCs", "Dur", "Impressions", "old_impressions", "old_dur", "old_tcs"}
    data = [{c: (_num(v) if c in numeric else v) for c, v in zip(cols, row)} for row in rows]
    counts = {s: sum(1 for d in data if d["status"] == s) for s in ("New", "Changed", "Unchanged")}
    low = {c.lower() for c in tcols}
    return {
        "table": target,
        "rows": data,
        "counts": counts,
        "has_tcs": "tcs" in low,
        "records_user": any(c in low for c in USER_COLS),
        "records_timestamps": any(c in low for c in UPDATED_COLS),
    }


def snapshot(label: str) -> dict:
    month_name, year = parse_month_label(label)
    params = {"month_name": month_name, "cal_year": year}
    _, period = run_sql(
        f"SELECT MIN(BROADCAST_DATE), MAX(BROADCAST_DATE) FROM {table('HIST_CALENDAR_TABLE')} "
        "WHERE UPPER(TRIM(NHI_MONTH_NAME)) = :month_name AND CAST(CALENDAR_YEAR AS INT) = :cal_year", params)
    start, end = (period[0] if period else (None, None))
    if not start:
        raise HistUpdateError(f"{label} is not in the broadcast calendar.")
    with ThreadPoolExecutor(max_workers=2) as pool:
        wd = pool.submit(_snapshot_one, "weekday", params)
        we = pool.submit(_snapshot_one, "weekend", params)
        weekday, weekend = wd.result(), we.result()
    return {"month": month_label(month_name, year), "period_start": str(start)[:10], "period_end": str(end)[:10],
            "weekday": weekday, "weekend": weekend}


def _update_one(kind: str, params: dict) -> dict:
    target = table(TARGETS[kind])
    cols, rows = run_sql(build_merge_sql(calc_sql(kind), target, target_columns(target)), params)
    stats = dict(zip(cols, rows[0])) if rows else {}
    return {"table": target,
            "inserted": int(_num(stats.get("num_inserted_rows")) or 0),
            "updated": int(_num(stats.get("num_updated_rows")) or 0)}


def update(label: str, user: str) -> dict:
    """Run the weekday script, then the weekend script, both as upserts."""
    month_name, year = parse_month_label(label)
    params = {"month_name": month_name, "cal_year": year, "user_id": user}
    weekday = _update_one("weekday", params)
    weekend = _update_one("weekend", params)
    return {"month": month_label(month_name, year), "user": user, "weekday": weekday, "weekend": weekend,
            "inserted": weekday["inserted"] + weekend["inserted"],
            "updated": weekday["updated"] + weekend["updated"]}
