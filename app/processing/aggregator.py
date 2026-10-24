"""VectorCore aggregator v3 — three cross-filterable cubes, no case-level joins.

main   : month x week x sub_pod x region x market x segment          -> every KPI measure
agents : ldap  x month x sub_pod x region x market x segment         -> correlation + simulator
det    : month x week x sub_pod x region x market x segment x l1 x l2 -> detractor counts

Each measure is SUMmed inside its own table, then tables are outer-merged on the shared
dimension keys. Ratios are only computed from summed numerators/denominators (in the
browser), so cross-filtering never double-counts.

Measure sources:
  Reopen %        = SUM(irt_raw[Cases Reopened (%)]) / SUM(irt_raw[Cases Reopened (%) (Denominator)])
  Negative Cases  = SUM(sentiment_raw[Sentiment DR]) - SUM(sentiment_raw[Case Sentiment Score (% Positive)])
  PoEFC           = SUM(efc_raw[PoEFC_Num]) / SUM(efc_raw[Quality Reviews])
"""

import json
import os
import sqlite3
import time
from datetime import UTC, datetime

import pandas as pd

DIM_COLS = {
    "month": "Time Series Month",
    "week": "Time Series Week",
    "sub_pod": "Product Sub Pod",
    "region": "Sales Service Region",
    "market": "Sales Service Market",
    "segment": "gCare Customer Segment (Final)",
    "ldap": "Final Assignee Username Masked",
}

MAIN_DIMS = ["month", "week", "sub_pod", "region", "market", "segment"]
AGENT_DIMS = ["ldap", "month", "sub_pod", "region", "market", "segment"]

MEASURES = {
    "sentiment_raw": {
        "sent_num": "Case Sentiment Score (% Positive)",
        "sent_den": "Sentiment DR",
        "closed": "Cases Closed",
        "cht_num": "Average Case Handle Time (CHT) (minutes)",
        "cht_den": "Average Case Handle Time (CHT) (minutes) Dr",
        "asg_num": "Average Time in Assigned (hours)",
        "asg_den": "Average Time in Assigned (hours) Dr",
        "tfr_num": "Average Time to First Response (TFR) (hours) (Email)",
        "tfr_den": "Average Time to First Response (TFR) (hours) (Email) Dr",
        "tta_num": "Average Time to First Assign (TTA) (hours) (Email)",
        "tta_den": "Average Time to First Assign (TTA) (hours) (Email) (Denominator)",
        "blk_num": "Average Time in Blocked By (hours)",
        "blk_den": "Average Time in Blocked By (hours) Dr",
        "nfo_num": "Average Time in Need Info (hours)",
        "nfo_den": "Average Time in Need Info (hours) Dr",
        "una_num": "Average Time in Unassigned (hours)",
        "una_den": "Average Time in Unassigned (hours) Dr",
        "tfs_num": "Average Time to First Solution Offered (TFS) (hours)",
        "tfs_den": "Average Time to First Solution Offered (TFS) (hours) Dr",
        "new_num": "Average Time in New (hours)",
        "new_den": "Average Time in New (hours) Dr",
        "agt_num": "Average Agent Time (hours)",
        "agt_den": "Average Agent Time (hours) Dr",
        "int_num": "Average Interactions per Closed Case",
        "int_den": "Average Interactions per Closed Case Dr",
        "cai_num": "Consult Average Interactions per Closed Case",
        "cai_den": "Consult Average Interactions per Closed Case Dr",
        "con_num": "Level 1 to Level 15 Consult (%)",
        "con_den": "1 to 15 DR",
    },
    "irt_raw": {
        "irt_num": "Internal Resolution Time within 24h (IRT) (%)",
        "irt_den": "Internal Resolution Time within 24h (IRT) (%) (Denominator)",
        # Reopen % is sourced ONLY from irt_raw
        "reo_num": "Cases Reopened (%)",
        "reo_den": "Cases Reopened (%) (Denominator)",
    },
    "esc_raw": {
        "esc_num": "Escalations Opened",
    },
    "efc_raw": {
        "efc_num": "PoEFC_Num",
        "efc_den": "Quality Reviews",
    },
}

ALL_MEASURES = [a for m in MEASURES.values() for a in m]

# Derived additive measures (computed after the merge; safe to SUM under any filter)
DERIVED = ["neg_cases"]  # Sentiment DR − Case Sentiment Score (% Positive)
CUBE_MEASURES = ALL_MEASURES + DERIVED

L1_COL = "Principal Negative Sentiment Driver Category"
L2_COL = "Principal Negative Sentiment Driver"
DETRACTOR_SQL = '"Sentiment DR" = 1 AND "Case Sentiment Score (% Positive)" = 0'

_WARNINGS = set()


def dim_expr(alias):
    """SQL expression for a dimension. Shared with the drilldown API so filters match the cubes."""
    col = f'CAST("{DIM_COLS[alias]}" AS TEXT)'
    return f"SUBSTR({col}, 1, 10)" if alias == "week" else col


def _cols(con, table):
    return {r[1] for r in con.execute(f'PRAGMA table_info("{table}")')}


def _has(con, table, alias):
    return MEASURES[table][alias] in _cols(con, table)


def _dim_select(cols, dims):
    return [
        f"COALESCE({dim_expr(a)}, '(blank)') AS {a}"
        if DIM_COLS[a] in cols
        else f"'(n/a)' AS {a}"
        for a in dims
    ]


def _agg(con, table, dims):
    cols = _cols(con, table)
    if not cols:
        return None
    meas = []
    for alias, col in MEASURES[table].items():
        if col in cols:
            meas.append(f'SUM("{col}") AS {alias}')
        else:
            _WARNINGS.add(f"{table}: column not found -> {col}")
            meas.append(f"NULL AS {alias}")
    sql = f'SELECT {", ".join(_dim_select(cols, dims) + meas)} FROM "{table}" GROUP BY {", ".join(dims)}'
    return pd.read_sql_query(sql, con)


def _combine(con, dims):
    out = None
    for table in MEASURES:
        part = _agg(con, table, dims)
        if part is not None:
            out = part if out is None else out.merge(part, on=dims, how="outer")

    if out is None:
        out = pd.DataFrame(columns=dims + ALL_MEASURES)

    for m in ALL_MEASURES:
        if m not in out.columns:
            out[m] = 0.0

    out[ALL_MEASURES] = out[ALL_MEASURES].apply(pd.to_numeric, errors="coerce").fillna(0.0)

    # Negative Cases Count = Sentiment DR − Case Sentiment Score (% Positive)
    out["neg_cases"] = out["sent_den"] - out["sent_num"]
    return out


def _num(x):
    x = float(x)
    return int(x) if x.is_integer() else round(x, 4)


def _pack(df, dims, measures):
    """Columnar encoding: dimension values become indices into a sorted vocabulary."""
    df = df[(df[measures] != 0).any(axis=1)].reset_index(drop=True)
    vocab, cols = {}, {}
    for a in dims:
        s = df[a].astype(str)
        vocab[a] = sorted(s.unique().tolist())
        idx = {v: i for i, v in enumerate(vocab[a])}
        cols[a] = s.map(idx).astype(int).tolist()
    for m in measures:
        cols[m] = [_num(x) for x in df[m].to_numpy()]
    return {
        "dims": dims,
        "measures": measures,
        "vocab": vocab,
        "cols": cols,
        "rows": len(df),
    }


def _det_cube(con):
    cols = _cols(con, "sentiment_raw")
    l1 = f"COALESCE(\"{L1_COL}\", 'Not yet RCA''d')" if L1_COL in cols else "'Not yet RCA''d'"
    l2 = f"COALESCE(\"{L2_COL}\", '(unspecified)')" if L2_COL in cols else "'(unspecified)'"
    sql = f"""SELECT {", ".join(_dim_select(cols, MAIN_DIMS))}, {l1} AS l1, {l2} AS l2, COUNT(*) AS det
              FROM sentiment_raw WHERE {DETRACTOR_SQL}
              GROUP BY {", ".join(MAIN_DIMS)}, l1, l2"""
    return _pack(pd.read_sql_query(sql, con), MAIN_DIMS + ["l1", "l2"], ["det"])


def _ratio(n, d):
    return round(float(n / d), 4) if d else None


def compute_complete_dashboard_payload(db_path="data/vector_core.db"):
    _WARNINGS.clear()
    if not os.path.exists(db_path):
        return None
    con = sqlite3.connect(db_path)
    try:
        if not _cols(con, "sentiment_raw"):
            return None
        has_reo = bool(_cols(con, "irt_raw")) and _has(con, "irt_raw", "reo_num") and _has(con, "irt_raw", "reo_den")
        main = _combine(con, MAIN_DIMS)
        agents = _combine(con, AGENT_DIMS)
        det = _det_cube(con)
    finally:
        con.close()

    t = main[CUBE_MEASURES].sum()
    kpis = {
        "sentiment": _ratio(t.sent_num, t.sent_den),
        "irt": _ratio(t.irt_num, t.irt_den),
        "reopen": _ratio(t.reo_num, t.reo_den) if has_reo else None,
        "efc": _ratio(t.efc_num, t.efc_den),
        "quality_reviews": int(t.efc_den),
        "esc_rate": _ratio(t.esc_num, t.closed),
        "consult": _ratio(t.con_num, t.con_den),
        "cht": _ratio(t.cht_num, t.cht_den),
        "time_assigned": _ratio(t.asg_num, t.asg_den),
        "tfr": _ratio(t.tfr_num, t.tfr_den),
        "tta": _ratio(t.tta_num, t.tta_den),
        "cases_closed": int(t.closed),
        "negative_cases": int(t.neg_cases),
        "escalations": int(t.esc_num),
    }
    return {
        "metadata": {
            "generated_at": datetime.now(UTC).isoformat(),
            "warnings": sorted(_WARNINGS),
        },
        "kpis": kpis,
        "cubes": {
            "main": _pack(main, MAIN_DIMS, CUBE_MEASURES),
            "agents": _pack(agents, AGENT_DIMS, CUBE_MEASURES),
            "det": det,
        },
    }


if __name__ == "__main__":
    t0 = time.time()
    p = compute_complete_dashboard_payload()
    if p:
        body = json.dumps(p, separators=(",", ":"))
        print(
            f"✓ compiled in {time.time() - t0:.1f}s | payload {len(body) / 1e6:.1f} MB | "
            f"rows: { {k: v['rows'] for k, v in p['cubes'].items()} }"
        )
        for w in p["metadata"]["warnings"]:
            print("⚠️ ", w)
        print(json.dumps(p["kpis"], indent=2))
    else:
        print("Failed to compute payload (DB or tables missing).")
