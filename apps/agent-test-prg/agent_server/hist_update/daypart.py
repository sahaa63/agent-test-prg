"""Daypart history update: snapshot (calculate + compare) and upsert, for the 7 daypart tables.

Dayparts come from the daypart list table (one row per daypart: days, time window and the
history tables that carry it), so no daypart is written in code. The maths and source filters
match the daypart_hist_load notebook: Nielsen quarter hours (Big Data, LS, Composite, P2+ and
P25-54), duration-weighted average / 1000, rounded, no 5 AM roll-forward.

SQL building is kept free of Databricks imports so it can be unit tested.
"""

import os
import re
from datetime import date, timedelta

from agent_server.hist_update.service import (
    CREATED_COLS, MONTHS, ORIGIN_COLS, UPDATED_COLS, USER_COLS, APP_ORIGIN,
    HistUpdateError, month_label, resolve_range, run_sql, table, _num, _q, _TABLE_NAME)

DEFAULT_SCHEMA = "genai_dev.bronze"
DEFAULT_LIST_TABLE = "genai_dev.bronze.disa_news_daypart_list"

# key -> (period grain, period column, demo label style). Demo style follows what each table
# already stores (daily and year write A25-54, the others P25-54), as the load notebook does.
TABLES = {
    "daily":              ("day",     "Month", "A25-54"),
    "weekly":             ("week",    "Week",  "P25-54"),
    "monthly":            ("month",   "Month", "P25-54"),
    "monthly_currency":   ("month",   "Month", "P25-54"),
    "quarterly":          ("quarter", "Month", "P25-54"),
    "quarterly_currency": ("quarter", "Month", "P25-54"),
    "year":               ("year",    "Month", "A25-54"),
}
GRAIN_LIMITS = {"day": 60, "week": 26, "month": 24, "quarter": 8, "year": 3}
REQUIRED = ["Network", "Daypart", "Demographic", "Impression"]


# ---------------------------------------------------------------- settings
def _schema() -> str:
    s = (os.environ.get("HIST_DAYPART_SCHEMA") or DEFAULT_SCHEMA).strip()
    if not _TABLE_NAME.match(f"{s}.x"):
        raise HistUpdateError(f"HIST_DAYPART_SCHEMA must be catalog.schema, got '{s}'.")
    return s


def list_table() -> str:
    name = (os.environ.get("HIST_DAYPART_LIST_TABLE") or DEFAULT_LIST_TABLE).strip()
    if not _TABLE_NAME.match(name):
        raise HistUpdateError(f"HIST_DAYPART_LIST_TABLE must be catalog.schema.table, got '{name}'.")
    return name


def target_table(key: str) -> str:
    if key not in TABLES:
        raise HistUpdateError(f"Unknown daypart table '{key}'.")
    return f"{_schema()}.disa_news_historical_daypart_{key}"


def list_tables() -> list[dict]:
    return [{"key": k, "table": target_table(k), "grain": g,
             "group": "currency" if k.endswith("_currency") else "standard"}
            for k, (g, _, _) in TABLES.items()]


# ---------------------------------------------------------------- pure helpers
def quarter_label(month_num: int, year: int) -> str:
    """June 2026 -> '2Q26' (calendar quarter of the broadcast month, as the tables store it)."""
    return f"{(month_num - 1) // 3 + 1}Q{str(year)[2:]}"


def group_periods(grain: str, months: list[tuple[str, int, str, str]]) -> list[dict]:
    """Month rows (NAME, year, start, end), newest first -> periods of the grain, newest first."""
    groups: dict[str, dict] = {}
    for name, year, start, end in months:
        num = MONTHS.index(name) + 1
        label = {"month": month_label(name, year), "quarter": quarter_label(num, year), "year": str(year)}[grain]
        g = groups.setdefault(label, {"label": label, "start": start, "end": end})
        g["start"], g["end"] = min(g["start"], start), max(g["end"], end)
    out = sorted(groups.values(), key=lambda p: p["start"], reverse=True)
    return out[:GRAIN_LIMITS[grain]]


def week_periods(week_starts: list[str]) -> list[dict]:
    out = []
    for w in week_starts:
        d = date.fromisoformat(w)
        out.append({"label": w, "start": w, "end": (d + timedelta(days=6)).isoformat()})
    return out


MAX_PERIODS = 24
_LABEL = re.compile(r"^[A-Za-z0-9-]{4,10}$")
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _check_periods(periods: list[dict]) -> None:
    """Labels and dates are put into the SQL text, so they must be exactly the expected shapes."""
    if not periods:
        raise HistUpdateError("Pick at least one period.")
    for p in periods:
        if not _LABEL.match(p["label"]) or not _DATE.match(p["start"]) or not _DATE.match(p["end"]):
            raise HistUpdateError(f"Invalid period {p!r}.")


def _period_values(periods: list[dict]) -> str:
    return ", ".join(f"('{p['label']}', DATE'{p['start']}', DATE'{p['end']}')" for p in periods)


def calc_sql(key: str, mde: str, dl_table: str, periods: list[dict]) -> str:
    """Calculated rows for one table and one or more periods ({label, start, end}, already validated).

    Built for speed:
      1. One pass over the Nielsen quarter hours for all the selected periods together (only the
         columns and dates needed), reduced to period x network x demo x weekday x quarter hour:
         at most 4,032 rows per period. The duration-weighted average adds up exactly:
         AA = sum(impressions x duration) / sum(duration) / 1000.
      2. Dayparts are matched against those few rows, never against the raw data. The daypart list
         and the period list are tiny and broadcast. The match short-circuits: all-week dayparts
         (M-Su) skip the day check, whole-day dayparts (6A - 6A) skip the time check.
    """
    _check_periods(periods)
    _, _, demo_style = TABLES[key]
    demo = ("CASE q.demographic WHEN 'P25-54' THEN 'A25-54' ELSE q.demographic END"
            if demo_style == "A25-54" else "q.demographic")
    first = min(p["start"] for p in periods)
    last = max(p["end"] for p in periods)
    return (
        "WITH per AS (\n"
        f"  SELECT * FROM VALUES {_period_values(periods)} AS per(label, p_start, p_end)\n"
        "),\n"
        "qh AS (\n"
        "  SELECT /*+ BROADCAST(p) */\n"
        "         p.label AS period,\n"
        "         CASE m.originator_name WHEN 'FOX NEWS CHANNEL' THEN 'FOXNC' WHEN 'MS NOW' THEN 'MSNBC'\n"
        "              ELSE m.originator_name END AS network,\n"
        "         m.demographic,\n"
        "         ((DAYOFWEEK(m.broadcast_date) + 5) % 7) + 1 AS dow,\n"
        "         m.qtr_hhr_start_time AS qt,\n"
        "         SUM(CAST(m.total_impressions AS DOUBLE) * CAST(m.qtr_hhr_program_duration AS DOUBLE)) AS w_sum,\n"
        "         SUM(CAST(m.qtr_hhr_program_duration AS DOUBLE)) AS d_sum\n"
        f"  FROM {mde} m\n"
        "  JOIN per p ON m.broadcast_date BETWEEN p.p_start AND p.p_end\n"
        f"  WHERE m.broadcast_date BETWEEN DATE'{first}' AND DATE'{last}'\n"
        "    AND m.stream = 'LS' AND m.market_break = 'Composite' AND m.feed_type = 'Big Data'\n"
        "    AND m.demographic IN ('P2+', 'P25-54')\n"
        "    AND m.originator_name IN ('MSNBC', 'MS NOW', 'CNN', 'FOX NEWS CHANNEL')\n"
        "  GROUP BY 1, 2, 3, 4, 5\n"
        "),\n"
        "dl AS (\n"
        "  SELECT daypart, days, start_time, end_time,\n"
        "         size(days) = 7 AS all_days,\n"
        "         start_time = end_time AS all_hours,\n"
        "         end_time < start_time AS past_midnight,\n"
        "         CONCAT(start_time, ':00') AS t_from, CONCAT(end_time, ':00') AS t_to\n"
        f"  FROM {dl_table}\n"
        f"  WHERE is_active AND array_contains(tables, '{key}')\n"
        ")\n"
        "SELECT /*+ BROADCAST(d) */\n"
        "       q.period AS Period, q.network AS Network, d.daypart AS Daypart,\n"
        f"       {demo} AS Demographic, 'Big Data' AS Feed_type,\n"
        "       ROUND(SUM(q.w_sum) / NULLIF(SUM(q.d_sum), 0) / 1000, 0) AS Impression,\n"
        "       d.start_time AS Start, d.end_time AS End\n"
        "FROM qh q\n"
        "JOIN dl d\n"
        "  ON (d.all_days OR array_contains(d.days, q.dow))\n"
        " AND (d.all_hours\n"
        "      OR (NOT d.past_midnight AND q.qt >= d.t_from AND q.qt < d.t_to)\n"
        "      OR (d.past_midnight AND (q.qt >= d.t_from OR q.qt < d.t_to)))\n"
        "GROUP BY q.period, q.network, d.daypart, d.start_time, d.end_time, q.demographic"
    )


def _resolve(key: str, target_types: dict[str, str]) -> tuple[dict, str]:
    """Map our column names onto the target's actual names; return (actual names, period column)."""
    actual = {c.lower(): c for c in target_types}
    pcol = TABLES[key][1]
    missing = [c for c in [pcol] + REQUIRED if c.lower() not in actual]
    if missing:
        raise HistUpdateError(f"Daypart table is missing column(s): {', '.join(missing)}.")
    return actual, actual[pcol.lower()]


def _period_key(key: str, t_col: str) -> str:
    """The stored period as text in the same form as the labels ('3Q25', 'Sep-26', '2025', '2026-09-21')."""
    if TABLES[key][0] in ("day", "week"):
        return f"CAST(CAST({t_col} AS DATE) AS STRING)"
    return f"CAST({t_col} AS STRING)"


def _period_filter(key: str, t_col: str, periods: list[dict]) -> str:
    """Only the selected periods. A fixed list of values (not a column), so Delta can skip files."""
    labels = ", ".join(f"'{p['label']}'" for p in periods)
    return f"{_period_key(key, t_col)} IN ({labels})"


def _on(key: str, actual: dict, pcol: str, periods: list[dict]) -> str:
    t_col = f"t.{_q(pcol)}"
    parts = [_period_filter(key, t_col, periods), f"{_period_key(key, t_col)} = s.`Period`"]
    parts += [f"t.{_q(actual[c.lower()])} <=> s.{_q(c)}" for c in ("Network", "Daypart", "Demographic")]
    if "feed_type" in actual:  # stored as 'Big data' or 'Big Data' depending on whether the fix has run
        parts.append(f"LOWER(t.{_q(actual['feed_type'])}) <=> LOWER(s.`Feed_type`)")
    return " AND ".join(parts)


def build_snapshot_sql(key: str, calc: str, target: str, target_types: dict[str, str], periods: list[dict]) -> str:
    """Calculated rows with the value already in the table and a status per row.

    The target is read once for the selected periods and grouped by key, so duplicate rows in
    the table never multiply the result.
    """
    _check_periods(periods)
    actual, pcol = _resolve(key, target_types)
    imp = f"TRY_CAST({_q(actual['impression'])} AS DOUBLE)"
    keys = [_q(actual[c.lower()]) for c in ("Network", "Daypart", "Demographic")]
    feed = "feed_type" in actual
    select_keys = f"{_period_key(key, _q(pcol))} AS per_key, " + ", ".join(f"{k} AS k{i}" for i, k in enumerate(keys))
    if feed:
        select_keys += f", LOWER({_q(actual['feed_type'])}) AS feed"
    group_by = ", ".join(str(n) for n in range(1, len(keys) + (3 if feed else 2)))
    join_on = "t.per_key = s.`Period` AND t.k0 <=> s.`Network` AND t.k1 <=> s.`Daypart` AND t.k2 <=> s.`Demographic`"
    if feed:
        join_on += " AND t.feed <=> LOWER(s.`Feed_type`)"
    return (
        "SELECT s.`Period`, s.`Network`, s.`Daypart`, s.`Demographic`, s.`Feed_type`, s.`Impression`,\n"
        "       s.`Start`, s.`End`, t.old_max AS old_impression,\n"
        "       CASE WHEN t.row_count IS NULL THEN 'New'\n"
        "            WHEN NOT (t.old_min <=> CAST(s.`Impression` AS DOUBLE)"
        " AND t.old_max <=> CAST(s.`Impression` AS DOUBLE)) THEN 'Changed'\n"
        "            ELSE 'Unchanged' END AS status\n"
        f"FROM (\n{calc}\n) s\n"
        "LEFT JOIN (\n"
        f"  SELECT {select_keys},\n"
        f"         COUNT(*) AS row_count, MIN({imp}) AS old_min, MAX({imp}) AS old_max\n"
        f"  FROM {target}\n"
        f"  WHERE {_period_filter(key, _q(pcol), periods)}\n"
        f"  GROUP BY {group_by}\n"
        f") t ON {join_on}\n"
        "ORDER BY s.`Period` DESC, s.`Network`, s.`Daypart`, s.`Demographic`"
    )


def build_merge_sql(key: str, calc: str, target: str, target_types: dict[str, str], periods: list[dict]) -> str:
    """Upsert: insert new keys, update keys whose Impression changed, leave the rest."""
    _check_periods(periods)
    actual, pcol = _resolve(key, target_types)
    types = {c.lower(): t for c, t in target_types.items()}
    imp = actual["impression"]
    grain = TABLES[key][0]

    sets = [f"t.{_q(imp)} = CAST(s.`Impression` AS {types['impression']})"]
    sets += [f"t.{_q(actual[c])} = current_timestamp()" for c in UPDATED_COLS if c in actual]
    sets += [f"t.{_q(actual[c])} = :user_id" for c in USER_COLS if c in actual]
    sets += [f"t.{_q(actual[c])} = '{APP_ORIGIN}'" for c in ORIGIN_COLS if c in actual]

    produced = {
        pcol.lower(): f"CAST(s.`Period` AS {types[pcol.lower()]})",
        "network": "s.`Network`", "daypart": "s.`Daypart`", "demographic": "s.`Demographic`",
        "feed_type": "s.`Feed_type`", "impression": f"CAST(s.`Impression` AS {types['impression']})",
        "period_type": f"'{grain}'",
    }
    insert_cols, insert_vals = [], []
    for low, name in actual.items():
        if low in produced:
            expr = produced[low]
        elif low in CREATED_COLS or low in UPDATED_COLS:
            expr = "current_timestamp()"
        elif low in USER_COLS:
            expr = ":user_id"
        elif low in ORIGIN_COLS:
            expr = f"'{APP_ORIGIN}'"
        else:
            continue  # column we do not produce (e.g. Day): left NULL
        insert_cols.append(_q(name))
        insert_vals.append(expr)

    return (
        f"MERGE INTO {target} t\n"
        f"USING (\n{calc}\n) s\n"
        f"ON {_on(key, actual, pcol, periods)}\n"
        f"WHEN MATCHED AND NOT (TRY_CAST(t.{_q(imp)} AS DOUBLE) <=> CAST(s.`Impression` AS DOUBLE)) THEN UPDATE SET\n  "
        + ",\n  ".join(sets) + "\n"
        f"WHEN NOT MATCHED THEN INSERT ({', '.join(insert_cols)})\n"
        f"  VALUES ({', '.join(insert_vals)})"
    )


NOW, KEPT = "(now)", "(kept)"


def write_preview(key: str, columns: list[str], row: dict, user: str) -> dict:
    """What the update will leave in each of the table's columns for this row.

    New rows get every column the load fills; changed rows get the new Impression and the update
    audit columns; everything else is kept. '(now)' = the time of the update, '(kept)' = unchanged.
    """
    grain, pcol, _ = TABLES[key]
    status = row["status"]
    new, touched = status == "New", status in ("New", "Changed")
    out = {}
    for c in columns:
        low = c.lower()
        if low == pcol.lower():
            v = row["Period"]
        elif low in ("network", "daypart", "demographic"):
            v = row[{"network": "Network", "daypart": "Daypart", "demographic": "Demographic"}[low]]
        elif low == "impression":
            v = row["Impression"]
        elif low == "feed_type":
            v = row["Feed_type"] if new else KEPT
        elif low == "period_type":
            v = grain if new else KEPT
        elif low in CREATED_COLS:
            v = NOW if new else KEPT
        elif low in UPDATED_COLS:
            v = NOW if touched else KEPT
        elif low in USER_COLS:
            v = user if touched else KEPT
        elif low in ORIGIN_COLS:
            v = APP_ORIGIN if touched else KEPT
        else:
            v = None if new else KEPT  # a column the load does not fill (e.g. Day)
        out[c] = v
    return out


# ---------------------------------------------------------------- execution
def target_types(target: str) -> dict[str, str]:
    _, rows = run_sql(f"DESCRIBE TABLE {target}")
    out = {}
    for row in rows:
        name = (row[0] or "").strip()
        if not name or name.startswith("#"):
            break
        out[name] = (row[1] or "string").strip()
    return out


def list_periods(key: str) -> list[dict]:
    target_table(key)  # validates the key
    grain = TABLES[key][0]
    cal = table("HIST_CALENDAR_TABLE")
    if grain == "day":
        _, rows = run_sql(f"SELECT DISTINCT BROADCAST_DATE FROM {cal} WHERE BROADCAST_DATE <= current_date() "
                          f"ORDER BY BROADCAST_DATE DESC LIMIT {GRAIN_LIMITS['day']}")
        return [{"label": str(r[0])[:10], "start": str(r[0])[:10], "end": str(r[0])[:10]} for r in rows]
    if grain == "week":
        _, rows = run_sql(f"SELECT DISTINCT CAST(DATE_TRUNC('WEEK', BROADCAST_DATE) AS DATE) AS w FROM {cal} "
                          f"WHERE BROADCAST_DATE <= current_date() ORDER BY w DESC LIMIT {GRAIN_LIMITS['week']}")
        return week_periods([str(r[0])[:10] for r in rows])
    _, rows = run_sql(
        "SELECT UPPER(TRIM(NHI_MONTH_NAME)), CAST(CALENDAR_YEAR AS INT), MIN(BROADCAST_DATE), MAX(BROADCAST_DATE)\n"
        f"FROM {cal} GROUP BY 1, 2 HAVING MIN(BROADCAST_DATE) <= current_date() ORDER BY 3 DESC LIMIT 60")
    months = [(m, int(y), str(s)[:10], str(e)[:10]) for m, y, s, e in rows if m in MONTHS]
    return group_periods(grain, months)


def resolve_periods(key: str, labels: list[str], available: list[dict],
                    start: str | None = None, end: str | None = None) -> tuple[list[dict], dict]:
    """The selected periods with their dates. A custom date range is allowed for a single period only."""
    labels = list(dict.fromkeys(l.strip() for l in labels if l and l.strip()))
    if not labels:
        raise HistUpdateError("Pick at least one period.")
    if len(labels) > MAX_PERIODS:
        raise HistUpdateError(f"Pick at most {MAX_PERIODS} periods at a time.")
    by_label = {p["label"]: p for p in available}
    unknown = [l for l in labels if l not in by_label]
    if unknown:
        raise HistUpdateError(f"Not an available period for the {key} table: {', '.join(unknown)}.")
    chosen = [dict(by_label[l]) for l in labels]
    custom = False
    if start or end:
        if len(chosen) > 1:
            raise HistUpdateError("A custom date range works with one period at a time.")
        p = chosen[0]
        p["start"], p["end"], custom = resolve_range(p["start"], p["end"], start or None, end or None)
    info = {"table_key": key, "periods": labels, "custom_range": custom,
            "period_start": chosen[0]["start"] if len(chosen) == 1 else None,
            "period_end": chosen[0]["end"] if len(chosen) == 1 else None}
    return chosen, info


def snapshot(key: str, labels: list[str], start: str | None = None, end: str | None = None,
             user: str = "") -> dict:
    """Calculated rows, plus exactly what the update would write in every column of the table."""
    periods, info = resolve_periods(key, labels, list_periods(key), start, end)
    target = target_table(key)
    types = target_types(target)
    calc = calc_sql(key, table("HIST_MDE_TABLE"), list_table(), periods)
    cols, rows = run_sql(build_snapshot_sql(key, calc, target, types, periods))
    numeric = {"Impression", "old_impression"}
    data = [{c: (_num(v) if c in numeric else v) for c, v in zip(cols, row)} for row in rows]
    columns = list(types)
    for d in data:
        d["write"] = write_preview(key, columns, d, user)
    counts = {s: sum(1 for d in data if d["status"] == s) for s in ("New", "Changed", "Unchanged")}
    return {**info, "table": target, "columns": columns, "period_column": _resolve(key, types)[1],
            "rows": data, "counts": counts}


def update(key: str, labels: list[str], user: str, start: str | None = None, end: str | None = None) -> dict:
    periods, info = resolve_periods(key, labels, list_periods(key), start, end)
    target = target_table(key)
    calc = calc_sql(key, table("HIST_MDE_TABLE"), list_table(), periods)
    cols, rows = run_sql(build_merge_sql(key, calc, target, target_types(target), periods), {"user_id": user})
    stats = dict(zip(cols, rows[0])) if rows else {}
    return {**info, "table": target, "user": user,
            "inserted": int(_num(stats.get("num_inserted_rows")) or 0),
            "updated": int(_num(stats.get("num_updated_rows")) or 0)}
