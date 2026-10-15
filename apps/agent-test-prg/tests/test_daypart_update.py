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


def calc(key="monthly"):
    return daypart.calc_sql(key, "nielsen_prod.gold.mde_program_qtr_hour", "genai_dev.bronze.disa_news_daypart_list")


def test_seven_tables_with_their_period_column():
    assert set(daypart.TABLES) == {"daily", "weekly", "monthly", "monthly_currency",
                                   "quarterly", "quarterly_currency", "year"}
    assert daypart.TABLES["weekly"][1] == "Week"
    assert daypart.target_table("monthly") == "genai_dev.bronze.disa_news_historical_daypart_monthly"
    with pytest.raises(HistUpdateError):
        daypart.target_table("monthly; DROP TABLE x")


def test_calc_reads_the_source_once_and_aggregates_before_the_daypart_match():
    sql = calc()
    # one pass over the quarter hours, reduced before the join
    assert sql.count("nielsen_prod.gold.mde_program_qtr_hour") == 1
    assert "GROUP BY 1, 2, 3, 4" in sql.split("dl AS")[0]
    assert "SUM(q.w_sum) / NULLIF(SUM(q.d_sum), 0) / 1000" in sql
    # same source filters as the load notebook
    for f in ("stream = 'LS'", "market_break = 'Composite'", "feed_type = 'Big Data'", "demographic IN ('P2+', 'P25-54')"):
        assert f in sql
    assert "broadcast_date BETWEEN CAST(:start_date AS DATE) AND CAST(:end_date AS DATE)" in sql


def test_daypart_match_short_circuits():
    sql = calc()
    assert "size(days) = 7 AS all_days" in sql                 # M-Su: no day check
    assert "start_time = end_time AS all_hours" in sql         # 6A - 6A: no time check
    assert "(d.all_days OR array_contains(d.days, q.dow))" in sql
    assert "array_contains(tables, 'monthly')" in sql
    assert "/*+ BROADCAST(d) */" in sql


def test_demo_label_follows_each_table():
    assert "THEN 'A25-54'" in calc("year") and "THEN 'A25-54'" in calc("daily")
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


def test_merge_matches_feed_type_case_insensitively_and_casts_to_target_types():
    sql = daypart.build_merge_sql("monthly", "SELECT 1", "c.s.t", MONTHLY)
    assert "CAST(t.`Month` AS STRING) = :period_label" in sql
    assert "LOWER(t.`Feed_type`) <=> LOWER(s.`Feed_type`)" in sql
    assert "TRY_CAST(t.`Impression` AS DOUBLE) <=> CAST(s.`Impression` AS DOUBLE)" in sql
    assert "'month'" in sql  # period_type filled on insert
    w = daypart.build_merge_sql("weekly", "SELECT 1", "c.s.t", WEEKLY)
    assert "CAST(t.`Week` AS DATE) = CAST(:period_label AS DATE)" in w
    assert "CAST(s.`Period` AS date)" in w and "CAST(s.`Impression` AS bigint)" in w
    y = daypart.build_merge_sql("year", "SELECT 1", "c.s.t", YEAR)
    assert "CAST(s.`Period` AS int)" in y


def test_snapshot_reads_the_target_once_per_period():
    sql = daypart.build_snapshot_sql("monthly", "SELECT 1", "c.s.t", MONTHLY)
    assert sql.count("FROM c.s.t") == 1
    assert "WHERE CAST(`Month` AS STRING) = :period_label" in sql
    assert "'New'" in sql and "'Changed'" in sql and "'Unchanged'" in sql


def test_missing_columns_are_reported():
    with pytest.raises(HistUpdateError):
        daypart.build_merge_sql("monthly", "SELECT 1", "c.s.t", {"Month": "string", "Network": "string"})


def test_generated_sql_parses():
    sqlglot = pytest.importorskip("sqlglot")
    for key, types in (("monthly", MONTHLY), ("weekly", WEEKLY), ("year", YEAR)):
        c = calc(key)
        for stmt in (c, daypart.build_snapshot_sql(key, c, "c.s.t", types), daypart.build_merge_sql(key, c, "c.s.t", types)):
            sqlglot.parse_one(stmt.replace(":period_label", "'x'").replace(":start_date", "'2026-01-01'")
                              .replace(":end_date", "'2026-01-31'").replace(":user_id", "'u'"), read="databricks")
