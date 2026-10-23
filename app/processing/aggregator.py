"""VectorCore aggregator v2: per-table aggregation at a shared dimension grain (no case-level joins)."""
import os, json, sqlite3, time
from datetime import datetime, timezone
import numpy as np
import pandas as pd

DIMS = {"month": "Time Series Month", "week": "Time Series Week", "sub_pod": "Product Sub Pod",
        "region": "Sales Service Region", "market": "Sales Service Market",
        "segment": "gCare Customer Segment (Final)"}
MEASURES = {
    "sentiment_raw": {
        "sent_num": "Case Sentiment Score (% Positive)", "sent_den": "Sentiment DR",
        "closed": "Cases Closed",
        "reo_num": "Cases Reopened (%)", "reo_den": "Cases Reopened (%) DR",
        "cht_num": "Average Case Handle Time (CHT) (minutes)", "cht_den": "Average Case Handle Time (CHT) (minutes) Dr",
        "asg_num": "Average Time in Assigned (hours)", "asg_den": "Average Time in Assigned (hours) Dr",
        "tfr_num": "Average Time to First Response (TFR) (hours) (Email)",
        "tfr_den": "Average Time to First Response (TFR) (hours) (Email) Dr",
        "tta_num": "Average Time to First Assign (TTA) (hours) (Email)",
        "tta_den": "Average Time to First Assign (TTA) (hours) (Email) (Denominator)",
        "con_num": "Level 1 to Level 15 Consult (%)", "con_den": "1 to 15 DR",
    },
    "irt_raw": {"irt_num": "Internal Resolution Time within 24h (IRT) (%)",
                "irt_den": "Internal Resolution Time within 24h (IRT) (%) (Denominator)"},
    "esc_raw": {"esc_num": "Escalations Opened"},
}
ALL_MEASURES = [a for m in MEASURES.values() for a in m]

def _cols(con, t):
    return {r[1] for r in con.execute(f'PRAGMA table_info("{t}")')}

def _agg(con, table, dims):
    cols = _cols(con, table)
    if not cols:
        return None
    d_sql = [f'COALESCE("{c}", \'(blank)\') AS {a}' if c in cols else f"'(n/a)' AS {a}" for a, c in dims.items()]
    m_sql = []
    for a, c in MEASURES[table].items():
        if c in cols:
            m_sql.append(f'SUM("{c}") AS {a}')
        else:
            print(f"⚠️  {table}: column not found -> {c}")
            m_sql.append(f"NULL AS {a}")
    q = f'SELECT {", ".join(d_sql + m_sql)} FROM "{table}" GROUP BY {", ".join(dims)}'
    return pd.read_sql_query(q, con)

def _combine(con, dims):
    keys = list(dims)
    out = None
    for t in MEASURES:
        f = _agg(con, t, dims)
        if f is not None:
            out = f if out is None else out.merge(f, on=keys, how="outer")
    for a in ALL_MEASURES:
        if a not in out.columns:
            out[a] = 0.0
    out[ALL_MEASURES] = out[ALL_MEASURES].apply(pd.to_numeric, errors="coerce").fillna(0.0)
    return out

def _r(n, d):  # ratio; 0.0 when the denominator is empty (keeps the current UI from crashing)
    return round(float(n / d), 4) if d else 0.0

def _kpis(s):
    return {"sentiment": _r(s.sent_num, s.sent_den), "irt": _r(s.irt_num, s.irt_den),
            "reopen": _r(s.reo_num, s.reo_den), "esc_rate": _r(s.esc_num, s.closed),
            "consult": _r(s.con_num, s.con_den), "cht": _r(s.cht_num, s.cht_den),
            "time_assigned": _r(s.asg_num, s.asg_den), "tfr": _r(s.tfr_num, s.tfr_den),
            "tta": _r(s.tta_num, s.tta_den), "cases_closed": int(s.closed), "escalations": int(s.esc_num)}

def compute_complete_dashboard_payload(db_path="data/vector_core.db"):
    if not os.path.exists(db_path):
        return None
    con = sqlite3.connect(db_path)
    if not _cols(con, "sentiment_raw"):
        con.close()
        return None

    cube = _combine(con, DIMS)
    total = cube[ALL_MEASURES].sum()

    by_m = cube.groupby("month")[ALL_MEASURES].sum().sort_index()
    trends = [{"period": m, **{k: _kpis(r)[k] for k in ("sentiment", "irt", "reopen", "esc_rate")},
               "cases_closed": int(r.closed)} for m, r in by_m.iterrows() if m not in ("(blank)", "(n/a)")]

    # Detractor categories: scored (DR=1) cases with score 0
    s_cols = _cols(con, "sentiment_raw")
    cat_col = "Principal Negative Sentiment Driver Category"
    cat_expr = f'COALESCE("{cat_col}", \'Not yet RCA\'\'d\')' if cat_col in s_cols else "'Not yet RCA''d'"
    cats = pd.read_sql_query(f'''
        SELECT {cat_expr} AS l1,
               SUM(CASE WHEN "Sentiment DR" = 1 AND "Case Sentiment Score (% Positive)" = 0 THEN 1 ELSE 0 END) AS det
        FROM sentiment_raw GROUP BY 1 HAVING det > 0 ORDER BY det DESC''', con)
    cat_tree = [{"id": r.l1, "name": r.l1, "levelNum": 1, "parentId": None, "hasChildren": False,
                 "total": int(r.det), "share": _r(r.det, total.sent_den), "delta": 0.0}
                for r in cats.itertuples()]

    # Agent-level correlations, aggregated per table (no case join)
    ag = _combine(con, {"ldap": "Final Assignee Username Masked"})
    con.close()
    ag = ag[(ag.closed >= 20) & (ag.sent_den > 0)].copy()
    for k, (n, d) in {"sentiment": ("sent_num", "sent_den"), "irt": ("irt_num", "irt_den"),
                      "reopen": ("reo_num", "reo_den"), "cht": ("cht_num", "cht_den")}.items():
        ag[k] = np.where(ag[d] > 0, ag[n] / ag[d].replace(0, np.nan), np.nan)
    ag["esc_rate"] = ag.esc_num / ag.closed
    strip = []
    for k, label, up in [("irt", "IRT 24h %", True), ("reopen", "Reopen %", False),
                         ("esc_rate", "Esc Rate", False), ("cht", "CHT (min)", False)]:
        v = ag[["sentiment", k]].dropna()
        r = float(np.corrcoef(v[k], v["sentiment"])[0, 1]) if len(v) >= 5 and v[k].std() > 1e-9 and v["sentiment"].std() > 1e-9 else 0.0
        strip.append({"key": k, "label": label, "r": round(r, 2), "aligned": bool(r > 0 if up else r < 0)})

    feats = ["irt", "reopen", "esc_rate"]
    v = ag[["sentiment", *feats]].dropna()
    beta = {"irt": 0.0, "reopen": 0.0, "esc_rate": 0.0}
    if len(v) >= 10:
        X, y = v[feats].values, v["sentiment"].values
        Xs, ys = (X - X.mean(0)) / (X.std(0) + 1e-9), (y - y.mean()) / (y.std() + 1e-9)
        b = np.linalg.solve(Xs.T @ Xs / len(v) + 0.1 * np.eye(3), Xs.T @ ys / len(v))
        beta = {f: round(float(b[i] * y.std() / (X[:, i].std() + 1e-9)), 4) for i, f in enumerate(feats)}

    k = _kpis(total)
    dims = {a: sorted(cube[a].astype(str).unique().tolist()) for a in DIMS}
    columns = {a: cube[a].astype(str).map({x: i for i, x in enumerate(dims[a])}).astype(int).tolist() for a in DIMS}
    columns.update({m: [round(float(x), 4) for x in cube[m]] for m in ALL_MEASURES})

    return {
        "metadata": {"generated_at": datetime.now(timezone.utc).isoformat(), "grain": list(DIMS), "dims": dims,
                     "dimensions": {"months": dims["month"], "pods": dims["sub_pod"],
                                    "regions": dims["region"], "markets": dims["market"]}},
        "kpis": k, "trends": trends, "cat_tree": cat_tree,
        "correlations": {"unit": "Agent", "min_cases": 20, "n_agents": int(len(ag)), "strip": strip},
        "simulator": {"base_sentiment": k["sentiment"], "beta": beta,
                      "ranges": {"irt": {"lo": 0.5, "hi": 1.0, "base": k["irt"]},
                                 "reopen": {"lo": 0.0, "hi": 0.4, "base": k["reopen"]},
                                 "esc_rate": {"lo": 0.0, "hi": 0.03, "base": k["esc_rate"]}}},
        "cube": {"rows": int(len(cube)), "columns": columns},
    }

if __name__ == "__main__":
    t0 = time.time()
    p = compute_complete_dashboard_payload()
    print(f"✓ compiled in {time.time() - t0:.2f}s | cube rows: {p['cube']['rows']:,} | "
          f"payload: {len(json.dumps(p)) / 1024:.0f} KB")
    print(json.dumps(p["kpis"], indent=2))
