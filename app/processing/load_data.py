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
MONTH, WEEK, DAY = "Time Series Month", "Time Series Week", "Time Series Day"

# Metric columns referenced by validation / summaries
SENT_NUM = "Case Sentiment Score (% Positive)"
SENT_DR = "Sentiment DR"
REO_NUM = "Cases Reopened (%)"
REO_DEN_SENT = "Cases Reopened (%) DR"
REO_DEN_IRT = "Cases Reopened (%) (Denominator)"

# EFC-native column names (from new schema)
EFC_CASE = "Case Id"
EFC_MONTH = "Qplus Review Month"
EFC_WEEK = "Qplus Review Week"
EFC_DAY = "Qplus Review Date"
EFC_SEGMENT = "Customer Tier"
EFC_OWNER = "Task Owner"

DIMS = [
    MONTH,
    WEEK,
    "Product Sub Pod",
    "Sales Service Region",
    "Sales Service Market",
    "gCare Customer Segment (Final)",
    "Final Assignee Username Masked",
]

# EFC-native dimensions (now including Case Id)
EFC_DIMS = [
    EFC_CASE,
    EFC_MONTH,
    EFC_WEEK,
    "Product Sub Pod",
    "Sales Service Region",
    EFC_SEGMENT,
    EFC_OWNER,
]

# EFC-native → canonical pipeline schema
EFC_TO_CANONICAL_RENAME = {
    EFC_CASE: KEY,                                 # 'Case Id' -> 'Support Cases Case Id'
    EFC_MONTH: MONTH,                              # 'Qplus Review Month' -> 'Time Series Month'
    EFC_WEEK: WEEK,                                # 'Qplus Review Week' -> 'Time Series Week'
    EFC_DAY: DAY,                                  # 'Qplus Review Date' -> 'Time Series Day'
    EFC_OWNER: "Final Assignee Username Masked",   # 'Task Owner' -> 'Final Assignee Username Masked'
    EFC_SEGMENT: "gCare Customer Segment (Final)", # 'Customer Tier' -> 'gCare Customer Segment (Final)'
    # Fallback variants for backwards compatibility
    "QPlus Review Month": MONTH,
    "QPlus Review Week": WEEK,
    "QPlus Review Day": DAY,
    "QPlus Review Date": DAY,
    "gTech Ads Customer Segment": "gCare Customer Segment (Final)",
}

# Hard requirements: ingestion stops if any are missing.
REQUIRED = {
    "sentiment_raw": [KEY, *DIMS, SENT_NUM, SENT_DR, "Cases Closed"],
    "irt_raw": [
        KEY, *DIMS,
        "Internal Resolution Time within 24h (IRT) (%)",
        "Internal Resolution Time within 24h (IRT) (%) (Denominator)",
        REO_NUM,
        REO_DEN_IRT,
    ],
    "esc_raw": [KEY, *DIMS, "Escalations Opened"],
    # EFC is now Case-ID level
    "efc_raw": [EFC_CASE, EFC_MONTH, EFC_WEEK, EFC_DAY, "PoEFC_Num", "Quality Reviews"],
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
    # Reopen % on the dashboard is sourced ONLY from irt_raw
    "irt_raw": [REO_NUM, REO_DEN_IRT],
    "efc_raw": [
        *EFC_DIMS,
        "EFC%", "Po EFC%", "MSP Site", "Review Type",
        "Neo Campaign Type", "Quality Reviewer", "Opening Channel", "Category"
    ],
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
    exclude = set(DIMS + EFC_DIMS + [EFC_DAY, DAY, KEY, EFC_CASE, "QPlus Review Day", "QPlus Review Date"])
    return [c for c in dict.fromkeys(cols) if c in df.columns and c != KEY and c != EFC_CASE and c not in exclude]


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


def _warn_num_gt_den(df, table, num, den, hint):
    """A numerator count should never exceed its denominator; if it does, it's usually on a % scale."""
    if num in df.columns and den in df.columns:
        bad = int((df[num] > df[den]).sum())
        if bad:
            print(f"   ⚠ {table}: {bad:,} row(s) where '{num}' > '{den}' — {hint}")


def clean(df, table):
    df.columns = [norm(c) for c in df.columns]
    df = df.drop(columns=[c for c in DROP_TEXT if c in df.columns])

    # EFC: early alias detection for dates, segments, and Case ID
    if table == "efc_raw":
        have = {_key(c): c for c in df.columns}
        
        # 1) Case ID alias detection
        if _key(KEY) in have and _key(EFC_CASE) not in have:
            df = df.rename(columns={have[_key(KEY)]: EFC_CASE})
            
        # 2) Date column alias detection
        for alt_day in ["Qplus Review Date", "QPlus Review Date", "QPlus Review Day", "Qplus Review Day"]:
            if _key(alt_day) in have and _key(EFC_DAY) not in have:
                df = df.rename(columns={have[_key(alt_day)]: EFC_DAY})
                break
                
        # 3) Segment alias detection (Customer Tier vs gTech Ads Customer Segment)
        for alt_seg in ["Customer Tier", "gTech Ads Customer Segment"]:
            if _key(alt_seg) in have and _key(EFC_SEGMENT) not in have:
                df = df.rename(columns={have[_key(alt_seg)]: EFC_SEGMENT})
                break

    df = canon_names(df, table)

    if table == "efc_raw":
        # a) PoEFC_Num = Po EFC% × Quality Reviews
        if "Po EFC%" in df.columns and "Quality Reviews" in df.columns:
            df["PoEFC_Num"] = to_num(df["Po EFC%"]) * to_num(df["Quality Reviews"])
            print(f"   ↳ {table}: calculated 'PoEFC_Num' = 'Po EFC%' × 'Quality Reviews'")
        
        # Calculate standard EFC_Num if EFC% is present
        if "EFC%" in df.columns and "Quality Reviews" in df.columns:
            df["EFC_Num"] = to_num(df["EFC%"]) * to_num(df["Quality Reviews"])

        # b) Drop canonical duplicate columns if EFC-native versions are present
        dupes = [canon for src, canon in EFC_TO_CANONICAL_RENAME.items()
                 if src in df.columns and canon in df.columns]
        if dupes:
            df = df.drop(columns=dupes)
            print(f"   ↳ {table}: dropped {dupes} (EFC-native equivalents present)")

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

    # 3) Case ID: clean formatting across both KEY and EFC_CASE
    if KEY in df.columns:
        df[KEY] = fix_key(df[KEY])
    if EFC_CASE in df.columns:
        df[EFC_CASE] = fix_key(df[EFC_CASE])

    # 4) Canonical periods
    if table == "efc_raw":
        canon_period(df, EFC_MONTH, "%Y-%m", table)
        canon_period(df, EFC_WEEK, "%Y-%m-%d", table)
        canon_period(df, EFC_DAY, "%Y-%m-%d", table)
    else:
        canon_period(df, MONTH, "%Y-%m", table)
        canon_period(df, WEEK, "%Y-%m-%d", table)

    # 5) Keep narratives for scored detractors only (columns are numeric now)
    if table == "sentiment_raw" and "Sentiment Explanation" in df.columns:
        keep = (df[SENT_DR] == 1) & (df[SENT_NUM] == 0)
        df.loc[~keep, "Sentiment Explanation"] = None

    # 6) Denominator so AVERAGE(Consult Avg Interactions) stays exact as SUM/SUM under any filter
    cai = "Consult Average Interactions per Closed Case"
    if table == "sentiment_raw" and cai in df.columns:
        df[cai + " Dr"] = df[cai].notna().astype("int8")

    # 7) Sanity checks on ratio inputs
    if table == "irt_raw":
        _warn_num_gt_den(df, table, REO_NUM, REO_DEN_IRT,
                         "numerator may be stored as a percentage (e.g. 100 instead of 1)")
    if table == "sentiment_raw":
        _warn_num_gt_den(df, table, SENT_NUM, SENT_DR,
                         "Negative Cases (DR − numerator) would go negative on these rows")

    # 8) EFC → canonical pipeline names (renames Case Id -> Support Cases Case Id, Customer Tier -> Segment)
    if table == "efc_raw":
        ren = {s: t for s, t in EFC_TO_CANONICAL_RENAME.items() if s in df.columns}
        if ren:
            df = df.rename(columns=ren)
            print(f"   ↳ {table}: renamed to pipeline schema {ren}")

    return df


def summarize(df, table):
    if MONTH in df.columns:
        m = df[MONTH].dropna()
        if len(m):
            print(f"   months {m.min()} → {m.max()} · {m.nunique()} distinct")

    # Distinct cases in EFC now that it is case-level
    if table == "efc_raw" and KEY in df.columns:
        n_cases = df[KEY].dropna().nunique()
        print(f"   cases: {n_cases:,} distinct Case IDs in {table}")

    # Month-wise Reopen % from irt_raw
    if table == "irt_raw" and {MONTH, REO_NUM, REO_DEN_IRT} <= set(df.columns):
        g = df.groupby(MONTH)[[REO_NUM, REO_DEN_IRT]].sum()
        for mth, r in g.iterrows():
            rate = r[REO_NUM] / r[REO_DEN_IRT] if r[REO_DEN_IRT] else float("nan")
            print(f"   reopen {mth}: {r[REO_NUM]:,.0f} / {r[REO_DEN_IRT]:,.0f} = {rate:.2%}")

    # Month-wise Negative Cases from sentiment_raw (DR − numerator)
    if table == "sentiment_raw" and {MONTH, SENT_DR, SENT_NUM} <= set(df.columns):
        g = df.groupby(MONTH)[[SENT_DR, SENT_NUM]].sum()
        for mth, r in g.iterrows():
            print(f"   negative cases {mth}: {r[SENT_DR] - r[SENT_NUM]:,.0f}")

    # Month-wise poEFC from efc_raw
    if table == "efc_raw" and {MONTH, "PoEFC_Num", "Quality Reviews"} <= set(df.columns):
        g = df.groupby(MONTH)[["PoEFC_Num", "Quality Reviews"]].sum()
        for mth, r in g.iterrows():
            rate = r["PoEFC_Num"] / r["Quality Reviews"] if r["Quality Reviews"] else float("nan")
            print(f"   poEFC {mth}: {r['PoEFC_Num']:,.1f} / {r['Quality Reviews']:,.0f} = {rate:.2%}")

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

            # Standardized indices across all tables (KEY now applies to efc_raw as well)
            idx_cols = [KEY, "Product Sub Pod", "Final Assignee Username Masked", MONTH, WEEK, DAY]
            for col in idx_cols:
                if col in df.columns:
                    idx = f"idx_{table}_" + "".join(ch if ch.isalnum() else "_" for ch in col.lower())
                    con.execute(f'CREATE INDEX IF NOT EXISTS "{idx}" ON "{table}"("{col}")')

        con.execute("DROP VIEW IF EXISTS dashboard_metrics_view")
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
