import time
from collections import Counter, deque
from datetime import datetime

import httpx
import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse

app = FastAPI(title="Fund Analyzer")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

BASE = "https://api.mfapi.in/mf"
RISK_FREE = 0.065  # assumed safe return (6.5%) used in the Sharpe ratio

cache = {}  # fund code -> (meta, nav series), so we don't call the data API twice

# ---- things the dashboard shows ----
STARTED = time.time()
stats = {"total": 0, "errors": 0, "latency_sum": 0.0}
endpoint_counts = Counter()
recent = deque(maxlen=40)  # newest request first
analyzed = {}              # fund code -> short summary of the last analysis

SKIP_LOG = ("/admin", "/dashboard", "/docs", "/redoc", "/openapi", "/favicon")


@app.middleware("http")
async def log_requests(request: Request, call_next):
    start = time.perf_counter()
    status = 500
    try:
        response = await call_next(request)
        status = response.status_code
        return response
    finally:
        path = request.url.path
        if request.method != "OPTIONS" and not path.startswith(SKIP_LOG):
            ms = (time.perf_counter() - start) * 1000
            stats["total"] += 1
            stats["latency_sum"] += ms
            if status >= 400:
                stats["errors"] += 1
            endpoint_counts["/" + path.split("/")[1]] += 1
            recent.appendleft(
                {
                    "time": datetime.now().strftime("%H:%M:%S"),
                    "method": request.method,
                    "path": path,
                    "status": status,
                    "ms": round(ms),
                }
            )


def r4(x):
    return None if x is None else round(float(x), 4)


def load_nav(code: int):
    if code in cache:
        return cache[code]
    try:
        resp = httpx.get(f"{BASE}/{code}", timeout=30)
    except httpx.HTTPError:
        raise HTTPException(502, "Could not reach the data source")
    if resp.status_code != 200:
        raise HTTPException(404, "Fund not found")

    body = resp.json()
    rows = body.get("data", [])
    if len(rows) < 30:
        raise HTTPException(404, "Not enough data for this fund")

    df = pd.DataFrame(rows)
    df["date"] = pd.to_datetime(df["date"], format="%d-%m-%Y")
    df["nav"] = df["nav"].astype(float)
    nav = df.sort_values("date").set_index("date")["nav"]  # oldest -> newest

    cache[code] = (body["meta"], nav)
    return cache[code]


def cagr_over(nav, years):
    """Average yearly growth over the last N years. None if the fund is too new."""
    end = nav.index[-1]
    start = end - pd.DateOffset(years=years)
    if nav.index[0] > start:
        return None
    start_nav = nav[:start].iloc[-1]
    return (nav.iloc[-1] / start_nav) ** (1 / years) - 1


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/search")
def search(q: str):
    try:
        resp = httpx.get(f"{BASE}/search", params={"q": q}, timeout=30)
    except httpx.HTTPError:
        raise HTTPException(502, "Could not reach the data source")
    return resp.json()[:100]


@app.get("/analyze/{code}")
def analyze(code: int):
    meta, nav = load_nav(code)

    daily = nav.pct_change().dropna()
    years = (nav.index[-1] - nav.index[0]).days / 365.25
    since_start = (nav.iloc[-1] / nav.iloc[0]) ** (1 / years) - 1

    volatility = daily.std() * np.sqrt(252)  # 252 trading days in a year
    sharpe = (since_start - RISK_FREE) / volatility if volatility > 0 else None

    drawdown = nav / nav.cummax() - 1  # how far below the previous peak
    worst_date = drawdown.idxmin()

    growth = (nav / nav.iloc[0] * 10000).resample("W").last().dropna()

    result = {
        "meta": meta,
        "latest_nav": r4(nav.iloc[-1]),
        "latest_date": nav.index[-1].strftime("%Y-%m-%d"),
        "years_of_data": round(years, 1),
        "returns": {
            "1Y": r4(cagr_over(nav, 1)),
            "3Y": r4(cagr_over(nav, 3)),
            "5Y": r4(cagr_over(nav, 5)),
            "since_start": r4(since_start),
        },
        "volatility": r4(volatility),
        "sharpe": r4(sharpe),
        "max_drawdown": r4(drawdown.min()),
        "max_drawdown_date": worst_date.strftime("%Y-%m-%d"),
        "growth_of_10000": [
            {"date": d.strftime("%Y-%m-%d"), "value": round(float(v), 2)}
            for d, v in growth.items()
        ],
    }

    analyzed.pop(code, None)  # re-analysing moves it to the end of the list
    analyzed[code] = {
        "code": code,
        "name": meta.get("scheme_name"),
        "category": meta.get("scheme_category"),
        "years": result["years_of_data"],
        "return_1y": result["returns"]["1Y"],
        "since_start": result["returns"]["since_start"],
        "sharpe": result["sharpe"],
        "max_drawdown": result["max_drawdown"],
        "at": datetime.now().strftime("%H:%M:%S"),
    }
    return result


# ---------------- SIP / lumpsum "what if I had invested" ----------------

def xirr(flows):
    """Yearly return from dated cash flows [(date, amount), ...]. None if it can't be solved."""
    t0 = flows[0][0]

    def npv(rate):
        return sum(a / (1 + rate) ** ((d - t0).days / 365.0) for d, a in flows)

    lo, hi = -0.99, 10.0
    f_lo, f_hi = npv(lo), npv(hi)
    if f_lo * f_hi > 0:
        return None
    mid = lo
    for _ in range(200):
        mid = (lo + hi) / 2
        f_mid = npv(mid)
        if abs(f_mid) < 1e-6:
            break
        if f_lo * f_mid < 0:
            hi = mid
        else:
            lo, f_lo = mid, f_mid
    return mid


def run_simulation(nav, mode, amount, years):
    """Pretend the person invested in the past and see what it is worth today.

    lumpsum: one purchase at the start date.
    sip: one purchase every month, on the first trading day on or after that date.
    Raises ValueError with a friendly message if it cannot be done.
    """
    end = nav.index[-1]
    start_target = end - pd.DateOffset(years=years)
    if nav.index[0] > start_target:
        raise ValueError(f"This fund has less than {years} years of data")

    start_date = nav[:start_target].index[-1]
    window = nav[nav.index >= start_date]
    final_nav = float(window.iloc[-1])
    held_years = (end - start_date).days / 365.25

    wk = window.resample("W").last().dropna()

    if mode == "lumpsum":
        units = amount / float(window.iloc[0])
        invested = amount
        value = units * final_nav
        annual = (value / invested) ** (1 / held_years) - 1
        units_at = np.full(len(wk), units)
        invested_at = np.full(len(wk), float(amount))
        installments = 1
    else:
        positions = []
        i = 0
        while True:
            anchor = window.index[0] + pd.DateOffset(months=i)
            pos = window.index.searchsorted(anchor)
            if anchor >= end or pos >= len(window):
                break
            positions.append(pos)
            i += 1
        sip_dates = window.index[positions]
        units_each = amount / window.values[positions]
        installments = len(positions)
        invested = amount * installments
        value = float(units_each.sum()) * final_nav

        flows = [(d, -amount) for d in sip_dates] + [(end, value)]
        annual = xirr(flows)

        cum_units = np.cumsum(units_each)
        counts = sip_dates.searchsorted(wk.index, side="right")
        units_at = np.where(counts > 0, cum_units[np.maximum(counts - 1, 0)], 0.0)
        invested_at = counts * float(amount)

    values_at = units_at * wk.values
    series = [
        {
            "date": min(d, end).strftime("%Y-%m-%d"),
            "invested": round(float(inv), 2),
            "value": round(float(val), 2),
        }
        for d, inv, val in zip(wk.index, invested_at, values_at)
    ]

    return {
        "mode": mode,
        "amount": amount,
        "years": years,
        "start_date": start_date.strftime("%Y-%m-%d"),
        "end_date": end.strftime("%Y-%m-%d"),
        "installments": installments,
        "invested": round(float(invested), 2),
        "current_value": round(float(value), 2),
        "gain": round(float(value - invested), 2),
        "absolute_return": r4(value / invested - 1),
        "annual_return": r4(annual),
        "series": series,
    }


@app.get("/simulate/{code}")
def simulate(code: int, mode: str = "sip", amount: float = 5000, years: int = 5):
    if mode not in ("sip", "lumpsum"):
        raise HTTPException(400, "mode must be 'sip' or 'lumpsum'")
    if amount <= 0 or amount > 1_000_000_000:
        raise HTTPException(400, "Enter an amount between 1 and 100 crore")
    if years < 1 or years > 40:
        raise HTTPException(400, "Years must be between 1 and 40")
    meta, nav = load_nav(code)
    try:
        return run_simulation(nav, mode, amount, years)
    except ValueError as e:
        raise HTTPException(400, str(e))


# ---------------- admin / dashboard (for local use) ----------------

@app.get("/admin/stats")
def admin_stats():
    total = stats["total"]
    return {
        "uptime_seconds": round(time.time() - STARTED),
        "total_requests": total,
        "errors": stats["errors"],
        "avg_latency_ms": round(stats["latency_sum"] / total, 1) if total else 0,
        "cached_funds": len(cache),
        "endpoint_counts": dict(endpoint_counts),
        "recent": list(recent),
        "analyzed": list(analyzed.values())[-20:][::-1],
    }


@app.post("/admin/clear-cache")
def clear_cache():
    removed = len(cache)
    cache.clear()
    analyzed.clear()
    return {"cleared": removed}


@app.get("/dashboard", response_class=HTMLResponse)
def dashboard():
    return DASHBOARD_HTML


DASHBOARD_HTML = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fund Analyzer API dashboard</title>
<style>
:root { --bg:#f4f6f8; --surface:#fff; --text:#14202e; --muted:#5b6675; --border:#dfe4ea; --accent:#14614f; --accent-soft:#e3f2ee; --on-accent:#fff; --bad:#b3382c; --ok:#14614f; --hover:#f0f3f6; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#0f151c; --surface:#171f28; --text:#e8edf2; --muted:#9aa6b5; --border:#2a3340; --accent:#4fd1a5; --accent-soft:#17302a; --on-accent:#0f151c; --bad:#f08a7e; --ok:#4fd1a5; --hover:#1f2933; }
}
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--text); font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; font-variant-numeric:tabular-nums; padding:24px; }
.wrap { max-width:1100px; margin:0 auto; }
header { display:flex; justify-content:space-between; align-items:flex-start; gap:16px; flex-wrap:wrap; margin-bottom:20px; }
h1 { margin:0; font-size:26px; letter-spacing:-0.5px; }
.sub { margin:4px 0 0; color:var(--muted); }
.links { display:flex; gap:8px; flex-wrap:wrap; }
a.btn, button { font-family:inherit; font-size:14px; cursor:pointer; border:1px solid var(--border); background:transparent; color:var(--text); border-radius:8px; padding:8px 12px; text-decoration:none; }
a.btn:hover, button:hover { background:var(--hover); }
button.primary { background:var(--accent); color:var(--on-accent); border:0; font-weight:600; }
button.danger { color:var(--bad); border-color:var(--bad); }
:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.status { display:inline-flex; align-items:center; gap:8px; font-weight:600; margin-top:10px; }
.dot { width:10px; height:10px; border-radius:50%; background:var(--muted); }
.dot.ok { background:var(--ok); }
.dot.bad { background:var(--bad); }
.cards { display:grid; grid-template-columns:repeat(5,1fr); gap:10px; margin-bottom:20px; }
.card { background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:12px; }
.card .l { font-size:13px; color:var(--muted); }
.card .v { font-size:24px; font-weight:700; margin-top:4px; }
.panel { background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:18px; margin-bottom:20px; }
.panel h2 { margin:0 0 12px; font-size:17px; }
.row { display:flex; gap:8px; }
input[type=text] { flex:1; min-width:0; padding:10px 12px; border:1px solid var(--border); border-radius:8px; background:var(--bg); color:var(--text); font-size:14px; }
.hits { margin-top:10px; max-height:220px; overflow-y:auto; }
.hit { display:block; width:100%; text-align:left; border:0; border-bottom:1px solid var(--border); border-radius:0; padding:8px 4px; }
pre { margin:12px 0 0; padding:12px; background:var(--bg); border:1px solid var(--border); border-radius:8px; max-height:300px; overflow:auto; font-size:12px; }
table { width:100%; border-collapse:collapse; font-size:14px; }
th, td { text-align:left; padding:8px 6px; border-bottom:1px solid var(--border); }
th { color:var(--muted); font-weight:600; font-size:13px; }
.empty { color:var(--muted); padding:8px 0; }
.err { color:var(--bad); }
.two { display:grid; grid-template-columns:1fr 1fr; gap:20px; }
.scroll { overflow-x:auto; }
@media (max-width:900px) { .cards { grid-template-columns:repeat(2,1fr); } .two { grid-template-columns:1fr; } }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div>
      <h1>Fund Analyzer API</h1>
      <p class="sub">Live view of the backend: requests, cached funds and a place to try the API.</p>
      <div class="status"><span id="dot" class="dot"></span><span id="status">Checking...</span></div>
    </div>
    <div class="links">
      <a class="btn" href="/docs" target="_blank">Interactive API docs</a>
      <a class="btn" href="http://localhost:5173" target="_blank">Open the app</a>
      <button class="danger" id="clear">Clear cache</button>
    </div>
  </header>

  <div class="cards">
    <div class="card"><div class="l">Uptime</div><div class="v" id="uptime">-</div></div>
    <div class="card"><div class="l">Requests</div><div class="v" id="total">-</div></div>
    <div class="card"><div class="l">Errors</div><div class="v" id="errors">-</div></div>
    <div class="card"><div class="l">Average speed</div><div class="v" id="latency">-</div></div>
    <div class="card"><div class="l">Funds cached</div><div class="v" id="cached">-</div></div>
  </div>

  <section class="panel">
    <h2>Try the API</h2>
    <div class="row">
      <input type="text" id="q" placeholder="Search a fund, e.g. parag parikh flexi cap">
      <button class="primary" id="go">Search</button>
    </div>
    <div class="hits" id="hits"></div>
    <pre id="out" hidden></pre>
  </section>

  <div class="two">
    <section class="panel">
      <h2>Recently analysed funds</h2>
      <div class="scroll"><table><thead><tr><th>Fund</th><th>1Y</th><th>Sharpe</th><th>Time</th></tr></thead><tbody id="funds"></tbody></table></div>
      <div class="empty" id="funds-empty">No funds analysed yet.</div>
    </section>
    <section class="panel">
      <h2>Recent requests</h2>
      <div class="scroll"><table><thead><tr><th>Time</th><th>Request</th><th>Status</th><th>Speed</th></tr></thead><tbody id="reqs"></tbody></table></div>
      <div class="empty" id="reqs-empty">No requests yet.</div>
    </section>
  </div>

  <section class="panel">
    <h2>Requests per endpoint</h2>
    <div id="eps" class="empty">Nothing yet.</div>
  </section>
</div>

<script>
const $ = (id) => document.getElementById(id);

function cell(tr, text, cls) {
  const td = document.createElement("td");
  td.textContent = text;
  if (cls) td.className = cls;
  tr.appendChild(td);
}

function fmtUptime(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h > 0 ? h + "h " + m + "m" : m + "m " + sec + "s";
}

function pct(x) { return x == null ? "N/A" : (x * 100).toFixed(2) + "%"; }

async function refresh() {
  try {
    const res = await fetch("/admin/stats");
    const d = await res.json();
    $("dot").className = "dot ok";
    $("status").textContent = "Online";
    $("uptime").textContent = fmtUptime(d.uptime_seconds);
    $("total").textContent = d.total_requests;
    $("errors").textContent = d.errors;
    $("latency").textContent = d.avg_latency_ms + " ms";
    $("cached").textContent = d.cached_funds;

    const funds = $("funds");
    funds.textContent = "";
    d.analyzed.forEach((f) => {
      const tr = document.createElement("tr");
      cell(tr, f.name || String(f.code));
      cell(tr, pct(f.return_1y));
      cell(tr, f.sharpe == null ? "N/A" : String(f.sharpe));
      cell(tr, f.at);
      funds.appendChild(tr);
    });
    $("funds-empty").hidden = d.analyzed.length > 0;

    const reqs = $("reqs");
    reqs.textContent = "";
    d.recent.forEach((r) => {
      const tr = document.createElement("tr");
      cell(tr, r.time);
      cell(tr, r.method + " " + r.path);
      cell(tr, String(r.status), r.status >= 400 ? "err" : "");
      cell(tr, r.ms + " ms");
      reqs.appendChild(tr);
    });
    $("reqs-empty").hidden = d.recent.length > 0;

    const names = Object.keys(d.endpoint_counts);
    $("eps").textContent = names.length
      ? names.map((n) => n + ": " + d.endpoint_counts[n]).join("   |   ")
      : "Nothing yet.";
  } catch (e) {
    $("dot").className = "dot bad";
    $("status").textContent = "Offline";
  }
}

async function search() {
  const q = $("q").value.trim();
  if (!q) return;
  const hits = $("hits");
  hits.textContent = "Searching...";
  try {
    const res = await fetch("/search?q=" + encodeURIComponent(q));
    const list = await res.json();
    hits.textContent = "";
    if (!list.length) { hits.textContent = "No funds found."; return; }
    list.slice(0, 30).forEach((f) => {
      const b = document.createElement("button");
      b.className = "hit";
      b.textContent = f.schemeName + "  (" + f.schemeCode + ")";
      b.onclick = () => analyze(f.schemeCode);
      hits.appendChild(b);
    });
  } catch (e) {
    hits.textContent = "Search failed.";
  }
}

async function analyze(code) {
  const out = $("out");
  out.hidden = false;
  out.textContent = "Analysing " + code + "...";
  try {
    const res = await fetch("/analyze/" + code);
    const d = await res.json();
    if (d.growth_of_10000) {
      d.growth_of_10000 = "[" + d.growth_of_10000.length + " weekly points hidden]";
    }
    out.textContent = JSON.stringify(d, null, 2);
  } catch (e) {
    out.textContent = "Analysis failed.";
  }
  refresh();
}

$("go").onclick = search;
$("q").addEventListener("keydown", (e) => { if (e.key === "Enter") search(); });
$("clear").onclick = async () => {
  if (!confirm("Clear the cache and the analysed list?")) return;
  await fetch("/admin/clear-cache", { method: "POST" });
  refresh();
};

refresh();
setInterval(refresh, 3000);
</script>
</body>
</html>
"""
