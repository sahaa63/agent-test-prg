"""Program flag table: generate a month's slots, then upload the reviewed flags.

The rows come from the monthly Nielsen summary function, the same function the
"PRG Flag Table Builder" Genie space calls. Calling it directly gives the same
rows every time, without a model in between. Flags (Yes / No) are set by a person
on the page and upserted into the flag table.

SQL building is kept free of Databricks imports so it can be unit tested.
"""

import json
import os
import re

from agent_server.hist_update.service import (
    CREATED_COLS, MONTHS, ORIGIN_COLS, UPDATED_COLS, USER_COLS, APP_ORIGIN,
    HistUpdateError, month_label, parse_month_label, resolve_range, run_sql, table, target_columns, _q)

DEFAULT_SUMMARY_FUNCTION = "genai_uat.bb_usecases_uat.uc_disa_prg_monthly_nielsen_summary"
DEFAULT_GENIE_SPACE_ID = "01f1c8708fe216589c4fa65370947628"

KEY_COLS = ["year", "month", "network", "daypart", "program", "start_time", "end_time"]
UPLOAD_COLS = ["network", "daypart", "program", "daypart_type", "start_time", "end_time", "flag", "dow_array"]
ROW_SCHEMA = ("ARRAY<STRUCT<network: STRING, daypart: STRING, program: STRING, daypart_type: STRING, "
              "start_time: STRING, end_time: STRING, flag: STRING, dow_array: ARRAY<INT>>>")
FLAG_VALUES = ("Yes", "No")
MAX_ROWS = 2000

_FUNCTION_NAME = re.compile(r"^[A-Za-z0-9_]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+$")
_TIME = re.compile(r"^\d{2}:\d{2}$")


# ---------------------------------------------------------------- settings
def summary_function() -> str:
    name = (os.environ.get("FLAG_SUMMARY_FUNCTION") or DEFAULT_SUMMARY_FUNCTION).strip()
    if not _FUNCTION_NAME.match(name):
        raise HistUpdateError(f"FLAG_SUMMARY_FUNCTION must be catalog.schema.function, got '{name}'.")
    return name


def genie_url() -> str | None:
    space = (os.environ.get("FLAG_GENIE_SPACE_ID") or DEFAULT_GENIE_SPACE_ID).strip()
    host = (os.environ.get("DATABRICKS_HOST") or "").strip().rstrip("/")
    if not space or not host:
        return None
    if not host.startswith("http"):
        host = f"https://{host}"
    return f"{host}/genie/rooms/{space}"


# ---------------------------------------------------------------- pure helpers
def previous_month(month_num: int, year: int) -> tuple[int, int]:
    return (12, year - 1) if month_num == 1 else (month_num - 1, year)


def _keys_on(left: str, right: str, cols: list[str]) -> str:
    return " AND ".join(f"{left}.{_q(c)} <=> {right}.{_q(c)}" for c in cols)


def generate_sql(function: str, flags_table: str) -> str:
    """The month's slots from the summary function, with the saved flag and last month's flag."""
    slot = ["network", "daypart", "program", "start_time", "end_time"]
    return (
        "WITH s AS (\n"
        "  SELECT network, daypart, program, CAST(dow_array AS ARRAY<INT>) AS dow_array,\n"
        "         LPAD(start_time, 5, '0') AS start_time, LPAD(end_time, 5, '0') AS end_time,\n"
        "         telecast_count, duration, demo_p2_plus_aa, demo_p25_54_aa, daypart_type\n"
        f"  FROM {function}(:year, :month, :start_date, :end_date)\n"
        "),\n"
        f"cur AS (SELECT * FROM {flags_table} WHERE year = :year AND month = :month),\n"
        f"prev AS (SELECT * FROM {flags_table} WHERE year = :prev_year AND month = :prev_month)\n"
        "SELECT s.network, s.daypart, s.program, s.dow_array, s.start_time, s.end_time,\n"
        "       s.telecast_count, s.duration, s.demo_p2_plus_aa, s.demo_p25_54_aa, s.daypart_type,\n"
        "       cur.flag AS saved_flag, prev.flag AS last_month_flag\n"
        "FROM s\n"
        f"LEFT JOIN cur ON {_keys_on('cur', 's', slot)}\n"
        f"LEFT JOIN prev ON {_keys_on('prev', 's', slot)}\n"
        "ORDER BY CASE s.daypart_type WHEN 'Weekday' THEN 1 ELSE 2 END, s.start_time, s.daypart, s.network, s.program"
    )


def saved_keys_sql(flags_table: str) -> str:
    """The slots already in the flag table for the month (cheap: no Nielsen data read)."""
    return (f"SELECT network, daypart, program, LPAD(start_time, 5, '0'), LPAD(end_time, 5, '0') "
            f"FROM {flags_table} WHERE year = :year AND month = :month")


def validate_rows(rows: list[dict]) -> list[dict]:
    """Clean and check the uploaded rows. Raises HistUpdateError with every problem found."""
    if not rows:
        raise HistUpdateError("No rows to upload.")
    if len(rows) > MAX_ROWS:
        raise HistUpdateError(f"Too many rows ({len(rows)}); the limit is {MAX_ROWS}.")
    problems, clean, seen = [], [], set()
    for i, r in enumerate(rows, 1):
        row = {c: r.get(c) for c in UPLOAD_COLS}
        for c in ("network", "daypart", "program", "daypart_type", "start_time", "end_time", "flag"):
            row[c] = (str(row[c]).strip() if row[c] is not None else "")
        label = f"Row {i} ({row['network']} / {row['daypart']} / {row['program']})"
        if row["flag"] not in FLAG_VALUES:
            problems.append(f"{label}: flag must be Yes or No, got '{row['flag'] or 'empty'}'.")
        if not row["network"] or not row["daypart"] or not row["program"]:
            problems.append(f"{label}: network, daypart and program are required.")
        if not _TIME.match(row["start_time"]) or not _TIME.match(row["end_time"]):
            problems.append(f"{label}: times must look like 09:00.")
        if row["daypart_type"] not in ("Weekday", "Weekend"):
            problems.append(f"{label}: daypart_type must be Weekday or Weekend.")
        try:
            row["dow_array"] = [int(d) for d in (row["dow_array"] or [])]
        except (TypeError, ValueError):
            problems.append(f"{label}: days must be numbers 1 to 7.")
            row["dow_array"] = []
        if not row["dow_array"] or any(d < 1 or d > 7 for d in row["dow_array"]):
            problems.append(f"{label}: days must be numbers 1 to 7.")
        key = (row["network"], row["daypart"], row["program"], row["start_time"], row["end_time"])
        if key in seen:
            problems.append(f"{label}: duplicate of an earlier row.")
        seen.add(key)
        clean.append(row)
    if problems:
        shown = problems[:10]
        more = f" (and {len(problems) - 10} more)" if len(problems) > 10 else ""
        raise HistUpdateError(" ".join(shown) + more)
    return clean


def build_upload_sql(flags_table: str, target_cols: list[str]) -> str:
    """Upsert the reviewed rows. Rows arrive as one JSON parameter, so no value is pasted into the SQL."""
    actual = {c.lower(): c for c in target_cols}
    missing = [k for k in KEY_COLS + ["flag"] if k not in actual]
    if missing:
        raise HistUpdateError(f"Flag table is missing column(s): {', '.join(missing)}.")

    source = (
        "SELECT CAST(:year AS INT) AS year, CAST(:month AS INT) AS month, r.*\n"
        f"  FROM (SELECT inline(from_json(:rows_json, '{ROW_SCHEMA}'))) r"
    )
    on = " AND ".join(f"t.{_q(actual[k])} = s.{_q(k)}" for k in KEY_COLS)
    sets = [f"t.{_q(actual['flag'])} = s.`flag`"]
    sets += [f"t.{_q(actual[c])} = current_timestamp()" for c in UPDATED_COLS if c in actual]
    sets += [f"t.{_q(actual[c])} = :user_id" for c in USER_COLS if c in actual]
    sets += [f"t.{_q(actual[c])} = '{APP_ORIGIN}'" for c in ORIGIN_COLS if c in actual]

    produced = set(KEY_COLS + UPLOAD_COLS)
    insert_cols, insert_vals = [], []
    for low, name in actual.items():
        if low in produced:
            expr = f"s.{_q(low)}"
        elif low in CREATED_COLS or low in UPDATED_COLS:
            expr = "current_timestamp()"
        elif low in USER_COLS:
            expr = ":user_id"
        elif low in ORIGIN_COLS:
            expr = f"'{APP_ORIGIN}'"
        else:
            continue
        insert_cols.append(_q(name))
        insert_vals.append(expr)

    return (
        f"MERGE INTO {flags_table} t\n"
        f"USING (\n  {source}\n) s\n"
        f"ON {on}\n"
        f"WHEN MATCHED AND NOT (t.{_q(actual['flag'])} <=> s.`flag`) THEN UPDATE SET\n  " + ",\n  ".join(sets) + "\n"
        f"WHEN NOT MATCHED THEN INSERT ({', '.join(insert_cols)})\n"
        f"  VALUES ({', '.join(insert_vals)})"
    )


# ---------------------------------------------------------------- execution
def _month_number(month_name: str) -> int:
    return MONTHS.index(month_name) + 1


def list_months() -> list[dict]:
    _, rows = run_sql(
        "SELECT UPPER(TRIM(NHI_MONTH_NAME)) AS m, CAST(CALENDAR_YEAR AS INT) AS y,\n"
        "       MIN(BROADCAST_DATE) AS month_start, MAX(BROADCAST_DATE) AS month_end\n"
        f"FROM {table('HIST_CALENDAR_TABLE')}\n"
        "GROUP BY 1, 2\n"
        "HAVING MIN(BROADCAST_DATE) <= current_date()\n"
        "ORDER BY month_start DESC\n"
        "LIMIT 18")
    _, saved = run_sql(f"SELECT year, month, COUNT(*) FROM {table('HIST_FLAGS_TABLE')} GROUP BY year, month")
    counts = {(int(y), int(m)): int(n) for y, m, n in saved}
    out = []
    for m, y, start, end in rows:
        if m not in MONTHS:
            continue
        num, year = _month_number(m), int(y)
        out.append({"label": month_label(m, year), "start": str(start)[:10], "end": str(end)[:10],
                    "saved_rows": counts.get((year, num), 0)})
    return out


def _params(label: str, start: str | None, end: str | None) -> tuple[dict, dict]:
    month_name, year = parse_month_label(label)
    num = _month_number(month_name)
    _, period = run_sql(
        f"SELECT MIN(BROADCAST_DATE), MAX(BROADCAST_DATE) FROM {table('HIST_CALENDAR_TABLE')} "
        "WHERE UPPER(TRIM(NHI_MONTH_NAME)) = :month_name AND CAST(CALENDAR_YEAR AS INT) = :cal_year",
        {"month_name": month_name, "cal_year": year})
    month_start, month_end = (period[0] if period else (None, None))
    if not month_start:
        raise HistUpdateError(f"{label} is not in the broadcast calendar.")
    month_start, month_end = str(month_start)[:10], str(month_end)[:10]
    eff_start, eff_end, custom = resolve_range(month_start, month_end, start or None, end or None)
    prev_month, prev_year = previous_month(num, year)
    params = {"year": year, "month": num, "start_date": eff_start, "end_date": eff_end,
              "prev_year": prev_year, "prev_month": prev_month}
    info = {"month": label, "year": year, "month_num": num, "month_start": month_start, "month_end": month_end,
            "period_start": eff_start, "period_end": eff_end, "custom_range": custom,
            "previous_month": month_label(MONTHS[prev_month - 1], prev_year)}
    return params, info


def _int(v):
    try:
        return None if v is None else int(float(v))
    except (TypeError, ValueError):
        return None


def _days(v) -> list[int]:
    if isinstance(v, list):
        return [int(x) for x in v]
    try:
        return [int(x) for x in json.loads(v)] if v else []
    except (TypeError, ValueError):
        return [int(x) for x in re.findall(r"\d", str(v))]


def generate(label: str, start: str | None = None, end: str | None = None) -> dict:
    params, info = _params(label, start, end)
    function, flags = summary_function(), table("HIST_FLAGS_TABLE")
    cols, rows = run_sql(generate_sql(function, flags), params)
    data = []
    for row in rows:
        d = dict(zip(cols, row))
        data.append({
            "network": d["network"], "daypart": d["daypart"], "program": d["program"],
            "dow_array": _days(d["dow_array"]), "start_time": d["start_time"], "end_time": d["end_time"],
            "telecast_count": _int(d["telecast_count"]), "duration": _int(d["duration"]),
            "demo_p2_plus_aa": _int(d["demo_p2_plus_aa"]), "demo_p25_54_aa": _int(d["demo_p25_54_aa"]),
            "daypart_type": d["daypart_type"],
            "saved_flag": d["saved_flag"] or None, "last_month_flag": d["last_month_flag"] or None,
        })
    _, saved = run_sql(saved_keys_sql(flags), {"year": params["year"], "month": params["month"]})
    shown = {(d["network"], d["daypart"], d["program"], d["start_time"], d["end_time"]) for d in data}
    not_in_summary = sum(1 for k in saved if tuple(k) not in shown)
    return {**info, "function": function, "table": flags, "rows": data,
            "saved_rows_not_in_summary": not_in_summary}


def upload(label: str, rows: list[dict], user: str, start: str | None = None, end: str | None = None) -> dict:
    clean = validate_rows(rows)
    params, info = _params(label, start, end)
    flags = table("HIST_FLAGS_TABLE")
    params = {"year": params["year"], "month": params["month"], "user_id": user,
              "rows_json": json.dumps(clean)}
    cols, out = run_sql(build_upload_sql(flags, target_columns(flags)), params)
    stats = dict(zip(cols, out[0])) if out else {}
    inserted = _int(stats.get("num_inserted_rows")) or 0
    updated = _int(stats.get("num_updated_rows")) or 0
    return {**info, "table": flags, "user": user, "rows": len(clean),
            "inserted": inserted, "updated": updated, "unchanged": len(clean) - inserted - updated}
