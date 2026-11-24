const $ = (s) => document.querySelector(s);
const state = { profile: localStorage.getItem("profile") || "basic", filter: "all", data: null };
const inr = (x) => x == null ? "–" : (x < 0 ? "−₹" : "₹") + Math.abs(Math.round(x)).toLocaleString("en-IN");
const num = (x) => x == null ? "–" : (+x).toLocaleString("en-IN", { maximumFractionDigits: 2 });
const HZ = { intraday: "Intraday", btst: "BTST", positional: "2–3 days" };
const AGENT = { momentum: "Opening-range breakout", oiBuildup: "OI build-up", gap: "Gap", btst: "BTST close", breakout15: "15-min breakout (A/D)",
  trigger5: "5-min trigger (B)", preBreakout: "Pre-breakout (C)", vaSweep: "Value-area sweep", emaReclaim: "EMA20 reclaim", avwapReclaim: "Anchored VWAP reclaim",
  indexScalp: "Index scalp", swing: "Swing breakout", premiumDecay: "Premium decay", expiryDecay: "Expiry decay", heroZero: "Hero-Zero (expiry)" };
const agentName = (a) => AGENT[a] ?? (a.startsWith("custom:") ? "Your scanner" : a);
const STRUCT = { future: "Future", long_option: "Option buy", debit_spread: "Debit spread", credit_spread: "Credit spread",
  iron_fly: "Iron fly", iron_condor: "Iron condor", short_strangle: "Short strangle (naked)", fut_hedge: "Future + protective option", long_straddle: "Long straddle", long_strangle: "OTM strangle (hero-zero)" };
const scoreColor = (s) => s >= 75 ? "var(--green)" : s >= 60 ? "var(--amber)" : "var(--mut)";

async function get(path) {
  const r = await fetch(path, { credentials: "include" });
  if (r.status === 401) { $("#login").showModal(); throw new Error("login"); }
  return r.json();
}

function legs(c) {
  return c.legs.map((l) => {
    const what = l.kind === "FUT" ? `${c.root} FUT` : `${c.root} ${num(l.strike)} ${l.kind}`;
    return `<div><span class="${l.side > 0 ? "buy" : "sell"}">${l.side > 0 ? "BUY " : "SELL"}</span> ${what} <span style="color:var(--mut)">@ ${num(l.price)}${l.expiry ? " · " + l.expiry.slice(5) : ""}</span></div>`;
  }).join("");
}

function levels(c) {
  const L = c.levels, u = c.underlying;
  const basis = { premium: "net premium", credit: "credit / buy-back", underlying: c.kind === "COMMODITY" ? "future price" : "future price" }[L.basis];
  if (L.basis === "credit") {
    return `<div class="lv"><div><small>Credit</small><b>${num(L.entry)}</b></div><div class="sl"><small>Stop (buy back)</small><b>${num(L.sl)}</b></div>
      <div class="tg"><small>T1 (50%)</small><b>${num(L.t1)}</b></div><div class="tg"><small>T2 (75%)</small><b>${num(L.t2)}</b></div>
      <div><small>Range</small><b style="font-size:12px">${c.range ? num(c.range[0]) + "–" + num(c.range[1]) : "–"}</b></div></div>
      <div class="meta">Levels are the ${basis} per unit. Exit if ${c.root} leaves the range.</div>`;
  }
  const cell = (k, v, cls = "") => `<div class="${cls}"><small>${k}</small><b>${num(v)}</b></div>`;
  return `<div class="lv">${cell(c.status === "WAIT" ? "Entry at" : "Entry", L.entry)}${cell("SL", L.sl, "sl")}${cell("T1", L.t1, "tg")}${cell("T2", L.t2, "tg")}${L.t3 ? cell("T3", L.t3, "tg") : `<div><small>Exit by</small><b style="font-size:13px">${c.exitBy ?? "–"}</b></div>`}</div>
    <div class="meta">${L.basis === "underlying" ? "Future price levels" : `Levels are the ${basis} (approx.). On the future: entry ${num(u.entry)}, SL ${num(u.sl)}, T1 ${num(u.t1)}, T2 ${num(u.t2)}`}</div>`;
}

function card(c) {
  const out = c.outcome ? `<div class="meta">Result: <b class="${c.outcome.r > 0 ? "pos" : "neg"}">${c.outcome.result} (${c.outcome.r > 0 ? "+" : ""}${c.outcome.r}R)</b></div>` : "";
  return `<article class="card ${c.status}">
    <div class="top"><span class="badge ${c.status}">${c.status}</span><span class="sym">${c.root}</span><span class="hz">${HZ[c.horizon]}</span><span class="hz">${STRUCT[c.structure]}</span>
      <div class="score" style="--s:${c.score};--c:${scoreColor(c.score)}"><i>${c.score}</i></div></div>
    <div class="trig">${c.trigger}</div>
    <div class="meta"><span class="agents">${(c.agents?.length ? c.agents : [c.agent]).map((a) => (a.startsWith("custom:") && a === c.agent ? `Your scanner: ${c.setup}` : agentName(a))).join(" + ")}</span>
      ${c.confirm ? `<span class="chip ${c.confirm.verdict > 0 ? "ok" : c.confirm.verdict < 0 ? "no" : "mid"}">Option chain ${c.confirm.verdict > 0 ? "confirms" : c.confirm.verdict < 0 ? "conflicts" : "neutral"}</span>` : ""}
      ${c.rank && c.rank !== c.score ? `<span>rank ${c.rank}</span>` : ""}</div>
    <div class="legs">${legs(c)}</div>
    ${levels(c)}
    <div class="meta"><span>Lots <b>${c.lots}</b> (${c.units.toLocaleString("en-IN")} ${c.kind === "COMMODITY" ? "bbl" : c.kind === "STOCK" ? "shares" : "units"})</span><span>Margin ≈ <b>${inr(c.margin)}</b></span><span>Max loss <b>${inr(c.maxLoss)}</b></span>
      <span>Exp. value <b class="${c.ev >= 0 ? "pos" : "neg"}">${inr(c.ev)}</b></span>
      <span>Win <b>${Math.round(c.pWin * 100)}%</b> of ${c.n}${c.thin ? " · thin evidence" : ""}</span></div>
    ${c.structure === "short_strangle" ? `<div class="warn">Gap risk: a ${c.gapMovePct}% gap (the largest of the last year, or a stress minimum) would cost about ${inr(c.gapLoss)}. Naked selling has no cap.</div>` : ""}
    ${c.worstCase && c.worstCase > c.maxLoss * 1.2 ? `<div class="meta">Worst case if the stop is not honoured: ${inr(c.worstCase)}</div>` : ""}
    ${c.overCap ? `<div class="warn">One lot loses ${inr(c.perLot?.risk)} at the stop, more than this profile's ${inr(profileRisk())} per trade. Shown for information; skip it or use a bigger profile.</div>` : ""}
    ${c.blocked ? `<div class="warn">Held back: ${c.blocked}</div>` : ""}
    ${c.chase ? `<div class="warn" style="color:#c9b6ff">Don't chase: price is already ${c.chase.movedR}R past entry. Wait for a retracement towards ${num(c.chase.retestAt)} (future).</div>` : ""}
    ${out}
    ${avgPlan(c)}
    ${["ENTER", "WAIT", "TRACKING"].includes(c.status) ? takeForm(c) : ""}
    <details><summary>Why</summary><ul>${c.why.map((w) => `<li>${w}</li>`).join("")}${c.confirm ? c.confirm.votes.map((v) => `<li>${v.v > 0 ? "✓" : v.v < 0 ? "✗" : "·"} ${v.label}</li>`).join("") : ""}<li>Setup: ${c.setup}</li></ul></details>
  </article>`;
}

function avgPlan(c) {
  const a = c.avg;
  if (!a) return "";
  const basis = c.levels.basis === "premium" ? "premium" : "price";
  const rows = a.adds.map((x) => `<li>+1 lot at ${basis} <b>${x.at}</b> (Fib ${x.fib}, underlying ≈ ${x.atUnderlying}) → average ${x.avgAfter}, T1 ${x.t1After}, T2 ${x.t2After} · loss at stop ${inr(x.riskAfter)} · reserve used ${inr(x.costAfter)}</li>`).join("");
  const head = a.mode === "pyramid" ? "Add on strength (pyramid)" : "Add on pullback (average)";
  return `<details class="avg"><summary>${head}: ${a.adds.length ? `${a.adds.length} add${a.adds.length > 1 ? "s" : ""}` : "no add fits"}</summary><ul>${rows}
    ${a.skipped ? `<li class="neg">Skipped: ${a.skipped}.</li>` : ""}<li>Stop stays at ${c.levels.sl}. Adds are paid from the ${inr(a.reserve)} reserve.</li></ul></details>`;
}

const profileRisk = () => state.data?.profiles.find((p) => p.id === state.profile)?.riskPerTrade;
function tag(c) {
  if (c.overCap) return ["OVER", "1 lot > cap"];
  if (c.blocked) return ["HELD", "Held"];
  if (c.chase) return ["CHASE", "Don't chase"];
  return [c.status, c.status === "WAIT" ? "Wait" : c.status === "ENTER" ? "Enter" : c.status];
}
function row(c) {
  const [cls, label] = tag(c), m = c.perLot ?? {};
  return `<details class="opp ${c.status} ${c.overCap ? "over" : ""}"><summary>
    <span class="badge ${cls}">${label}</span>
    <span class="r-sym"><b>${c.root}</b><small>${STRUCT[c.structure]} · ${HZ[c.horizon]} · ${(c.agents?.length ? c.agents : [c.agent]).map(agentName).join(" + ")}</small></span>
    <span class="r-money"><span>1 lot<b>${inr(m.capital)}</b></span><span class="risk">risk<b>${inr(m.risk)}</b></span><span class="rew">reward<b>${inr(m.reward)}</b></span></span>
    <span class="r-score" style="color:${scoreColor(c.score)}">${c.score}</span></summary>${card(c)}</details>`;
}
function takeForm(c) {
  return `<div class="take" data-card="${c.id}"><label>Lots<input type="number" min="1" value="1" class="tLots"></label>
    <label>Your fill (${c.levels.basis === "underlying" ? "price" : c.levels.basis === "credit" ? "credit" : "premium"})<input type="number" step="0.05" value="${c.levels.entry}" class="tPx"></label>
    <label style="flex:1">Note<input type="text" class="tNote" placeholder="optional" style="width:100%"></label>
    <button data-take="${c.id}">I took this trade</button></div>`;
}
function banner(d) {
  const h = d.health ?? {}, out = [];
  if (h.manual?.on) out.push(`<div class="banner bad">⛔ Kill switch ON since ${h.manual.at}: ${h.manual.reason}. No new ENTER is shown or pushed. <button data-kill="0">Turn off</button></div>`);
  for (const seg of ["NSE", "MCX"]) {
    const x = h[seg];
    if (!x) continue;
    if (!x.ok) out.push(`<div class="banner bad">⚠ ${seg} data check failed since ${x.since}: ${x.reasons.join("; ")}. New ENTERs are held until data is healthy.</div>`);
    else if (x.scanLate && x.minutesSinceScan != null) out.push(`<div class="banner warn">⚠ ${seg}: no scan for ${x.minutesSinceScan} minutes. The board may be stale.</div>`);
  }
  const alerts = (d.journal ?? []).filter((e) => e.watch && !["OK"].includes(e.watch.level));
  for (const e of alerts) out.push(`<div class="banner ${["EXIT", "STOP"].includes(e.watch.level) ? "bad" : "warn"}"><span class="lvl ${e.watch.level}">${e.watch.level}</span> Your ${e.root} trade: ${e.watch.reasons.join("; ")}</div>`);
  $("#banner").innerHTML = out.join("");
}

const SELL = ["iron_fly", "iron_condor", "short_strangle", "credit_spread"];
const match = (c) => state.filter === "all" || (state.filter === "sell" ? SELL.includes(c.structure) : state.filter === "watch" ? c.status === "WAIT" : c.horizon === state.filter);

function render() {
  const d = state.data;
  if (!d) return;
  $("#mkt").innerHTML = `<span><i class="dot ${d.market.nse === "open" ? "on" : ""}"></i>NSE <b>${d.market.nse}</b></span><span><i class="dot ${d.market.mcx.startsWith("open") ? "on" : ""}"></i>MCX <b>${d.market.mcx}</b></span>`;
  $("#profiles").innerHTML = d.profiles.map((p) => `<button data-p="${p.id}" class="${p.id === state.profile ? "on" : ""}">${p.label}<br><small style="opacity:.7">risk ${inr(p.riskPerTrade)}/trade</small></button>`).join("");
  const lr = d.lastRun.nse || d.lastRun.mcx;
  $("#status").textContent = `Updated ${d.now} IST${lr ? ` · last scan ${lr.at}, ${lr.instruments} instruments, ${lr.candidates} signals` : ""}${d.market.calendarKnown ? "" : " · holiday calendar for this year not loaded"}`;
  banner(d);
  if (d.disclosure) $("#disclosure").textContent = d.disclosure;
  const pages = ["perf", "hedge", "greeks", "scanners", "settings", "mine"], page = pages.includes(state.filter);
  for (const p of pages) $("#" + p).hidden = state.filter !== p;
  for (const id of ["#top", "#open", "#done", "#openH", "#doneH"]) $(id).hidden = page;
  if (state.filter === "perf") return renderPerf();
  if (state.filter === "hedge") return renderHedges(d);
  if (state.filter === "greeks") return renderGreeks();
  if (state.filter === "scanners") return renderScanners();
  if (state.filter === "settings") return renderSettings();
  if (state.filter === "mine") return renderMine();
  const top = d.top.filter(match);
  $("#top").innerHTML = top.length ? top.map(row).join("") : `<div class="empty">No opportunity with a positive edge right now for this profile. That is a normal answer; the board refreshes every 5 minutes in market hours.</div>`;
  const open = d.open.filter(match);
  $("#openH").hidden = !open.length;
  $("#open").innerHTML = open.map(card).join("");
  $("#doneH").hidden = !d.done.length;
  $("#done").innerHTML = d.done.map((c) => `<div class="row"><b>${c.root}</b><span>${STRUCT[c.structure]} · ${c.setup}</span><span style="color:var(--mut)">score ${c.score}</span><span class="r ${c.outcome.r > 0 ? "pos" : "neg"}">${c.outcome.result} ${c.outcome.r > 0 ? "+" : ""}${c.outcome.r}R</span></div>`).join("");
}

function renderHedges(d) {
  const h = d.hedges;
  if (!h) { $("#hedge").innerHTML = `<div class="empty">No F&O positions read yet. The book is checked every 15 minutes while a market is open.${d.hedgesError ? "<br>Last error: " + d.hedgesError : ""}</div>`; return; }
  const book = h.book.length ? h.book.map((b) => `<div class="hbox"><b>${b.root}</b> · spot ${num(b.spot)}<div class="meta">
      <span>Net delta <b>${num(b.delta)}</b> units (${inr(b.deltaRupees)})</span><span>Gamma <b>${b.gamma}</b></span><span>Vega <b>${inr(b.vega)}</b>/IV pt</span><span>Theta <b>${inr(b.thetaPerDay)}</b>/day</span></div>
      <div class="meta"><span>If ${b.root} +${h.stressMovePct}%: <b class="${b.pnlUp2 >= 0 ? "pos" : "neg"}">${inr(b.pnlUp2)}</b></span><span>If −${h.stressMovePct}%: <b class="${b.pnlDown2 >= 0 ? "pos" : "neg"}">${inr(b.pnlDown2)}</b></span></div>
      <div class="meta">${b.positions.join(", ")}</div></div>`).join("") : `<div class="empty">No open F&O positions.</div>`;
  const sug = (h.suggestions[state.profile] ?? []).map((s) => `<div class="hbox"><b>${s.root}</b>: exposure ${inr(s.exposure)} is large for this profile. Hedges that remove about half the delta:
      ${s.ideas.map((x) => `<div class="meta"><b>${x.label}</b><span>cost ${x.costIsMargin ? "≈ margin " : ""}${inr(x.cost)}</span><span>worst ±${h.stressMovePct}% move: ${inr(x.worstBefore)} → <b>${inr(x.worstAfter)}</b></span><span>delta → ${num(x.deltaAfter)}</span></div>`).join("")}</div>`).join("");
  $("#hedge").innerHTML = `<h2>Your book (from Dhan, read-only) · ${h.asOf}</h2>${book}<h2>Hedge ideas for this profile</h2>${sug || `<div class="empty">Exposure is within limits for this profile.</div>`}${h.skipped?.length ? `<p class="status">Not covered (outside the universe): ${h.skipped.join(", ")}</p>` : ""}`;
}

// ---------------------------------------------------------------- Greeks
function spark(points, w = 520, h = 90) {
  const ys = points.map((p) => p.y).filter(Number.isFinite);
  if (ys.length < 2) return "";
  const lo = Math.min(...ys, 0), hi = Math.max(...ys, 0), sx = (i) => (i / (points.length - 1)) * (w - 10) + 5, sy = (y) => h - 5 - ((y - lo) / (hi - lo || 1)) * (h - 10);
  const path = points.map((p, i) => `${i ? "L" : "M"}${sx(i).toFixed(1)},${sy(p.y).toFixed(1)}`).join("");
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}"><line x1="0" x2="${w}" y1="${sy(0)}" y2="${sy(0)}" stroke="#2a3542"/><path d="${path}" fill="none" stroke="var(--amber)" stroke-width="2"/>
    <text x="5" y="12" fill="#8b98a5" font-size="11">${points[0].x}</text><text x="${w - 40}" y="12" fill="#8b98a5" font-size="11">${points.at(-1).x}</text></svg>`;
}
async function renderGreeks() {
  const d = await get("/api/greeks");
  const cr = (x) => (x / 1e7).toFixed(2) + " Cr";
  const roots = Object.entries(d.roots);
  if (!roots.length) { $("#greeks").innerHTML = `<div class="empty">No Greeks snapshots yet today. They are taken every 15 minutes while the market is open (indices and crude).</div>`; return; }
  $("#greeks").innerHTML = `<p class="status">Open-interest-weighted Greeks of the nearest expiry, ATM ± 10 strikes. Vega in ₹ per 1 IV point across all open contracts. Put vega rising faster than call vega = money paying up for downside protection.</p>` +
    roots.map(([root, snaps]) => {
      const f = snaps[0].g, l = snaps.at(-1).g;
      const dc = l.callVega - f.callVega, dp = l.putVega - f.putVega;
      const read = Math.abs(dp - dc) < 0.05 * Math.abs(l.callVega + l.putVega) ? "call and put vega moving together" : dp > dc ? "put vega growing faster than call vega since the first snapshot: protection demand rising" : "call vega growing faster than put vega since the first snapshot: upside demand / put unwinding";
      return `<div class="hbox"><div class="row2"><b>${root}</b><span class="status">spot ${num(l.spot)} · expiry ${l.expiry} · ${snaps.at(-1).ts}</span></div>
        <table><tr><th></th><th>Call</th><th>Put</th><th>Put − Call</th></tr>
        <tr><td>Vega (OI-weighted)</td><td>${cr(l.callVega)}</td><td>${cr(l.putVega)}</td><td><b class="${l.vegaDiff >= 0 ? "neg" : "pos"}">${cr(l.vegaDiff)}</b> (ratio ${l.vegaRatio.toFixed(2)})</td></tr>
        <tr><td>Change today</td><td>${cr(dc)}</td><td>${cr(dp)}</td><td>${cr(dp - dc)}</td></tr>
        <tr><td>ATM IV</td><td>${l.callIv.toFixed(2)}%</td><td>${l.putIv.toFixed(2)}%</td><td>${(l.putIv - l.callIv).toFixed(2)} pts</td></tr>
        <tr><td>ATM vega per unit</td><td>${l.atmCallVega.toFixed(2)}</td><td>${l.atmPutVega.toFixed(2)}</td><td></td></tr>
        <tr><td>Theta (OI-weighted, ₹/day)</td><td>${cr(l.callTheta)}</td><td>${cr(l.putTheta)}</td><td></td></tr></table>
        <div class="meta">${read}</div>${spark(snaps.map((s) => ({ x: s.ts, y: s.g.vegaDiff })))}<div class="status">Put − call vega through the day</div></div>`;
    }).join("");
}

// ---------------------------------------------------------------- Scanner builder
const EXAMPLE = `Stock passes ALL
[0] 15 minute Close > [0] 15 minute EMA(Close,20)
[0] 15 minute Close > [0] 15 minute VWAP
[0] 15 minute Close > [-1] 15 minute Max(10,High)
[-1] 15 minute Volume > [-1] 15 minute SMA(Volume,20) * 1.5
[0] 15 minute RSI(14) > 55`;
const HELP = `One condition per line. "Stock passes ALL" (AND, default) or "Stock passes ANY" (OR).
[0] = latest closed bar, [-1] = the bar before, [-2] ...
Timeframes: 5 minute · 15 minute · 30 minute · 60 minute · daily · weekly · chain
Fields: Open High Low Close Volume OI VWAP
Functions: EMA(Close,20) SMA(Volume,20) RSI(14) ATR(14) Max(10,High) Min(10,Low)
           Supertrend(7,3) MACD Line(26,12,9) MACD Signal(26,12,9)
Math: + - * /   Compare: > < >= <= =   crossed above   crossed below
Option chain (live only, not in history): [0] chain PCR · Max Pain · ATM IV · IV Rank
           · Call Vega · Put Vega · Vega Diff · Spot
Examples:
[0] 5 minute Close crossed above [0] 5 minute VWAP
[0] daily Close > [-1] daily Max(20,High)
[0] chain Vega Diff > 0
Only daily/weekly lines → evaluated once a day near the close (BTST / 2–3 days).
Any minute line → intraday on the smallest timeframe used.`;
let editing = null;
async function renderScanners() {
  const d = await get("/api/scanners");
  const s = editing ?? { name: "", text: EXAMPLE, dir: 1, kinds: ["INDEX", "STOCK", "COMMODITY"], stop: "atr:1.5", targets: [1, 2, 3], holdDays: 3, enabled: true };
  const [stopKind, stopVal] = s.stop.split(":");
  $("#scanners").innerHTML = `<h2>${s.id ? "Edit scanner" : "New scanner"}</h2>
  <div class="hbox form">
    <label class="full">Name<input type="text" id="sName" value="${s.name ?? ""}" placeholder="e.g. 15-min breakout with volume"></label>
    <label class="full">Rules<textarea id="sText" spellcheck="false">${s.text}</textarea></label>
    <label>Direction when it passes<select id="sDir"><option value="1" ${s.dir > 0 ? "selected" : ""}>Long (buy)</option><option value="-1" ${s.dir < 0 ? "selected" : ""}>Short (sell)</option></select></label>
    <label>Segments<span class="row2">${[["INDEX", "Index F&O"], ["STOCK", "Stock F&O"], ["COMMODITY", "MCX crude"]].map(([k, l]) => `<label class="row2"><input type="checkbox" class="sKind" value="${k}" ${s.kinds.includes(k) ? "checked" : ""}> ${l}</label>`).join("")}</span></label>
    <label>Stop-loss<span class="row2"><select id="sStopK"><option value="atr" ${stopKind === "atr" ? "selected" : ""}>ATR ×</option><option value="pct" ${stopKind === "pct" ? "selected" : ""}>% from entry</option><option value="swing" ${stopKind === "swing" ? "selected" : ""}>swing low/high of N bars</option></select><input type="number" id="sStopV" step="0.1" value="${stopVal}" style="width:90px"></span></label>
    <label>Targets in R (comma separated, the last must be ≥ 2)<input type="text" id="sTg" value="${s.targets.join(", ")}"></label>
    <label>Hold for daily scanners (sessions: 1 = BTST)<input type="number" id="sHold" min="1" max="5" value="${s.holdDays ?? 3}"></label>
    <div class="full row2"><button id="sCheck">Check rules</button><button id="sTest">Test on the market</button><button id="sSave" class="on" style="background:var(--green);color:#03140a;font-weight:700">Save & run every 5 min</button>${s.id ? `<button id="sNew">New</button>` : ""}</div>
    <div class="full" id="sOut"></div>
    <details class="full"><summary>Syntax</summary><pre class="help">${HELP}</pre></details>
  </div>
  <h2>Your scanners</h2>
  ${d.custom.length ? d.custom.map((c) => `<div class="toggle"><span><b>${c.name}</b> <span class="status">${c.dir > 0 ? "long" : "short"} · ${c.kinds.join(", ")} · stop ${c.stop}</span></span>
    <span class="row2"><label class="row2"><input type="checkbox" data-cid="${c.id}" ${c.enabled ? "checked" : ""}> on</label><button data-edit="${c.id}">Edit</button><button data-del="${c.id}">Delete</button></span></div>`).join("") : `<div class="status">None yet.</div>`}
  <h2>Built-in agents</h2>
  ${d.builtin.map((a) => `<div class="toggle"><span>${AGENT[a.name] ?? a.name} <span class="status">${a.name}</span></span><label class="row2"><input type="checkbox" data-agent="${a.name}" ${a.enabled ? "checked" : ""}> on</label></div>`).join("")}`;
  const form = () => ({ ...(editing ?? {}), name: $("#sName").value, text: $("#sText").value, dir: +$("#sDir").value,
    kinds: [...document.querySelectorAll(".sKind:checked")].map((x) => x.value), stop: `${$("#sStopK").value}:${$("#sStopV").value || 1}`,
    targets: $("#sTg").value.split(",").map(Number).filter((x) => x > 0), holdDays: +$("#sHold").value || 3, enabled: editing?.enabled ?? true });
  const post = async (path, body, method = "POST") => (await fetch(path, { method, credentials: "include", body: JSON.stringify(body) })).json();
  const showErrors = (errs) => `<div class="err">${errs.map((e) => `Line ${e.line}: ${e.error}<br><code>${e.text}</code>`).join("<br>")}</div>`;
  $("#sCheck").onclick = async () => {
    const r = await post("/api/scanners/parse", { text: $("#sText").value });
    $("#sOut").innerHTML = r.errors.length ? showErrors(r.errors) : `<div class="ok">${r.conditions.length} conditions, ${r.logic}, timeframes: ${r.timeframes.join(", ")}</div><pre class="help">${r.conditions.join("\n")}</pre>`;
  };
  $("#sTest").onclick = async () => {
    $("#sOut").innerHTML = `<div class="status">Testing across the universe… (about 20–40 seconds)</div>`;
    const r = await post("/api/scanners/test", form());
    if (r.errors?.length) { $("#sOut").innerHTML = showErrors(r.errors); return; }
    if (r.error) { $("#sOut").innerHTML = `<div class="err">${r.error}</div>`; return; }
    $("#sOut").innerHTML = `<div class="status">${r.mode === "intraday" ? `intraday on ${r.baseTf}-minute bars` : "daily"} · ${r.conditions} conditions (${r.logic}). History: each past day's first pass, with your stop and targets, in R.</div>
      <table><tr><th>Symbol</th><th>Passes now</th><th>Passed today at</th><th>Past passes</th><th>Win %</th><th>Reached T1</th><th>Avg R</th></tr>
      ${r.rows.map((x) => `<tr><td>${x.symbol}</td><td>${x.now ? "<b class=ok>YES</b>" : ""}</td><td>${(x.firedToday ?? []).slice(-4).join(", ")}</td><td>${x.n ?? x.note ?? ""}</td><td>${x.pWin ?? ""}${x.pWin != null ? "%" : ""}</td><td>${x.pT1 ?? ""}${x.pT1 != null ? "%" : ""}</td><td class="${x.avgR > 0 ? "pos" : x.avgR < 0 ? "neg" : ""}">${x.avgR ?? ""}</td></tr>`).join("")}</table>`;
  };
  $("#sSave").onclick = async () => {
    const r = await post("/api/scanners", form());
    if (r.errors) { $("#sOut").innerHTML = showErrors(r.errors); return; }
    if (r.error) { $("#sOut").innerHTML = `<div class="err">${r.error}</div>`; return; }
    editing = null; await renderScanners(); $("#sOut").innerHTML = `<div class="ok">Saved. It runs from the next 5-minute scan; its ideas appear on the board like any agent's.</div>`;
  };
  if ($("#sNew")) $("#sNew").onclick = () => { editing = null; renderScanners(); };
  document.querySelectorAll("[data-edit]").forEach((b) => (b.onclick = () => { editing = d.custom.find((c) => c.id === b.dataset.edit); renderScanners(); window.scrollTo(0, 0); }));
  document.querySelectorAll("[data-del]").forEach((b) => (b.onclick = async () => { if (confirm("Delete this scanner?")) { await post(`/api/scanners?id=${b.dataset.del}`, {}, "DELETE"); renderScanners(); } }));
  document.querySelectorAll("[data-cid]").forEach((b) => (b.onchange = async () => { const c = d.custom.find((x) => x.id === b.dataset.cid); await post("/api/scanners", { ...c, enabled: b.checked }); }));
  document.querySelectorAll("[data-agent]").forEach((b) => (b.onchange = () => post("/api/agents", { name: b.dataset.agent, enabled: b.checked })));
}

// ---------------------------------------------------------------- Settings
async function renderSettings() {
  const s = await get("/api/settings");
  const tick = (x) => (x ? `<b class="ok">✓ set</b>` : `<b class="err">✗ missing</b>`);
  $("#settings").innerHTML = `<h2>Dhan connection</h2><div class="hbox">
    <div class="toggle"><span>Client ID (DHAN_CLIENT_ID)</span>${tick(s.dhan.clientId)}</div>
    <div class="toggle"><span>PIN (DHAN_PIN)</span>${tick(s.dhan.pin)}</div>
    <div class="toggle"><span>TOTP secret (DHAN_TOTP_SECRET)</span>${tick(s.dhan.totpSecret)}</div>
    <div class="toggle"><span>Access token</span><span>${s.dhan.tokenAgeMinutes == null ? "not generated yet" : `renewed ${s.dhan.tokenAgeMinutes} min ago`}</span></div>
    ${s.dhan.lastTokenError ? `<div class="err">Last error: ${s.dhan.lastTokenError}</div>` : ""}
    <div class="row2" style="margin-top:10px"><button id="dTest">Test Dhan connection</button></div><div id="dOut"></div>
    <p class="status">These are secrets, set in Cloudflare (not in this page): dash.cloudflare.com → Workers & Pages → viponly-scanner → Settings → Variables and Secrets → Add → type <b>Secret</b>. The values are never shown again, not even here.</p></div>
    <h2>Kill switch</h2><div class="hbox"><p class="status">Stops every new ENTER (board and push) until you switch it back. Calls already published keep being tracked. Every switch is logged in the ledger.</p>
    ${state.data?.health?.manual?.on ? `<div class="err">ON since ${state.data.health.manual.at}: ${state.data.health.manual.reason}</div><button data-kill="0">Turn off</button>` : `<button data-kill="1" style="background:var(--red);color:#fff">Stop new signals</button>`}</div>
    <h2>App</h2><div class="hbox">
    <div class="toggle"><span>Login</span><span>${s.login}</span></div>
    <div class="toggle"><span>Push keys (VAPID)</span>${tick(s.push.vapid)}</div>
    ${s.push.vapid ? "" : `<div class="row2" style="margin-top:8px"><button id="vGen">Generate push keys</button></div><div id="vOut"></div>`}
    <div class="toggle"><span>Instruments in today's universe</span><span>${s.universe}</span></div></div>`;
  if ($("#vGen")) $("#vGen").onclick = async () => {
    const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
    const pub = btoa(String.fromCharCode(...raw)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const jwk = JSON.stringify(await crypto.subtle.exportKey("jwk", kp.privateKey));
    $("#vOut").innerHTML = `<p class="status">Made in this browser, never sent anywhere. Add both as Secrets in Cloudflare (Variables and Secrets), then reload.</p>
      <label>VAPID_PUBLIC_KEY<textarea style="min-height:60px">${pub}</textarea></label><label>VAPID_PRIVATE_JWK<textarea style="min-height:90px">${jwk}</textarea></label>`;
  };
  $("#dTest").onclick = async () => {
    $("#dOut").innerHTML = `<div class="status">Testing…</div>`;
    const r = await (await fetch("/api/dhan-test", { method: "POST", credentials: "include" })).json();
    $("#dOut").innerHTML = r.steps.map((x) => `<div class="${x.ok ? "ok" : "err"}">${x.ok ? "✓" : "✗"} ${x.step}: ${x.detail}</div>`).join("");
  };
}

function progressBar(p) {
  if (!p) return "";
  const lo = Math.min(p.slPct, -100), hi = Math.max(110, p.pct), span = hi - lo, x = (v) => ((v - lo) / span) * 100;
  const a = x(Math.min(0, p.pct)), b = x(Math.max(0, p.pct));
  return `<div class="bar"><i class="fill ${p.pct >= 0 ? "pos" : "neg"}" style="left:${a}%;width:${b - a}%"></i>
    <i class="mk sl" style="left:${x(p.slPct)}%" title="stop"></i><i class="mk zero" style="left:${x(0)}%" title="your entry"></i>
    <i class="mk t1" style="left:${x(p.t1Pct)}%" title="T1"></i><i class="mk" style="left:${x(100)}%" title="T2"></i></div>
    <div class="meta"><span>Future ${num(p.px)}</span><span>${p.pct}% of the way to T2 from your entry</span><span style="color:var(--red)">stop</span><span style="color:var(--amber)">T1</span></div>`;
}
function tradeBox(e) {
  const s = e.summary, w = e.watch;
  const open = e.status === "OPEN";
  return `<div class="hbox"><div class="row2"><b>${e.root}</b><span>${e.label}</span><span class="status">${HZ[e.horizon]} · signal score ${e.signal.score} · ${new Date(e.created).toLocaleString("en-IN")}</span>
      ${w ? `<span class="lvl ${w.level}">${w.level}</span>` : ""}<span class="status" style="margin-left:auto">${e.status}${e.voidReason ? ": " + e.voidReason : ""}</span></div>
    <div class="meta"><span>Signal entry <b>${num(e.signal.entry)}</b> · SL <b>${num(e.signal.sl)}</b> · T1 <b>${num(e.signal.t1)}</b> · T2 <b>${num(e.signal.t2)}</b></span></div>
    <div class="meta"><span>Your avg in <b>${num(s.avgIn)}</b></span>${s.avgOut ? `<span>avg out <b>${num(s.avgOut)}</b></span>` : ""}<span>open lots <b>${s.openLots}</b></span>
      ${s.slippage ? `<span>slippage <b class="${s.slippage.rupees > 0 ? "neg" : "pos"}">${inr(s.slippage.rupees)}</b>${s.slippage.pctOfRisk != null ? ` (${s.slippage.pctOfRisk}% of risk)` : ""}</span>` : ""}
      <span>realised <b class="${s.realised >= 0 ? "pos" : "neg"}">${inr(s.realised)}</b>${s.r != null ? ` (${s.r}R)` : ""}</span></div>
    ${open ? progressBar(e.progress) : ""}
    ${w && w.reasons.length ? `<div class="meta">${w.reasons.join(" · ")}</div>` : ""}
    <div class="meta">${e.fills.map((f) => `${f.side === "in" ? "+" : "−"}${f.lots} @ ${num(f.price)}`).join(" · ")}</div>
    ${open ? `<div class="take" data-entry="${e.id}"><label>Lots<input type="number" min="1" value="${s.openLots}" class="fLots"></label><label>Price<input type="number" step="0.05" class="fPx"></label>
      <button data-fill="out">Exit</button><button data-fill="in">Add</button><button data-void="${e.id}">Void (mistake)</button></div>` : ""}
    <div class="status">${s.note}</div></div>`;
}
async function renderMine() {
  const j = await get("/api/journal?days=60"), st = j.stats;
  const open = j.entries.filter((e) => e.status === "OPEN"), closed = j.entries.filter((e) => e.status !== "OPEN");
  $("#mine").innerHTML = `<h2>Your real trades · last 60 days</h2>
    <div class="hbox meta"><span>Closed <b>${st.trades}</b></span><span>Open <b>${st.open}</b></span><span>Win <b>${st.winPct ?? "–"}${st.winPct != null ? "%" : ""}</b></span>
      <span>P&L <b class="${st.pnl >= 0 ? "pos" : "neg"}">${inr(st.pnl)}</b> (gross)</span><span>Avg <b>${st.avgR ?? "–"}R</b></span>
      <span>Avg slippage <b>${st.avgSlippagePctOfRisk ?? "–"}${st.avgSlippagePctOfRisk != null ? "% of risk" : ""}</b></span><span>Lost more than planned <b class="${st.lostMoreThanPlanned ? "neg" : ""}">${st.lostMoreThanPlanned}</b></span></div>
    <h2>Open</h2>${open.length ? open.map(tradeBox).join("") : `<div class="status">None. Tap a board row, then "I took this trade".</div>`}
    <h2>Closed</h2>${closed.length ? closed.map(tradeBox).join("") : `<div class="status">None yet.</div>`}`;
}

async function renderPerf() {
  const [p, cal, v, j] = await Promise.all([get("/api/perf"), get(`/api/calibration?profile=${state.profile}`), get("/api/ledger/verify"), get("/api/journal?days=30")]);
  const tbl = (rows, cols) => `<table><tr>${cols.map((c) => `<th>${c[0]}</th>`).join("")}</tr>${rows.map((r) => `<tr>${cols.map((c) => `<td>${c[1](r)}</td>`).join("")}</tr>`).join("")}</table>`;
  const pc = (x) => (x == null ? "–" : x + "%");
  const calCols = [["Trades", (r) => r.n], ["Predicted win", (r) => pc(r.predictedWinPct)], ["Live win", (r) => pc(r.winPct)], ["Predicted EV", (r) => (r.predictedEvR ?? "–") + "R"], ["Live avg", (r) => `<b class="${(r.avgR ?? 0) >= 0 ? "pos" : "neg"}">${r.avgR ?? "–"}R</b>`]];
  $("#perf").innerHTML = `<h2>Ledger</h2><div class="hbox">${v.ok ? `<b class="ok">✓ Chain intact</b>: ${v.rows} records, nothing edited or deleted.` : `<b class="err">✗ Chain broken at record ${v.brokenAt}: ${v.reason}</b>`}
      <div class="status">Head hash ${v.head.slice(0, 16)}… · <a href="/api/ledger/export" style="color:var(--blue)">Download the full ledger (JSON)</a></div></div>
    <h2>Calibration · ${state.profile} · last ${cal.days} days</h2><p class="status">${cal.calls} calls published, ${cal.closed} closed, ${cal.open} open. ${cal.note}</p>
    ${cal.overall.n ? tbl([{ band: "All", ...cal.overall }, ...cal.byScore.filter((r) => r.n)], [["Score", (r) => r.band], ...calCols]) : `<div class="status">No closed calls yet.</div>`}
    ${cal.byAgent.length ? tbl(cal.byAgent, [["Agent", (r) => (AGENT[r.agent] ?? r.agent) + (r.paused ? ` <span class="chip no">paused: ${r.paused.reason}</span>` : "")], ...calCols]) : ""}
    ${cal.chased.n && cal.notChased.n ? `<p class="status">Calls flagged "don't chase": ${cal.chased.n} trades, live avg ${cal.chased.avgR}R vs ${cal.notChased.avgR}R for the rest.</p>` : ""}
    <h2>Your real trades vs the signals (30 days)</h2><div class="hbox meta"><span>Closed <b>${j.stats.trades}</b></span><span>Win <b>${pc(j.stats.winPct)}</b></span><span>Avg <b>${j.stats.avgR ?? "–"}R</b></span><span>Slippage <b>${j.stats.avgSlippagePctOfRisk ?? "–"}${j.stats.avgSlippagePctOfRisk != null ? "% of risk" : ""}</b></span></div>
    <h2>Every ENTER, all profiles (hypothetical)</h2>
    ${tbl(p.byScore, [["Score", (r) => r.band], ["Trades", (r) => r.n], ["Win %", (r) => Math.round((r.wins / r.n) * 100) + "%"], ["Avg R", (r) => r.avgR]])}`;
}

async function post(path, body) { return (await fetch(path, { method: "POST", credentials: "include", body: JSON.stringify(body) })).json(); }
document.addEventListener("click", async (ev) => {
  const t = ev.target.closest("[data-take],[data-fill],[data-void],[data-kill]");
  if (!t) return;
  if (t.dataset.take) {
    const box = t.closest(".take");
    const r = await post("/api/journal", { cardId: t.dataset.take, lots: +box.querySelector(".tLots").value, price: +box.querySelector(".tPx").value, note: box.querySelector(".tNote").value });
    if (r.error) return alert(r.error);
    alert(`Journaled: ${r.entry.root}, ${r.entry.fills[0].lots} lot(s) at ${r.entry.fills[0].price}. Slippage vs signal: ${inr(r.summary.slippage.rupees)}. You'll get exit alerts on this trade.`);
    load();
  } else if (t.dataset.fill) {
    const box = t.closest(".take"), price = +box.querySelector(".fPx").value;
    if (!price) return alert("Enter the price you got.");
    const r = await post("/api/journal/fill", { id: box.dataset.entry, side: t.dataset.fill, lots: +box.querySelector(".fLots").value, price });
    if (r.error) return alert(r.error);
    renderMine(); load();
  } else if (t.dataset.void) {
    const reason = prompt("Why void this entry? (it stays in the ledger, marked void)");
    if (!reason) return;
    await post("/api/journal/void", { id: t.dataset.void, reason }); renderMine();
  } else if (t.dataset.kill !== undefined) {
    const on = t.dataset.kill === "1";
    const reason = on ? prompt("Why are you switching new signals off?") ?? "" : "";
    if (on && !reason) return;
    await post("/api/kill", { on, reason }); load(); if (state.filter === "settings") renderSettings();
  }
});

async function load() {
  try { state.data = await get(`/api/cards?profile=${state.profile}`); render(); } catch (e) { if (e.message !== "login") $("#status").textContent = "Could not load: " + e.message; }
}

$("#profiles").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; state.profile = b.dataset.p; localStorage.setItem("profile", state.profile); load(); });
$("#filters").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; state.filter = b.dataset.f; document.querySelectorAll("#filters button").forEach((x) => x.classList.toggle("on", x === b)); render(); });
$("#refresh").onclick = load;
$("#loginForm").addEventListener("submit", async () => { await fetch("/api/login", { method: "POST", body: JSON.stringify({ password: $("#pw").value }), credentials: "include" }); load(); });

const b64 = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
$("#bell").onclick = async () => {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return alert("This browser does not support push. Use Chrome on Android.");
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return alert("Notifications are blocked for this site.");
  const reg = await navigator.serviceWorker.ready;
  const { key } = await (await fetch("/api/vapid")).json();
  if (!key) return alert("Push is not configured on the server (VAPID keys).");
  const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(key) }));
  await fetch("/api/subscribe", { method: "POST", credentials: "include", body: JSON.stringify({ subscription: sub, profile: state.profile }) });
  await fetch("/api/test-push", { method: "POST", credentials: "include" });
  $("#bell").textContent = "🔔✓";
};

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js");
load();
setInterval(() => { if (!document.hidden) load(); }, 60_000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
