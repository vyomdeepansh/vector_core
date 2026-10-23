"""
VectorCore Database Scaffolding Suite
Coordinates database table setups and automated SQL view compilations.
"""

import os
import sqlite3

from app.processing.load_data import run_ingestion

SQL_VIEW_STATEMENT = """
CREATE VIEW IF NOT EXISTS dashboard_metrics_view AS
SELECT
    s."Support Cases Case Id" AS case_id,
    COALESCE(s."Time Series Month", 'Unknown') AS month,
    COALESCE(s."Time Series Week", '') AS week,
    COALESCE(s."Time Series Day", '') AS day,
    COALESCE(s."Product Sub Pod", 'General') AS pod,
    COALESCE(s."Final Assignee Site", 'Unknown') AS site,
    COALESCE(s."gCare Customer Segment (Final)", 'Standard') AS segment,
    COALESCE(s."Sales Service Region", 'Unknown') AS region,
    COALESCE(s."Sales Service Market", 'Unknown') AS market,
    COALESCE(s."Final Assignee Username Masked", 'Unknown') AS ldap,
    COALESCE(s."Frd Inbound Communication Channel Display String", 'Unknown') AS inbound_channel,
    COALESCE(i."Last Outgoing Or Synchronous Communication Channel", 'Unknown') AS outbound_channel,

    CAST(SUM(COALESCE(s."Cases Closed", 1.0)) AS INTEGER) AS cases_closed,

    ROUND(100.0 * SUM(COALESCE(s."Case Sentiment Score (% Positive)", 0.0)) / 
          NULLIF(SUM(COALESCE(s."Sentiment DR", 0.0)), 0), 2) AS sentiment_pct,

    ROUND(100.0 * SUM(COALESCE(e."Escalations Opened", 0.0)) / 
          NULLIF(SUM(COALESCE(s."Cases Closed", 1.0)), 0), 2) AS esc_rate_pct,

    ROUND(100.0 * SUM(COALESCE(i."Cases Reopened (%)", 0.0)) / 
          NULLIF(SUM(COALESCE(i."Cases Reopened (%) (Denominator)", 0.0)), 0), 2) AS reopen_rate_pct,

    ROUND(100.0 * SUM(COALESCE(i."Internal Resolution Time within 24h (IRT) (%)", 0.0)) / 
          NULLIF(SUM(COALESCE(i."Internal Resolution Time within 24h (IRT) (%) (Denominator)", 0.0)), 0), 2) AS irt_24h_pct,

    NULL AS po_efc_pct,

    ROUND(SUM(COALESCE(s."Average Time to First Response (TFR) (hours) (Email)", 0.0)) / 
          NULLIF(SUM(COALESCE(s."Average Time to First Response (TFR) (hours) (Email) Dr", 0.0)), 0), 2) AS avg_tfr_hours,

    ROUND(AVG(COALESCE(s."Consult Average Interactions per Closed Case", 0.0)), 2) AS avg_consult_interactions,

    ROUND(SUM(COALESCE(s."Average Time in Assigned (hours)", 0.0)) / 
          NULLIF(SUM(COALESCE(s."Average Time in Assigned (hours) Dr", 0.0)), 0), 2) AS avg_time_assigned_hours,

    ROUND(SUM(COALESCE(s."Average Time in Blocked By (hours)", 0.0)) / 
          NULLIF(SUM(COALESCE(s."Average Time in Blocked By (hours) Dr", 0.0)), 0), 2) AS avg_time_blocked_hours,

    ROUND(SUM(COALESCE(s."Average Time in Need Info (hours)", 0.0)) / 
          NULLIF(SUM(COALESCE(s."Average Time in Need Info (hours) Dr", 0.0)), 0), 2) AS avg_time_need_info_hours,

    ROUND(SUM(COALESCE(s."Average Time in Unassigned (hours)", 0.0)) / 
          NULLIF(SUM(COALESCE(s."Average Time in Unassigned (hours) Dr", 0.0)), 0), 2) AS avg_time_unassigned_hours,

    ROUND(SUM(COALESCE(s."Average Time to First Solution Offered (TFS) (hours)", 0.0)) / 
          NULLIF(SUM(COALESCE(s."Average Time to First Solution Offered (TFS) (hours) Dr", 0.0)), 0), 2) AS avg_tfs_hours,

    ROUND(SUM(COALESCE(s."Average Time in New (hours)", 0.0)) / 
          NULLIF(SUM(COALESCE(s."Average Time in New (hours) Dr", 0.0)), 0), 2) AS avg_time_new_hours,

    ROUND(SUM(COALESCE(s."Average Agent Time (hours)", 0.0)) / 
          NULLIF(SUM(COALESCE(s."Average Agent Time (hours) Dr", 0.0)), 0), 2) AS avg_agent_time_hours,

    ROUND(SUM(COALESCE(s."Average Interactions per Closed Case", 0.0)) / 
          NULLIF(SUM(COALESCE(s."Average Interactions per Closed Case Dr", 0.0)), 0), 2) AS avg_interactions_per_case

FROM sentiment_raw s
LEFT JOIN irt_raw i ON s."Support Cases Case Id" = i."Support Cases Case Id"
LEFT JOIN esc_raw e ON s."Support Cases Case Id" = e."Support Cases Case Id"
GROUP BY s."Support Cases Case Id";
"""


def initialize_database():
    db_path = "data/vector_core.db"

    # 1. Run local parquet ingestion to SQLite
    run_ingestion("data", "replace")

    # 2. Build the database View definition
    if os.path.exists(db_path):
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        cursor.execute("DROP VIEW IF EXISTS dashboard_metrics_view;")
        cursor.execute(SQL_VIEW_STATEMENT)
        conn.commit()
        conn.close()
        print("✓ SQL View 'dashboard_metrics_view' successfully built inside SQLite.")


if __name__ == "__main__":
    initialize_database()
