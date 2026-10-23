"""
VectorCore FastAPI Core Engine
Pre-calculates and serves lightweight summary payloads (<50KB) to prevent network and browser lag.
"""

from fastapi import FastAPI, HTTPException, Response, Query
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse
import sqlite3
import os

from app.config import settings
from app.processing.aggregator import compute_complete_dashboard_payload

app = FastAPI(title=settings.APP_NAME, docs_url=None, redoc_url=None)

from fastapi.middleware.gzip import GZipMiddleware
app.add_middleware(GZipMiddleware, minimum_size=1000)


SERVER_CACHE = {"dashboard_model": None}

@app.middleware("http")
async def add_security_headers(request, call_next):
    response: Response = await call_next(request)
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-XSS-Protection"] = "1; mode=block"
    # Strict compliant CSP allowing only self-hosted assets
    response.headers["Content-Security-Policy"] = (
        "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: https: http:; "
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net; "
        "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; "
        "font-src 'self' data: https://cdn.jsdelivr.net; "
        "img-src 'self' data: blob: https:;"
    )
    return response

def warm_cache():
    db_path = "data/vector_core.db"
    try:
        # Pre-aggregates all metrics, trends, and correlations to a ~35KB payload
        model = compute_complete_dashboard_payload(db_path)
        if model:
            SERVER_CACHE["dashboard_model"] = model
            print("✓ VectorCore Analytics Model pre-computed successfully.")
        else:
            print("⚠️ Database empty or not found.")
    except Exception as e:
        print(f"✗ Failed to compile cache: {str(e)}")

@app.on_event("startup")
def startup_event():
    warm_cache()

@app.get("/api/v1/vectors/summary")
def get_vector_summary():
    """Serves the lightweight pre-calculated summary payload."""
    if SERVER_CACHE["dashboard_model"] is None:
        warm_cache()
    if SERVER_CACHE["dashboard_model"] is None:
        raise HTTPException(status_code=503, detail="Analytical model is warming up.")
    return SERVER_CACHE["dashboard_model"]

@app.get("/api/v1/cases/drilldown")
def get_case_drilldown(page: int = Query(1, ge=1), page_size: int = Query(25, ge=10, le=100)):
    """Paginated lazy-load endpoint for Tab 4 Case Level Data."""
    db_path = "data/vector_core.db"
    if not os.path.exists(db_path):
        return {"records": [], "total": 0}

    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    cursor.execute("SELECT COUNT(*) FROM sentiment_raw")
    total = cursor.fetchone()[0]

    offset = (page - 1) * page_size
    # Explicitly query only the needed columns for paginated view
    cursor.execute(f"""
        SELECT 
            "Support Cases Case Id" AS case_id, 
            "Time Series Month" AS month, 
            "Product Sub Pod" AS sub_pod,
            "Final Assignee Username Masked" AS ldap, 
            "Case Sentiment Score (% Positive)" AS sentiment_score
        FROM sentiment_raw
        LIMIT {page_size} OFFSET {offset}
    """)
    rows = cursor.fetchall()
    conn.close()

    records = []
    for r in rows:
        records.append({
            "caseId": r[0],
            "month": r or "—",
            "pod": r or "—",
            "ldap": r or "—",
            "sentimentScore": r
        })

    return {"records": records, "total": total, "page": page, "page_size": page_size}

static_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), "static")
app.mount("/static", StaticFiles(directory=static_dir), name="static")

@app.get("/", response_class=HTMLResponse)
def serve_index():
    index_path = os.path.join(static_dir, "index.html")
    if not os.path.exists(index_path):
        raise HTTPException(status_code=404, detail="Index template missing.")
    with open(index_path, "r", encoding="utf-8") as f:
        return f.read()
