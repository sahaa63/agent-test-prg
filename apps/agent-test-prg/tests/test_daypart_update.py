"""Tests for the daypart history update SQL builders (no Databricks connection needed)."""

import pytest

from agent_server.hist_update import daypart
from agent_server.hist_update.service import HistUpdateError

MONTHLY = {"Month": "string", "Network": "string", "Daypart": "string", "Demographic": "string",
           "Feed_type": "string", "Impression": "double", "period_type": "string"}
WEEKLY = {"Week": "date", "Network": "string", "Daypart": "string", "Demographic": "string",
          "Feed_type": "string", "Impression": "bigint"}
YEAR = {"Month": "int", "Network": "string", "Daypart": "string", "Demographic": "string",
        "Feed_type": "string", "Impression": "double"}

Q = [{"label": "3Q25", "start": "2025-06-30", "end": "2025-09-28"},
     {"label": "2Q25", "start": "2025-03-31", "end": "2025-06-29"}]
SEP = [{"label": "Sep-26", "start": "2026-08-31", "end": "2026-09-27"}]
WEEK = [{"label": "2026-09-21", "start": "2026-09-21", "end": "2026-09-27"}]
YR = [{"label": "2025", "start": "2024-12-30", "end": "2025-12-28"}]


def calc(key="monthly", periods=SEP):
    return daypart.calc_sql(key, "nielsen_prod.gold.mde_program_qtr_hour",
                            "genai_dev.bronze.disa_news_daypart_list", periods)


def test_seven_tables_with_their_period_column():
    assert set(daypart.TABLES) == {"daily", "weekly", "monthly", "monthly_currency",
                                   "quarterly", "quarterly_currency", "year"}
    assert daypart.TABLES["weekly"][1] == "Week"
    assert daypart.target_table("monthly") == "genai_dev.bronze.disa_news_historical_daypart_monthly"
    with pytest.raises(HistUpdateError):
        daypart.target_table("monthly; DROP TABLE x")


def test_calc_reads_the_source_once_for_all_selected_periods():
    sql = calc("quarterly", Q)
    assert sql.count("nielsen_prod.gold.mde_program_qtr_hour") == 1
    assert "VALUES ('3Q25', DATE'2025-06-30', DATE'2025-09-28'), ('2Q25', DATE'2025-03-31', DATE'2025-06-29')" in sql
    # one date window covering every selected period, so files outside it are skipped
    assert "m.broadcast_date BETWEEN DATE'2025-03-31' AND DATE'2025-09-28'" in sql
    assert "GROUP BY 1, 2, 3, 4, 5" in sql.split("dl AS")[0]          # reduced before the daypart match
    assert "q.period AS Period" in sql and "GROUP BY q.period" in sql
    assert "SUM(q.w_sum) / NULLIF(SUM(q.d_sum), 0) / 1000" in sql
    for f in ("m.stream = 'LS'", "m.market_break = 'Composite'", "m.feed_type = 'Big Data'"):
        assert f in sql


def test_daypart_match_short_circuits():
    sql = calc()
    assert "size(days) = 7 AS all_days" in sql
    assert "start_time = end_time AS all_hours" in sql
    assert "(d.all_days OR array_contains(d.days, q.dow))" in sql
    assert "array_contains(tables, 'monthly')" in sql
    assert "/*+ BROADCAST(d) */" in sql and "/*+ BROADCAST(p) */" in sql


def test_period_values_are_checked_before_going_into_the_sql():
    for bad in ({"label": "x'); DROP", "start": "2025-01-01", "end": "2025-01-31"},
                {"label": "Sep-26", "start": "2025-01-01'", "end": "2025-01-31"}):
        with pytest.raises(HistUpdateError):
            calc("monthly", [bad])
    with pytest.raises(HistUpdateError):
        calc("monthly", [])


def test_demo_label_follows_each_table():
    assert "THEN 'A25-54'" in calc("year", YR) and "THEN 'A25-54'" in calc("daily", WEEK[:1])
    assert "THEN 'A25-54'" not in calc("monthly")


def test_networks_keep_the_history_table_names():
    sql = calc()
    assert "WHEN 'FOX NEWS CHANNEL' THEN 'FOXNC'" in sql and "WHEN 'MS NOW' THEN 'MSNBC'" in sql


def test_quarter_and_period_grouping():
    assert daypart.quarter_label(6, 2026) == "2Q26"
    assert daypart.quarter_label(9, 2026) == "3Q26"
    months = [("SEPTEMBER", 2026, "2026-08-31", "2026-09-27"), ("AUGUST", 2026, "2026-07-27", "2026-08-30"),
              ("JULY", 2026, "2026-06-29", "2026-07-26"), ("JUNE", 2026, "2026-06-01", "2026-06-28")]
    q = daypart.group_periods("quarter", months)
    assert q[0] == {"label": "3Q26", "start": "2026-06-29", "end": "2026-09-27"}
    assert q[1]["label"] == "2Q26"
    assert daypart.group_periods("month", months)[0]["label"] == "Sep-26"
    assert daypart.group_periods("year", months) == [{"label": "2026", "start": "2026-06-01", "end": "2026-09-27"}]
    assert daypart.week_periods(["2026-09-21"]) == [{"label": "2026-09-21", "start": "2026-09-21", "end": "2026-09-27"}]


def test_resolve_periods_rules():
    avail = Q + [{"label": "1Q25", "start": "2024-12-30", "end": "2025-03-30"}]
    chosen, info = daypart.resolve_periods("quarterly", ["3Q25", "2Q25", "3Q25"], avail)
    assert [p["label"] for p in chosen] == ["3Q25", "2Q25"] and info["periods"] == ["3Q25", "2Q25"]
    one, info = daypart.resolve_periods("quarterly", ["3Q25"], avail, "2025-07-01", "2025-07-31")
    assert one[0]["start"] == "2025-07-01" and info["custom_range"] is True
    with pytest.raises(HistUpdateError):
        daypart.resolve_periods("quarterly", ["3Q25", "2Q25"], avail, "2025-07-01", None)   # range needs one period
    with pytest.raises(HistUpdateError):
        daypart.resolve_periods("quarterly", ["4Q25"], avail)                               # not available
    with pytest.raises(HistUpdateError):
        daypart.resolve_periods("quarterly", [], avail)


def test_merge_matches_the_selected_periods_and_casts_to_target_types():
    sql = daypart.build_merge_sql("quarterly", calc("quarterly", Q), "c.s.t", MONTHLY, Q)
    assert "CAST(t.`Month` AS STRING) IN ('3Q25', '2Q25')" in sql
    assert "CAST(t.`Month` AS STRING) = s.`Period`" in sql
    assert "LOWER(t.`Feed_type`) <=> LOWER(s.`Feed_type`)" in sql
    assert "TRY_CAST(t.`Impression` AS DOUBLE) <=> CAST(s.`Impression` AS DOUBLE)" in sql
    assert "'quarter'" in sql
    w = daypart.build_merge_sql("weekly", calc("weekly", WEEK), "c.s.t", WEEKLY, WEEK)
    assert "CAST(CAST(t.`Week` AS DATE) AS STRING) IN ('2026-09-21')" in w
    assert "CAST(s.`Period` AS date)" in w and "CAST(s.`Impression` AS bigint)" in w
    y = daypart.build_merge_sql("year", calc("year", YR), "c.s.t", YEAR, YR)
    assert "CAST(s.`Period` AS int)" in y


def test_snapshot_reads_the_target_once_for_the_selected_periods():
    sql = daypart.build_snapshot_sql("quarterly", calc("quarterly", Q), "c.s.t", MONTHLY, Q)
    assert sql.count("FROM c.s.t") == 1
    assert "WHERE CAST(`Month` AS STRING) IN ('3Q25', '2Q25')" in sql
    assert "t.per_key = s.`Period`" in sql
    assert "'New'" in sql and "'Changed'" in sql and "'Unchanged'" in sql


def test_missing_columns_are_reported():
    with pytest.raises(HistUpdateError):
        daypart.build_merge_sql("monthly", calc(), "c.s.t", {"Month": "string", "Network": "string"}, SEP)


def test_generated_sql_parses():
    sqlglot = pytest.importorskip("sqlglot")
    for key, types, periods in (("monthly", MONTHLY, SEP), ("quarterly", MONTHLY, Q),
                                ("weekly", WEEKLY, WEEK), ("year", YEAR, YR)):
        c = calc(key, periods)
        for stmt in (c, daypart.build_snapshot_sql(key, c, "c.s.t", types, periods),
                     daypart.build_merge_sql(key, c, "c.s.t", types, periods)):
            sqlglot.parse_one(stmt.replace(":user_id", "'u'"), read="databricks")


def test_write_preview_shows_every_table_column():
    cols = ["Month", "Network", "Daypart", "Demographic", "Feed_type", "Impression", "period_type",
            "created_at", "updated_at", "update_source", "updated_by", "Day"]
    row = {"Period": "3Q25", "Network": "CNN", "Daypart": "M-F 6A - 9A", "Demographic": "P2+",
           "Feed_type": "Big Data", "Impression": 552, "status": "New"}
    new = daypart.write_preview("quarterly", cols, row, "a@b.com")
    assert list(new) == cols
    assert new["Month"] == "3Q25" and new["period_type"] == "quarter" and new["Feed_type"] == "Big Data"
    assert new["created_at"] == "(now)" and new["updated_by"] == "a@b.com" and new["update_source"] == "prg_app"
    assert new["Day"] is None
    changed = daypart.write_preview("quarterly", cols, row | {"status": "Changed"}, "a@b.com")
    assert changed["Impression"] == 552 and changed["updated_at"] == "(now)"
    assert changed["created_at"] == "(kept)" and changed["Feed_type"] == "(kept)" and changed["period_type"] == "(kept)"
    same = daypart.write_preview("quarterly", cols, row | {"status": "Unchanged"}, "a@b.com")
    assert same["updated_by"] == "(kept)" and same["Month"] == "3Q25"
    weekly = daypart.write_preview("weekly", ["Week", "Network", "Daypart", "Demographic", "Impression"],
                                   row | {"Period": "2026-09-21"}, "u")
    assert weekly["Week"] == "2026-09-21"
