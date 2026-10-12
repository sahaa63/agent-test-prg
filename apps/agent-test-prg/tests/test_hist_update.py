"""Tests for the Historical Update SQL builders (no Databricks connection needed)."""

import pytest

from agent_server.hist_update import service

WEEKDAY_16 = ["Month", "Network", "Daypart", "Program", "Start", "End", "Demo", "TCs", "Dur", "Impressions",
              "MSNBC_Show", "Source", "created_ts", "updated_ts", "start_day", "end_day"]
WEEKEND_7 = ["Month", "Network", "Daypart", "Program", "Demo", "Impressions", "Dur"]


def test_parse_month_label():
    assert service.parse_month_label("Sep-26") == ("SEPTEMBER", 2026)
    assert service.parse_month_label(" jul-26 ") == ("JULY", 2026)
    assert service.month_label("SEPTEMBER", 2026) == "Sep-26"


@pytest.mark.parametrize("bad", ["", "September 2026", "Xyz-26", "Sep-2026", "Sep-26; DROP TABLE x"])
def test_parse_month_label_rejects(bad):
    with pytest.raises(service.HistUpdateError):
        service.parse_month_label(bad)


def test_table_name_must_be_three_parts(monkeypatch):
    monkeypatch.setenv("HIST_FLAGS_TABLE", "flags; DROP TABLE x")
    with pytest.raises(service.HistUpdateError):
        service.table("HIST_FLAGS_TABLE")
    monkeypatch.setenv("HIST_FLAGS_TABLE", "main.prg.flags")
    assert service.table("HIST_FLAGS_TABLE") == "main.prg.flags"


@pytest.mark.parametrize("kind", ["weekday", "weekend"])
def test_calc_sql_has_inputs_and_no_placeholders(kind):
    sql = service.calc_sql(kind)
    assert ":month_name" in sql and ":cal_year" in sql
    assert "{" not in sql and "p_month_name" not in sql and "DECLARE" not in sql
    # optional custom range, defaulting to the full broadcast month
    assert "COALESCE(CAST(:start_date AS DATE), (SELECT period_start FROM _cal))" in sql
    assert "COALESCE(CAST(:end_date   AS DATE), (SELECT period_end   FROM _cal))" in sql


AUG = ("2026-07-27", "2026-08-30")


def test_range_defaults_to_the_full_month():
    assert service.resolve_range(*AUG, None, None) == ("2026-07-27", "2026-08-30", False)
    assert service.resolve_range(*AUG, "2026-07-27", "2026-08-30") == ("2026-07-27", "2026-08-30", False)


def test_range_inside_the_month_is_custom():
    assert service.resolve_range(*AUG, None, "2026-08-23") == ("2026-07-27", "2026-08-23", True)
    assert service.resolve_range(*AUG, "2026-08-03", "2026-08-09") == ("2026-08-03", "2026-08-09", True)


@pytest.mark.parametrize("start,end", [
    ("2026-08-24", "2026-08-23"),   # start after end
    ("2026-07-26", None),           # before the month
    (None, "2026-08-31"),           # after the month
    ("23/08/2026", None),           # wrong format
    (None, "2026-08-23'; DROP"),    # not a date
])
def test_range_rejects_bad_input(start, end):
    with pytest.raises(service.HistUpdateError):
        service.resolve_range(*AUG, start, end)


def test_month_list_carries_the_broadcast_dates():
    sql = service.months_sql()
    assert "MIN(c.BROADCAST_DATE) AS month_start" in sql and "MAX(c.BROADCAST_DATE) AS month_end" in sql
    # same month match the calculation scripts use: NHI month name + calendar year
    assert "UPPER(TRIM(c.NHI_MONTH_NAME))" in sql and "CAST(c.CALENDAR_YEAR AS INT) = f.year" in sql


def test_merge_fills_timestamps_and_skips_missing_user_column():
    sql = service.build_merge_sql("SELECT 1", "c.s.t", WEEKDAY_16)
    assert "WHEN MATCHED AND (" in sql and "WHEN NOT MATCHED THEN INSERT" in sql
    assert "t.`updated_ts` = current_timestamp()" in sql
    assert "t.`created_ts` =" not in sql  # created time is kept on update
    assert ":user_id" not in sql  # no user column in the table yet
    assert "t.`TCs` = s.`TCs`" in sql
    assert sql.count("current_timestamp()") == 3  # update: updated_ts; insert: created_ts + updated_ts


def test_merge_adapts_to_a_narrow_table():
    sql = service.build_merge_sql("SELECT 1", "c.s.t", WEEKEND_7)
    assert "`TCs`" not in sql and "`Start`" not in sql and "current_timestamp()" not in sql
    assert "INSERT (`Month`, `Network`, `Daypart`, `Program`, `Demo`, `Impressions`, `Dur`)" in sql


def test_merge_fills_user_column_once_it_exists():
    sql = service.build_merge_sql("SELECT 1", "c.s.t", WEEKDAY_16 + ["user_id"])
    assert "t.`user_id` = :user_id" in sql
    assert sql.rstrip().endswith(":user_id)")


def test_snapshot_reports_old_values_and_status():
    sql = service.build_snapshot_sql("SELECT 1", "c.s.t", WEEKEND_7)
    assert "NULL AS old_tcs" in sql and "t.`Impressions` AS old_impressions" in sql
    assert "'New'" in sql and "'Changed'" in sql and "'Unchanged'" in sql


def test_missing_key_column_is_an_error():
    with pytest.raises(service.HistUpdateError):
        service.build_merge_sql("SELECT 1", "c.s.t", ["Month", "Network", "Impressions"])
