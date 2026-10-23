"""Read-only metric audit: parquet (truth) vs SQLite vs the cube the dashboard renders."""
import json, math, os, sqlite3, urllib.request
import pandas as pd
import pyarrow.parquet as pq

FILES = {"sentiment_raw": "data/sentiment.parquet", "irt_raw": "data/irt.parquet",
         "esc_raw": "data/escalations.parquet", "efc_raw": "data/efc.parquet"}
DB, API, MONTH = "data/vector_core.db", "http://localhost:8080/api/v1/vectors/summary", "Time Series Month"
DEN_SUFFIXES = (" Dr", " DR", " (Denominator)", " Denominator")
norm = lambda c: str(c).replace("\ufe0f", "").replace("🔑", "").strip()

# id, label, kind, numerator table, numerator, denominator table, denominator (None = derive), format
M = [
  ("1",   "Sentiment %",                  "ratio", "sentiment_raw", "Case Sentiment Score (% Positive)", "sentiment_raw", "Sentiment DR", "pct"),
  ("2",   "Escalation Rate",              "ratio", "esc_raw", "Escalations Opened", "sentiment_raw", "Cases Closed", "pct3"),
  ("3",   "Reopen Rate (support)",        "ratio", "sentiment_raw", "Cases Reopened (%)", "sentiment_raw", None, "pct"),
  ("3*",  "Reopen Rate (irt_raw, ref.)",  "ratio", "irt_raw", "Cases Reopened (%)", "irt_raw", None, "pct"),
  ("4",   "IRT 24h (support)",            "ratio", "irt_raw", "Internal Resolution Time within 24h (IRT) (%)", "irt_raw", None, "pct"),
  ("5",   "poEFC%",                       "ratio", "efc_raw", "PoEFC_Num", "efc_raw", "Quality Reviews", "pct"),
  ("6",   "Cases Closed",                 "sum",   "sentiment_raw", "Cases Closed", None, None, "int"),
  ("7",   "TFR Email (h)",                "ratio", "sentiment_raw", "Average Time to First Response (TFR) (hours) (Email)", "sentiment_raw", None, "num"),
  ("8",   "Consult Avg Interactions",     "mean",  "sentiment_raw", "Consult Average Interactions per Closed Case", None, None, "num"),
  ("9",   "Time in Assigned (h)",         "ratio", "sentiment_raw", "Average Time in Assigned (hours)", "sentiment_raw", None, "num"),
  ("10",  "Time in Blocked By (h)",       "ratio", "sentiment_raw", "Average Time in Blocked By (hours)", "sentiment_raw", None, "num"),
  ("11",  "Time in Need Info (h)",        "ratio", "sentiment_raw", "Average Time in Need Info (hours)", "sentiment_raw", None, "num"),
  ("12",  "Time in Unassigned (h)",       "ratio", "sentiment_raw", "Average Time in Unassigned (hours)", "sentiment_raw", None, "num"),
  ("13",  "TFS (h)",                      "ratio", "sentiment_raw", "Average Time to First Solution Offered (TFS) (hours)", "sentiment_raw", None, "num"),
  ("14a", "Time in New (h)",              "ratio", "sentiment_raw", "Average Time in New (hours)", "sentiment_raw", None, "num"),
  ("14b", "Agent Time (h)",               "ratio", "sentiment_raw", "Average Agent Time (hours)", "sentiment_raw", None, "num"),
  ("15",  "Interactions / Closed Case",   "ratio", "sentiment_raw", "Average Interactions per Closed Case", "sentiment_raw", None, "num"),
]
ALIASES = {
  "Case Sentiment Score (% Positive)": ["sent_num"], "Sentiment DR": ["sent_den"],
  "Cases Closed": ["closed", "cases_closed"], "Escalations Opened": ["esc_num", "escalations"],
  "Internal Resolution Time within 24h (IRT) (%)": ["irt_num"],
  "Internal Resolution Time within 24h (IRT) (%) (Denominator)": ["irt_den"],
  "Average Time to First Response (TFR) (hours) (Email)": ["tfr_num"],
  "Average Time in Assigned (hours)": ["asg_num"],
}
DEN_ALIASES = {"Cases Reopened (%)@sentiment_raw": (["reo_num", "reopen_num"], ["reo_den", "reopen_den"]),
               "Average Time to First Response (TFR) (hours) (Email)": ([], ["tfr_den"]),
               "Average Time in Assigned (hours)": ([], ["asg_den"])}

def fmt(v, f):
    if v is None or (isinstance(v, float) and math.isnan(v)): return "—"
    return {"pct": f"{v*100:.2f}%", "pct3": f"{v*100:.3f}%", "int": f"{v:,.0f}"}.get(f, f"{v:,.3f}")
def same(a, b): return a is not None and b is not None and abs(a - b) <= 1e-9 + 1e-6 * abs(b)

# ── 1. Resolve columns in each parquet ──
schemas = {t: {norm(n): n for n in pq.read_schema(f).names} for t, f in FILES.items() if os.path.exists(f)}
def resolve(t, name):
    sc = schemas.get(t, {})
    return name if name in sc else {k.lower(): k for k in sc}.get(name.lower())
def resolve_den(t, num):
    for s in DEN_SUFFIXES:
        r = resolve(t, num + s)
        if r: return r
    return None

plan, need = [], {t: set() for t in schemas}
for m in M:
    mid, label, kind, nt, num, dt, den, f = m
    if nt not in schemas or (dt and dt not in schemas):
        plan.append((m, None, None, f"{FILES[nt if nt not in schemas else dt]} not found")); continue
    nc = resolve(nt, num)
    dc = (resolve(dt, den) if den else resolve_den(dt, num)) if kind == "ratio" else None
    miss = ([f"numerator '{num}'"] if not nc else []) + ([f"denominator for '{num}'"] if kind == "ratio" and not dc else [])
    if miss: plan.append((m, nc, dc, "missing in parquet: " + "; ".join(miss))); continue
    need[nt] |= {nc, MONTH, "Cases Closed"}
    if dc: need[dt] |= {dc, MONTH}
    plan.append((m, nc, dc, None))

frames, lost = {}, {}
for t, cols in need.items():
    real = [schemas[t][c] for c in cols if c in schemas[t]]
    if not real: continue
    df = pd.read_parquet(FILES[t], columns=real); df.columns = [norm(c) for c in df.columns]
    for c in df.columns:
        if c == MONTH: continue
        conv = pd.to_numeric(df[c], errors="coerce")
        lost[(t, c)] = int(df[c].notna().sum() - conv.notna().sum()); df[c] = conv
    frames[t] = df

# ── 2. SQLite + cube ──
con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
dbcols = {t: {r[1] for r in con.execute(f'PRAGMA table_info("{t}")')} for t in FILES}
def q1(sql): return con.execute(sql).fetchone()[0]

sums, cube_err = {}, None
try:
    p = json.load(urllib.request.urlopen(API, timeout=180))
    cube = p.get("cube") or (p.get("cubes") or {}).get("main") or next(iter((p.get("cubes") or {}).values()), None)
    if not cube: cube_err = "payload has no cube"
    else:
        cols = cube.get("columns") or cube.get("cols") or cube
        for k, v in cols.items():
            if isinstance(v, list) and v and all(isinstance(x, (int, float)) or x is None for x in v[:50]):
                sums[k] = float(sum(x or 0 for x in v))
except Exception as e:
    cube_err = f"API not reachable ({e})"

def cube_col(names, total):
    for k in names:
        if k in sums and same(sums[k], total): return k, "by name"
    if total:
        hits = [k for k, s in sums.items() if same(s, total)]
        if len(hits) == 1: return hits[0], "by total"
        if hits: return hits[0], "by total (ambiguous: " + ", ".join(hits) + ")"
    for k in names:
        if k in sums: return k, "by name — TOTAL DIFFERS"
    return None, "not in cube"

# ── 3. Evaluate ──
rows, details = [], []
for m, nc, dc, err in plan:
    mid, label, kind, nt, num, dt, den, f = m
    if err:
        rows.append((mid, label, "—", "—", "—", "⛔ " + err)); continue
    a, info = frames[nt][nc], {}
    if lost.get((nt, nc)): info["⚠ non-numeric values turned into NULL"] = lost[(nt, nc)]
    if kind == "sum":
        truth = float(a.sum())
        sql = q1(f'SELECT SUM("{nc}") FROM "{nt}"') if nc in dbcols[nt] else None
        ck, how = cube_col(ALIASES.get(nc, []), truth)
        cube_v = sums.get(ck) if ck else None
    elif kind == "mean":
        truth = float(a.mean())
        info["mean, NULL counted as 0"] = fmt(float(a.fillna(0).mean()), f)
        if "Cases Closed" in frames[nt]:
            w = frames[nt]["Cases Closed"]; ok = a.notna() & w.notna()
            info["mean weighted by Cases Closed"] = fmt(float((a[ok] * w[ok]).sum() / w[ok].sum()) if w[ok].sum() else None, f)
        info["non-NULL rows"] = f"{int(a.notna().sum()):,} of {len(a):,}"
        sql = q1(f'SELECT AVG("{nc}") FROM "{nt}"') if nc in dbcols[nt] else None
        cube_v, how = None, "not in cube (cube stores sums, not row averages)"
    else:
        d = frames[dt][dc]
        n_sum, d_sum = float(a.sum()), float(d.sum())
        truth = n_sum / d_sum if d_sum else None
        info["numerator total"], info["denominator total"] = f"{n_sum:,.2f}", f"{d_sum:,.2f}"
        if nt == dt:
            info["denominator max per row"] = d.max()
            leak = int(((a.fillna(0) != 0) & (d.fillna(0) == 0)).sum())
            if leak: info["⚠ rows with a numerator but denominator 0/NULL"] = f"{leak:,}"
            multi = int((d > 1).sum())
            if multi:
                ok = a.notna() & d.notna()
                info["⚠ rows with denominator > 1"] = f"{multi:,}"
                info["  alt. if numerator is a per-row average: Σ(num·den)/Σden"] = fmt(float((a[ok] * d[ok]).sum() / d[ok].sum()), f)
            if f.startswith("pct"):
                over = int((a.fillna(0) > d.fillna(0)).sum())
                if over: info["⚠ rows where numerator > denominator"] = f"{over:,}"
        sql = None
        if nc in dbcols[nt] and dc in dbcols[dt]:
            sn, sd = q1(f'SELECT SUM("{nc}") FROM "{nt}"') or 0, q1(f'SELECT SUM("{dc}") FROM "{dt}"') or 0
            sql = sn / sd if sd else None
        key = f"{nc}@{nt}" if f"{nc}@{nt}" in DEN_ALIASES else nc
        na, da = DEN_ALIASES.get(key, (ALIASES.get(nc, []), ALIASES.get(dc, [])))
        cn, hn = cube_col(na or ALIASES.get(nc, []), n_sum)
        cd, hd = cube_col(da or ALIASES.get(dc, []), d_sum)
        cube_v = sums[cn] / sums[cd] if cn and cd and sums[cd] else None
        how = f"num {cn} ({hn}) · den {cd} ({hd})" if (cn or cd) else "not in cube"
        if MONTH in frames[nt] and MONTH in frames[dt] and MONTH in dbcols[nt] and MONTH in dbcols[dt]:
            try:
                pn, pd_ = frames[nt].groupby(MONTH)[nc].sum(), frames[dt].groupby(MONTH)[dc].sum()
                sn = dict(con.execute(f'SELECT "{MONTH}", SUM("{nc}") FROM "{nt}" GROUP BY 1'))
                sd = dict(con.execute(f'SELECT "{MONTH}", SUM("{dc}") FROM "{dt}" GROUP BY 1'))
                diffs = [abs(pn[k] / pd_[k] - (sn.get(k) or 0) / sd[k]) for k in pn.index if k in pd_ and pd_[k] and sd.get(k)]
                info["per-month parquet vs SQLite"] = f"{len(diffs)} months · max diff {max(diffs) if diffs else 0:.2e}"
            except Exception as e:
                info["per-month check"] = f"skipped ({e})"
    db_s = "DB ✓" if same(sql, truth) else ("DB n/a" if sql is None else "DB ✗")
    cb_s = cube_err or ("on dashboard ✓" if same(cube_v, truth) else ("not on dashboard" if cube_v is None else "dashboard ✗"))
    rows.append((mid, label, fmt(truth, f), fmt(sql, f), fmt(cube_v, f), f"{db_s} · {cb_s}"))
    details.append((mid, label, nt, nc, dt, dc, how, info))
con.close()

print(f"\n{'#':<5}{'Metric':<30}{'Parquet (truth)':>17}{'SQLite':>14}{'Dashboard':>14}   Status")
print("─" * 112)
for r in rows: print(f"{r[0]:<5}{r[1]:<30}{r[2]:>17}{r[3]:>14}{r[4]:>14}   {r[5]}")
print("\n═══ Details ═══")
for mid, label, nt, nc, dt, dc, how, info in details:
    print(f"\n[{mid}] {label}\n  numerator   : {nt}.{nc}" + (f"\n  denominator : {dt}.{dc}" if dc else "") + f"\n  dashboard   : {how}")
    for k, v in info.items(): print(f"  {k}: {v}")
