"""VectorCore ingestion v2: keep all columns, preserve NULLs, fail loudly on missing required columns."""
import os, sqlite3, argparse
import pandas as pd

DB_PATH = "data/vector_core.db"
FILES = {"sentiment_raw": "sentiment.parquet", "irt_raw": "irt.parquet",
         "esc_raw": "escalations.parquet", "efc_raw": "efc.parquet"}
KEY = "Support Cases Case Id"
DIMS = ["Time Series Month", "Time Series Week", "Product Sub Pod", "Sales Service Region",
        "Sales Service Market", "gCare Customer Segment (Final)", "Final Assignee Username Masked"]
REQUIRED = {
    "sentiment_raw": [KEY, *DIMS, "Case Sentiment Score (% Positive)", "Sentiment DR", "Cases Closed"],
    "irt_raw": [KEY, *DIMS, "Internal Resolution Time within 24h (IRT) (%)",
                "Internal Resolution Time within 24h (IRT) (%) (Denominator)"],
    "esc_raw": [KEY, *DIMS, "Escalations Opened"],
}
DROP_TEXT = {"Qualitative Sentiment Drivers", "Nautilus Solution Offered Summary", "Nautilus Issue Summary"}
PLACEHOLDERS = {"", "none", "nan", "nat", "null", "n/a", "#n/a", "-"}

def norm(c):
    return str(c).replace("\ufe0f", "").replace("🔑", "").strip()

def clean(df, table):
    df.columns = [norm(c) for c in df.columns]
    df = df.drop(columns=[c for c in DROP_TEXT if c in df.columns])
    missing = [c for c in REQUIRED.get(table, []) if c not in df.columns]
    if missing:
        raise ValueError(f"{table}: missing required columns {missing}")
    # Text columns: trim, turn placeholders into real NULLs (never the string 'None')
    for c in df.select_dtypes(include=["object", "string"]).columns:
        s = df[c].astype("string").str.strip()
        s = s.mask(s.str.lower().isin(PLACEHOLDERS))
        df[c] = s.astype(object).where(s.notna(), None)
    if KEY in df.columns:
        df[KEY] = df[KEY].map(lambda v: None if v is None else str(v).removesuffix(".0"))
    # Numeric columns are left as-is: NULL stays NULL, and SQL SUM() ignores it
    if table == "sentiment_raw" and "Sentiment Explanation" in df.columns:
        keep = (df["Sentiment DR"] == 1) & (df["Case Sentiment Score (% Positive)"] == 0)
        df.loc[~keep, "Sentiment Explanation"] = None   # keep narratives for scored detractors only
    return df

def run_ingestion(source_dir="data", mode="replace"):
    con = sqlite3.connect(DB_PATH)
    for table, fname in FILES.items():
        path = os.path.join(source_dir, fname)
        if not os.path.exists(path):
            print(f"ℹ️  {fname} not found, skipping")
            continue
        df = clean(pd.read_parquet(path), table)
        df.to_sql(table, con, if_exists=mode, index=False, chunksize=50_000)
        print(f"✓ {table}: {len(df):,} rows, {df.shape[1]} columns")
        for col in [KEY, "Time Series Month", "Time Series Week", "Product Sub Pod", "Final Assignee Username Masked"]:
            if col in df.columns:
                idx = f"idx_{table}_" + "".join(ch if ch.isalnum() else "_" for ch in col.lower())
                con.execute(f'CREATE INDEX IF NOT EXISTS "{idx}" ON "{table}"("{col}")')
    con.execute("DROP VIEW IF EXISTS dashboard_metrics_view")  # old view assumed one row per case
    con.commit()
    con.close()

if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--source-dir", default="data")
    run_ingestion(p.parse_args().source_dir)
