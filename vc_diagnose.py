# vc_diagnose.py — read-only diagnostics. Run: python vc_diagnose.py
import os, json, sqlite3, urllib.request
import pandas as pd
import pyarrow.parquet as pq
from app.processing.schema import SCHEMA_CATALOG

def norm(s): return str(s).replace("\ufe0f", "").replace("🔑", "").strip()

FILES = {"sentiment_raw": "data/sentiment.parquet",
         "irt_raw": "data/irt.parquet",
         "esc_raw": "data/escalations.parquet"}
METRICS = {"sentiment_raw": ["Case Sentiment Score (% Positive)", "Sentiment DR", "Cases Closed"],
           "irt_raw": ["Internal Resolution Time within 24h (IRT) (%)",
                       "Internal Resolution Time within 24h (IRT) (%) (Denominator)",
                       "Cases Reopened (%)", "Cases Reopened (%) (Denominator)"],
           "esc_raw": ["Escalations Opened"]}

print("=== 1. Parquet headers vs schema catalog ===")
for t, f in FILES.items():
    if not os.path.exists(f): print(f"{t}: {f} not found"); continue
    names = pq.read_schema(f).names
    cat = {norm(c) for c in SCHEMA_CATALOG[t]}
    have = {norm(n) for n in names}
    print(f"\n{t}: {len(names)} parquet columns")
    print("  Expected but MISSING (silently zero-filled):", [c for c in SCHEMA_CATALOG[t] if norm(c) not in have])
    print("  Present but DROPPED by catalog:", [n for n in names if norm(n) not in cat])

print("\n=== 2. Raw metric types & ranges ===")
for t, f in FILES.items():
    if not os.path.exists(f): continue
    lookup = {norm(n): n for n in pq.read_schema(f).names}
    cols = [lookup[norm(m)] for m in METRICS[t] if norm(m) in lookup]
    df = pd.read_parquet(f, columns=cols)
    for c in cols:
        s = df[c]; num = pd.to_numeric(s, errors="coerce")
        lost = int(num.isna().sum() - s.isna().sum())
        print(f"{t}.{c}: dtype={s.dtype} sample={s.dropna().astype(str).unique()[:5].tolist()} "
              f"lost_to_coercion={lost:,} min={num.min()} max={num.max()}")

print("\n=== 3. Grain & join fan-out ===")
con = sqlite3.connect("data/vector_core.db"); q = lambda s: con.execute(s).fetchall()
for t in ["sentiment_raw", "irt_raw", "esc_raw"]:
    try:
        r, d = q(f'SELECT COUNT(*), COUNT(DISTINCT "Support Cases Case Id") FROM {t}')[0]
        print(f"{t}: rows={r:,} distinct_cases={d:,} rows_per_case={r/max(d,1):.2f}")
    except Exception as e: print(t, "error:", e)
base = q("SELECT COUNT(*) FROM sentiment_raw")[0][0]
joined = q('''SELECT COUNT(*) FROM sentiment_raw s
  LEFT JOIN irt_raw i ON s."Support Cases Case Id"=i."Support Cases Case Id"
  LEFT JOIN esc_raw e ON s."Support Cases Case Id"=e."Support Cases Case Id"''')[0][0]
print(f"join fan-out: {base:,} -> {joined:,} rows ({joined/max(base,1):.2f}x)")

print("\n=== 4. Placeholder strings in filter dimensions ===")
for col in ["Time Series Month", "Product Sub Pod", "Sales Service Region", "Sales Service Market"]:
    try:
        bad = q(f'''SELECT COUNT(*) FROM sentiment_raw WHERE "{col}" IS NULL OR "{col}" IN ('None','nan','NaT','')''')[0][0]
        top = q(f'SELECT "{col}", COUNT(*) FROM sentiment_raw GROUP BY 1 ORDER BY 2 DESC LIMIT 5')
        print(f"{col}: placeholder_rows={bad:,} top={top}")
    except Exception as e: print(col, "error:", e)

print("\n=== 5. Zero-fill footprint ===")
for t, cols in METRICS.items():
    for c in cols:
        try:
            z, n = q(f'SELECT SUM("{c}"=0), COUNT(*) FROM {t}')[0]
            print(f"{t}.{c}: zero_rows={z or 0:,}/{n:,}")
        except Exception as e: print(f"{t}.{c}: {e}")
con.close()

print("\n=== 6. Live API payload ===")
try:
    p = json.load(urllib.request.urlopen("http://localhost:8080/api/v1/vectors/summary", timeout=60))
    print("top-level keys:", list(p))
    print("kpis:", p.get("kpis"))
    print("dimension sizes:", {k: len(v) for k, v in p.get("metadata", {}).get("dimensions", {}).items()})
except Exception as e:
    print("API not reachable:", e)
