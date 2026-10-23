"""VectorCore ingestion v3: keep all columns, preserve NULLs, typed metrics, canonical dates
(month → 2026-01, week → 2026-01-10), fail loudly on missing required columns."""

import argparse
import os
import re
import sqlite3
from datetime import date, datetime

import pandas as pd

DB_PATH = "data/vector_core.db"

FILES = {
    "sentiment_raw": "sentiment.parquet",
    "irt_raw": "irt.parquet",
    "esc_raw": "escalations.parquet",
    "efc_raw": "efc.parquet",
}

KEY = "Support Cases Case Id"
MONTH, WEEK = "Time Series Month", "Time Series Week"
DIMS = [
    MONTH,
    WEEK,
    "Product Sub Pod",
    "Sales Service Region",
    "Sales Service Market",
    "gCare Customer Segment (Final)",
    "Final Assignee Username Masked",
]

# Hard requirements: ingestion stops if any are missing.
REQUIRED = {
    "sentiment_raw": [KEY, *DIMS, "Case Sentiment Score (% Positive)", "Sentiment DR", "Cases Closed"],
    "irt_raw": [
        KEY, *DIMS,
        "Internal Resolution Time within 24h (IRT) (%)",
        "Internal Resolution Time within 24h (IRT) (%) (Denominator)",
    ],
    "esc_raw": [KEY, *DIMS, "Escalations Opened"],
    "efc_raw": [MONTH, "PoEFC_Num", "Quality Reviews"],
}

# Soft expectations: warn only. A missing metric shows as "awaiting feed" on the dashboard.
_HRS = [
    "Average Time to First Response (TFR) (hours) (Email)",
    "Average Time in Assigned (hours)",
    "Average Time in Blocked By (hours)",
    "Average Time in Need Info (hours)",
    "Average Time in Unassigned (hours)",
    "Average Time to First Solution Offered (TFS) (hours)",
    "Average Time in New (hours)",
    "Average Agent Time (hours)",
    "Average Interactions per Closed Case",
]
EXPECTED = {
    "sentiment_raw": [
        "Cases Reopened (%)", "Cases Reopened (%) DR",
        "Consult Average Interactions per Closed Case",
        *[c for h in _HRS for c in (h, h + " Dr")],
    ],
    "efc_raw": [KEY, *DIMS],  # slicing dims for poEFC; missing ones limit which filters apply
}

DROP_TEXT = {"Qualitative Sentiment Drivers", "Nautilus Solution Offered Summary", "Nautilus Issue Summary"}
PLACEHOLDERS = {"", "none", "nan", "nat", "null", "n/a", "#n/a", "-"}
ISO_WEEK = re.compile(r"^(\d{4})-?W(\d{1,2})$", re.I)
YM6 = re.compile(r"^(\d{4})(\d{2})$")


def norm(c):
    return str(c).replace("\ufe0f", "").replace("🔑", "").strip()


def _key(c):
    return re.sub(r"\s+", " ", str(c)).strip().lower()


def canon_names(df, table):
    """Rename case/spacing variants (e.g. 'Sentiment Dr' → 'Sentiment DR') to the expected spelling."""
    have = {_key(c): c for c in df.columns}
    ren = {}
    for want in REQUIRED.get(table, []) + EXPECTED.get(table, []):
        src = have.get(_key(want))
        if want not in df.columns and src and src not in ren:
            ren[src] = want
    if ren:
        print(f"   ↳ {table}: renamed {ren}")
    return df.rename(columns=ren)


def numeric_cols(table, df):
    cols = REQUIRED.get(table, []) + EXPECTED.get(table, [])
    return [c for c in dict.fromkeys(cols) if c in df.columns and c != KEY and c not in DIMS]


def to_num(s):
    """Text → float. Handles '1,234' and '45%' (→ 0.45). Placeholders → NaN."""
    if pd.api.types.is_numeric_dtype(s):
        return s
    t = s.astype("string").str.strip().str.replace(",", "", regex=False)
    pct = t.str.endswith("%", na=False)
    v = pd.to_numeric(t.str.rstrip("%"), errors="coerce")
    return v.where(~pct, v / 100)


def fix_key(s):
    if pd.api.types.is_float_dtype(s):
        try:
            s = s.astype("Int64")  # avoid '123.0' and float rounding on long IDs
        except (TypeError, ValueError):
            pass
    return s.map(lambda v: None if pd.isna(v) else str(v).strip().removesuffix(".0"))


def _one_date(v):
    if isinstance(v, (pd.Timestamp, datetime, date)):
        return pd.Timestamp(v)
    s = str(v).strip()
    m = ISO_WEEK.match(s)
    if m:
        return pd.Timestamp(datetime.strptime(f"{m[1]}-W{int(m[2]):02d}-1", "%G-W%V-%u"))
    m = YM6.match(s)
    if m and 1 <= int(m[2]) <= 12:
        return pd.Timestamp(int(m[1]), int(m[2]), 1)
    ts = pd.to_datetime(s, errors="coerce")
    return None if pd.isna(ts) else ts


def canon_period(df, col, fmt, table):
    """Rewrite a period column to fmt ('%Y-%m' or '%Y-%m-%d'); unparseable values are kept and reported."""
    if col not in df.columns:
        return
    s = df[col]
    if pd.api.types.is_datetime64_any_dtype(s):
        out = s.dt.strftime(fmt)
        df[col] = out.astype(object).where(out.notna(), None)
        return
    cache, bad = {}, set()

    def conv(v):
        if v is None or (not isinstance(v, str) and pd.isna(v)):
            return None
        k = str(v)
        if k not in cache:
            ts = _one_date(v)
            cache[k] = ts.strftime(fmt) if ts is not None else k
            if ts is None:
                bad.add(k)
        return cache[k]

    df[col] = s.map(conv)
    if bad:
        print(f"   ⚠ {table}.{col}: {len(bad)} value(s) not parseable as dates, kept as-is: {sorted(bad)[:5]}")


def clean(df, table):
    df.columns = [norm(c) for c in df.columns]
    df = df.drop(columns=[c for c in DROP_TEXT if c in df.columns])
    df = canon_names(df, table)

    missing = [c for c in REQUIRED.get(table, []) if c not in df.columns]
    if missing:
        raise ValueError(f"{table}: missing required columns {missing}")
    soft = [c for c in EXPECTED.get(table, []) if c not in df.columns]
    if soft:
        print(f"   ⚠ {table}: optional columns not found → {soft}")

    # 1) Metrics → numeric BEFORE text cleanup, so they never become strings
    for c in numeric_cols(table, df):
        before = df[c].notna() & ~df[c].astype("string").str.strip().str.lower().isin(PLACEHOLDERS)
        df[c] = to_num(df[c])
        lost = int((before & df[c].isna()).sum())
        if lost:
            print(f"   ⚠ {table}.{c}: {lost:,} non-numeric value(s) set to NULL")

    # 2) Text columns: trim, placeholders → real NULLs (never the string 'None')
    for c in df.select_dtypes(include=["object", "string"]).columns:
        s = df[c].astype("string").str.strip()
        s = s.mask(s.str.lower().isin(PLACEHOLDERS))
        df[c] = s.astype(object).where(s.notna(), None)

    # 3) Case ID: no 'nan' strings, no '.0' suffix
    if KEY in df.columns:
        df[KEY] = fix_key(df[KEY])

    # 4) Canonical periods: month → 2026-01 · week → 2026-01-10
    canon_period(df, MONTH, "%Y-%m", table)
    canon_period(df, WEEK, "%Y-%m-%d", table)

    # 5) Keep narratives for scored detractors only (now safe: columns are numeric)
    if table == "sentiment_raw" and "Sentiment Explanation" in df.columns:
        keep = (df["Sentiment DR"] == 1) & (df["Case Sentiment Score (% Positive)"] == 0)
        df.loc[~keep, "Sentiment Explanation"] = None

    # 6) Denominator so AVERAGE(Consult Avg Interactions) stays exact as SUM/SUM under any filter
    cai = "Consult Average Interactions per Closed Case"
    if table == "sentiment_raw" and cai in df.columns:
        df[cai + " Dr"] = df[cai].notna().astype("int8")

    return df


def summarize(df, table):
    if MONTH in df.columns:
        m = df[MONTH].dropna()
        if len(m):
            print(f"   months {m.min()} → {m.max()} · {m.nunique()} distinct")
    for c in numeric_cols(table, df):
        nn = df[c].isna().mean()
        if nn > 0.5:
            print(f"   ⚠ {c}: {nn:.0%} NULL")


def run_ingestion(source_dir="data", mode="replace", db_path=DB_PATH):
    con = sqlite3.connect(db_path)
    try:
        for table, fname in FILES.items():
            path = os.path.join(source_dir, fname)
            if not os.path.exists(path):
                print(f"ℹ️  {fname} not found, skipping {table}")
                continue
            df = clean(pd.read_parquet(path), table)
            df.to_sql(table, con, if_exists=mode, index=False, chunksize=50_000)
            print(f"✓ {table}: {len(df):,} rows, {df.shape[1]} columns")
            summarize(df, table)
            for col in [KEY, MONTH, WEEK, "Product Sub Pod", "Final Assignee Username Masked"]:
                if col in df.columns:
                    idx = f"idx_{table}_" + "".join(ch if ch.isalnum() else "_" for ch in col.lower())
                    con.execute(f'CREATE INDEX IF NOT EXISTS "{idx}" ON "{table}"("{col}")')
        con.execute("DROP VIEW IF EXISTS dashboard_metrics_view")  # old view assumed one row per case
        con.commit()
    finally:
        con.close()


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--source-dir", default="data")
    p.add_argument("--mode", default="replace", choices=["replace", "append"])
    p.add_argument("--db", default=DB_PATH)
    a = p.parse_args()
    run_ingestion(a.source_dir, a.mode, a.db)
