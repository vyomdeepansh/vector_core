"""VectorCore FastAPI service v3.

GET  /api/v1/vectors/summary : cube payload, built once at startup and served as cached bytes
GET  /api/v1/cases/drilldown : paginated, filterable, sortable rows straight from SQLite (read-only)
POST /api/v1/admin/refresh   : rebuild the payload after re-running ingestion
"""
import json
import os
import sqlite3
import threading
import time
from typing import Optional

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import HTMLResponse, Response
from fastapi.staticfiles import StaticFiles

from app.config import settings
from app.processing.aggregator import DIM_COLS, compute_complete_dashboard_payload, dim_expr

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(BASE_DIR, "data", "vector_core.db")
STATIC_DIR = os.path.join(BASE_DIR, "static")
FILTER_ALIASES = ["month", "week", "sub_pod", "region", "market", "segment"]
L1_COL, L2_COL = "Principal Negative Sentiment Driver Category", "Principal Negative Sentiment Driver"
NOT_RCA, UNSPECIFIED = "Not yet RCA'd", "(unspecified)"

_DIM_FIELDS = [(a, DIM_COLS[a], lbl) for a, lbl in
               zip(FILTER_ALIASES, ["Month", "Week", "Pod", "Region", "Market", "Segment"])]
_ID = ("case_id", "Support Cases Case Id", "Case ID")
_AGENT = ("ldap", DIM_COLS["ldap"], "Agent")
SOURCES = {
    "sentiment": ("sentiment_raw", [_ID, *_DIM_FIELDS, _AGENT,
        ("scored", "Sentiment DR", "Scored"), ("positive", "Case Sentiment Score (% Positive)", "Positive"),
        ("closed", "Cases Closed", "Closed"), ("l1", L1_COL, "L1 Driver Category"),
        ("l2", L2_COL, "L2 Driver"), ("explanation", "Sentiment Explanation", "Explanation")]),
    "irt": ("irt_raw", [_ID, *_DIM_FIELDS, _AGENT,
        ("irt_met", "Internal Resolution Time within 24h (IRT) (%)", "IRT ≤ 24h"),
        ("irt_hours", "Average Internal Resolution Time (IRT) (hours)", "IRT (h)"),
        ("reopened", "Cases Reopened (%)", "Reopened"), ("reopen_driver", "Reopen Driver", "Reopen Driver")]),
    "esc": ("esc_raw", [_ID, *_DIM_FIELDS, _AGENT,
        ("escalations", "Escalations Opened", "Escalations"),
        ("inbound", "Frd Inbound Communication Channel Display String", "Inbound"),
        ("outbound", "Last Outgoing Or Synchronous Communication Channel", "Last Outbound"),
        ("summary", "Nautilus Case Summary", "Case Summary")]),
}

app = FastAPI(title=settings.APP_NAME, docs_url=None, redoc_url=None)
app.add_middleware(GZipMiddleware, minimum_size=1000)

CACHE = {"body": None, "error": None}
LOCK = threading.Lock()


@app.middleware("http")
async def security_headers(request: Request, call_next):
    resp = await call_next(request)
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Content-Security-Policy"] = (
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'")
    if request.url.path.startswith("/static/"):
        resp.headers["Cache-Control"] = "no-cache"  # always revalidate during development
    return resp


def rebuild():
    with LOCK:
        t0 = time.time()
        try:
            p = compute_complete_dashboard_payload(DB_PATH)
            if p is None:
                CACHE.update(body=None, error="database missing or empty")
                print("⚠️  Database missing or empty — run: python -m app.processing.load_data")
                return False
            CACHE.update(body=json.dumps(p, separators=(",", ":")).encode("utf-8"), error=None)
            rows = {k: v["rows"] for k, v in p["cubes"].items()}
            print(f"✓ Payload built in {time.time() - t0:.1f}s · {len(CACHE['body']) / 1e6:.1f} MB · rows {rows}")
            for w in p["metadata"]["warnings"]:
                print("  ⚠️ ", w)
            return True
        except Exception as e:  # surface the reason instead of a silent 503
            CACHE.update(body=None, error=str(e))
            print(f"✗ Payload build failed: {e}")
            return False


@app.on_event("startup")
def on_startup():
    rebuild()


@app.get("/api/v1/vectors/summary")
def summary():
    if CACHE["body"] is None and not rebuild():
        raise HTTPException(503, detail=CACHE["error"] or "payload unavailable")
    return Response(content=CACHE["body"], media_type="application/json", headers={"Cache-Control": "no-store"})


@app.post("/api/v1/admin/refresh")
def refresh():
    ok = rebuild()
    return {"ok": ok, "error": CACHE["error"]}


def _clean(v):
    return int(v) if isinstance(v, float) and v.is_integer() else v


@app.get("/api/v1/cases/drilldown")
def cases_drilldown(source: str = "sentiment",
                    page: int = Query(1, ge=1), page_size: int = Query(25, ge=10, le=200),
                    q: str = "", sort: str = "", direction: str = Query("desc", alias="dir"),
                    filters: str = "{}", l1: Optional[str] = None, l2: Optional[str] = None,
                    detractors_only: bool = False, scored_only: bool = False, irt_missed: bool = False):
    if source not in SOURCES:
        raise HTTPException(400, f"source must be one of {list(SOURCES)}")
    if not os.path.exists(DB_PATH):
        raise HTTPException(503, "database not found")
    try:
        flt = json.loads(filters or "{}")
        assert isinstance(flt, dict)
    except Exception:
        raise HTTPException(400, "filters must be a JSON object")

    table, fields = SOURCES[source]
    con = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    try:
        cols = {r[1] for r in con.execute(f'PRAGMA table_info("{table}")')}
        if not cols:
            raise HTTPException(404, f"{table} is not loaded")
        avail = [(k, c, lbl) for k, c, lbl in fields if c in cols]

        def expr(k, c):
            if k in FILTER_ALIASES:
                return dim_expr(k)
            if k in ("explanation", "summary"):
                return f'SUBSTR("{c}", 1, 600)'
            return f'"{c}"'

        where, params = [], []
        for alias in FILTER_ALIASES:
            vals = flt.get(alias) or []
            if not isinstance(vals, list) or not vals or DIM_COLS[alias] not in cols:
                continue
            real = [str(v) for v in vals if v not in ("(blank)", "(n/a)")]
            parts = []
            if real:
                parts.append(f"{dim_expr(alias)} IN ({','.join('?' * len(real))})")
                params += real
            if "(blank)" in vals:
                parts.append(f'"{DIM_COLS[alias]}" IS NULL')
            if parts:
                where.append("(" + " OR ".join(parts) + ")")

        if source == "sentiment":
            if detractors_only:
                where.append('"Sentiment DR" = 1 AND "Case Sentiment Score (% Positive)" = 0')
            for val, col, sentinel in ((l1, L1_COL, NOT_RCA), (l2, L2_COL, UNSPECIFIED)):
                if val is None or col not in cols:
                    continue
                if val == sentinel:
                    where.append(f'"{col}" IS NULL')
                else:
                    where.append(f'"{col}" = ?')
                    params.append(val)

        if source == "sentiment" and scored_only and not detractors_only and "Sentiment DR" in cols:
            where.append('"Sentiment DR" = 1')
        if source == "irt" and irt_missed and "Internal Resolution Time within 24h (IRT) (%)" in cols:
            where.append('"Internal Resolution Time within 24h (IRT) (%)" = 0')
        if q.strip():
            search = [c for c in ("Support Cases Case Id", DIM_COLS["ldap"]) if c in cols]
            if search:
                where.append("(" + " OR ".join(f'"{c}" LIKE ?' for c in search) + ")")
                params += [f"%{q.strip()}%"] * len(search)

        w = (" WHERE " + " AND ".join(where)) if where else ""
        total = con.execute(f'SELECT COUNT(*) FROM "{table}"{w}', params).fetchone()[0]
        sort_map = {k: expr(k, c) for k, c, _ in avail}
        order = f" ORDER BY {sort_map[sort]} {'ASC' if direction.lower() == 'asc' else 'DESC'}" if sort in sort_map else ""
        if not order and "Time Series Day" in cols:
            order = ' ORDER BY "Time Series Day" DESC'
        sel = ", ".join(f"{expr(k, c)} AS {k}" for k, c, _ in avail)
        rows = con.execute(f'SELECT {sel} FROM "{table}"{w}{order} LIMIT ? OFFSET ?',
                           params + [page_size, (page - 1) * page_size]).fetchall()
    finally:
        con.close()

    return {"source": source, "keys": [k for k, _, _ in avail], "labels": [l for _, _, l in avail],
            "rows": [[_clean(v) for v in r] for r in rows], "total": int(total),
            "page": page, "page_size": page_size}


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/", response_class=HTMLResponse)
def index():
    path = os.path.join(STATIC_DIR, "index.html")
    if not os.path.exists(path):
        raise HTTPException(404, "index.html missing")
    with open(path, encoding="utf-8") as f:
        return f.read()
