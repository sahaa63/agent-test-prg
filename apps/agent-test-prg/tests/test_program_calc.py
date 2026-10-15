"""Tests for the Program calculation builder (no Databricks connection needed).

These check the shape of the SQL. The numbers are proven separately in Databricks by
files_prg/Historical/hist_data_load/program/validate_program_rewrite.ipynb (old vs new, Jul-Sep 2026).
"""

import pytest

from agent_server.hist_update import program, service

CAL, FLG, MDE = "c.s.calendar", "c.s.flags", "c.s.mde"
OUTPUT = ["Month", "Network", "Daypart", "Program", "Start", "End", "Demo", "TCs", "Dur", "Impressions",
          "MSNBC_Show", "Source", "created_ts", "updated_ts", "start_day", "end_day"]


def sql(kind):
    return program.calc_sql(kind, CAL, FLG, MDE)


@pytest.mark.parametrize("kind", program.KINDS)
def test_reads_the_quarter_hours_once_for_the_month_only(kind):
    s = sql(kind)
    assert s.count(f"FROM {MDE}") == 1
    assert "broadcast_date BETWEEN DATE_ADD((SELECT MIN(BROADCAST_DATE) FROM _period_dates), -1)" in s
    assert "JOIN _period_dates pd ON m.effective_date = pd.BROADCAST_DATE" in s


@pytest.mark.parametrize("kind", program.KINDS)
def test_one_join_against_slot_rules(kind):
    s = sql(kind)
    assert s.count("JOIN _rules r") == 1
    assert "(r.prog_key IS NULL OR m.prog_key = r.prog_key)" in s
    assert "'main' AS rule_kind" in s and "'clubbed'" in s
    assert "CONCAT_WS('/', SORT_ARRAY(COLLECT_SET(fl.flag_program)))" in s


@pytest.mark.parametrize("kind", program.KINDS)
def test_kept_behaviour(kind):
    s = sql(kind)
    assert "THEN DATE_ADD(broadcast_date, 1) ELSE broadcast_date END AS effective_date" in s  # 5 AM roll-forward
    assert "UPPER(TRIM(flag)) = 'YES'" in s
    assert "ELSE (SELECT MAX(year * 100 + month) FROM c.s.flags) END)" in s                   # latest-month fallback
    assert "CASE demographic WHEN 'P25-54' THEN 'A25-54' ELSE demographic END" in s
    assert "'mde_qtr_hist_refresh' AS Source" in s and "'h:mm a') AS Start" in s
    for col in OUTPUT:
        assert f"AS {col}" in s or f"  {col},\n" in s


def test_weekday_specifics():
    s = sql("weekday")
    assert "(is_repeat = FALSE OR ((DAYOFWEEK(broadcast_date) + 5) % 7) + 1 IN (6, 7))" in s
    assert "VARIOUS" not in s
    assert "ARRAY_MIN(dow_array)" in s


def test_weekend_specifics():
    s = sql("weekend")
    assert "AND ((DAYOFWEEK(broadcast_date) + 5) % 7) + 1 IN (6, 7)" in s
    assert "is_repeat" not in s
    assert "'CNN VARIOUS'" in s and "'FOX NEWS VARIOUS'" in s
    # CNN's various dayparts are skipped for main rows; the FOX check compares with 'FOXNC' as before
    assert "NOT (fl.flag_network = 'CNN'   AND fl.flag_daypart IN ('Sa-Su 10A-1P Span'" in s
    assert "NOT (fl.flag_network = 'FOXNC' AND fl.flag_daypart IN ('Sa-Su 10A-1P Span', 'Sa-Su 1P-4P Span'))" in s


def test_service_uses_the_builder_and_the_old_files_are_gone():
    assert "JOIN _rules r" in service.calc_sql("weekday")
    from pathlib import Path
    assert not (Path(program.__file__).parent / "sql" / "program_weekday.sql").exists()


def test_unknown_kind_is_rejected():
    with pytest.raises(ValueError):
        program.calc_sql("daily", CAL, FLG, MDE)


@pytest.mark.parametrize("kind", program.KINDS)
def test_sql_parses(kind):
    sqlglot = pytest.importorskip("sqlglot")
    s = (sql(kind).replace(":month_name", "'SEPTEMBER'").replace(":cal_year", "2026")
         .replace(":start_date", "NULL").replace(":end_date", "NULL"))
    sqlglot.parse_one(s, read="databricks")
