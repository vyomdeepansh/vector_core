"""
VectorCore Server-Side Analytics Engine
Resilient column detection: dynamically adapts to available schema fields.
"""

import sqlite3
import numpy as np
import pandas as pd
from typing import Dict, Any, List

def compute_dashboard_model(db_path: str = "data/vector_core.db") -> Dict[str, Any]:
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table';")
    tables = [r[0] for r in cursor.fetchall()]
    
    if "sentiment_raw" not in tables:
        conn.close()
        return {"error": "No sentiment_raw table found"}

    # 1. Inspect existing columns in sentiment_raw
    cursor.execute("PRAGMA table_info(sentiment_raw);")
    sent_cols_existing = {row for row in cursor.fetchall()}

    # Desired columns to pull if they exist
    potential_sent_cols = [
        "Support Cases Case Id", "Time Series Month", "Time Series Week",
        "Product Sub Pod", "Sales Service Region", "Sales Service Market",
        "Final Assignee Username Masked",
        "Case Sentiment Score (% Positive)", "Sentiment DR", "Cases Closed",
        "Average Time in Assigned (hours)", "Average Time in Assigned (hours) Dr",
        "Average Case Handle Time (CHT) (minutes)",
        "Average Handle Time (AHT) (minutes)",
        "Sentiment Explanation"
    ]
    selected_sent_cols = [f'"{c}"' for c in potential_sent_cols if c in sent_cols_existing]

    if "Support Cases Case Id" not in sent_cols_existing:
        conn.close()
        return {"error": "Support Cases Case Id missing from sentiment_raw"}

    sent = pd.read_sql_query(f"SELECT {', '.join(selected_sent_cols)} FROM sentiment_raw", conn)

    # 2. Inspect existing columns in irt_raw
    if "irt_raw" in tables:
        cursor.execute("PRAGMA table_info(irt_raw);")
        irt_cols_existing = {row for row in cursor.fetchall()}
        potential_irt_cols = [
            "Support Cases Case Id",
            "Internal Resolution Time within 24h (IRT) (%)",
            "Internal Resolution Time within 24h (IRT) (%) (Denominator)",
            "Cases Reopened (%)", "Cases Reopened (%) (Denominator)"
        ]
        selected_irt_cols = [f'"{c}"' for c in potential_irt_cols if c in irt_cols_existing]
        irt = pd.read_sql_query(f"SELECT {', '.join(selected_irt_cols)} FROM irt_raw", conn) if selected_irt_cols else pd.DataFrame()
    else:
        irt = pd.DataFrame()

    # 3. Inspect existing columns in esc_raw
    if "esc_raw" in tables:
        cursor.execute("PRAGMA table_info(esc_raw);")
        esc_cols_existing = {row for row in cursor.fetchall()}
        potential_esc_cols = ["Support Cases Case Id", "Escalations Opened"]
        selected_esc_cols = [f'"{c}"' for c in potential_esc_cols if c in esc_cols_existing]
        esc = pd.read_sql_query(f"SELECT {', '.join(selected_esc_cols)} FROM esc_raw", conn) if selected_esc_cols else pd.DataFrame()
    else:
        esc = pd.DataFrame()

    conn.close()

    # 4. Resolve Handle Time Column Alias (CHT vs AHT)
    if "Average Case Handle Time (CHT) (minutes)" in sent.columns:
        sent["cht"] = pd.to_numeric(sent["Average Case Handle Time (CHT) (minutes)"], errors="coerce").fillna(0.0)
    elif "Average Handle Time (AHT) (minutes)" in sent.columns:
        sent["cht"] = pd.to_numeric(sent["Average Handle Time (AHT) (minutes)"], errors="coerce").fillna(0.0)
    else:
        sent["cht"] = 0.0

    # 5. In-memory joins
    merged = pd.merge(sent, irt, on="Support Cases Case Id", how="left") if not irt.empty and "Support Cases Case Id" in irt.columns else sent
    if not esc.empty and "Support Cases Case Id" in esc.columns and "Escalations Opened" in esc.columns:
        esc["Escalations Opened"] = pd.to_numeric(esc["Escalations Opened"], errors="coerce").fillna(0.0)
        esc_g = esc.groupby("Support Cases Case Id", as_index=False)["Escalations Opened"].sum()
        merged = pd.merge(merged, esc_g, on="Support Cases Case Id", how="left")
        merged["Escalations Opened"] = merged["Escalations Opened"].fillna(0.0)
    else:
        merged["Escalations Opened"] = 0.0

    # Ensure required numeric fields exist safely
    defaults = {
        "Case Sentiment Score (% Positive)": 0.0,
        "Sentiment DR": 0.0,
        "Cases Closed": 1.0,
        "Internal Resolution Time within 24h (IRT) (%)": 0.0,
        "Internal Resolution Time within 24h (IRT) (%) (Denominator)": 0.0,
        "Cases Reopened (%)": 0.0,
        "Cases Reopened (%) (Denominator)": 0.0,
        "Average Time in Assigned (hours)": 0.0,
        "Average Time in Assigned (hours) Dr": 0.0,
        "Escalations Opened": 0.0,
        "cht": 0.0
    }
    for col, default_val in defaults.items():
        if col not in merged.columns:
            merged[col] = default_val
        else:
            merged[col] = pd.to_numeric(merged[col], errors="coerce").fillna(default_val)

    # 6. Overall KPI Calculations
    sent_dr = merged["Sentiment DR"].sum()
    sentiment_rate = (merged["Case Sentiment Score (% Positive)"].sum() / sent_dr) if sent_dr > 0 else 0.0

    irt_den = merged["Internal Resolution Time within 24h (IRT) (%) (Denominator)"].sum()
    irt_rate = (merged["Internal Resolution Time within 24h (IRT) (%)"].sum() / irt_den) if irt_den > 0 else 0.0

    reopen_den = merged["Cases Reopened (%) (Denominator)"].sum()
    reopen_rate = (merged["Cases Reopened (%)"].sum() / reopen_den) if reopen_den > 0 else 0.0

    cases_closed = merged["Cases Closed"].sum()
    esc_rate = (merged["Escalations Opened"].sum() / cases_closed) if cases_closed > 0 else 0.0

    time_den = merged["Average Time in Assigned (hours) Dr"].sum()
    avg_time_assigned = (merged["Average Time in Assigned (hours)"].sum() / time_den) if time_den > 0 else 0.0

    cht_val = merged["cht"].mean()

    # 7. Monthly Trends
    if "Time Series Month" in merged.columns:
        months = sorted([m for m in merged["Time Series Month"].dropna().unique() if str(m).strip() != ''])
    else:
        months = []

    trends = []
    for m in months:
        sub = merged[merged["Time Series Month"] == m]
        s_dr = sub["Sentiment DR"].sum()
        i_dr = sub["Internal Resolution Time within 24h (IRT) (%) (Denominator)"].sum()
        r_dr = sub["Cases Reopened (%) (Denominator)"].sum()
        c_cl = sub["Cases Closed"].sum()

        trends.append({
            "period": str(m),
            "sentiment": round(float((sub["Case Sentiment Score (% Positive)"].sum() / s_dr) if s_dr > 0 else 0.0), 4),
            "irt": round(float((sub["Internal Resolution Time within 24h (IRT) (%)"].sum() / i_dr) if i_dr > 0 else 0.0), 4),
            "reopen": round(float((sub["Cases Reopened (%)"].sum() / r_dr) if r_dr > 0 else 0.0), 4),
            "esc_rate": round(float((sub["Escalations Opened"].sum() / c_cl) if c_cl > 0 else 0.0), 4),
            "cases_closed": int(c_cl)
        })

    # 8. Pearson Correlations (Agent Level)
    assignee_col = "Final Assignee Username Masked" if "Final Assignee Username Masked" in merged.columns else None
    strip = []
    
    if assignee_col:
        agent_df = merged.groupby(assignee_col, as_index=False).agg({
            "Case Sentiment Score (% Positive)": "sum", "Sentiment DR": "sum",
            "Internal Resolution Time within 24h (IRT) (%)": "sum", "Internal Resolution Time within 24h (IRT) (%) (Denominator)": "sum",
            "Cases Reopened (%)": "sum", "Cases Reopened (%) (Denominator)": "sum",
            "Escalations Opened": "sum", "Cases Closed": "sum",
            "cht": "mean"
        })
        agent_df["sentiment"] = np.where(agent_df["Sentiment DR"] > 0, agent_df["Case Sentiment Score (% Positive)"] / agent_df["Sentiment DR"], np.nan)
        agent_df["irt"] = np.where(agent_df["Internal Resolution Time within 24h (IRT) (%) (Denominator)"] > 0, agent_df["Internal Resolution Time within 24h (IRT) (%)"] / agent_df["Internal Resolution Time within 24h (IRT) (%) (Denominator)"], np.nan)
        agent_df["reopen"] = np.where(agent_df["Cases Reopened (%) (Denominator)"] > 0, agent_df["Cases Reopened (%)"] / agent_df["Cases Reopened (%) (Denominator)"], np.nan)
        agent_df["esc_rate"] = np.where(agent_df["Cases Closed"] > 0, agent_df["Escalations Opened"] / agent_df["Cases Closed"], np.nan)

        valid_agents = agent_df.dropna(subset=["sentiment", "irt", "reopen", "esc_rate", "cht"])

        for var, label, higher_is_better in [
            ("irt", "IRT 24h %", True),
            ("reopen", "Reopen %", False),
            ("esc_rate", "Esc Rate", False),
            ("cht", "CHT (min)", False)
        ]:
            if len(valid_agents) >= 3 and valid_agents[var].std() > 1e-9 and valid_agents["sentiment"].std() > 1e-9:
                r = float(np.corrcoef(valid_agents[var], valid_agents["sentiment"]))
            else:
                r = 0.0

            strip.append({
                "key": var,
                "label": label,
                "r": round(r, 2),
                "aligned": (r > 0) if higher_is_better else (r < 0)
            })

    # 9. Return Lightweight View Model
    return {
        "metadata": {
            "total_cases": int(len(merged)),
            "months": months
        },
        "kpis": {
            "sentiment": round(float(sentiment_rate), 4),
            "irt": round(float(irt_rate), 4),
            "reopen": round(float(reopen_rate), 4),
            "esc_rate": round(float(esc_rate), 4),
            "time_assigned": round(float(avg_time_assigned), 1),
            "cht": round(float(cht_val), 1),
            "cases_closed": int(cases_closed)
        },
        "trends": trends,
        "correlations": {
            "unit": "Agent",
            "strip": strip
        }
    }
