import { useEffect, useMemo, useState } from "react";
import {
  AreaChart, Area, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer,
} from "recharts";

const API = "http://localhost:8000";

const SUGGESTIONS = [
  "parag parikh flexi cap",
  "nifty 50 index direct",
  "sbi small cap",
  "hdfc mid cap",
  "quant active",
];

const RANGES = [
  { key: "1Y", years: 1 },
  { key: "3Y", years: 3 },
  { key: "5Y", years: 5 },
  { key: "ALL", years: null },
];

const CHART = {
  light: { line: "#14614f", grid: "#dfe4ea", axis: "#5b6675" },
  dark: { line: "#4fd1a5", grid: "#2a3340", axis: "#9aa6b5" },
};

const YEAR_OPTIONS = [1, 2, 3, 5, 7, 10, 15, 20];
const QUICK_AMOUNTS = {
  sip: [1000, 5000, 10000, 25000],
  lumpsum: [10000, 50000, 100000, 500000],
};
const DEFAULT_AMOUNT = { sip: "5000", lumpsum: "100000" };

const axisMoney = (v) =>
  "\u20B9" + (v >= 100000 ? (v / 100000).toFixed(1) + "L" : Math.round(v / 1000) + "k");

const pct = (x) => (x == null ? "N/A" : (x * 100).toFixed(2) + "%");
const inr = (v) => "\u20B9" + Math.round(v).toLocaleString("en-IN");
const tone = (x) => (x == null ? "" : x >= 0 ? "pos" : "neg");
const fmtDate = (s, opts) => new Date(s).toLocaleDateString("en-IN", opts);

const isGrowth = (n) => /growth/i.test(n) && !/idcw|dividend|payout|reinvest/i.test(n);
const isDirect = (n) => /direct/i.test(n);
const planBadge = (n) => (isDirect(n) ? "Direct" : /regular/i.test(n) ? "Regular" : "");
const optionBadge = (n) => (isGrowth(n) ? "Growth" : /idcw|dividend/i.test(n) ? "IDCW" : "");

function Stat({ label, value, valueTone, hint }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className={"stat-value " + (valueTone || "")}>{value}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

function ChartTip({ active, payload }) {
  if (!active || !payload || !payload.length) return null;
  const p = payload[0].payload;
  return (
    <div className="tip">
      <div>{fmtDate(p.date, { day: "numeric", month: "short", year: "numeric" })}</div>
      <strong>{inr(p.value)}</strong>
    </div>
  );
}

function SimTip({ active, payload }) {
  if (!active || !payload || !payload.length) return null;
  const p = payload[0].payload;
  return (
    <div className="tip">
      <div>{fmtDate(p.date, { day: "numeric", month: "short", year: "numeric" })}</div>
      <div>Put in: <strong>{inr(p.invested)}</strong></div>
      <div>Worth: <strong>{inr(p.value)}</strong></div>
    </div>
  );
}

export default function App() {
  const [theme, setTheme] = useState(() =>
    window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light"
  );
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [searched, setSearched] = useState(false);
  const [growthOnly, setGrowthOnly] = useState(true);
  const [directOnly, setDirectOnly] = useState(false);
  const [selected, setSelected] = useState(null);
  const [data, setData] = useState(null);
  const [range, setRange] = useState("ALL");
  const [loading, setLoading] = useState("");
  const [error, setError] = useState("");
  const [mode, setMode] = useState("sip");
  const [amount, setAmount] = useState(DEFAULT_AMOUNT.sip);
  const [simYears, setSimYears] = useState(5);
  const [sim, setSim] = useState(null);
  const [simLoading, setSimLoading] = useState(false);
  const [simError, setSimError] = useState("");

  async function runSearch(term) {
    const text = (term ?? q).trim();
    if (!text) return;
    setQ(text);
    setLoading("search");
    setError("");
    try {
      const res = await fetch(`${API}/search?q=${encodeURIComponent(text)}`);
      if (!res.ok) throw new Error();
      setResults(await res.json());
      setSearched(true);
    } catch {
      setError("Could not reach the backend. Check that it is running on port 8000.");
    } finally {
      setLoading("");
    }
  }

  async function analyze(code) {
    setSelected(code);
    setLoading("analyze");
    setError("");
    setData(null);
    setRange("ALL");
    try {
      const res = await fetch(`${API}/analyze/${code}`);
      if (!res.ok) throw new Error();
      setData(await res.json());
    } catch {
      setError("Could not analyse this fund. Try another one.");
    } finally {
      setLoading("");
    }
  }

  const visible = useMemo(
    () =>
      results.filter(
        (r) =>
          (!growthOnly || isGrowth(r.schemeName)) &&
          (!directOnly || isDirect(r.schemeName))
      ),
    [results, growthOnly, directOnly]
  );

  const series = useMemo(() => {
    if (!data) return [];
    const all = data.growth_of_10000;
    const r = RANGES.find((x) => x.key === range);
    let sub = all;
    if (r && r.years) {
      const end = new Date(all[all.length - 1].date);
      const start = new Date(end);
      start.setFullYear(end.getFullYear() - r.years);
      sub = all.filter((p) => new Date(p.date) >= start);
    }
    if (!sub.length) return [];
    const base = sub[0].value;
    return sub.map((p) => ({ date: p.date, value: (p.value / base) * 10000 }));
  }, [data, range]);

  const finalValue = series.length ? series[series.length - 1].value : null;
  const periodGain = finalValue == null ? null : finalValue / 10000 - 1;
  const colors = CHART[theme];
  const activeRange = RANGES.find((x) => x.key === range);

  const yearOptions = data
    ? YEAR_OPTIONS.filter((y) => y <= Math.floor(data.years_of_data - 0.1))
    : [];
  const activeYears = yearOptions.includes(simYears)
    ? simYears
    : yearOptions[yearOptions.length - 1];

  // Re-run the calculation shortly after the person stops typing or changes a choice.
  useEffect(() => {
    const amt = parseInt(amount, 10);
    if (!data || !selected || !activeYears || !amt || amt <= 0) {
      setSim(null);
      setSimError("");
      setSimLoading(false);
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setSimLoading(true);
      setSimError("");
      try {
        const res = await fetch(
          `${API}/simulate/${selected}?mode=${mode}&amount=${amt}&years=${activeYears}`
        );
        const body = await res.json();
        if (!res.ok) {
          throw new Error(typeof body.detail === "string" ? body.detail : "Could not run the calculation.");
        }
        if (!cancelled) setSim(body);
      } catch (e) {
        if (!cancelled) {
          setSim(null);
          setSimError(e.message || "Could not run the calculation.");
        }
      } finally {
        if (!cancelled) setSimLoading(false);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [data, selected, mode, amount, activeYears]);

  function switchMode(m) {
    setMode(m);
    setAmount(DEFAULT_AMOUNT[m]);
  }

  return (
    <div className="app" data-theme={theme}>
      <style>{css}</style>

      <header className="top">
        <div>
          <h1>Fund Analyzer</h1>
          <p className="sub">Past performance of Indian mutual funds, worked out from public NAV data.</p>
        </div>
        <button
          className="ghost"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          aria-label="Switch between light and dark mode"
        >
          {theme === "dark" ? "Light mode" : "Dark mode"}
        </button>
      </header>

      {error && <div className="alert" role="alert">{error}</div>}

      <div className="layout">
        <aside className="panel finder">
          <label className="field-label" htmlFor="fund-search">Find a fund</label>
          <div className="search-row">
            <input
              id="fund-search"
              value={q}
              placeholder="e.g. parag parikh direct growth"
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && runSearch()}
            />
            <button className="primary" onClick={() => runSearch()} disabled={loading === "search"}>
              {loading === "search" ? "Searching" : "Search"}
            </button>
          </div>

          <div className="chips">
            {SUGGESTIONS.map((s) => (
              <button key={s} className="chip" onClick={() => runSearch(s)}>{s}</button>
            ))}
          </div>

          <div className="filters">
            <label>
              <input type="checkbox" checked={growthOnly} onChange={(e) => setGrowthOnly(e.target.checked)} />
              Growth plans only
            </label>
            <label>
              <input type="checkbox" checked={directOnly} onChange={(e) => setDirectOnly(e.target.checked)} />
              Direct plans only
            </label>
          </div>

          {searched && (
            <div className="count">
              {visible.length} of {results.length} results shown
            </div>
          )}

          <div className="results">
            {visible.map((r) => (
              <button
                key={r.schemeCode}
                className={"row " + (selected === r.schemeCode ? "active" : "")}
                onClick={() => analyze(r.schemeCode)}
              >
                <span className="row-name">{r.schemeName}</span>
                <span className="row-badges">
                  {planBadge(r.schemeName) && <span className="badge">{planBadge(r.schemeName)}</span>}
                  {optionBadge(r.schemeName) && <span className="badge">{optionBadge(r.schemeName)}</span>}
                </span>
              </button>
            ))}
            {searched && visible.length === 0 && (
              <div className="empty-small">
                No matches with these filters. Try switching a filter off or searching a shorter name.
              </div>
            )}
            {!searched && (
              <div className="empty-small">Search for a fund, then click a result to analyse it.</div>
            )}
          </div>
        </aside>

        <main className="panel detail">
          {loading === "analyze" && (
            <div className="loading">
              <div className="spinner" />
              <div>Downloading NAV history and working out the numbers...</div>
            </div>
          )}

          {!data && loading !== "analyze" && (
            <div className="empty">
              <h2>Pick a fund to see how it did</h2>
              <p>You will see yearly returns, how bumpy the ride was, the worst fall, and a growth chart.</p>
              <p className="muted">Tip: choose Growth plans. IDCW plans pay money out, which pulls the NAV down and makes the returns look worse than they were.</p>
            </div>
          )}

          {data && loading !== "analyze" && (
            <>
              <h2 className="fund-name">{data.meta.scheme_name}</h2>
              <div className="meta">
                <span className="muted">{data.meta.fund_house}</span>
                <span className="badge">{data.meta.scheme_category}</span>
                <span className="muted">{data.years_of_data} years of data</span>
              </div>
              <div className="nav-line">
                Latest NAV <strong>{"\u20B9"}{data.latest_nav}</strong> on {fmtDate(data.latest_date, { day: "numeric", month: "short", year: "numeric" })}
              </div>

              <h3 className="section">Returns</h3>
              <div className="grid4">
                <Stat label="1 year" value={pct(data.returns["1Y"])} valueTone={tone(data.returns["1Y"])} />
                <Stat label="3 years" value={pct(data.returns["3Y"])} valueTone={tone(data.returns["3Y"])} hint="per year" />
                <Stat label="5 years" value={pct(data.returns["5Y"])} valueTone={tone(data.returns["5Y"])} hint="per year" />
                <Stat label="Since start" value={pct(data.returns.since_start)} valueTone={tone(data.returns.since_start)} hint="per year" />
              </div>

              <h3 className="section">Risk</h3>
              <div className="grid3">
                <Stat label="Volatility" value={pct(data.volatility)} hint="How much the price jumps around in a year. Lower is calmer." />
                <Stat
                  label="Sharpe ratio"
                  value={data.sharpe ?? "N/A"}
                  valueTone={data.sharpe == null ? "" : data.sharpe >= 1 ? "pos" : data.sharpe < 0 ? "neg" : ""}
                  hint="Return for each unit of risk. Above 1 is generally good."
                />
                <Stat
                  label="Max drawdown"
                  value={pct(data.max_drawdown)}
                  valueTone="neg"
                  hint={"Biggest fall from a peak, bottoming around " + fmtDate(data.max_drawdown_date, { month: "short", year: "numeric" }) + "."}
                />
              </div>

              <div className="chart-head">
                <h3 className="section">
                  {activeRange && activeRange.years
                    ? "\u20B910,000 invested " + activeRange.years + (activeRange.years === 1 ? " year ago" : " years ago")
                    : "\u20B910,000 invested at the start"}
                </h3>
                <div className="seg" role="group" aria-label="Chart period">
                  {RANGES.map((r) => {
                    const disabled = r.years != null && data.years_of_data < r.years;
                    return (
                      <button
                        key={r.key}
                        className={range === r.key ? "on" : ""}
                        aria-pressed={range === r.key}
                        disabled={disabled}
                        onClick={() => setRange(r.key)}
                      >
                        {r.key}
                      </button>
                    );
                  })}
                </div>
              </div>

              {finalValue != null && (
                <div className="result-line">
                  Would be worth <strong>{inr(finalValue)}</strong> today
                  <span className={"gain " + tone(periodGain)}>
                    {periodGain >= 0 ? "+" : ""}{(periodGain * 100).toFixed(1)}% in total
                  </span>
                </div>
              )}

              <div className="chart-box">
                <ResponsiveContainer>
                  <AreaChart data={series} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
                    <defs>
                      <linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={colors.line} stopOpacity={0.28} />
                        <stop offset="100%" stopColor={colors.line} stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke={colors.grid} strokeDasharray="3 3" />
                    <XAxis
                      dataKey="date"
                      minTickGap={50}
                      tick={{ fill: colors.axis, fontSize: 12 }}
                      tickFormatter={(s) => fmtDate(s, { month: "short", year: "2-digit" })}
                    />
                    <YAxis
                      width={56}
                      domain={["auto", "auto"]}
                      tick={{ fill: colors.axis, fontSize: 12 }}
                      tickFormatter={(v) =>
                        "\u20B9" + (v >= 100000 ? (v / 100000).toFixed(1) + "L" : Math.round(v / 1000) + "k")
                      }
                    />
                    <Tooltip content={<ChartTip />} />
                    <Area type="monotone" dataKey="value" stroke={colors.line} strokeWidth={2} fill="url(#fill)" dot={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>

              <h3 className="section">What if I had invested?</h3>
              <div className="calc">
                <div className="seg" role="group" aria-label="Investment type">
                  <button
                    className={mode === "sip" ? "on" : ""}
                    aria-pressed={mode === "sip"}
                    onClick={() => switchMode("sip")}
                  >
                    SIP (every month)
                  </button>
                  <button
                    className={mode === "lumpsum" ? "on" : ""}
                    aria-pressed={mode === "lumpsum"}
                    onClick={() => switchMode("lumpsum")}
                  >
                    Lumpsum (one time)
                  </button>
                </div>

                {yearOptions.length === 0 ? (
                  <p className="muted">This fund does not have enough history for the calculator.</p>
                ) : (
                  <>
                    <div className="calc-inputs">
                      <div>
                        <label className="field-label" htmlFor="amount">
                          {mode === "sip" ? "Amount every month" : "Amount invested once"}
                        </label>
                        <div className="amount-wrap">
                          <span className="rupee">{"\u20B9"}</span>
                          <input
                            id="amount"
                            type="text"
                            inputMode="numeric"
                            value={amount}
                            onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, "").slice(0, 9))}
                          />
                        </div>
                      </div>
                      <div>
                        <label className="field-label" htmlFor="years">For how long</label>
                        <select
                          id="years"
                          value={activeYears}
                          onChange={(e) => setSimYears(parseInt(e.target.value, 10))}
                        >
                          {yearOptions.map((y) => (
                            <option key={y} value={y}>
                              {y} {y === 1 ? "year" : "years"}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                    <div className="chips">
                      {QUICK_AMOUNTS[mode].map((a) => (
                        <button key={a} className="chip" onClick={() => setAmount(String(a))}>
                          {inr(a)}
                        </button>
                      ))}
                    </div>
                  </>
                )}

                {simError && <div className="alert-inline">{simError}</div>}
                {simLoading && !sim && <div className="calc-note">Working it out...</div>}

                {sim && (
                  <div className={simLoading ? "calc-out dim" : "calc-out"}>
                    <p className="calc-note">
                      {sim.mode === "sip"
                        ? sim.installments + " monthly instalments of " + inr(sim.amount) +
                          ", from " + fmtDate(sim.start_date, { month: "short", year: "numeric" }) +
                          " to " + fmtDate(sim.end_date, { month: "short", year: "numeric" }) + "."
                        : inr(sim.amount) + " invested on " +
                          fmtDate(sim.start_date, { day: "numeric", month: "short", year: "numeric" }) +
                          " and held until " +
                          fmtDate(sim.end_date, { day: "numeric", month: "short", year: "numeric" }) + "."}
                    </p>

                    <div className="grid4">
                      <Stat label="You put in" value={inr(sim.invested)} />
                      <Stat
                        label="It would be worth"
                        value={inr(sim.current_value)}
                        valueTone={tone(sim.gain)}
                      />
                      <Stat
                        label={sim.gain >= 0 ? "Profit" : "Loss"}
                        value={(sim.gain >= 0 ? "+" : "-") + inr(Math.abs(sim.gain))}
                        valueTone={tone(sim.gain)}
                        hint={pct(sim.absolute_return) + " in total"}
                      />
                      <Stat
                        label="Yearly return"
                        value={pct(sim.annual_return)}
                        valueTone={tone(sim.annual_return)}
                        hint={sim.mode === "sip" ? "XIRR (accounts for when each instalment went in)" : "CAGR"}
                      />
                    </div>

                    <div className="chart-box small">
                      <ResponsiveContainer>
                        <LineChart data={sim.series} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
                          <CartesianGrid stroke={colors.grid} strokeDasharray="3 3" />
                          <XAxis
                            dataKey="date"
                            minTickGap={50}
                            tick={{ fill: colors.axis, fontSize: 12 }}
                            tickFormatter={(s) => fmtDate(s, { month: "short", year: "2-digit" })}
                          />
                          <YAxis
                            width={56}
                            domain={["auto", "auto"]}
                            tick={{ fill: colors.axis, fontSize: 12 }}
                            tickFormatter={axisMoney}
                          />
                          <Tooltip content={<SimTip />} />
                          <Line type="monotone" dataKey="invested" stroke={colors.axis} strokeWidth={2} strokeDasharray="5 4" dot={false} />
                          <Line type="monotone" dataKey="value" stroke={colors.line} strokeWidth={2} dot={false} />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                    <div className="legend">
                      <span className="legend-item"><span className="swatch dashed" />Money you put in</span>
                      <span className="legend-item"><span className="swatch" />What it was worth</span>
                    </div>
                    <p className="calc-note">
                      This replays the fund's real past prices. It does not predict the future. Taxes and exit
                      loads are not included.
                    </p>
                  </div>
                )}
              </div>

              <p className="disclaimer">
                Based on past data only. Past performance does not predict future returns.
                3-year, 5-year and since-start figures are yearly averages (CAGR). This is a learning project, not financial advice.
              </p>
            </>
          )}
        </main>
      </div>
    </div>
  );
}

const css = `
html, body, #root { margin: 0; padding: 0; max-width: none; text-align: left; }
.app {
  --bg: #f4f6f8; --surface: #ffffff; --text: #14202e; --muted: #5b6675;
  --border: #dfe4ea; --accent: #14614f; --accent-soft: #e3f2ee; --on-accent: #ffffff;
  --pos: #14614f; --neg: #b3382c; --hover: #f0f3f6;
  min-height: 100vh; background: var(--bg); color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  padding: 24px; box-sizing: border-box; font-variant-numeric: tabular-nums;
}
.app[data-theme="dark"] {
  --bg: #0f151c; --surface: #171f28; --text: #e8edf2; --muted: #9aa6b5;
  --border: #2a3340; --accent: #4fd1a5; --accent-soft: #17302a; --on-accent: #0f151c;
  --pos: #4fd1a5; --neg: #f08a7e; --hover: #1f2933;
}
.app * { box-sizing: border-box; }
.top { max-width: 1200px; margin: 0 auto 20px; display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
h1 { margin: 0; font-size: 28px; letter-spacing: -0.5px; }
.sub { margin: 4px 0 0; color: var(--muted); }
.layout { max-width: 1200px; margin: 0 auto; display: grid; grid-template-columns: 360px 1fr; gap: 20px; align-items: start; }
.panel { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 18px; }
.field-label { display: block; font-weight: 600; margin-bottom: 8px; }
.search-row { display: flex; gap: 8px; }
.search-row input { flex: 1; min-width: 0; }
input[type="text"], .search-row input {
  padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px;
  background: var(--bg); color: var(--text); font-size: 14px;
}
button { font-family: inherit; font-size: 14px; cursor: pointer; }
button:disabled { cursor: not-allowed; opacity: 0.5; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.primary { background: var(--accent); color: var(--on-accent); border: 0; border-radius: 8px; padding: 10px 16px; font-weight: 600; }
.ghost { background: transparent; color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 8px 12px; white-space: nowrap; }
.ghost:hover { background: var(--hover); }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.chip { background: var(--accent-soft); color: var(--accent); border: 0; border-radius: 999px; padding: 5px 10px; font-size: 12px; }
.filters { display: flex; flex-direction: column; gap: 6px; margin: 14px 0 8px; font-size: 14px; }
.filters label { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.count { font-size: 12px; color: var(--muted); margin-bottom: 6px; }
.results { max-height: 58vh; overflow-y: auto; border-top: 1px solid var(--border); }
.row { display: block; width: 100%; text-align: left; background: transparent; color: var(--text); border: 0; border-bottom: 1px solid var(--border); padding: 10px 6px; }
.row:hover { background: var(--hover); }
.row.active { background: var(--accent-soft); box-shadow: inset 3px 0 0 var(--accent); }
.row-name { display: block; font-size: 14px; line-height: 1.35; }
.row-badges { display: flex; gap: 6px; margin-top: 5px; }
.badge { display: inline-block; font-size: 12px; padding: 2px 8px; border-radius: 6px; border: 1px solid var(--border); color: var(--muted); }
.empty-small { padding: 14px 6px; color: var(--muted); font-size: 14px; }
.alert { max-width: 1200px; margin: 0 auto 16px; padding: 12px 14px; border-radius: 8px; border: 1px solid var(--neg); color: var(--neg); background: var(--surface); }
.detail { min-height: 420px; }
.empty { padding: 40px 12px; max-width: 460px; }
.empty h2 { margin: 0 0 8px; }
.muted { color: var(--muted); }
.loading { display: flex; align-items: center; gap: 14px; padding: 40px 8px; color: var(--muted); }
.spinner { width: 22px; height: 22px; border-radius: 50%; border: 3px solid var(--border); border-top-color: var(--accent); animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.fund-name { margin: 0; font-size: 22px; line-height: 1.3; }
.meta { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-top: 8px; }
.nav-line { margin-top: 8px; color: var(--muted); }
.nav-line strong { color: var(--text); }
.section { margin: 22px 0 10px; font-size: 16px; }
.grid4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
.grid3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.stat { border: 1px solid var(--border); border-radius: 10px; padding: 12px; }
.stat-label { font-size: 13px; color: var(--muted); }
.stat-value { font-size: 24px; font-weight: 700; margin-top: 4px; }
.stat-value.pos { color: var(--pos); }
.stat-value.neg { color: var(--neg); }
.stat-hint { font-size: 12px; color: var(--muted); margin-top: 4px; line-height: 1.4; }
.chart-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
.chart-head .section { margin-bottom: 0; }
.seg { display: inline-flex; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.seg button { background: transparent; color: var(--text); border: 0; padding: 6px 12px; }
.seg button.on { background: var(--accent); color: var(--on-accent); font-weight: 600; }
.result-line { margin: 12px 0 6px; }
.gain { margin-left: 10px; font-size: 13px; font-weight: 600; }
.gain.pos { color: var(--pos); }
.gain.neg { color: var(--neg); }
.chart-box { height: 320px; margin-top: 8px; }
.tip { background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; font-size: 13px; }
.disclaimer { margin-top: 18px; font-size: 12px; color: var(--muted); line-height: 1.5; }
.calc { border: 1px solid var(--border); border-radius: 10px; padding: 14px; }
.calc-inputs { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 14px; }
.amount-wrap { position: relative; }
.rupee { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: var(--muted); }
.amount-wrap input { width: 100%; padding: 10px 12px 10px 28px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); color: var(--text); font-size: 16px; }
select { width: 100%; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); color: var(--text); font-size: 16px; }
.calc-out { margin-top: 14px; }
.calc-out.dim { opacity: 0.55; }
.calc-note { font-size: 13px; color: var(--muted); margin: 10px 0; line-height: 1.5; }
.chart-box.small { height: 260px; }
.legend { display: flex; gap: 16px; flex-wrap: wrap; font-size: 12px; color: var(--muted); margin-top: 6px; }
.legend-item { display: inline-flex; align-items: center; gap: 6px; }
.swatch { display: inline-block; width: 18px; height: 0; border-top: 2px solid var(--accent); }
.swatch.dashed { border-top: 2px dashed var(--muted); }
.alert-inline { margin-top: 12px; color: var(--neg); font-size: 14px; }
@media (max-width: 600px) {
  .calc-inputs { grid-template-columns: 1fr; }
}
@media (max-width: 900px) {
  .layout { grid-template-columns: 1fr; }
  .grid4 { grid-template-columns: repeat(2, 1fr); }
  .grid3 { grid-template-columns: 1fr; }
  .results { max-height: 40vh; }
}
`;
