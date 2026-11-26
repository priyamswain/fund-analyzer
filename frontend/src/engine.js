// Browser version of the Fund Analyzer backend.
//
// GitHub Pages can only host static files, so it cannot run the Python (FastAPI) server.
// This file does the same job inside the visitor's browser: it fetches NAV history from the
// public MFapi.in API and works out returns, risk and SIP / lumpsum results with the same
// formulas as backend/main.py. The three functions at the bottom (search, analyze, simulate)
// mirror the three backend endpoints, and every call is logged for the "Backend" tab.

const BASE = "https://api.mfapi.in/mf";
const RISK_FREE = 0.065; // assumed safe return (6.5%) used in the Sharpe ratio
const DAY = 86400000;

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------- small helpers
const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10000) / 10000);
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

function parseDMY(s) {
  const m = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(String(s).trim());
  return m ? Date.UTC(+m[3], +m[2] - 1, +m[1]) : NaN;
}

// Add whole months, keeping the day of month where possible (31 Jan + 1 month = 28/29 Feb).
function addMonths(ms, k) {
  const d = new Date(ms);
  const total = d.getUTCFullYear() * 12 + d.getUTCMonth() + k;
  const y = Math.floor(total / 12);
  const m = total - y * 12;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return Date.UTC(y, m, Math.min(d.getUTCDate(), lastDay));
}

// First index whose value is >= x, and first index whose value is > x (arrays sorted ascending).
function searchLeft(arr, x) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
function searchRight(arr, x) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Last value of each week. Weeks end on Sunday, and each week is labelled with that Sunday.
function weeklyLast(dates, values) {
  const labels = [];
  const vals = [];
  let current = null;
  for (let i = 0; i < dates.length; i += 1) {
    const dow = new Date(dates[i]).getUTCDay(); // 0 = Sunday
    const label = dates[i] + ((7 - dow) % 7) * DAY;
    if (label === current) {
      vals[vals.length - 1] = values[i];
    } else {
      labels.push(label);
      vals.push(values[i]);
      current = label;
    }
  }
  return { labels, vals };
}

function xirr(flows) {
  const t0 = flows[0][0];
  const npv = (rate) =>
    flows.reduce((sum, [d, a]) => sum + a / Math.pow(1 + rate, (d - t0) / DAY / 365.0), 0);
  let lo = -0.99;
  let hi = 10.0;
  let fLo = npv(lo);
  const fHi = npv(hi);
  if (fLo * fHi > 0) return null;
  let mid = lo;
  for (let i = 0; i < 200; i += 1) {
    mid = (lo + hi) / 2;
    const fMid = npv(mid);
    if (Math.abs(fMid) < 1e-6) break;
    if (fLo * fMid < 0) {
      hi = mid;
    } else {
      lo = mid;
      fLo = fMid;
    }
  }
  return mid;
}

function cagrOver(dates, navs, years) {
  const n = navs.length;
  const start = addMonths(dates[n - 1], -12 * years);
  if (dates[0] > start) return null;
  const startNav = navs[searchRight(dates, start) - 1];
  return Math.pow(navs[n - 1] / startNav, 1 / years) - 1;
}

// ---------------------------------------------------------------- the maths (same as backend/main.py)
export function parseRows(rows) {
  const pairs = [];
  for (const row of rows || []) {
    const d = parseDMY(row.date);
    const v = parseFloat(row.nav);
    if (Number.isFinite(d) && Number.isFinite(v) && v > 0) pairs.push([d, v]);
  }
  pairs.sort((a, b) => a[0] - b[0]); // oldest -> newest
  return { dates: pairs.map((p) => p[0]), navs: pairs.map((p) => p[1]) };
}

export function analyzeSeries(meta, dates, navs) {
  const n = navs.length;
  const years = (dates[n - 1] - dates[0]) / DAY / 365.25;
  const sinceStart = Math.pow(navs[n - 1] / navs[0], 1 / years) - 1;

  const rets = [];
  for (let i = 1; i < n; i += 1) rets.push(navs[i] / navs[i - 1] - 1);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (rets.length - 1);
  const volatility = Math.sqrt(variance) * Math.sqrt(252); // 252 trading days in a year
  const sharpe = volatility > 0 ? (sinceStart - RISK_FREE) / volatility : null;

  let peak = -Infinity;
  let minDd = 0;
  let minIdx = 0;
  for (let i = 0; i < n; i += 1) {
    if (navs[i] > peak) peak = navs[i];
    const dd = navs[i] / peak - 1;
    if (dd < minDd) {
      minDd = dd;
      minIdx = i;
    }
  }

  const wk = weeklyLast(dates, navs);
  const growth = wk.labels.map((d, i) => ({
    date: iso(d),
    value: r2((wk.vals[i] / navs[0]) * 10000),
  }));

  return {
    meta,
    latest_nav: r4(navs[n - 1]),
    latest_date: iso(dates[n - 1]),
    years_of_data: Math.round(years * 10) / 10,
    returns: {
      "1Y": r4(cagrOver(dates, navs, 1)),
      "3Y": r4(cagrOver(dates, navs, 3)),
      "5Y": r4(cagrOver(dates, navs, 5)),
      since_start: r4(sinceStart),
    },
    volatility: r4(volatility),
    sharpe: r4(sharpe),
    max_drawdown: r4(minDd),
    max_drawdown_date: iso(dates[minIdx]),
    growth_of_10000: growth,
  };
}

export function simulateSeries(dates, navs, mode, amount, years) {
  const n = navs.length;
  const end = dates[n - 1];
  const startTarget = addMonths(end, -12 * years);
  if (dates[0] > startTarget) {
    throw new ApiError(400, `This fund has less than ${years} years of data`);
  }

  const s0 = searchRight(dates, startTarget) - 1;
  const wd = dates.slice(s0);
  const wn = navs.slice(s0);
  const finalNav = wn[wn.length - 1];
  const heldYears = (end - wd[0]) / DAY / 365.25;
  const wk = weeklyLast(wd, wn);

  let invested;
  let value;
  let annual;
  let installments;
  let unitsAt;
  let investedAt;

  if (mode === "lumpsum") {
    const units = amount / wn[0];
    invested = amount;
    value = units * finalNav;
    annual = Math.pow(value / invested, 1 / heldYears) - 1;
    unitsAt = wk.labels.map(() => units);
    investedAt = wk.labels.map(() => amount);
    installments = 1;
  } else {
    const positions = [];
    for (let i = 0; ; i += 1) {
      const anchor = addMonths(wd[0], i);
      const pos = searchLeft(wd, anchor);
      if (anchor >= end || pos >= wd.length) break;
      positions.push(pos);
    }
    const sipDates = positions.map((p) => wd[p]);
    const unitsEach = positions.map((p) => amount / wn[p]);
    installments = positions.length;
    invested = amount * installments;
    value = unitsEach.reduce((a, b) => a + b, 0) * finalNav;

    annual = xirr([...sipDates.map((d) => [d, -amount]), [end, value]]);

    const cum = [];
    unitsEach.reduce((acc, u) => {
      cum.push(acc + u);
      return acc + u;
    }, 0);
    const counts = wk.labels.map((label) => searchRight(sipDates, label));
    unitsAt = counts.map((c) => (c > 0 ? cum[c - 1] : 0));
    investedAt = counts.map((c) => c * amount);
  }

  const series = wk.labels.map((label, i) => ({
    date: iso(Math.min(label, end)),
    invested: r2(investedAt[i]),
    value: r2(unitsAt[i] * wk.vals[i]),
  }));

  return {
    mode,
    amount,
    years,
    start_date: iso(wd[0]),
    end_date: iso(end),
    installments,
    invested: r2(invested),
    current_value: r2(value),
    gain: r2(value - invested),
    absolute_return: r4(value / invested - 1),
    annual_return: r4(annual),
    series,
  };
}

// ---------------------------------------------------------------- request log (for the Backend tab)
const STARTED = Date.now();
const stats = { total: 0, errors: 0, latencySum: 0 };
const recent = []; // newest first
const analyzed = new Map(); // fund code -> short summary
const cache = new Map(); // fund code -> { meta, dates, navs }

function record(path, status, ms) {
  stats.total += 1;
  stats.latencySum += ms;
  if (status >= 400) stats.errors += 1;
  recent.unshift({
    time: new Date().toLocaleTimeString("en-GB"),
    method: "GET",
    path,
    status,
    ms: Math.round(ms),
  });
  if (recent.length > 40) recent.pop();
}

async function tracked(path, fn) {
  const t0 = performance.now();
  let status = 200;
  try {
    return await fn();
  } catch (e) {
    status = e instanceof ApiError ? e.status : 500;
    throw e;
  } finally {
    record(path, status, performance.now() - t0);
  }
}

export function getStats() {
  return {
    uptimeSeconds: Math.round((Date.now() - STARTED) / 1000),
    total: stats.total,
    errors: stats.errors,
    avgMs: stats.total ? Math.round((stats.latencySum / stats.total) * 10) / 10 : 0,
    cached: cache.size,
    recent: recent.slice(),
    analyzed: Array.from(analyzed.values()).reverse().slice(0, 20),
  };
}

export function clearCache() {
  const removed = cache.size;
  cache.clear();
  analyzed.clear();
  return removed;
}

// ---------------------------------------------------------------- talking to MFapi.in
async function fetchJson(url) {
  let res;
  try {
    res = await fetch(url);
  } catch {
    throw new ApiError(502, "Could not reach the fund data source. Check your internet connection and try again.");
  }
  if (!res.ok) {
    if (res.status === 404) throw new ApiError(404, "Fund not found");
    throw new ApiError(502, "The fund data source returned an error. Try again in a moment.");
  }
  try {
    return await res.json();
  } catch {
    throw new ApiError(502, "The fund data source sent an unreadable response.");
  }
}

async function loadNav(code) {
  if (cache.has(code)) return cache.get(code);
  const body = await fetchJson(`${BASE}/${code}`);
  const { dates, navs } = parseRows(body && body.data);
  if (dates.length < 30) throw new ApiError(404, "Not enough data for this fund");
  const entry = { meta: (body && body.meta) || {}, dates, navs };
  cache.set(code, entry);
  return entry;
}

// ---------------------------------------------------------------- the three "endpoints"
export function search(q) {
  return tracked("/search", async () => {
    const list = await fetchJson(`${BASE}/search?q=${encodeURIComponent(q)}`);
    return Array.isArray(list) ? list.slice(0, 100) : [];
  });
}

export function analyze(code) {
  return tracked(`/analyze/${code}`, async () => {
    const { meta, dates, navs } = await loadNav(code);
    const result = analyzeSeries(meta, dates, navs);
    analyzed.delete(code); // re-analysing moves it to the end of the list
    analyzed.set(code, {
      code,
      name: meta.scheme_name,
      years: result.years_of_data,
      return1y: result.returns["1Y"],
      sharpe: result.sharpe,
      at: new Date().toLocaleTimeString("en-GB"),
    });
    return result;
  });
}

export function simulate(code, mode, amount, years) {
  return tracked(`/simulate/${code}`, async () => {
    if (mode !== "sip" && mode !== "lumpsum") throw new ApiError(400, "mode must be 'sip' or 'lumpsum'");
    if (!(amount > 0) || amount > 1e9) throw new ApiError(400, "Enter an amount between 1 and 100 crore");
    if (!(years >= 1 && years <= 40)) throw new ApiError(400, "Years must be between 1 and 40");
    const { dates, navs } = await loadNav(code);
    return simulateSeries(dates, navs, mode, amount, years);
  });
}
