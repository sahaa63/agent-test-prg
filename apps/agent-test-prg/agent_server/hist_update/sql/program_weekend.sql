-- Program history: WEEKEND rows for one broadcast month.
-- Source: prg_hist_updated_logic notebook, cell 'weekend_with_clubbing_logic'. Logic unchanged.
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
    -- purely-weekend entries only: must contain Sat(6) or Sun(7)
    AND (ARRAY_CONTAINS(dow_array, 6) OR ARRAY_CONTAINS(dow_array, 7))
    -- exclude cross-DOW entries that also have weekday days (e.g. WAY TOO EARLY Su-Thu)
    AND NOT (  ARRAY_CONTAINS(dow_array, 1)
            OR ARRAY_CONTAINS(dow_array, 2)
            OR ARRAY_CONTAINS(dow_array, 3)
            OR ARRAY_CONTAINS(dow_array, 4)
            OR ARRAY_CONTAINS(dow_array, 5) )
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
    AND ((DAYOFWEEK(broadcast_date) + 5) % 7) + 1 IN (6, 7)
    AND demographic     IN ('P2+', 'P25-54')
    AND feed_type        = 'Big Data'
    AND stream           = 'LS'
    AND market_break     = 'Composite'
    -- is_repeat NOT filtered for weekend (all telecasts included)
),

-- The four dayparts where CNN's historical entry is a combined "VARIOUS" row.
_cnn_various_dayparts (daypart_label) AS (
  VALUES ('Sa-Su 10A-1P Span'), ('Sa-Su 1P-4P Span'), ('Sa-Su 7A-10A Span'), ('Sa-Su 6P-9P Span')
),

_cnn_various_windows AS (
  SELECT DISTINCT
    fl.flag_daypart AS daypart_label,
    fl.dow_array, fl.win_start, fl.win_end, fl.start_raw, fl.end_raw
  FROM _flags fl
  JOIN _cnn_various_dayparts cvd ON fl.flag_daypart = cvd.daypart_label
),

-- NEW: the two dayparts where FOXNC's historical entry is a combined
-- "FOX NEWS VARIOUS" row, same pattern as CNN's various dayparts above.
_foxnc_various_dayparts (daypart_label) AS (
  VALUES ('Sa-Su 10A-1P Span'), ('Sa-Su 1P-4P Span')
),

_foxnc_various_windows AS (
  SELECT DISTINCT
    fl.flag_daypart AS daypart_label,
    fl.dow_array, fl.win_start, fl.win_end, fl.start_raw, fl.end_raw
  FROM _flags fl
  JOIN _foxnc_various_dayparts fvd ON fl.flag_daypart = fvd.daypart_label
),

main_branch AS (
  SELECT
    m.originator_name                                                            AS Network,
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
  WHERE NOT (
    fl.flag_network = 'CNN'
    AND fl.flag_daypart IN (SELECT daypart_label FROM _cnn_various_dayparts)
  )
  AND NOT (
    fl.flag_network = 'FOXNC'
    AND fl.flag_daypart IN (SELECT daypart_label FROM _foxnc_various_dayparts)
  )
  GROUP BY m.originator_name, fl.flag_daypart, fl.start_raw, fl.end_raw, fl.dow_array, m.program_name, m.demo
),

cnn_various_branch AS (
  SELECT
    'CNN'              AS Network,
    w.daypart_label     AS Daypart,
    'CNN VARIOUS'        AS Program,
    w.start_raw, w.end_raw,
    m.demo,
    COUNT(DISTINCT CONCAT(CAST(m.telecast_id AS STRING), '|', CAST(m.broadcast_date AS STRING))) AS TCs,
    CAST(SUM(m.duration) AS DOUBLE)                                              AS Dur,
    ROUND(SUM(m.impressions * m.duration) / NULLIF(SUM(m.duration), 0) / 1000, 0) AS Impressions,
    w.dow_array
  FROM _mde m
  JOIN _period_dates pd ON m.effective_date = pd.BROADCAST_DATE
  JOIN _cnn_various_windows w
    ON m.originator_name = 'CNN'
   AND ARRAY_CONTAINS(w.dow_array, m.dow)
   AND m.qtr_hhr_start_time >= w.win_start
   AND m.qtr_hhr_start_time <  w.win_end
  GROUP BY w.daypart_label, m.demo, w.start_raw, w.end_raw, w.dow_array
),

-- NEW: same pattern as cnn_various_branch. Note originator_name in the raw
-- mde_program_qtr_hour table is 'FOX NEWS CHANNEL', not 'FOXNC' - so the
-- filter below uses the raw source value, while the output Network column
-- is still hardcoded to 'FOXNC' to match the rest of the query's display
-- convention.
foxnc_various_branch AS (
  SELECT
    'FOXNC'                AS Network,
    w.daypart_label          AS Daypart,
    'FOX NEWS VARIOUS'        AS Program,
    w.start_raw, w.end_raw,
    m.demo,
    COUNT(DISTINCT CONCAT(CAST(m.telecast_id AS STRING), '|', CAST(m.broadcast_date AS STRING))) AS TCs,
    CAST(SUM(m.duration) AS DOUBLE)                                              AS Dur,
    ROUND(SUM(m.impressions * m.duration) / NULLIF(SUM(m.duration), 0) / 1000, 0) AS Impressions,
    w.dow_array
  FROM _mde m
  JOIN _period_dates pd ON m.effective_date = pd.BROADCAST_DATE
  JOIN _foxnc_various_windows w
    ON m.originator_name = 'FOX NEWS CHANNEL'
   AND ARRAY_CONTAINS(w.dow_array, m.dow)
   AND m.qtr_hhr_start_time >= w.win_start
   AND m.qtr_hhr_start_time <  w.win_end
  GROUP BY w.daypart_label, m.demo, w.start_raw, w.end_raw, w.dow_array
),

-- Any (network, daypart, start, end) combo with 2+ distinct flagged shows -
-- detected dynamically, not hardcoded to any specific pair.
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
    cl.flag_network              AS Network,
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
  SELECT * FROM cnn_various_branch
  UNION ALL
  SELECT * FROM foxnc_various_branch
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
  CASE WHEN ARRAY_CONTAINS(dow_array, 6) THEN 'Saturday' ELSE 'Sunday' END                   AS start_day,
  CASE WHEN ARRAY_CONTAINS(dow_array, 7) THEN 'Sunday'   ELSE 'Saturday' END                 AS end_day
FROM combined
