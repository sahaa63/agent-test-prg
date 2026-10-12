-- Program history: WEEKDAY rows for one broadcast month.
-- Source: prg_hist_updated_logic notebook, cell 'weekday'. Logic unchanged.
-- Inputs: :month_name (e.g. 'SEPTEMBER'), :cal_year (e.g. 2026),
--         :start_date / :end_date (optional 'YYYY-MM-DD' inside the month; NULL = full month).
-- {calendar_table}, {flags_table} and {mde_table} are filled in from the app settings.

WITH

_cal AS (
  SELECT MIN(BROADCAST_DATE)               AS period_start,
         MAX(BROADCAST_DATE)               AS period_end,
         CAST(MIN(NHI_SEASON_YEAR) AS INT) AS nhi_sy
  FROM {calendar_table}
  WHERE UPPER(TRIM(NHI_MONTH_NAME)) = UPPER(TRIM(:month_name))
    AND CAST(CALENDAR_YEAR AS INT)  = :cal_year
),

_period_dates AS (
  SELECT BROADCAST_DATE
  FROM {calendar_table}
  WHERE BROADCAST_DATE BETWEEN (SELECT period_start FROM _cal)
                           AND (SELECT period_end   FROM _cal)
    AND CAST(NHI_SEASON_YEAR AS INT) = (SELECT nhi_sy FROM _cal)
    -- Optional custom range inside the month. NULL means the full broadcast month.
    AND BROADCAST_DATE >= COALESCE(CAST(:start_date AS DATE), (SELECT period_start FROM _cal))
    AND BROADCAST_DATE <= COALESCE(CAST(:end_date   AS DATE), (SELECT period_end   FROM _cal))
),

_flags AS (
  SELECT UPPER(TRIM(network))                                      AS flag_network,
         UPPER(TRIM(program))                                      AS flag_program,
         TRIM(daypart)                                             AS flag_daypart,
         dow_array,
         CONCAT(start_time, ':00')                                 AS win_start,
         CASE WHEN end_time = '00:00' THEN '24:00:00'
              ELSE CONCAT(end_time, ':00') END                     AS win_end,
         start_time                                                AS start_raw,
         end_time                                                  AS end_raw
  FROM {flags_table}
  WHERE year * 100 + month = (
          SELECT CASE WHEN (:cal_year * 100 +
                             CASE UPPER(TRIM(:month_name))
                               WHEN 'JANUARY'   THEN 1  WHEN 'FEBRUARY' THEN 2  WHEN 'MARCH'     THEN 3
                               WHEN 'APRIL'     THEN 4  WHEN 'MAY'      THEN 5  WHEN 'JUNE'      THEN 6
                               WHEN 'JULY'      THEN 7  WHEN 'AUGUST'   THEN 8  WHEN 'SEPTEMBER' THEN 9
                               WHEN 'OCTOBER'   THEN 10 WHEN 'NOVEMBER' THEN 11 WHEN 'DECEMBER'  THEN 12
                             END)
                           IN (SELECT DISTINCT year * 100 + month
                               FROM {flags_table})
                      THEN (:cal_year * 100 +
                             CASE UPPER(TRIM(:month_name))
                               WHEN 'JANUARY'   THEN 1  WHEN 'FEBRUARY' THEN 2  WHEN 'MARCH'     THEN 3
                               WHEN 'APRIL'     THEN 4  WHEN 'MAY'      THEN 5  WHEN 'JUNE'      THEN 6
                               WHEN 'JULY'      THEN 7  WHEN 'AUGUST'   THEN 8  WHEN 'SEPTEMBER' THEN 9
                               WHEN 'OCTOBER'   THEN 10 WHEN 'NOVEMBER' THEN 11 WHEN 'DECEMBER'  THEN 12
                             END)
                      ELSE (SELECT MAX(year * 100 + month)
                            FROM {flags_table})
                 END)
    AND UPPER(TRIM(flag)) = 'YES'
    -- Weekday + cross-DOW entries only (weekend-only handled by weekend query)
    AND (ARRAY_CONTAINS(dow_array, 1) OR ARRAY_CONTAINS(dow_array, 2)
         OR ARRAY_CONTAINS(dow_array, 3) OR ARRAY_CONTAINS(dow_array, 4)
         OR ARRAY_CONTAINS(dow_array, 5))
),

_mde AS (
  SELECT program_name,
         originator_name,
         CASE demographic WHEN 'P25-54' THEN 'A25-54' ELSE demographic END AS demo,
         total_impressions                                          AS impressions,
         CAST(qtr_hhr_program_duration AS DOUBLE)                  AS duration,
         telecast_id,
         broadcast_date,
         qtr_hhr_start_time,
         ((DAYOFWEEK(broadcast_date) + 5) % 7) + 1                AS dow,
         CASE WHEN qtr_hhr_start_time >= '05:00:00' AND qtr_hhr_start_time < '06:00:00'
              THEN DATE_ADD(broadcast_date, 1)
              ELSE broadcast_date
         END AS effective_date
  FROM {mde_table}
  WHERE originator_name IN ('MS NOW', 'MSNBC', 'CNN', 'FOX NEWS CHANNEL')
    AND demographic     IN ('P2+', 'P25-54')
    AND feed_type        = 'Big Data'
    AND stream           = 'LS'
    AND market_break     = 'Composite'
    AND (is_repeat = FALSE OR ((DAYOFWEEK(broadcast_date) + 5) % 7) + 1 IN (6, 7))
),

main_branch AS (
  -- Original logic, completely unchanged, just restructured into a named
  -- CTE so it can UNION ALL with clubbed_branch below.
  SELECT
    CASE m.originator_name WHEN 'MS NOW' THEN 'MSNOW' ELSE m.originator_name END AS Network,
    fl.flag_daypart                                                              AS Daypart,
    UPPER(m.program_name)                                                        AS Program,
    fl.start_raw, fl.end_raw,
    m.demo,
    COUNT(DISTINCT CONCAT(CAST(m.telecast_id AS STRING), '|', CAST(m.broadcast_date AS STRING))) AS TCs,
    CAST(SUM(m.duration) AS DOUBLE)                                              AS Dur,
    ROUND(SUM(m.impressions * m.duration) / NULLIF(SUM(m.duration), 0) / 1000, 0) AS Impressions,
    fl.dow_array
  FROM _mde m
  JOIN _period_dates pd ON m.effective_date = pd.BROADCAST_DATE
  JOIN _flags fl
    ON UPPER(TRIM(m.originator_name)) = fl.flag_network
   AND UPPER(TRIM(m.program_name))   = fl.flag_program
   AND ARRAY_CONTAINS(fl.dow_array, m.dow)
   AND m.qtr_hhr_start_time >= fl.win_start
   AND m.qtr_hhr_start_time <  fl.win_end
  GROUP BY m.originator_name, fl.flag_daypart, fl.start_raw, fl.end_raw, fl.dow_array, m.program_name, m.demo
),

_clubbed_groups AS (
  SELECT flag_network, flag_daypart, start_raw, end_raw, dow_array
  FROM _flags
  GROUP BY flag_network, flag_daypart, start_raw, end_raw, dow_array
  HAVING COUNT(DISTINCT flag_program) > 1
),

_clubbed_label AS (
  SELECT
    fl.flag_network, fl.flag_daypart, fl.start_raw, fl.end_raw, fl.dow_array,
    CONCAT_WS('/', SORT_ARRAY(COLLECT_SET(fl.flag_program))) AS clubbed_program_label
  FROM _flags fl
  JOIN _clubbed_groups cg
    ON fl.flag_network = cg.flag_network
   AND fl.flag_daypart = cg.flag_daypart
   AND fl.start_raw    = cg.start_raw
   AND fl.end_raw       = cg.end_raw
  GROUP BY fl.flag_network, fl.flag_daypart, fl.start_raw, fl.end_raw, fl.dow_array
),

clubbed_branch AS (
  SELECT
    CASE cl.flag_network WHEN 'MS NOW' THEN 'MSNOW' ELSE cl.flag_network END AS Network,
    cl.flag_daypart              AS Daypart,
    cl.clubbed_program_label      AS Program,
    cl.start_raw, cl.end_raw,
    m.demo,
    COUNT(DISTINCT CONCAT(CAST(m.telecast_id AS STRING), '|', CAST(m.broadcast_date AS STRING))) AS TCs,
    CAST(SUM(m.duration) AS DOUBLE)                                              AS Dur,
    ROUND(SUM(m.impressions * m.duration) / NULLIF(SUM(m.duration), 0) / 1000, 0) AS Impressions,
    cl.dow_array
  FROM _mde m
  JOIN _period_dates pd ON m.effective_date = pd.BROADCAST_DATE
  JOIN _clubbed_label cl
    ON UPPER(TRIM(m.originator_name)) = cl.flag_network
   AND ARRAY_CONTAINS(cl.dow_array, m.dow)
   AND m.qtr_hhr_start_time >= CONCAT(cl.start_raw, ':00')
   AND m.qtr_hhr_start_time <  CASE WHEN cl.end_raw = '00:00' THEN '24:00:00' ELSE CONCAT(cl.end_raw, ':00') END
  GROUP BY cl.flag_network, cl.flag_daypart, cl.clubbed_program_label, cl.start_raw, cl.end_raw, cl.dow_array, m.demo
),

combined AS (
  SELECT * FROM main_branch
  UNION ALL
  SELECT * FROM clubbed_branch
)

SELECT
  CONCAT(INITCAP(SUBSTRING(UPPER(TRIM(:month_name)), 1, 3)), '-',
         SUBSTRING(CAST(:cal_year AS STRING), 3, 2))                                    AS Month,
  Network,
  Daypart,
  Program,
  DATE_FORMAT(TO_TIMESTAMP(CONCAT('2000-01-01 ', start_raw, ':00'), 'yyyy-MM-dd HH:mm:ss'), 'h:mm a') AS Start,
  DATE_FORMAT(CASE WHEN end_raw = '00:00' THEN TO_TIMESTAMP('2000-01-02 00:00:00')
                   ELSE TO_TIMESTAMP(CONCAT('2000-01-01 ', end_raw, ':00'), 'yyyy-MM-dd HH:mm:ss') END, 'h:mm a') AS End,
  demo                                                                                        AS Demo,
  TCs,
  Dur,
  Impressions,
  INITCAP(LOWER(Program))                                                                     AS MSNBC_Show,
  'mde_qtr_hist_refresh'                                                                       AS Source,
  CURRENT_TIMESTAMP()                                                                          AS created_ts,
  CURRENT_TIMESTAMP()                                                                          AS updated_ts,
  CASE WHEN ARRAY_CONTAINS(dow_array, 7) AND ARRAY_CONTAINS(dow_array, 1) THEN 'Sunday'
       ELSE CASE ARRAY_MIN(dow_array)
              WHEN 1 THEN 'Monday' WHEN 2 THEN 'Tuesday' WHEN 3 THEN 'Wednesday'
              WHEN 4 THEN 'Thursday' WHEN 5 THEN 'Friday'
              WHEN 6 THEN 'Saturday' WHEN 7 THEN 'Sunday'
            ELSE 'Monday'
            END
  END                                                                                         AS start_day,
  CASE WHEN ARRAY_CONTAINS(dow_array, 7) AND ARRAY_CONTAINS(dow_array, 1) THEN
         CASE GREATEST(
           IF(ARRAY_CONTAINS(dow_array, 5), 5, 0),
           IF(ARRAY_CONTAINS(dow_array, 4), 4, 0),
           IF(ARRAY_CONTAINS(dow_array, 3), 3, 0),
           IF(ARRAY_CONTAINS(dow_array, 2), 2, 0),
           IF(ARRAY_CONTAINS(dow_array, 1), 1, 0)
         )
           WHEN 5 THEN 'Friday'  WHEN 4 THEN 'Thursday' WHEN 3 THEN 'Wednesday'
           WHEN 2 THEN 'Tuesday' WHEN 1 THEN 'Monday'   ELSE 'Monday'
         END
       ELSE CASE ARRAY_MAX(dow_array)
              WHEN 1 THEN 'Monday' WHEN 2 THEN 'Tuesday' WHEN 3 THEN 'Wednesday'
              WHEN 4 THEN 'Thursday' WHEN 5 THEN 'Friday'
              WHEN 6 THEN 'Saturday' WHEN 7 THEN 'Sunday'
              ELSE 'Friday'
            END
  END                                                                                         AS end_day
FROM combined
