"""Program history calculation, built the same way as the daypart load.

Replaces sql/program_weekday.sql and sql/program_weekend.sql with one builder. The logic is the
same as those scripts (from the prg_hist_updated_logic notebook); only the shape changes:

  1. The flag table becomes a small set of "slot rules":
       - main:    one rule per flagged program (match network + program + days + time window)
       - clubbed: one rule per slot with 2+ flagged programs (network + days + window, any program),
                  labelled with the sorted program names joined by '/'
       - various: weekend only, CNN and FOX "VARIOUS" rows for fixed dayparts (network + window)
  2. The quarter hours are read once, only for the month's dates (plus the day before, for the
     5 AM roll-forward), and joined to the rules once. The old scripts read the whole table and
     joined it once per branch.

Behaviour kept exactly, including the parts the old scripts did on purpose or by accident:
  - 5 AM quarter hours count for the next day (effective_date); days of week come from broadcast_date.
  - Weekday: repeats are excluded except on Saturday and Sunday. Weekend: all telecasts.
  - Flags: the requested month, or the latest month in the table if it has none. Flag = Yes only.
    Weekday takes rules with any of Mon-Fri; weekend takes rules with Sat/Sun and no Mon-Fri.
  - Weekend main rows skip CNN's four "various" dayparts. The matching FOX exclusion compares with
    'FOXNC', which the flag table never contains (it stores 'FOX NEWS CHANNEL'), so it never applies.
    Kept as is, so the output does not change.
  - Output columns, formats (h:mm a), Source and start_day / end_day are unchanged.

SQL building only; no Databricks imports, so it can be unit tested.
"""

KINDS = ("weekday", "weekend")

# Weekend dayparts whose historical CNN / FOX entry is a combined "VARIOUS" row.
CNN_VARIOUS_DAYPARTS = ("Sa-Su 10A-1P Span", "Sa-Su 1P-4P Span", "Sa-Su 7A-10A Span", "Sa-Su 6P-9P Span")
FOX_VARIOUS_DAYPARTS = ("Sa-Su 10A-1P Span", "Sa-Su 1P-4P Span")

_MONTH_NUM = (
    "CASE UPPER(TRIM(:month_name))\n"
    "                 WHEN 'JANUARY'   THEN 1  WHEN 'FEBRUARY' THEN 2  WHEN 'MARCH'     THEN 3\n"
    "                 WHEN 'APRIL'     THEN 4  WHEN 'MAY'      THEN 5  WHEN 'JUNE'      THEN 6\n"
    "                 WHEN 'JULY'      THEN 7  WHEN 'AUGUST'   THEN 8  WHEN 'SEPTEMBER' THEN 9\n"
    "                 WHEN 'OCTOBER'   THEN 10 WHEN 'NOVEMBER' THEN 11 WHEN 'DECEMBER'  THEN 12\n"
    "               END"
)

_WEEKDAY_DAYS = ("(ARRAY_CONTAINS(dow_array, 1) OR ARRAY_CONTAINS(dow_array, 2) OR ARRAY_CONTAINS(dow_array, 3)"
                 " OR ARRAY_CONTAINS(dow_array, 4) OR ARRAY_CONTAINS(dow_array, 5))")


def _quoted(values) -> str:
    return ", ".join(f"'{v}'" for v in values)


def _day_columns(kind: str) -> str:
    if kind == "weekend":
        return ("  CASE WHEN ARRAY_CONTAINS(dow_array, 6) THEN 'Saturday' ELSE 'Sunday' END   AS start_day,\n"
                "  CASE WHEN ARRAY_CONTAINS(dow_array, 7) THEN 'Sunday'   ELSE 'Saturday' END AS end_day\n")
    names = ("WHEN 1 THEN 'Monday' WHEN 2 THEN 'Tuesday' WHEN 3 THEN 'Wednesday' "
             "WHEN 4 THEN 'Thursday' WHEN 5 THEN 'Friday' WHEN 6 THEN 'Saturday' WHEN 7 THEN 'Sunday'")
    return (
        "  CASE WHEN ARRAY_CONTAINS(dow_array, 7) AND ARRAY_CONTAINS(dow_array, 1) THEN 'Sunday'\n"
        f"       ELSE CASE ARRAY_MIN(dow_array) {names} ELSE 'Monday' END\n"
        "  END AS start_day,\n"
        "  CASE WHEN ARRAY_CONTAINS(dow_array, 7) AND ARRAY_CONTAINS(dow_array, 1) THEN\n"
        "         CASE GREATEST(IF(ARRAY_CONTAINS(dow_array, 5), 5, 0), IF(ARRAY_CONTAINS(dow_array, 4), 4, 0),\n"
        "                       IF(ARRAY_CONTAINS(dow_array, 3), 3, 0), IF(ARRAY_CONTAINS(dow_array, 2), 2, 0),\n"
        "                       IF(ARRAY_CONTAINS(dow_array, 1), 1, 0))\n"
        "           WHEN 5 THEN 'Friday'  WHEN 4 THEN 'Thursday' WHEN 3 THEN 'Wednesday'\n"
        "           WHEN 2 THEN 'Tuesday' WHEN 1 THEN 'Monday'   ELSE 'Monday'\n"
        "         END\n"
        f"       ELSE CASE ARRAY_MAX(dow_array) {names} ELSE 'Friday' END\n"
        "  END AS end_day\n"
    )


def calc_sql(kind: str, calendar: str, flags: str, mde: str) -> str:
    """Weekday or weekend program rows for one broadcast month.

    Parameters: :month_name (e.g. 'SEPTEMBER'), :cal_year (e.g. 2026),
                :start_date / :end_date (optional 'YYYY-MM-DD' inside the month; NULL = full month).
    """
    if kind not in KINDS:
        raise ValueError(f"kind must be one of {KINDS}, got '{kind}'")
    weekend = kind == "weekend"

    flag_days = (
        f"    AND (ARRAY_CONTAINS(dow_array, 6) OR ARRAY_CONTAINS(dow_array, 7)) AND NOT {_WEEKDAY_DAYS}\n"
        if weekend else f"    AND {_WEEKDAY_DAYS}\n")
    mde_days = ("    AND ((DAYOFWEEK(broadcast_date) + 5) % 7) + 1 IN (6, 7)\n" if weekend else
                "    AND (is_repeat = FALSE OR ((DAYOFWEEK(broadcast_date) + 5) % 7) + 1 IN (6, 7))\n")
    main_skip = (
        f"  WHERE NOT (fl.flag_network = 'CNN'   AND fl.flag_daypart IN ({_quoted(CNN_VARIOUS_DAYPARTS)}))\n"
        f"    AND NOT (fl.flag_network = 'FOXNC' AND fl.flag_daypart IN ({_quoted(FOX_VARIOUS_DAYPARTS)}))\n"
        if weekend else "")
    various_rules = (
        "  UNION ALL\n"
        "  SELECT DISTINCT 'various', 'CNN', CAST(NULL AS STRING), fl.flag_daypart, fl.dow_array,\n"
        "         fl.win_start, fl.win_end, fl.start_raw, fl.end_raw, 'CNN', 'CNN VARIOUS'\n"
        f"  FROM _flags fl WHERE fl.flag_daypart IN ({_quoted(CNN_VARIOUS_DAYPARTS)})\n"
        "  UNION ALL\n"
        "  SELECT DISTINCT 'various', 'FOX NEWS CHANNEL', CAST(NULL AS STRING), fl.flag_daypart, fl.dow_array,\n"
        "         fl.win_start, fl.win_end, fl.start_raw, fl.end_raw, 'FOXNC', 'FOX NEWS VARIOUS'\n"
        f"  FROM _flags fl WHERE fl.flag_daypart IN ({_quoted(FOX_VARIOUS_DAYPARTS)})\n"
        if weekend else "")

    return (
        f"-- Program history: {kind.upper()} rows for one broadcast month (slot-rules build).\n"
        "WITH\n"
        "_cal AS (\n"
        "  SELECT MIN(BROADCAST_DATE)               AS period_start,\n"
        "         MAX(BROADCAST_DATE)               AS period_end,\n"
        "         CAST(MIN(NHI_SEASON_YEAR) AS INT) AS nhi_sy\n"
        f"  FROM {calendar}\n"
        "  WHERE UPPER(TRIM(NHI_MONTH_NAME)) = UPPER(TRIM(:month_name))\n"
        "    AND CAST(CALENDAR_YEAR AS INT)  = :cal_year\n"
        "),\n"
        "_period_dates AS (\n"
        "  SELECT BROADCAST_DATE\n"
        f"  FROM {calendar}\n"
        "  WHERE BROADCAST_DATE BETWEEN (SELECT period_start FROM _cal)\n"
        "                           AND (SELECT period_end   FROM _cal)\n"
        "    AND CAST(NHI_SEASON_YEAR AS INT) = (SELECT nhi_sy FROM _cal)\n"
        "    AND BROADCAST_DATE >= COALESCE(CAST(:start_date AS DATE), (SELECT period_start FROM _cal))\n"
        "    AND BROADCAST_DATE <= COALESCE(CAST(:end_date   AS DATE), (SELECT period_end   FROM _cal))\n"
        "),\n"
        # Flags: the requested month, or the latest month in the table when it has none.
        "_flags AS (\n"
        "  SELECT UPPER(TRIM(network)) AS flag_network,\n"
        "         UPPER(TRIM(program)) AS flag_program,\n"
        "         TRIM(daypart)        AS flag_daypart,\n"
        "         dow_array,\n"
        "         CONCAT(start_time, ':00') AS win_start,\n"
        "         CASE WHEN end_time = '00:00' THEN '24:00:00' ELSE CONCAT(end_time, ':00') END AS win_end,\n"
        "         start_time AS start_raw,\n"
        "         end_time   AS end_raw\n"
        f"  FROM {flags}\n"
        "  WHERE year * 100 + month = (\n"
        f"          SELECT CASE WHEN (:cal_year * 100 + {_MONTH_NUM}) IN (SELECT DISTINCT year * 100 + month FROM {flags})\n"
        f"                      THEN :cal_year * 100 + {_MONTH_NUM}\n"
        f"                      ELSE (SELECT MAX(year * 100 + month) FROM {flags}) END)\n"
        "    AND UPPER(TRIM(flag)) = 'YES'\n"
        f"{flag_days}"
        "),\n"
        # Quarter hours: one read, only the month's dates (plus the day before for the 5 AM roll-forward).
        "_mde AS (\n"
        "  SELECT originator_name,\n"
        "         UPPER(TRIM(originator_name)) AS net_key,\n"
        "         program_name,\n"
        "         UPPER(TRIM(program_name))    AS prog_key,\n"
        "         CASE demographic WHEN 'P25-54' THEN 'A25-54' ELSE demographic END AS demo,\n"
        "         total_impressions AS impressions,\n"
        "         CAST(qtr_hhr_program_duration AS DOUBLE) AS duration,\n"
        "         telecast_id,\n"
        "         broadcast_date,\n"
        "         qtr_hhr_start_time,\n"
        "         ((DAYOFWEEK(broadcast_date) + 5) % 7) + 1 AS dow,\n"
        "         CASE WHEN qtr_hhr_start_time >= '05:00:00' AND qtr_hhr_start_time < '06:00:00'\n"
        "              THEN DATE_ADD(broadcast_date, 1) ELSE broadcast_date END AS effective_date\n"
        f"  FROM {mde}\n"
        "  WHERE broadcast_date BETWEEN DATE_ADD((SELECT MIN(BROADCAST_DATE) FROM _period_dates), -1)\n"
        "                           AND (SELECT MAX(BROADCAST_DATE) FROM _period_dates)\n"
        "    AND originator_name IN ('MS NOW', 'MSNBC', 'CNN', 'FOX NEWS CHANNEL')\n"
        "    AND demographic IN ('P2+', 'P25-54')\n"
        "    AND feed_type = 'Big Data' AND stream = 'LS' AND market_break = 'Composite'\n"
        f"{mde_days}"
        "),\n"
        "_clubbed_label AS (\n"
        "  SELECT fl.flag_network, fl.flag_daypart, fl.start_raw, fl.end_raw, fl.dow_array,\n"
        "         CONCAT_WS('/', SORT_ARRAY(COLLECT_SET(fl.flag_program))) AS clubbed_program_label\n"
        "  FROM _flags fl\n"
        "  JOIN (SELECT flag_network, flag_daypart, start_raw, end_raw\n"
        "        FROM _flags\n"
        "        GROUP BY flag_network, flag_daypart, start_raw, end_raw, dow_array\n"
        "        HAVING COUNT(DISTINCT flag_program) > 1) cg\n"
        "    ON fl.flag_network = cg.flag_network AND fl.flag_daypart = cg.flag_daypart\n"
        "   AND fl.start_raw = cg.start_raw AND fl.end_raw = cg.end_raw\n"
        "  GROUP BY fl.flag_network, fl.flag_daypart, fl.start_raw, fl.end_raw, fl.dow_array\n"
        "),\n"
        # Slot rules: prog_key NULL means "any program of that network in the slot".
        "_rules AS (\n"
        "  SELECT 'main' AS rule_kind, fl.flag_network AS net_key, fl.flag_program AS prog_key,\n"
        "         fl.flag_daypart AS daypart, fl.dow_array, fl.win_start, fl.win_end, fl.start_raw, fl.end_raw,\n"
        "         CAST(NULL AS STRING) AS out_network, CAST(NULL AS STRING) AS out_program\n"
        "  FROM _flags fl\n"
        f"{main_skip}"
        "  UNION ALL\n"
        "  SELECT 'clubbed', cl.flag_network, CAST(NULL AS STRING), cl.flag_daypart, cl.dow_array,\n"
        "         CONCAT(cl.start_raw, ':00'),\n"
        "         CASE WHEN cl.end_raw = '00:00' THEN '24:00:00' ELSE CONCAT(cl.end_raw, ':00') END,\n"
        "         cl.start_raw, cl.end_raw, cl.flag_network, cl.clubbed_program_label\n"
        "  FROM _clubbed_label cl\n"
        f"{various_rules}"
        "),\n"
        "combined AS (\n"
        "  SELECT /*+ BROADCAST(r) */\n"
        "    CASE WHEN r.rule_kind = 'main' THEN m.originator_name ELSE r.out_network END AS Network,\n"
        "    r.daypart AS Daypart,\n"
        "    CASE WHEN r.rule_kind = 'main' THEN UPPER(m.program_name) ELSE r.out_program END AS Program,\n"
        "    r.start_raw, r.end_raw,\n"
        "    m.demo,\n"
        "    COUNT(DISTINCT CONCAT(CAST(m.telecast_id AS STRING), '|', CAST(m.broadcast_date AS STRING))) AS TCs,\n"
        "    CAST(SUM(m.duration) AS DOUBLE) AS Dur,\n"
        "    ROUND(SUM(m.impressions * m.duration) / NULLIF(SUM(m.duration), 0) / 1000, 0) AS Impressions,\n"
        "    r.dow_array\n"
        "  FROM _mde m\n"
        "  JOIN _period_dates pd ON m.effective_date = pd.BROADCAST_DATE\n"
        "  JOIN _rules r\n"
        "    ON m.net_key = r.net_key\n"
        "   AND (r.prog_key IS NULL OR m.prog_key = r.prog_key)\n"
        "   AND ARRAY_CONTAINS(r.dow_array, m.dow)\n"
        "   AND m.qtr_hhr_start_time >= r.win_start\n"
        "   AND m.qtr_hhr_start_time <  r.win_end\n"
        "  GROUP BY r.rule_kind,\n"
        "           CASE WHEN r.rule_kind = 'main' THEN m.originator_name ELSE r.out_network END,\n"
        "           r.daypart,\n"
        "           CASE WHEN r.rule_kind = 'main' THEN m.program_name ELSE r.out_program END,\n"
        "           r.start_raw, r.end_raw, r.dow_array, m.demo,\n"
        "           CASE WHEN r.rule_kind = 'main' THEN UPPER(m.program_name) ELSE r.out_program END\n"
        ")\n"
        "SELECT\n"
        "  CONCAT(INITCAP(SUBSTRING(UPPER(TRIM(:month_name)), 1, 3)), '-', SUBSTRING(CAST(:cal_year AS STRING), 3, 2)) AS Month,\n"
        "  Network,\n"
        "  Daypart,\n"
        "  Program,\n"
        "  DATE_FORMAT(TO_TIMESTAMP(CONCAT('2000-01-01 ', start_raw, ':00'), 'yyyy-MM-dd HH:mm:ss'), 'h:mm a') AS Start,\n"
        "  DATE_FORMAT(CASE WHEN end_raw = '00:00' THEN TO_TIMESTAMP('2000-01-02 00:00:00')\n"
        "                   ELSE TO_TIMESTAMP(CONCAT('2000-01-01 ', end_raw, ':00'), 'yyyy-MM-dd HH:mm:ss') END, 'h:mm a') AS End,\n"
        "  demo AS Demo,\n"
        "  TCs,\n"
        "  Dur,\n"
        "  Impressions,\n"
        "  INITCAP(LOWER(Program)) AS MSNBC_Show,\n"
        "  'mde_qtr_hist_refresh' AS Source,\n"
        "  CURRENT_TIMESTAMP() AS created_ts,\n"
        "  CURRENT_TIMESTAMP() AS updated_ts,\n"
        f"{_day_columns(kind)}"
        "FROM combined"
    )
