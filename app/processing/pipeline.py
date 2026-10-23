"""
VectorCore Data Ingestion and Alignment Engine
Optimized projection pruning: Loads ONLY required analytical columns from SQLite.
"""

from typing import Dict, Any
import pandas as pd
import numpy as np
import sqlite3

# Strict dimensions needed for filtering & UI slicing
CATEGORICAL_DIMS = [
    "Time Series Month",
    "Time Series Week",
    "Time Series Day",
    "Product Sub Pod",
    "Final Assignee Site",
    "gCare Customer Segment (Final)",
    "Sales Service Region",
    "Sales Service Market",
    "Final Assignee Username Masked",
    "Frd Inbound Communication Channel Display String",
    "Last Outgoing Or Synchronous Communication Channel",
    "Principal Negative Sentiment Driver Category",
    "Principal Negative Sentiment Driver",
    "FRD Component",
    "FRD Component Detail"
]

NUMERIC_METRIC_TARGETS = [
    "Case Sentiment Score (% Positive)",
    "Sentiment DR",
    "Cases Closed",
    "Cases Opened",
    "Escalations Opened",
    "Cases Reopened (%)",
    "Cases Reopened (%) (Denominator)",
    "Internal Resolution Time within 24h (IRT) (%)",
    "Internal Resolution Time within 24h (IRT) (%) (Denominator)",
    "Average Time in Assigned (hours)",
    "Average Time in Assigned (hours) Dr",
    "Average Case Handle Time (CHT) (minutes)",
    "Average Time to First Response (TFR) (hours) (Email)",
    "Average Time to First Response (TFR) (hours) (Email) Dr"
]

class VectorCorePipeline:
    def __init__(self, db_path: str = "data/vector_core.db"):
        self.db_path = db_path

    def run(self) -> Dict[str, Any]:
        """Loads pruned columns from SQLite, executes fast outer joins, and yields the aggregated cube."""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table';")
        tables = [row[0] for row in cursor.fetchall()]
        
        if "sentiment_raw" not in tables:
            conn.close()
            return {"metadata": {"status": "empty"}, "cube": []}

        # 1. Inspect existing columns in SQLite to build a safe, pruned query
        cursor.execute("PRAGMA table_info(sentiment_raw);")
        sent_available = [row[1] for row in cursor.fetchall()]
        
        desired_sent = set(CATEGORICAL_DIMS + NUMERIC_METRIC_TARGETS + ["Support Cases Case Id", "Sentiment Bucket"])
        sent_cols_to_query = [f'"{c}"' for c in sent_available if c in desired_sent]
        
        if not sent_cols_to_query:
            conn.close()
            return {"metadata": {"status": "empty"}, "cube": []}

        query_sent = f"SELECT {', '.join(sent_cols_to_query)} FROM sentiment_raw"
        sent = pd.read_sql_query(query_sent, conn)

        # 2. Prune IRT table
        if "irt_raw" in tables:
            cursor.execute("PRAGMA table_info(irt_raw);")
            irt_available = [row[1] for row in cursor.fetchall()]
            desired_irt = {
                "Support Cases Case Id",
                "Internal Resolution Time within 24h (IRT) (%)",
                "Internal Resolution Time within 24h (IRT) (%) (Denominator)",
                "Cases Reopened (%)",
                "Cases Reopened (%) (Denominator)"
            }
            irt_cols = [f'"{c}"' for c in irt_available if c in desired_irt]
            irt = pd.read_sql_query(f"SELECT {', '.join(irt_cols)} FROM irt_raw", conn) if irt_cols else pd.DataFrame()
        else:
            irt = pd.DataFrame()

        # 3. Prune Escalations table
        if "esc_raw" in tables:
            cursor.execute("PRAGMA table_info(esc_raw);")
            esc_available = [row[1] for row in cursor.fetchall()]
            desired_esc = {"Support Cases Case Id", "Escalations Opened"}
            esc_cols = [f'"{c}"' for c in esc_available if c in desired_esc]
            esc = pd.read_sql_query(f"SELECT {', '.join(esc_cols)} FROM esc_raw", conn) if esc_cols else pd.DataFrame()
        else:
            esc = pd.DataFrame()

        conn.close()

        # Step 1: Align Sentiment and IRT on Support Cases Case Id
        if not irt.empty and "Support Cases Case Id" in irt.columns:
            merged = pd.merge(
                sent,
                irt,
                on="Support Cases Case Id",
                how="left",
                suffixes=("", "_irt")
            )
        else:
            merged = sent

        # Step 2: Incorporate Escalations safely
        if not esc.empty and "Support Cases Case Id" in esc.columns and "Escalations Opened" in esc.columns:
            esc["Escalations Opened"] = pd.to_numeric(esc["Escalations Opened"], errors="coerce").fillna(0)
            esc_grouped = esc.groupby("Support Cases Case Id", as_index=False)["Escalations Opened"].sum()
            merged = pd.merge(merged, esc_grouped, on="Support Cases Case Id", how="left")
            merged["Escalations Opened"] = merged["Escalations Opened"].fillna(0)
        else:
            merged["Escalations Opened"] = 0.0

        # Step 3: Fill numeric metrics
        for col in NUMERIC_METRIC_TARGETS:
            if col not in merged.columns:
                merged[col] = 0.0
            else:
                merged[col] = pd.to_numeric(merged[col], errors="coerce").fillna(0.0)

        # Step 4: Identify grouping columns
        group_cols = [col for col in CATEGORICAL_DIMS if col in merged.columns]
        if not group_cols:
            merged["_all"] = "All"
            group_cols = ["_all"]

        # Step 5: Fast In-Memory Aggregation Cube
        cube = merged.groupby(group_cols, observed=True)[NUMERIC_METRIC_TARGETS].sum().reset_index()

        # Step 6: Vectorized Ratios
        cube["sentiment_pct"] = np.where(cube["Sentiment DR"] > 0, cube["Case Sentiment Score (% Positive)"] / cube["Sentiment DR"], np.nan)
        cube["irt_pct"] = np.where(cube["Internal Resolution Time within 24h (IRT) (%) (Denominator)"] > 0, cube["Internal Resolution Time within 24h (IRT) (%)"] / cube["Internal Resolution Time within 24h (IRT) (%) (Denominator)"], np.nan)
        cube["reopen_rate"] = np.where(cube["Cases Reopened (%) (Denominator)"] > 0, cube["Cases Reopened (%)"] / cube["Cases Reopened (%) (Denominator)"], np.nan)
        cube["esc_rate"] = np.where(cube["Cases Closed"] > 0, cube["Escalations Opened"] / cube["Cases Closed"], np.nan)
        cube["avg_time_assigned"] = np.where(cube["Average Time in Assigned (hours) Dr"] > 0, cube["Average Time in Assigned (hours)"] / cube["Average Time in Assigned (hours) Dr"], np.nan)

        return {
            "metadata": {
                "total_rows_processed": len(merged),
                "aggregated_cube_records": len(cube),
                "dimensions": {dim: merged[dim].dropna().unique().tolist() for dim in group_cols if dim != "_all"}
            },
            "cube": cube.replace({np.nan: None}).to_dict(orient="records")
        }
