"""Tests for the flag table generate / upload SQL and validation (no Databricks connection needed)."""

import pytest

from agent_server.flag_update import service
from agent_server.hist_update.service import HistUpdateError

FLAG_COLS = ["year", "month", "network", "daypart", "program", "daypart_type",
             "start_time", "end_time", "flag", "dow_array"]
FN = "genai_uat.bb_usecases_uat.uc_disa_prg_monthly_nielsen_summary"
TBL = "genai_dev.bronze.disa_news_monthly_program_dayparts"


def row(**kw):
    base = {"network": "MS NOW", "daypart": "M-F 6a-9a Span", "program": "MORNING JOE", "daypart_type": "Weekday",
            "start_time": "06:00", "end_time": "09:00", "flag": "Yes", "dow_array": [1, 2, 3, 4, 5]}
    return base | kw


def test_previous_month_wraps_the_year():
    assert service.previous_month(1, 2026) == (12, 2025)
    assert service.previous_month(9, 2026) == (8, 2026)


def test_generate_calls_the_function_once_with_parameters():
    sql = service.generate_sql(FN, TBL)
    assert sql.count(f"{FN}(:year, :month, :start_date, :end_date)") == 1
    assert "CAST(dow_array AS ARRAY<INT>)" in sql and "LPAD(start_time, 5, '0')" in sql
    assert "year = :prev_year AND month = :prev_month" in sql
    assert "saved_flag" in sql and "last_month_flag" in sql


def test_function_name_is_validated(monkeypatch):
    monkeypatch.setenv("FLAG_SUMMARY_FUNCTION", "x; DROP TABLE y")
    with pytest.raises(HistUpdateError):
        service.summary_function()


def test_validation_accepts_a_clean_row():
    assert service.validate_rows([row()])[0]["dow_array"] == [1, 2, 3, 4, 5]


@pytest.mark.parametrize("bad", [
    {"flag": ""}, {"flag": "Maybe"}, {"start_time": "6:00"}, {"daypart_type": "Daily"},
    {"dow_array": []}, {"dow_array": [0, 8]}, {"program": ""},
])
def test_validation_rejects_bad_rows(bad):
    with pytest.raises(HistUpdateError):
        service.validate_rows([row(**bad)])


def test_validation_rejects_duplicates_and_empty_uploads():
    with pytest.raises(HistUpdateError):
        service.validate_rows([row(), row(flag="No")])
    with pytest.raises(HistUpdateError):
        service.validate_rows([])


def test_upload_merge_uses_one_json_parameter_and_the_slot_key():
    sql = service.build_upload_sql(TBL, FLAG_COLS)
    assert "inline(from_json(:rows_json," in sql
    for k in ("year", "month", "network", "daypart", "program", "start_time", "end_time"):
        assert f"t.`{k}` = s.`{k}`" in sql
    assert "WHEN MATCHED AND NOT (t.`flag` <=> s.`flag`) THEN UPDATE SET" in sql
    assert ":user_id" not in sql  # the table has no audit columns


def test_upload_fills_audit_columns_when_present():
    sql = service.build_upload_sql(TBL, FLAG_COLS + ["updated_at", "updated_by", "update_source"])
    assert "t.`updated_by` = :user_id" in sql and "'prg_app'" in sql


def test_upload_reports_missing_key_columns():
    with pytest.raises(HistUpdateError):
        service.build_upload_sql(TBL, ["year", "month", "flag"])


def test_generated_sql_parses():
    sqlglot = pytest.importorskip("sqlglot")
    for stmt in (service.generate_sql(FN, TBL), service.build_upload_sql(TBL, FLAG_COLS)):
        for p in (":year", ":month", ":prev_year", ":prev_month"):
            stmt = stmt.replace(p, "1")
        for p in (":start_date", ":end_date", ":rows_json", ":user_id"):
            stmt = stmt.replace(p, "'x'")
        sqlglot.parse_one(stmt, read="databricks")
