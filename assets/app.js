// Reading Path — standalone front end (tabs: Today, Ask, Discover, Atlas, Library, More).
// Reads data/*.json. When served by server.py it can also write through /api/*.
// On static hosting (GitHub Pages, any web server) it runs read-only.
(function () {
  "use strict";
  const PASS = { 1: "Core", 2: "Recommended", 3: "Deep dive" };
  const DONE = new Set(["read", "known", "skipped", "skimmed"]); // skimmed: enough to move on, flagged for a proper read
  const READISH = new Set(["read", "skimmed"]);
  const FILES = ["papers", "status", "days", "discover", "reactions", "interests", "recall", "agenda", "requests", "drafts", "digests", "zsync", "settings", "tutor"];
  const TABS = ["today", "ask", "discover", "atlas", "library", "more"];
  const S = { papers: [], tracks: {}, status: {}, days: [], disc: [], reactions: {}, interests: {}, recall: {}, agenda: [], requests: [], drafts: [], digests: [], zsync: {},
    settings: {}, tutor: {}, writable: false, limit: 60, loaded: false, logRating: 0, server: {}, askKey: "" };
  const NOTE_FIELDS = [["problem", "Problem it solves"], ["method", "Method / key equation"], ["limitation", "Limitation or open question"], ["use", "Use for my work"]];
  const ABOUT_ME = "PhD student at DTU Compute, supervised by Jes Frellsen (probabilistic modelling group) and Kristoffer; also in the Isoform Analysis Group. I work on generative models for single-cell isoform expression: CTMC / generator matching on the lattice simplex (isoform counts with fixed gene totals), hierarchical negative-binomial + multinomial models, and scIso (predicting isoform expression from gene expression).";
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const tcolor = (t) => `var(--t-${t}, var(--accent))`;
  const iso = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  const todayISO = () => iso(new Date());
  const setting = (k, d) => (S.settings && S.settings[k] !== undefined ? S.settings[k] : d);

  // ---------- data access ----------
  async function loadAll() {
    const got = await Promise.all(FILES.map((f) => fetch(`data/${f}.json`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null)));
    const [papers, status, days, disc, reactions, interests, recall, agenda, requests, drafts, digests, zsync, settings, tutor] = got;
    if (!papers) { $("today").innerHTML = '<p class="empty">Could not load data/papers.json. Open the site through <code>python3 server.py</code> or a web server, not as a file.</p>'; return; }
    S.papers = papers.papers || []; S.tracks = papers.tracks || {};
    S.status = status || {}; S.days = (days || []).slice().sort((a, b) => b.id.localeCompare(a.id));
    S.disc = (disc || []).slice().sort((a, b) => b.id.localeCompare(a.id));
    S.reactions = reactions || {}; S.interests = interests || {};
    S.recall = recall || {}; S.agenda = agenda || []; S.requests = requests || []; S.drafts = drafts || [];
    S.digests = (digests || []).slice().sort((a, b) => b.id.localeCompare(a.id)); S.zsync = zsync || {};
    S.settings = settings || {}; S.tutor = Object.assign({ style: [], struggles: [], qa: [] }, tutor || {});
    const first = !S.loaded; S.loaded = true;
    if (first) { fillTrackSelects(); fillSettings(); $("stylePrefs").value = (S.tutor.style || []).join("\n"); }
    renderAll();
  }
  async function api(path, body) {
    if (!S.writable) throw new Error("read-only");
    const r = await fetch("api/" + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  }
  async function detectServer() {
    try { const r = await fetch("api/ping", { cache: "no-store" }); const j = await r.json(); S.writable = !!j.ok; S.server = j; } catch (e) { S.writable = false; }
    document.body.classList.toggle("readonly", !S.writable);
    const m = $("mode");
    if (!S.writable) { m.hidden = false; m.className = "modebar warn"; m.textContent = "Read-only copy. To mark papers and take notes, run python3 server.py in your ReadingPath folder and open http://localhost:8765."; }
    else if (S.server.syncError) { m.hidden = false; m.className = "modebar warn"; m.textContent = "GitHub sync problem: " + S.server.syncError; }
    $("dNow").hidden = !S.server.instantDrafts; $("zsyncAll").hidden = !S.server.zotero;
  }

  // ---------- helpers ----------
  function papers() { return S.papers.filter((p) => p.seq != null).slice().sort((a, b) => a.seq - b.seq); }
  function allPapers() { return S.papers.slice().sort((a, b) => (a.seq ?? 1e9) - (b.seq ?? 1e9)); }
  function byKey() { const m = {}; for (const p of S.papers) m[p.key] = p; return m; }
  function st(k) { return (S.status[k] || {}).state || ""; }
  function ident(p) {
    const u = p.url || ""; let m;
    if ((m = u.match(/arxiv\.org\/(?:abs|pdf|html)\/([0-9]{4}\.[0-9]{4,5}|[a-z\-]+\/\d{7})/i))) return "arXiv:" + m[1];
    if ((m = u.match(/doi\.org\/(10\.[^?#\s]+)/))) return decodeURIComponent(m[1]);
    if ((m = u.match(/biorxiv\.org\/content\/(10\.\d+\/[^v?#\s]+)/))) return m[1];
    return "";
  }
  // Only tonight's paper is "taken". A missed pick simply goes back in the queue, and a paper only counts as
  // covered once it is read, skimmed, known or skipped, so nothing that builds on it unlocks before that.
  function assignedSet() { const a = new Set(); const d = S.days[0]; if (d && !DONE.has(st(d.paper))) a.add(d.paper); return a; }
  // Same rule as the morning update: lowest seq whose prerequisites are covered.
  function upcoming(n, exclude) {
    const assigned = assignedSet(); const ex = new Set(exclude || []); const now = Date.now(); const out = [];
    const ok = (k) => DONE.has(st(k)) || out.some((o) => o.key === k);
    // course-prep chapters (with a due date) are read alongside, never as the daily paper;
    // a paper planned for a date (pickOn) jumps the queue from that date on
    const t = todayISO(); const planned = (p) => (p.pickOn && p.pickOn <= t ? 0 : 1);
    for (const p of papers().filter((p) => !p.due).sort((a, b) => planned(a) - planned(b) || (a.pickOn || "").localeCompare(b.pickOn || "") || a.seq - b.seq)) {
      if (out.length >= n) break;
      const s = S.status[p.key] || {};
      if (DONE.has(s.state) || assigned.has(p.key) || ex.has(p.key)) continue;
      if (s.state === "later" && s.at && now - Date.parse(s.at) < 10 * 864e5) continue;
      if ((p.prereqs || []).every(ok)) out.push(p);
    }
    return out;
  }
  function todayPaper() { const d = S.days[0]; return d ? byKey()[d.paper] : null; }
  function readDate(s) { return (s.readOn || s.at || "").slice(0, 10); }

  // ---------- habit: streak, week goal, calendar, milestones ----------
  function readsByDay() {
    const m = {};
    for (const [k, s] of Object.entries(S.status)) if (READISH.has(s.state)) { const d = readDate(s); if (d) m[d] = (m[d] || 0) + 1; }
    return m;
  }
  function streak() {
    const m = readsByDay(); const d = new Date(); let n = 0; let first = true; let todayDone = false;
    for (let i = 0; i < 400; i++) {
      const wd = d.getDay(); const key = iso(d);
      if (m[key]) { n++; if (first) todayDone = true; }
      else if (wd !== 0 && wd !== 6 && !pausedOn(key)) { if (!first) break; }   // today unread doesn't break it yet; weekends and paused days never do
      first = false; d.setDate(d.getDate() - 1);
    }
    return { n, todayDone };
  }
  function pausedOn(ds) { return (setting("pauses", []) || []).some((x) => x.from <= ds && ds <= x.to) || (setting("busyUntil", "") >= ds && ds >= todayISO()); }
  function busyNow() { const b = setting("busyUntil", ""); return b && b >= todayISO() ? b : ""; }
  function fmtDay(ds) { return new Date(ds + "T12:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }); }
  async function setBusy(until) {
    const t = todayISO(); let pz = (setting("pauses", []) || []).filter((x) => x.to < t);
    if (until) pz = pz.concat([{ from: t, to: until }]);
    else { const cur = (setting("pauses", []) || []).find((x) => x.from <= t && t <= x.to); if (cur && cur.from < t) { const y = new Date(); y.setDate(y.getDate() - 1); pz.push({ from: cur.from, to: iso(y) }); } }
    try { const r = await api("settings", { busyUntil: until || "", pauses: pz }); S.settings = r.settings || Object.assign(S.settings, { busyUntil: until, pauses: pz }); if (!until) delete S.settings.busyUntil; renderAll(); toast(until ? "Paused until " + fmtDay(until) + ". Your plan waits and your streak is frozen." : "Welcome back. The plan picks up where you left it."); } catch (e) { alertBar(e); }
  }
  function weekCount() {
    const m = readsByDay(); const d = new Date(); const dow = (d.getDay() + 6) % 7; d.setDate(d.getDate() - dow); let c = 0;
    for (let i = 0; i < 7; i++) { c += m[iso(d)] || 0; d.setDate(d.getDate() + 1); }
    return c;
  }
  function renderJourney() {
    const sk = streak(), wk = weekCount(), goal = +setting("weeklyGoal", 5) || 5;
    const total = Object.values(S.status).filter((s) => s.state === "read").length;
    $("journey").innerHTML = `
      <div class="jstat" title="Weekdays in a row with a paper read. Weekends never break it."><span class="flame ${sk.todayDone ? "on" : ""}" aria-hidden="true">◆</span><span><span class="big">${sk.n}</span></span><span class="lab">day<br>streak</span></div>
      <div class="jstat" title="Papers read this week"><span class="ring" style="--p:${Math.min(100, Math.round((100 * wk) / goal))}" data-v="${wk}/${goal}"></span><span class="lab">this<br>week</span></div>
      <div class="jstat" title="Papers read in total"><span class="big">${total}</span><span class="lab">papers<br>read</span></div>`;
  }
  function milestones() {
    const read = Object.entries(S.status).filter(([, s]) => s.state === "read").map(([k]) => k);
    const m = byKey(); const sk = streak().n; const out = [];
    [1, 5, 10, 25, 50, 100, 200].forEach((n) => out.push({ id: "read" + n, ic: "◆", t: n === 1 ? "First paper read" : `${n} papers read`, got: read.length >= n }));
    [5, 10, 20, 40].forEach((n) => out.push({ id: "streak" + n, ic: "≋", t: `${n}-day streak`, got: sk >= n }));
    const fieldsRead = new Set(read.map((k) => m[k] && m[k].track).filter(Boolean));
    out.push({ id: "explorer", ic: "✦", t: "Read in every field", got: Object.keys(S.tracks).every((t) => fieldsRead.has(t)) });
    for (const [t, name] of Object.entries(S.tracks)) {
      const core = papers().filter((p) => p.track === t && p.pass === 1);
      out.push({ id: "core-" + t, ic: "⚑", t: `${name}: all core papers`, got: core.length > 0 && core.every((p) => DONE.has(st(p.key))) });
    }
    return out;
  }
  async function checkMilestones() {
    if (!S.writable) return;
    const seen = new Set(setting("milestonesSeen", [])); const ms = milestones().filter((x) => x.got);
    const fresh = ms.filter((x) => !seen.has(x.id));
    if (!fresh.length) return;
    if (seen.size === 0 && fresh.length > 3) { /* first run: record silently */ }
    else toast("Milestone: " + fresh.map((x) => x.t).join(" · "), null, true);
    try { await api("settings", { milestonesSeen: [...seen, ...fresh.map((x) => x.id)] }); S.settings.milestonesSeen = [...seen, ...fresh.map((x) => x.id)]; } catch (e) { /* not critical */ }
  }
  function renderMilestones() {
    const ms = milestones();
    const got = ms.filter((x) => x.got), next = ms.filter((x) => !x.got).slice(0, 8);
    $("milestones").innerHTML = `<div class="ms">${got.concat(next).map((x) => `<div class="badge-ms ${x.got ? "got" : ""}"><span class="ic" aria-hidden="true">${x.ic}</span><span>${esc(x.t)}</span></div>`).join("")}</div>`;
  }
  function renderHeatmap() {
    const m = readsByDay(); const weeks = 26, cs = 13, g = 3;
    const end = new Date(); const start = new Date(end); start.setDate(end.getDate() - (weeks * 7 - 1) - ((end.getDay() + 6) % 7 === 6 ? 0 : 0));
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7)); // Monday
    let cells = "", months = "", lastM = -1; const d = new Date(start);
    for (let w = 0; w < weeks + 1; w++) {
      for (let r = 0; r < 7; r++) {
        if (d > end) break;
        const c = m[iso(d)] || 0; const op = c ? Math.min(1, 0.35 + 0.3 * c) : 0;
        cells += `<rect x="${28 + w * (cs + g)}" y="${16 + r * (cs + g)}" width="${cs}" height="${cs}" fill="${c ? "var(--accent)" : "var(--soft)"}" fill-opacity="${c ? op : 1}"><title>${iso(d)}: ${c} read</title></rect>`;
        if (r === 0 && d.getMonth() !== lastM) { lastM = d.getMonth(); months += `<text x="${28 + w * (cs + g)}" y="10" font-size="9" fill="var(--muted)" font-family="var(--f-mono)">${d.toLocaleString("en", { month: "short" })}</text>`; }
        d.setDate(d.getDate() + 1);
      }
    }
    const days = ["Mon", "", "Wed", "", "Fri", "", ""].map((t, i) => t ? `<text x="0" y="${26 + i * (cs + g)}" font-size="9" fill="var(--muted)" font-family="var(--f-mono)">${t}</text>` : "").join("");
    $("heatmap").innerHTML = `<svg viewBox="0 0 ${32 + (weeks + 1) * (cs + g)} ${20 + 7 * (cs + g)}" role="img" aria-label="Papers read per day over the last six months">${months}${days}${cells}</svg>`;
  }

  // ---------- Sky chart ----------
  // Each field is a constellation; its papers spiral out from the core in reading order (a Fermat spiral keeps
  // neighbours in sequence close together). Constellation lines join the core papers in order.
  const ORDER = ["GRP", "PML", "DLC", "ISO", "COMP", "DIF", "FLOW", "OT", "GEO", "DISC", "CTRL", "TRF", "GRL", "PROT", "SC"];
  function trackOrder() { const ks = Object.keys(S.tracks); return ORDER.filter((t) => ks.includes(t)).concat(ks.filter((t) => !ORDER.includes(t))); }
  const SKY = { W: 3900, H: 1450, v: { x: 0, y: 0, k: 0.5 }, L: null, anim: 0, moved: false, routed: "" };
  const NS = "http://www.w3.org/2000/svg";
  function hash(str) { let h = 2166136261; for (const c of String(str)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; }
  function rng(seed) { let a = seed >>> 0 || 1; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  const f1 = (n) => n.toFixed(1);
  function skyLayout() {
    const ts = trackOrder(); const step = (SKY.W - 600) / Math.max(1, ts.length - 1); const L = { tracks: {}, stars: {} };
    ts.forEach((t, i) => {
      const ps = papers().filter((p) => p.track === t); const n = Math.max(1, ps.length);
      const R = 48 + 13 * Math.sqrt(ps.length); const rot = hash(t) * Math.PI * 2;
      const cx = 300 + i * step, cy = SKY.H / 2 + (i % 2 ? -1 : 1) * 290 + Math.sin(i * 1.7) * 45;
      L.tracks[t] = { cx, cy, R, ps };
      ps.forEach((p, k) => {
        const r = R * Math.sqrt((k + 0.6) / n), th = rot + 3.4 * Math.sqrt(k + 0.6);
        L.stars[p.key] = { x: cx + r * Math.cos(th) + (hash(p.key) - 0.5) * 12, y: cy + r * Math.sin(th) + (hash(p.key + "y") - 0.5) * 12, p };
      });
    });
    return L;
  }
  function boundary(cx, cy, R, seed) {
    const r = rng(seed * 1e9), pts = [];
    for (let i = 0; i < 26; i++) { const a = (i / 26) * Math.PI * 2, rr = R * (1 + (r() - 0.5) * 0.22); pts.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)]); }
    return "M" + pts.map((q) => f1(q[0]) + "," + f1(q[1])).join("L") + "Z";
  }
  function smoothPath(pts) {
    if (pts.length < 2) return "";
    let d = `M${f1(pts[0][0])},${f1(pts[0][1])}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
      d += ` C${f1(p1[0] + (p2[0] - p0[0]) / 6)},${f1(p1[1] + (p2[1] - p0[1]) / 6)} ${f1(p2[0] - (p3[0] - p1[0]) / 6)},${f1(p2[1] - (p3[1] - p1[1]) / 6)} ${f1(p2[0])},${f1(p2[1])}`;
    }
    return d;
  }
  function cnameLines(name) {
    let parts = [name];
    if (name.length > 24) { const i = name.indexOf(" & ") > 6 ? name.indexOf(" & ") + 2 : name.lastIndexOf(" ", Math.ceil(name.length / 2) + 4); if (i > 0) parts = [name.slice(0, i).trim(), name.slice(i).trim()]; }
    return `<text class="cname" text-anchor="middle" y="${parts.length > 1 ? "-1.1em" : 0}">${parts.map((x, j) => `<tspan x="0" dy="${j ? "1.15em" : 0}">${esc(x)}</tspan>`).join("")}</text>`;
  }
  function starBase(p) { return p.pass === 1 ? 4.6 : p.pass === 2 ? 3.2 : 2.3; }
  function renderSky() {
    const L = (SKY.L = skyLayout()); const tk = (todayPaper() || {}).key; const ts = trackOrder(); let h = "";
    // graticule, like a printed star atlas
    let g = "";
    for (let x = 0; x <= SKY.W; x += 150) g += `<line x1="${x}" y1="0" x2="${x}" y2="${SKY.H}"/>`;
    for (let y = 0; y <= SKY.H; y += 150) g += `<line x1="0" y1="${y}" x2="${SKY.W}" y2="${y}"/>`;
    let gl = "";
    for (let x = 150; x < SKY.W; x += 300) gl += `<text class="coord" x="${x + 4}" y="14">${Math.round((x / SKY.W) * 24)}h</text>`;
    for (let y = 150; y < SKY.H; y += 300) { const dec = Math.round(60 - (y / SKY.H) * 120); gl += `<text class="coord" x="4" y="${y - 4}">${dec > 0 ? "+" : ""}${dec}°</text>`; }
    h += `<g class="grid">${g}<rect x="0" y="0" width="${SKY.W}" height="${SKY.H}" class="frame"/></g><g class="coords">${gl}</g>`;
    // the ecliptic: your route through the fields, in the order you meet them
    const cs = ts.map((t) => [L.tracks[t].cx, L.tracks[t].cy]);
    h += `<path class="ecliptic" d="${smoothPath(cs)}"/>`;
    if (cs.length > 1) h += `<text class="ecl-label" x="${f1((cs[0][0] + cs[1][0]) / 2)}" y="${f1((cs[0][1] + cs[1][1]) / 2 - 10)}" text-anchor="middle">your route</text>`;
    // constellations
    for (const t of ts) {
      const { cx, cy, R, ps } = L.tracks[t]; const done = ps.filter((p) => DONE.has(st(p.key))).length;
      const core = ps.filter((p) => p.pass === 1);
      let lines = "";
      for (let i = 1; i < core.length; i++) {
        const a = L.stars[core[i - 1].key], b = L.stars[core[i].key]; const lit = DONE.has(st(core[i - 1].key)) && DONE.has(st(core[i].key));
        lines += `<line class="cl ${lit ? "lit" : ""}" x1="${f1(a.x)}" y1="${f1(a.y)}" x2="${f1(b.x)}" y2="${f1(b.y)}"/>`;
      }
      const stars = ps.map((p) => {
        const s = st(p.key), q = L.stars[p.key], here = p.key === tk;
        const isNew = isAdded(p) && p.addedAt && Date.now() - Date.parse(p.addedAt) < 14 * 864e5 && !DONE.has(s);
        return `<g class="star ${s || "open"} p${p.pass}${here ? " here" : ""}${isNew ? " new" : ""}" tabindex="0" role="button" data-stop="${esc(p.key)}" aria-label="${esc(p.title)}${s ? " (" + s + ")" : ""}" transform="translate(${f1(q.x)},${f1(q.y)})">
          <circle class="hit" r="9"/>${isNew ? `<circle class="newring" r="9"/>` : ""}${s === "read" ? `<circle class="halo-g" r="14" fill="url(#glow)"/>` : ""}<circle class="dot" r="${starBase(p)}" data-r="${starBase(p)}"/><title>${esc(p.title)}</title></g>`;
      }).join("");
      h += `<g class="const" data-track="${esc(t)}" style="--c:${tcolor(t)}">
        <path class="bound" d="${boundary(cx, cy, R + 34, hash(t))}"/>${lines}${stars}
        <g class="clabel" transform="translate(${f1(cx)},${f1(cy - R - 44)})">${cnameLines(S.tracks[t] || t)}<text class="ccount" y="1.5em" text-anchor="middle">${done} of ${ps.length} lit</text></g></g>`;
    }
    // tonight's star: a reticle on top of everything
    if (tk && L.stars[tk]) { const q = L.stars[tk]; h += `<g class="reticle" transform="translate(${f1(q.x)},${f1(q.y)})"><g class="ret-s"><circle r="13"/><path d="M0,-21V-15M0,21V15M-21,0H-15M21,0H15"/><circle class="pulse" r="13"/></g><text class="ret-label" y="-26" text-anchor="middle">tonight</text></g>`; }
    // compass rose and cartouche
    h += `<g class="rose" transform="translate(${SKY.W - 120},${SKY.H - 120})"><circle r="46"/><circle r="30"/><path d="M0,-62 L7,-7 L0,0 L-7,-7Z M0,62 L7,7 L0,0 L-7,7Z M-62,0 L-7,-7 L0,0 L-7,7Z M62,0 L7,-7 L0,0 L7,7Z"/><text y="-68" text-anchor="middle">N</text></g>`;
    h += `<g class="cartouche" transform="translate(70,${SKY.H - 70})"><text class="ct1">A chart of the reading sky</text><text class="ct2" y="1.5em">${Object.values(S.status).filter((s) => s.state === "read").length} stars lit · epoch ${new Date().getFullYear()}</text></g>`;
    $("skyView").innerHTML = h;
    $("skyView").querySelectorAll("[data-stop]").forEach((el) => {
      el.addEventListener("click", () => { if (!SKY.moved) showPop(el.dataset.stop, el.querySelector(".dot").getBoundingClientRect()); });
      el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); showPop(el.dataset.stop, el.querySelector(".dot").getBoundingClientRect()); } });
    });
    applyView();
  }
  function bgStars() {
    const w = innerWidth, hgt = innerHeight, r = rng(11), n = Math.round((w * hgt) / 2600); let h = "";
    for (let i = 0; i < n; i++) { const big = r() < 0.06; h += `<circle cx="${f1(r() * w)}" cy="${f1(r() * hgt)}" r="${big ? 1.25 : (0.45 + r() * 0.45).toFixed(2)}" opacity="${(0.25 + r() * 0.65).toFixed(2)}"/>`; }
    $("bgStars").innerHTML = h;
  }
  function applyView() {
    const { x, y, k } = SKY.v; const view = $("skyView");
    view.setAttribute("transform", `translate(${f1(x)},${f1(y)}) scale(${k.toFixed(4)})`);
    $("skySvg").style.setProperty("--k", k.toFixed(4)); $("skySvg").style.setProperty("--ks", Math.min(1, Math.pow(k / 0.9, 0.45)).toFixed(3));
    const sc = Math.pow(k, -0.55);
    view.querySelectorAll(".dot").forEach((c) => c.setAttribute("r", (+c.dataset.r * sc).toFixed(2)));
    view.querySelectorAll(".hit").forEach((c) => c.setAttribute("r", (11 / k).toFixed(1)));
    view.querySelectorAll(".halo-g").forEach((c) => c.setAttribute("r", (15 * sc).toFixed(1)));
    view.querySelectorAll(".ret-s").forEach((c) => c.setAttribute("transform", `scale(${(1 / k).toFixed(3)})`));
    $("bgStars").setAttribute("transform", `translate(${f1((x * 0.04) % 40)},${f1((y * 0.04) % 40)})`);
  }
  // the part of the screen where the sky is visible (not under the header or the side panel)
  function skyArea() {
    const top = document.querySelector(".top").getBoundingClientRect().bottom; let l = 0, r = innerWidth, t = top, b = innerHeight;
    const side = [...document.querySelectorAll(".side")].find((el) => !el.closest("[hidden]") && el.getClientRects().length);
    if (side && getComputedStyle(side).position === "fixed") l = side.getBoundingClientRect().right;
    else if (side && side.firstElementChild) b = Math.min(b, side.firstElementChild.getBoundingClientRect().top + scrollY);
    if (b - t < 120) b = t + 120;
    return { l: l + 12, r: r - 12, t: t + 12, b: b - 12 };
  }
  function fitTo(x0, y0, x1, y1, maxK, animate) {
    const A = skyArea(); const k = Math.max(0.1, Math.min(maxK || 3, (A.r - A.l) / (x1 - x0), (A.b - A.t) / (y1 - y0)));
    const v = { k, x: (A.l + A.r) / 2 - k * (x0 + x1) / 2, y: (A.t + A.b) / 2 - k * (y0 + y1) / 2 };
    flyTo(v, animate);
  }
  function flyTo(v, animate) {
    cancelAnimationFrame(SKY.anim);
    if (!animate || matchMedia("(prefers-reduced-motion: reduce)").matches) { SKY.v = v; applyView(); return; }
    const from = Object.assign({}, SKY.v), t0 = performance.now(), D = 650;
    const step = (now) => { const u = Math.min(1, (now - t0) / D), e = 1 - Math.pow(1 - u, 3);
      SKY.v = { x: from.x + (v.x - from.x) * e, y: from.y + (v.y - from.y) * e, k: from.k * Math.pow(v.k / from.k, e) }; applyView(); if (u < 1) SKY.anim = requestAnimationFrame(step); };
    SKY.anim = requestAnimationFrame(step);
  }
  function skyWhole(animate) { fitTo(0, 0, SKY.W, SKY.H, 3, animate); }
  function skyTrack(t, animate) { const c = SKY.L && SKY.L.tracks[t]; if (!c) return skyWhole(animate); const R = c.R + 80; fitTo(c.cx - R, c.cy - R - 30, c.cx + R, c.cy + R, 2.4, animate); }
  function skyToday(animate) {
    const p = todayPaper(); const q = p && SKY.L && SKY.L.stars[p.key]; if (!q) return skyWhole(animate);
    const c = SKY.L.tracks[p.track]; const R = c.R + 80; const A = skyArea();
    const k = Math.max(0.1, Math.min(2.4, (A.r - A.l) / (2 * R), (A.b - A.t) / (2 * R + 30)));
    // frame the constellation, nudged so tonight's star sits near the middle
    const cx = (c.cx * 2 + q.x) / 3, cy = (c.cy * 2 + q.y) / 3;
    flyTo({ k, x: (A.l + A.r) / 2 - k * cx, y: (A.t + A.b) / 2 - k * cy }, animate);
  }
  function zoomAt(f, px, py) {
    const v = SKY.v; const k = Math.max(0.15, Math.min(6, v.k * f)); const r = k / v.k;
    SKY.v = { k, x: px - (px - v.x) * r, y: py - (py - v.y) * r }; applyView();
  }
  function initSky() {
    const svg = $("skySvg"); const pts = new Map(); let start = null;
    svg.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); SKY.moved = false; cancelAnimationFrame(SKY.anim);
      start = { v: Object.assign({}, SKY.v), pts: new Map([...pts].map(([i, p]) => [i, Object.assign({}, p)])) };
    });
    window.addEventListener("pointermove", (e) => {
      if (!pts.has(e.pointerId) || !start) return; pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const cur = [...pts.values()], st0 = [...start.pts.values()];
      if (cur.length === 1 && st0.length === 1) {
        const dx = cur[0].x - st0[0].x, dy = cur[0].y - st0[0].y;
        if (Math.abs(dx) + Math.abs(dy) > 4) SKY.moved = true;
        if (SKY.moved) { svg.classList.add("dragging"); SKY.v = { k: start.v.k, x: start.v.x + dx, y: start.v.y + dy }; applyView(); }
      } else if (cur.length >= 2 && st0.length >= 2) {
        SKY.moved = true; const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
        const m0 = { x: (st0[0].x + st0[1].x) / 2, y: (st0[0].y + st0[1].y) / 2 }, m1 = { x: (cur[0].x + cur[1].x) / 2, y: (cur[0].y + cur[1].y) / 2 };
        const k = Math.max(0.15, Math.min(6, start.v.k * d(cur[0], cur[1]) / Math.max(1, d(st0[0], st0[1])))); const r = k / start.v.k;
        SKY.v = { k, x: m1.x - (m0.x - start.v.x) * r, y: m1.y - (m0.y - start.v.y) * r }; applyView();
      }
    });
    const end = (e) => {
      if (!pts.has(e.pointerId)) return; pts.delete(e.pointerId); svg.classList.remove("dragging");
      start = pts.size ? { v: Object.assign({}, SKY.v), pts: new Map([...pts].map(([i, p]) => [i, Object.assign({}, p)])) } : null;
      if (SKY.moved) setTimeout(() => (SKY.moved = false), 0);
    };
    window.addEventListener("pointerup", end); window.addEventListener("pointercancel", end);
    svg.addEventListener("wheel", (e) => {
      e.preventDefault(); cancelAnimationFrame(SKY.anim);
      const mouseWheel = e.deltaMode === 1 || (e.deltaX === 0 && Math.abs(e.deltaY) >= 50 && Number.isInteger(e.deltaY));
      if (e.ctrlKey || mouseWheel) zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX, e.clientY);
      else { SKY.v = { k: SKY.v.k, x: SKY.v.x - e.deltaX, y: SKY.v.y - e.deltaY }; applyView(); }
    }, { passive: false });
    const mid = () => { const A = skyArea(); return [(A.l + A.r) / 2, (A.t + A.b) / 2]; };
    $("zIn").onclick = () => { cancelAnimationFrame(SKY.anim); zoomAt(1.4, ...mid()); };
    $("zOut").onclick = () => { cancelAnimationFrame(SKY.anim); zoomAt(1 / 1.4, ...mid()); };
    $("zFit").onclick = () => skyWhole(true);
    $("zHere").onclick = () => skyToday(true);
    let rt; window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => { bgStars(); focusSky(false); }, 150); });
    bgStars();
  }
  function focusSky(animate) { const h = SKY.routed; if (h === "atlas") skyWhole(animate); else if (h === "today") skyToday(animate); }
  const ADDED_SRC = new Set(["discover", "you", "zotero", "followup", "gap", "jes-new", "new"]);
  // papers that arrived one at a time (from Discover, the add form, Zotero or the morning update), not the planned curriculum
  function isAdded(p) { return ADDED_SRC.has(p.source) && !p.due && !p.book && (p.source !== "you" || /^u/.test(p.key)) && (p.source !== "zotero" || /^z-/.test(p.key)); }
  function renderAdded() {
    const since = Date.now() - 21 * 864e5;
    const items = S.papers.filter((p) => isAdded(p) && p.seq != null && (!p.addedAt || Date.parse(p.addedAt) > since || !DONE.has(st(p.key))))
      .sort((a, b) => (b.addedAt || "").localeCompare(a.addedAt || "")).slice(0, 12);
    $("addedBox").hidden = !items.length;
    $("addedList").innerHTML = items.map((p) => `<div class="added-row"><a href="#" data-open="${esc(p.key)}">${esc(p.title)}</a><span class="pass">${esc({ discover: "Discover", you: "you", zotero: "Zotero", followup: "follow-up", gap: "gap", "jes-new": "group", new: "new" }[p.source] || p.source)} · ${esc(queuePos(p.key))}</span></div>`).join("");
  }
  function renderAtlas() {
    $("atlas").innerHTML = trackOrder().map((t) => {
      const ps = papers().filter((p) => p.track === t); const d = ps.filter((p) => DONE.has(st(p.key))).length; const pct = ps.length ? (100 * d) / ps.length : 0;
      return `<button class="const-row" data-fly="${esc(t)}" style="--c:${tcolor(t)}"><span class="cdot" aria-hidden="true"></span><span class="cn">${esc(S.tracks[t] || t)}</span><span class="cc">${d}/${ps.length}</span><span class="cbar"><i style="width:${pct.toFixed(1)}%"></i></span></button>`;
    }).join("");
    $("atlas").querySelectorAll("[data-fly]").forEach((b) => (b.onclick = () => skyTrack(b.dataset.fly, true)));
    renderAdded();
    renderMilestones();
  }
  function bindStops(el) {
    el.querySelectorAll("[data-stop]").forEach((g) => {
      const open = (e) => showPop(g.dataset.stop, g.getBoundingClientRect());
      g.addEventListener("click", open); g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(e); } });
    });
  }
  function showPop(key, rect) {
    const p = byKey()[key]; if (!p) return; const s = st(key); const pop = $("pop");
    pop.innerHTML = `<span class="chip" style="color:${tcolor(p.track)}">${esc(S.tracks[p.track] || p.track)} · ${PASS[p.pass] || ""}</span>
      <h3 id="popTitle">${esc(p.title)}</h3><div class="pass">${esc(p.authors)} · ${esc(p.year)}${s ? " · " + esc(s) : ""}</div>
      <p class="hint">${esc(p.why)}</p>
      <div class="actions"><a class="btn primary" href="${esc(p.url)}" target="_blank" rel="noopener">Open</a>
        <span class="seg needs-write">${[["read", "Read"], ["known", "Known"], ["later", "Later"]].map(([k, l]) => `<button data-k="${esc(key)}" data-s="${k}" class="${s === k ? "on" : ""}">${l}</button>`).join("")}</span>
        <button class="btn" id="popOpen">Notes & details</button><button class="btn ghost" id="popAsk">Ask</button><button class="btn ghost" id="popClose" aria-label="Close">✕</button></div>
      ${(todayPaper() || {}).key !== key && !p.due ? `<div class="actions needs-write"><button class="btn ghost" id="popTonight">Read it tonight instead</button></div>` : ""}`;
    pop.hidden = false;
    const w = pop.offsetWidth, h = pop.offsetHeight;
    let x = Math.min(window.innerWidth - w - 16, Math.max(16, rect.left + rect.width / 2 - w / 2));
    let y = rect.bottom + 10; if (y + h > window.innerHeight - 16) y = Math.max(16, rect.top - h - 10);
    pop.style.left = x + "px"; pop.style.top = y + "px";
    bindRows(pop); $("popClose").onclick = () => (pop.hidden = true); $("popAsk").onclick = () => { pop.hidden = true; goAsk(key); }; $("popOpen").onclick = () => { pop.hidden = true; openPaper(key); };
    if ($("popTonight")) $("popTonight").onclick = () => { pop.hidden = true; const c = (todayPaper() || {}).key; startDay(key, c && DONE.has(st(c)) ? [c] : []); };
  }
  document.addEventListener("click", (e) => { const pop = $("pop"); if (!pop.hidden && !pop.contains(e.target) && !e.target.closest("[data-stop]")) pop.hidden = true; });

  // ---------- notes ----------
  function tmplHTML(prefix, s) {
    s = s || {}; const n = s.notes || {};
    const structured = setting("structuredNotes", false) || NOTE_FIELDS.some(([k]) => n[k]);
    return `<label class="lbl" for="${prefix}Note">One line to remember it by <span class="hint">(optional)</span></label>
      <input id="${prefix}Note" placeholder="The key idea, in your words" value="${esc(s.note || "")}">
      <label class="lbl" for="${prefix}Text">Notes <span class="hint">(as long as you like)</span></label>
      <textarea id="${prefix}Text" rows="${n.text ? Math.min(14, 3 + n.text.split("\n").length) : 3}" placeholder="Questions, equations, how it connects to your work…">${esc(n.text || "")}</textarea>
      ${structured ? `<details ${NOTE_FIELDS.some(([k]) => n[k]) ? "open" : ""}><summary>Structured notes</summary><div class="grid">${NOTE_FIELDS.map(([k, l]) => `<input id="${prefix}N_${k}" placeholder="${l}" aria-label="${l}" value="${esc(n[k] || "")}">`).join("")}</div></details>` : ""}`;
  }
  function readTmpl(prefix) {
    const notes = {}; NOTE_FIELDS.forEach(([k]) => { const v = ($(prefix + "N_" + k) || {}).value; if (v && v.trim()) notes[k] = v.trim(); });
    const tx = ($(prefix + "Text") || {}).value; if (tx && tx.trim()) notes.text = tx.trim();
    return { note: ($(prefix + "Note") || {}).value?.trim() || "", notes: Object.keys(notes).length ? notes : "" };
  }
  function composeNote(s) { const n = (s && s.notes) || {}; return [s && s.note].concat(NOTE_FIELDS.filter(([k]) => n[k]).map(([k, l]) => l + ": " + n[k]), n.text ? [n.text] : []).filter(Boolean).join("\n"); }

  // ---------- Paper page: everything about one paper, editable any time ----------
  function dayFor(key) { return S.days.find((d) => d.paper === key && d.summary) || null; }
  function extraFor(key) { for (const d of S.days) { const x = (d.extras || []).find((e) => e.paper === key); if (x) return x; } return null; }
  function openPaper(key) {
    if (!byKey()[key]) return; S.drawer = key; $("pop").hidden = true; renderDrawer(true);
    $("drawer").hidden = false; document.body.classList.add("drawer-open"); setTimeout(() => $("drClose") && $("drClose").focus(), 0);
  }
  function closePaper() { S.drawer = ""; $("drawer").hidden = true; document.body.classList.remove("drawer-open"); }
  function renderDrawer(force) {
    const key = S.drawer; if (!key) return; const box = $("drawerIn");
    if (!force && box.contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return; // don't wipe what you're typing
    const m = byKey(); const p = m[key]; if (!p) return closePaper(); const s = S.status[key] || {}; const state = s.state || "";
    const day = dayFor(key), x = extraFor(key); const tk = (todayPaper() || {}).key;
    const pre = (p.prereqs || []).concat(p.background || []).map((k) => m[k]).filter(Boolean);
    const next = S.papers.filter((q) => (q.prereqs || []).includes(key)).slice(0, 8);
    const qa = (S.tutor.qa || []).filter((q) => q.paper === key), str = (S.tutor.struggles || []).filter((q) => q.paper === key);
    const link = (q) => `<a href="#" data-open="${esc(q.key)}">${esc(q.title)}</a>${DONE.has(st(q.key)) ? " ✓" : ""}`;
    const sum = (day && day.summary) || (x && x.summary) || "";
    const tks = (day && day.takeaways) || (x && x.takeaways) || [];
    box.innerHTML = `
      <div class="dr-top"><span class="chip" style="color:${tcolor(p.track)}">${esc(S.tracks[p.track] || p.track || "?")}${p.pass ? " · " + (PASS[p.pass] || "") : ""}</span><button class="tool" id="drClose" aria-label="Close">✕</button></div>
      <h2 id="drTitle">${esc(p.title)}</h2>
      <div class="pass">${esc(p.authors)} · ${esc(p.year)}${p.book ? " · " + esc(p.book) + ", pp. " + esc(p.pages) : ""}${ident(p) ? " · " + esc(ident(p)) : ""}${p.due ? " · course prep for " + esc(p.due) : ""}</div>
      <div class="actions">
        <a class="btn primary" href="${esc(p.url)}" target="_blank" rel="noopener">${p.book ? "Open the chapter" : "Open paper"} ↗</a>
        <button class="btn" id="drAsk">Ask about it</button>
        ${p.zotero ? `<a class="btn ghost" href="zotero://select/library/items/${esc(p.zotero)}">Zotero</a>` : ""}
        ${tk !== key && !p.due ? `<button class="btn ghost needs-write" id="drTonight">Read it tonight</button>` : tk === key ? `<span class="hint">Tonight's paper</span>` : ""}
      </div>
      <section class="dr-sec needs-write">
        <div class="dr-row"><span class="lbl">Status</span>
          <span class="seg" role="group" aria-label="Status">${[["read", "Read"], ["skimmed", "Skimmed"], ["known", "Known"], ["later", "Later"], ["skipped", "Skip"]].map(([k, l]) => `<button data-ds="${k}" class="${state === k ? "on" : ""}" aria-pressed="${state === k}">${l}</button>`).join("")}</span></div>
        ${READISH.has(state) ? `<div class="dr-row"><label class="lbl" for="drDate">${state === "skimmed" ? "Skimmed on" : "Read on"}</label><input type="date" id="drDate" value="${esc(readDate(s))}" style="max-width:11em"></div>` : ""}
        <div class="dr-row"><span class="lbl">Rating</span><span class="stars" aria-label="Rating">${[1, 2, 3, 4, 5].map((i) => `<button data-drate="${i}" class="${(s.rating || 0) >= i ? "on" : ""}" aria-label="${i} of 5">★</button>`).join("")}</span></div>
        <div class="dr-row"><span class="lbl">Supervisors</span><button class="btn ghost" id="drDiscuss">${s.discuss ? "On the supervisor list ✓" : "Discuss with supervisors"}</button></div>
      </section>
      <section class="dr-sec needs-write tmpl">${tmplHTML("d", s)}
        <div class="actions"><button class="btn primary" id="drSave">Save notes</button><span class="status" id="drStatus"></span></div></section>
      ${!S.writable && composeNote(s) ? `<section class="dr-sec"><div class="lbl">Your notes</div><p style="white-space:pre-wrap;margin:0">${esc(composeNote(s))}</p></section>` : ""}
      <section class="dr-sec"><div class="lbl">${sum ? "Summary" : "Why it's on your path"}</div><p>${esc(sum || p.why || "")}</p>
        ${tks.length ? `<ul>${tks.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}
        ${day && day.relevance ? `<div class="foryou"><strong>For your work:</strong> ${esc(day.relevance)}</div>` : ""}
        ${x && (x.pitfalls || []).length ? `<div class="lbl">Where students get stuck</div><ul>${x.pitfalls.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}
        ${day && day.brief ? `<details><summary>How to read it</summary><p>${esc(day.brief)}</p></details>` : ""}
        ${day && day.keyFigure ? `<details><summary>Key figure</summary><p>${esc(day.keyFigure)}</p></details>` : ""}
        ${sum && p.why ? `<details><summary>Why it's on your path</summary><p>${esc(p.why)}</p></details>` : ""}</section>
      ${qa.length || str.length ? `<section class="dr-sec"><div class="lbl">From your Q&A chats</div>${str.length ? `<div class="chips">${str.map((x) => `<span class="struggle">${esc(x.concept)}</span>`).join("")}</div>` : ""}${qa.map((q) => `<div class="qa"><div class="q">${esc(q.q)}</div>${q.gist ? `<div class="g">${esc(q.gist)}</div>` : ""}<div class="pass">${esc(q.date || "")}</div></div>`).join("")}</section>` : ""}
      ${pre.length || next.length ? `<section class="dr-sec">${pre.length ? `<div class="lbl">Builds on</div><ul class="plain">${pre.map((q) => `<li>${link(q)}</li>`).join("")}</ul>` : ""}${next.length ? `<div class="lbl">Leads to</div><ul class="plain">${next.map((q) => `<li>${link(q)}</li>`).join("")}</ul>` : ""}</section>` : ""}
      <div id="drHl"></div>`;
    $("drClose").onclick = closePaper;
    $("drAsk").onclick = () => { closePaper(); goAsk(key); };
    if ($("drTonight")) $("drTonight").onclick = () => { const c = tk; closePaper(); startDay(key, c && DONE.has(st(c)) ? [c] : []); };
    box.querySelectorAll("[data-ds]").forEach((b) => (b.onclick = async () => { const prev = st(key); await setState(key, b.dataset.ds); const now = st(key); toast(now ? `Marked ${now}` : "Status cleared", () => setState(key, prev || now)); renderDrawer(true); }));
    box.querySelectorAll("[data-drate]").forEach((b) => (b.onclick = async () => { const r = +b.dataset.drate; await saveStatus(key, { rating: (s.rating || 0) === r ? "" : r }); renderDrawer(true); }));
    if ($("drDate")) $("drDate").onchange = () => saveStatus(key, { readOn: $("drDate").value });
    $("drDiscuss").onclick = () => discuss(p);
    $("drSave").onclick = async () => { $("drStatus").textContent = "Saving…"; const ok = await saveStatus(key, readTmpl("d")); $("drStatus").textContent = ok ? "Saved" : "Could not save."; };
    if (p.zotero && S.writable) annotationsInto(p.zotero, "drHl");
  }
  async function annotationsInto(zkey, id) {
    try { const hs = await (await fetch("api/annotations?key=" + encodeURIComponent(zkey))).json();
      if (hs.length && $(id)) $(id).innerHTML = `<section class="dr-sec"><details><summary>Your Zotero highlights (${hs.length})</summary>${hs.map((h) => `<div class="hl">${esc(h.text)}${h.comment ? `<div class="pass">${esc(h.comment)}</div>` : ""}</div>`).join("")}</details></section>`; } catch (e) { /* optional */ }
  }
  document.addEventListener("click", (e) => { const a = e.target.closest("[data-open]"); if (!a) return; e.preventDefault(); openPaper(a.dataset.open); });

  // ---------- Today ----------
  function renderToday() {
    const box = $("today"); const m = byKey(); const day = S.days[0];
    if (!day || !m[day.paper]) {
      const nx = upcoming(1)[0];
      box.innerHTML = `<h2>Ready when you are</h2><p class="empty">No paper scheduled yet.${nx ? ` Next on your path: <strong>${esc(nx.title)}</strong>.` : ""}</p>${nx ? `<div class="actions needs-write"><button class="btn primary big" id="startNext">Start it now</button></div>` : ""}`;
      if ($("startNext")) $("startNext").onclick = () => startDay(nx.key);
      return;
    }
    const p = m[day.paper]; const s = S.status[p.key] || {}; const state = s.state || "";
    const pre = (p.prereqs || []).concat(p.background || []).map((k) => m[k]).filter(Boolean);
    const finished = DONE.has(state); const nxt = finished ? upcoming(1, [p.key])[0] : null;
    if (finished && nxt && S.writable && day.id < todayISO() && !S.autoAdvanced) { S.autoAdvanced = true; startDay(nxt.key, [p.key]); return; }
    const isToday = day.id === todayISO();
    // how long this paper has been open (the plan waits for you instead of piling up)
    let since = day.id; for (const d of S.days) { if (d.paper === p.key) since = d.id; else break; }
    const wdays = (a, b) => { let n = 0; const d = new Date(a + "T12:00:00"), e = new Date(b + "T12:00:00"); while (d <= e) { const w = d.getDay(); if (w && w < 6 && !pausedOn(iso(d))) n++; d.setDate(d.getDate() + 1); } return n; };
    const dayN = finished ? 1 : Math.max(1, wdays(since, todayISO()));
    const busy = busyNow();
    const courseToday = S.papers.some((q) => q.due && q.due <= todayISO() && !DONE.has(st(q.key)));
    const label = finished ? (isToday ? "Today" : "Latest pick") : busy ? "Paused" : dayN > 1 ? `Day ${dayN} with this paper · since ${fmtDay(since)}` : isToday ? "Today" : "Still open · " + fmtDay(since);
    box.style.setProperty("--trk", tcolor(p.track));
    box.innerHTML = `
      ${busy ? `<div class="pausebar"><span>Paused until <strong>${esc(fmtDay(busy))}</strong>. No new papers, and your streak is frozen. The plan waits here.</span><button class="btn needs-write" id="resumeBtn">Resume now</button></div>` : ""}
      ${!busy && courseToday && !finished ? `<p class="optional">Course prep comes first today; this paper is optional and will wait for you.</p>` : ""}
      ${finished ? `<div class="donebar"><span>✓ ${state === "read" ? "Read. Nice." : state === "skimmed" ? "Skimmed. It stays on your revisit list." : state === "known" ? "Marked as known." : "Skipped."}${nxt ? ` Next: <strong>${esc(nxt.title)}</strong>` : ""}</span>${nxt ? `<button class="btn primary needs-write" id="startNext2">Start the next paper</button>` : ""}</div>` : ""}
      <div class="meta"><span class="eyebrow">${esc(label)}</span>
        <span class="chip" style="color:${tcolor(p.track)}">${esc(S.tracks[p.track] || p.track)}</span><span class="pass">stop #${p.seq} · ${PASS[p.pass] || ""}</span></div>
      <h2><a href="#" data-open="${esc(p.key)}" class="h2link" title="Notes & details">${esc(p.title)}</a></h2>
      <div class="meta"><span>${esc(p.authors)} · ${esc(p.year)}</span>${p.book ? `<span>Book · ${esc(p.book)} · pp. ${esc(p.pages)}</span>` : ""}${p.byJes ? `<span class="jes">${p.track === "GRP" ? "Your group" : "Jes Frellsen"}</span>` : ""}${p.inZotero ? "<span>In your Zotero</span>" : ""}${p.source === "supervisor" ? "<span>Group reading list</span>" : ""}</div>
      <p>${esc(day.summary || p.why)}</p>
      ${day.relevance ? `<div class="foryou"><strong>For your work:</strong> ${esc(day.relevance)}</div>` : ""}
      ${(day.takeaways || []).length ? `<details class="fold" open><summary>Key takeaways</summary><ul>${day.takeaways.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></details>` : ""}
      ${day.brief ? `<details class="fold"><summary>How to read it</summary><p>${esc(day.brief)}</p></details>` : ""}
      ${day.keyFigure ? `<details class="fold"><summary>Key figure</summary><div class="fig"><span>${esc(day.keyFigure)}</span>${day.figUrl ? `<a href="${esc(day.figUrl)}" target="_blank" rel="noopener">Open the figure</a>` : ""}</div></details>` : ""}
      ${!day.summary ? `<p class="pass">Summary and takeaways arrive with the next morning update.</p>` : ""}
      ${pre.length ? `<p class="builds">${p.track === "GRP" ? "Background" : "Builds on"}: ${pre.map((q) => esc(q.title) + (DONE.has(st(q.key)) ? " ✓" : "")).join(" · ")}</p>` : ""}
      <div class="actions">
        <a class="btn ${finished ? "" : "primary"} big" href="${esc(p.url)}" target="_blank" rel="noopener">${p.book ? "Open the chapter" : "Open paper"}</a>
        ${!finished ? `<button class="btn primary big needs-write" data-state="read">✓ Done</button><button class="btn big needs-write" data-state="skimmed" title="Read the summary, takeaways and figures. Enough to move on; it stays on your revisit list.">~ Skimmed</button>` : ""}
        <button class="btn big" id="askToday">Ask about it</button>
        ${p.zotero ? `<a class="btn ghost" href="zotero://select/library/items/${esc(p.zotero)}">Zotero</a>` : ""}
      </div>
      <div class="actions needs-write">
        ${!finished ? `<button class="btn ghost" data-state="known">I know it already</button><button class="btn ghost" data-state="later">Later</button><button class="btn ghost" data-state="skipped">Skip</button>` : `<button class="btn ghost" data-state="${state}">Undo</button>`}
        <button class="btn ghost" id="discussBtn">${s.discuss ? "On the supervisor list ✓" : "Discuss with supervisors"}</button>
        ${busy ? "" : `<button class="btn ghost" id="busyBtn">Busy? Pause…</button>`}
      </div>
      <div class="busybox needs-write" id="busyBox" hidden><label class="lbl" for="busyDate">Pause until (and including)</label>
        <div class="row-inline"><input type="date" id="busyDate" min="${todayISO()}" style="max-width:12em"><button class="btn primary" id="busyGo">Pause</button><button class="btn ghost" id="busyCancel">Cancel</button></div>
        <p class="hint">No new papers while you're away, and those days don't break your streak. Course chapters keep their dates. If you read something else meanwhile (a paper you're reviewing, say), log it in the Logbook so it counts.</p></div>
      <details class="fold needs-write" ${READISH.has(state) || s.note || (s.notes && Object.keys(s.notes).length) ? "open" : ""}><summary>Your notes</summary><div class="takeaway tmpl">${tmplHTML("t", s)}
        <div class="actions">${READISH.has(state) ? `<span class="stars" aria-label="Rating">${[1, 2, 3, 4, 5].map((i) => `<button data-r="${i}" class="${(s.rating || 0) >= i ? "on" : ""}" aria-label="${i} of 5">★</button>`).join("")}</span>` : ""}<button class="btn" id="saveNote">Save</button><span class="status" id="noteStatus"></span></div></div></details>
      <div id="hlBox"></div>
      ${day.news ? `<p class="news"><strong>Also new this week:</strong> ${esc(day.news)}</p>` : ""}`;
    box.querySelectorAll("[data-state]").forEach((b) => (b.onclick = () => setState(p.key, b.dataset.state)));
    if ($("resumeBtn")) $("resumeBtn").onclick = () => setBusy("");
    if ($("busyBtn")) $("busyBtn").onclick = () => { const d = new Date(); const toFri = (5 - d.getDay() + 7) % 7; d.setDate(d.getDate() + (toFri || 0)); $("busyDate").value = iso(d); $("busyBox").hidden = false; $("busyDate").focus(); };
    if ($("busyGo")) $("busyGo").onclick = () => { const v = $("busyDate").value; if (v) setBusy(v); };
    if ($("busyCancel")) $("busyCancel").onclick = () => ($("busyBox").hidden = true);
    box.querySelectorAll("[data-r]").forEach((b) => (b.onclick = () => saveStatus(p.key, { rating: +b.dataset.r })));
    if ($("saveNote")) $("saveNote").onclick = async () => { $("noteStatus").textContent = "Saving…"; const ok = await saveStatus(p.key, readTmpl("t")); $("noteStatus").textContent = ok ? "Saved" : "Could not save."; };
    $("discussBtn").onclick = () => discuss(p);
    $("askToday").onclick = () => goAsk(p.key);
    if ($("startNext2")) $("startNext2").onclick = () => startDay(nxt.key, [p.key]);
    if (p.zotero && S.writable) loadHighlights(p.zotero);
    const ups = upcoming(3, [p.key]);
    $("upnextList").innerHTML = ups.length ? `<div class="list mini">${ups.map((q) => rowHTML(q)).join("")}</div>` : '<p class="empty">Nothing else is unlocked yet.</p>';
    bindRows($("upnextList"));
  }
  async function loadHighlights(zkey) {
    try {
      const hs = await (await fetch("api/annotations?key=" + encodeURIComponent(zkey))).json();
      if (hs.length && $("hlBox")) $("hlBox").innerHTML = `<details class="fold"><summary>Your Zotero highlights (${hs.length})</summary>${hs.map((h) => `<div class="hl">${esc(h.text)}${h.comment ? `<div class="pass">${esc(h.comment)}</div>` : ""}</div>`).join("")}</details>`;
    } catch (e) { /* optional */ }
  }

  // ---------- Course prep: chapters scheduled on dates, read alongside the daily paper ----------
  function placeCourse() {
    const side = $("today").parentElement, cp = $("coursePanel");
    const first = !cp.hidden && S.papers.some((q) => q.due && q.due <= todayISO() && !DONE.has(st(q.key))) && !DONE.has(st((todayPaper() || {}).key));
    if (first && cp.nextElementSibling !== $("today")) side.insertBefore(cp, $("today"));
    if (!first && $("today").nextElementSibling !== cp) side.insertBefore(cp, $("today").nextElementSibling);
  }
  function renderCourse() {
    const t = todayISO(); const items = S.papers.filter((p) => p.due).sort((a, b) => a.due.localeCompare(b.due) || a.seq - b.seq);
    const d0 = new Date(); d0.setDate(d0.getDate() - 7); const from = iso(d0);
    const show = items.filter((p) => !DONE.has(st(p.key)) || p.due >= from);
    $("coursePanel").hidden = !show.length; if (!show.length) return;
    const done = show.filter((p) => DONE.has(st(p.key))).length;
    $("courseProg").textContent = `· ${done} of ${show.length} done`;
    const extra = {}; S.days.forEach((d) => (d.extras || []).forEach((x) => { if (!extra[x.paper]) extra[x.paper] = x; }));
    const groups = {}; show.forEach((p) => (groups[p.due] = groups[p.due] || []).push(p));
    const label = (ds) => { const d = new Date(ds + "T12:00:00"); return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }); };
    $("courseList").innerHTML = Object.entries(groups).map(([ds, ps]) => {
      const all = ps.every((p) => DONE.has(st(p.key))); const cls = ds === t ? "is-today" : ds < t && !all ? "late" : all ? "alldone" : "";
      return `<details class="cday ${cls}" ${ds === t || (ds < t && !all) ? "open" : ""}><summary><span>${label(ds)}${ds === t ? " · today" : ds < t && !all ? " · catch up" : ""}</span><span class="pass">${ps.filter((p) => DONE.has(st(p.key))).length}/${ps.length}</span></summary>
        ${ps.map((p) => { const s = st(p.key), x = extra[p.key];
          return `<div class="citem ${DONE.has(s) ? "isdone" : ""}"><div><a href="#" data-open="${esc(p.key)}" class="ct">${esc(p.title)}</a> <a class="ext" href="${esc(p.url)}" target="_blank" rel="noopener" aria-label="Open the chapter" title="Open the chapter">↗</a></div>
            <div class="pass">${esc(p.book || p.authors)} · pp. ${esc(p.pages || "")}</div>
            ${x ? `<details class="cx"><summary>Brief${(x.pitfalls || []).length ? " and student pitfalls" : ""}</summary>${x.summary ? `<p>${esc(x.summary)}</p>` : ""}${(x.takeaways || []).length ? `<ul>${x.takeaways.map((q) => `<li>${esc(q)}</li>`).join("")}</ul>` : ""}${(x.pitfalls || []).length ? `<div class="eyebrow">Where students get stuck</div><ul>${x.pitfalls.map((q) => `<li>${esc(q)}</li>`).join("")}</ul>` : ""}${x.links ? `<p class="hint">${esc(x.links)}</p>` : ""}</details>` : ""}
            <div class="seg needs-write" role="group" aria-label="Status">${[["read", "Read"], ["skimmed", "Skim"], ["known", "Known"], ["later", "Later"]].map(([k, l]) => `<button data-k="${esc(p.key)}" data-s="${k}" class="${s === k ? "on" : ""}" aria-pressed="${s === k}">${l}</button>`).join("")}</div></div>`; }).join("")}</details>`;
    }).join("");
    bindRows($("courseList")); placeCourse();
  }

  // ---------- Recall (optional) ----------
  function dueRecall() {
    const t = todayISO(); const m = byKey();
    return Object.entries(S.recall).filter(([k, e]) => !e.done && e.due && e.due <= t && m[k]).map(([k, e]) => ({ key: k, e, p: m[k] }));
  }
  function renderRecall() {
    const on = setting("recall", false); const due = on ? dueRecall() : [];
    $("recallPanel").hidden = !due.length;
    if (!due.length) return;
    const { key, e, p } = due[0]; const s = S.status[key] || {};
    const qa = (e.questions || [])[e.stage % Math.max(1, (e.questions || []).length)];
    $("recallList").innerHTML = `<p style="margin:0;font-weight:700">${esc(qa ? qa.q : `What was the key idea of “${p.title}”?`)}</p><div class="pass">${esc(p.title)}${due.length > 1 ? ` · ${due.length - 1} more due` : ""}</div>
      <details><summary>Reveal</summary><p style="margin:0">${esc(qa ? qa.a : composeNote(s) || p.why)}</p>
      <div class="actions needs-write" style="margin-top:8px"><button class="btn primary" data-res="remembered">Remembered</button><button class="btn" data-res="shaky">Shaky</button></div></details>`;
    $("recallList").querySelectorAll("[data-res]").forEach((b) => (b.onclick = async () => { try { await api("recall", { key, result: b.dataset.res }); await loadAll(); } catch (err) { alertBar(err); } }));
  }

  // ---------- Ask (briefing for a Claude chat) ----------
  function goAsk(key) { S.askKey = key; location.hash = "#ask"; fillAskSelect(); $("askPaper").value = key; $("askPreview").hidden = true; $("askQ").focus(); }
  function fillAskSelect() {
    const m = byKey(); const tp = todayPaper(); const seen = new Set(); const opt = (p) => { if (!p || seen.has(p.key)) return ""; seen.add(p.key); return `<option value="${esc(p.key)}">${esc(p.title.slice(0, 90))}</option>`; };
    const recent = Object.entries(S.status).filter(([, s]) => s.state === "read" || s.state === "known").sort((a, b) => (b[1].at || "").localeCompare(a[1].at || "")).slice(0, 25).map(([k]) => m[k]);
    const extra = S.askKey && m[S.askKey] ? opt(m[S.askKey]) : "";
    $("askPaper").innerHTML = (extra ? `<optgroup label="Selected">${extra}</optgroup>` : "") + (tp ? `<optgroup label="Today">${opt(tp)}</optgroup>` : "") +
      `<optgroup label="Recently read">${recent.map(opt).join("")}</optgroup><optgroup label="Coming up">${upcoming(15).map(opt).join("")}</optgroup>`;
    if (S.askKey && seen.has(S.askKey)) $("askPaper").value = S.askKey;
  }
  function related(p) {
    const m = byKey(); const keys = new Set((p.prereqs || []).concat(p.background || []));
    const read = Object.entries(S.status).filter(([k, s]) => (s.state === "read" || s.state === "known") && k !== p.key && m[k]);
    const pick = read.filter(([k]) => keys.has(k)).concat(read.filter(([k]) => !keys.has(k) && m[k].track === p.track).sort((a, b) => (b[1].at || "").localeCompare(a[1].at || "")));
    return pick.slice(0, 8).map(([k, s]) => ({ p: m[k], s }));
  }
  function briefing(key, question) {
    const m = byKey(); const p = m[key]; if (!p) return "";
    const day = S.days.find((d) => d.paper === key); const s = S.status[key] || {}; const rel = related(p); const relKeys = new Set(rel.map((r) => r.p.key));
    const style = (S.tutor.style || []).filter(Boolean);
    const struggles = (S.tutor.struggles || []).slice().sort((a, b) => ((m[b.paper] || {}).track === p.track) - ((m[a.paper] || {}).track === p.track) || (b.date || "").localeCompare(a.date || "")).slice(0, 8);
    const pastQ = (S.tutor.qa || []).filter((q) => q.paper === key || relKeys.has(q.paper)).slice(-8);
    const L = [];
    L.push("Please be my tutor for a research paper I'm reading. Keep this context in mind for the whole conversation.", "");
    if (p.book) L.push(`READING: ${p.title}`, `This is part of the book "${p.book}" by ${p.authors} (${p.year}), pages ${p.pages} of the PDF. I'll upload those pages (or the whole book) in this chat.`, "");
    else if (p.file) L.push(`PAPER: ${p.title} — ${p.authors} (${p.year})`, ...(/^https?:/.test(p.url) ? [`Link: ${p.url}`] : []), "I've attached the PDF to this chat.", "");
    else L.push(`PAPER: ${p.title} — ${p.authors} (${p.year})`, `Link: ${p.url}`, "If you can't open the link, tell me and I'll upload the PDF.", "");
    L.push("ABOUT ME: " + ABOUT_ME, "");
    if (style.length) L.push("HOW I LIKE ANSWERS:", ...style.map((x) => "- " + x), "");
    if (day && day.summary) L.push("SUMMARY FROM MY READING TOOL (may be imperfect):", day.summary, "");
    if (composeNote(s)) L.push("MY OWN NOTES ON IT:", composeNote(s), "");
    if (rel.length) L.push("RELATED PAPERS I'VE ALREADY READ (build on these, and point out connections):", ...rel.map(({ p: q, s: qs }) => `- ${q.title} (${q.authors}, ${q.year})${qs.note ? " — my takeaway: " + qs.note : ""}`), "");
    if (struggles.length) L.push("THINGS I'VE STRUGGLED WITH BEFORE (if today's question touches these, say so and reconnect to where I met them):", ...struggles.map((x) => `- ${x.concept}${m[x.paper] ? " (while reading " + m[x.paper].title + ")" : ""}`), "");
    if (pastQ.length) L.push("QUESTIONS I ASKED BEFORE ON THIS OR RELATED PAPERS:", ...pastQ.map((q) => `- ${q.q}${q.gist ? " → " + q.gist : ""}`), "");
    L.push("MY QUESTION: " + (question || "(I'll ask in my next message.)"), "");
    L.push("When I write \"wrap up\", reply only with a fenced code block labelled reading-path containing JSON like:",
      '{"paper": "' + key + '", "questions": [{"q": "my question", "gist": "one-sentence answer"}], "struggled": ["concept I found hard"], "style": {"liked": "what worked in your answers", "disliked": "what didn\'t"}}',
      "so I can save it to my reading notes.");
    return L.join("\n");
  }
  async function askGo(preview) {
    const key = $("askPaper").value; const text = briefing(key, $("askQ").value.trim());
    $("askPreview").textContent = text;
    if (preview) { $("askPreview").hidden = !$("askPreview").hidden; return; }
    let copied = false; try { await navigator.clipboard.writeText(text); copied = true; } catch (e) { /* fall back to selecting */ }
    $("askPreview").hidden = false;
    if (!copied) { const r = document.createRange(); r.selectNodeContents($("askPreview")); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); }
    $("askStatus").textContent = copied ? "Briefing copied. Paste it into the new chat (⌘V)." : "Copy the selected briefing below, then paste it into the chat.";
    const p = byKey()[key];
    if (p && p.file && !p.book) $("askStatus").insertAdjacentHTML("beforeend", ` Then attach the PDF: <a href="${esc(p.file)}" download>download it</a> and drag it into the chat.`);
    window.open("https://claude.ai/new", "_blank", "noopener");
    $("saveBack").open = true;
  }
  function parseWrap(text) {
    const fence = text.match(/```(?:reading-path|json)?\s*([\s\S]*?)```/); const raw = fence ? fence[1] : (text.match(/\{[\s\S]*\}/) || [""])[0];
    try { return JSON.parse(raw); } catch (e) { return null; }
  }
  async function tutorSave() {
    const text = $("tutorPaste").value.trim(); if (!text) return; const key = $("askPaper").value;
    const j = parseWrap(text) || { paper: key, questions: [{ q: $("askQ").value.trim() || "Notes", gist: text.slice(0, 500) }], struggled: [] };
    if (!j.paper || !byKey()[j.paper]) j.paper = key;
    try { await api("tutor", { op: "merge", ...j }); $("tutorPaste").value = ""; $("tutorStatus").textContent = "Saved to your tutor memory."; await loadAll(); }
    catch (e) { $("tutorStatus").textContent = "Could not save: " + e.message; }
  }
  function renderAskMemory() {
    const m = byKey();
    $("struggles").innerHTML = (S.tutor.struggles || []).length ? S.tutor.struggles.slice().reverse().slice(0, 30).map((x) => `<span class="struggle" title="${esc((m[x.paper] || {}).title || "")}">${esc(x.concept)}</span>`).join("") : '<p class="empty">Nothing yet. Concepts you found hard show up here after you save a chat.</p>';
    const qa = (S.tutor.qa || []).slice().reverse().slice(0, 30);
    $("pastQs").innerHTML = qa.length ? qa.map((q) => `<div class="qa"><div class="q">${esc(q.q)}</div>${q.gist ? `<div class="g">${esc(q.gist)}</div>` : ""}<div class="pass">${esc((m[q.paper] || {}).title || q.paper)} · ${esc(q.date || "")}</div></div>`).join("") : '<p class="empty">No saved questions yet.</p>';
  }

  // ---------- writes ----------
  async function saveStatus(key, patch) {
    const prev = S.status[key] || {}; const next = Object.assign({}, prev, patch, { at: new Date().toISOString() });
    if (patch.state === "read" && !next.readOn) next.readOn = todayISO();
    S.status[key] = next; renderAll();
    try { const r = await api("status", { key, patch }); S.status[key] = r.status || next; renderAll(); checkMilestones(); return true; } catch (e) { S.status[key] = prev; renderAll(); alertBar(e); return false; }
  }
  async function setState(key, state) {
    const cur = st(key); const nextState = cur === state ? "" : state;
    const ok = await saveStatus(key, nextState === "read" ? { state: nextState } : nextState === "skimmed" ? { state: nextState, readOn: todayISO() } : { state: nextState, readOn: "" });
    if (ok && S.days[0] && S.days[0].paper === key && ["known", "skipped", "later"].includes(nextState)) await replaceToday(key);
    // undoing "done" on a paper finished earlier today: make it tonight's paper again
    else if (ok && !nextState && S.days[0] && S.days[0].id === todayISO() && (S.days[0].finished || []).includes(key) && S.days[0].paper !== key) await startDay(key);
    return ok;
  }
  async function replaceToday(oldKey) {
    const id = todayISO(); const cur = S.days[0]; const same = cur && cur.id === id;
    const next = upcoming(1, [oldKey])[0]; if (!next) return;
    const doc = { id, paper: next.key, brief: "", news: same ? cur.news || "" : "", replaced: [...(same ? cur.replaced || [] : []), oldKey], finished: same ? cur.finished || [] : [], extras: same ? cur.extras || [] : [] };
    try { await api("day", doc); await loadAll(); } catch (e) { alertBar(e); }
  }
  async function startDay(key, finished) {
    const cur = S.days[0]; const same = cur && cur.id === todayISO();
    const doc = { id: todayISO(), paper: key, brief: "", news: same ? cur.news || "" : "", replaced: same ? cur.replaced || [] : [], finished: [...(same ? cur.finished || [] : []), ...(finished || [])].filter((k) => k !== key), extras: same ? cur.extras || [] : [] };
    // reuse the summary and takeaways if this paper was picked on an earlier day
    const earlier = S.days.find((d) => d.paper === key && d.summary);
    if (earlier) ["summary", "takeaways", "keyFigure", "figUrl", "relevance", "brief"].forEach((f) => { if (earlier[f]) doc[f] = earlier[f]; });
    try { await api("day", doc); await loadAll(); location.hash = "#today"; } catch (e) { alertBar(e); }
  }
  function alertBar(e) { const m = $("mode"); m.hidden = false; m.className = "modebar warn"; m.textContent = "Could not save: " + (e.message || e) + ". Is server.py still running?"; }

  // ---------- rows ----------
  function rowHTML(p, todayKey) {
    const s = st(p.key);
    return `<div class="row ${DONE.has(s) ? "isdone" : ""}">
      <span class="n">${p.seq == null ? "—" : p.seq % 1 ? p.seq.toFixed(1) : p.seq}</span>
      <div class="t"><span><a href="#" data-open="${esc(p.key)}">${esc(p.title)}</a> <a class="ext" href="${esc(p.url)}" target="_blank" rel="noopener" aria-label="Open the paper" title="Open the paper">↗</a></span>
        <div class="sub"><span class="chip" style="color:${tcolor(p.track)}">${esc(p.track || "?")}</span>${{ discover: "From Discover", you: "Added by you", zotero: "From Zotero", followup: "Follow-up", gap: "Fills a gap" }[p.source] ? `<span class="srcchip">${{ discover: "From Discover", you: "Added by you", zotero: "From Zotero", followup: "Follow-up", gap: "Fills a gap" }[p.source]}</span>` : ""}${p.byJes ? `<span class="jes">${p.track === "GRP" ? "Group" : "Jes"}</span>` : ""}<span>${esc(p.authors)} ${esc(p.year)}</span>${s ? `<span class="statechip st-${esc(s)}">${esc(s === "skipped" ? "not for me" : s)}</span>` : ""}</div></div>
      <div class="seg needs-write" role="group" aria-label="Status">${[["read", "Read"], ["skimmed", "Skim"], ["known", "Known"], ["later", "Later"]].map(([k, l]) => `<button data-k="${esc(p.key)}" data-s="${k}" class="${s === k ? "on" : ""}" aria-pressed="${s === k}">${l}</button>`).join("")}</div></div>`;
  }
  function bindRows(el) { el.querySelectorAll("[data-k]").forEach((b) => (b.onclick = async () => {
    const key = b.dataset.k, prev = st(key); await setState(key, b.dataset.s); const now = st(key); const p = byKey()[key]; $("pop").hidden = true;
    toast(now ? `${{ read: "Read", skimmed: "Skimmed", known: "Known", later: "Later" }[now] || now}: ${p ? p.title : key}` : "Status cleared", () => setState(key, prev || now)); })); }
  let toastT;
  function toast(msg, undo, cele) {
    let t = $("toast"); if (!t) { t = document.createElement("div"); t.id = "toast"; t.setAttribute("role", "status"); document.body.appendChild(t); }
    t.className = "toast" + (cele ? " cele" : "");
    t.innerHTML = `<span>${esc(msg)}</span>${undo ? '<button class="btn" id="toastUndo">Undo</button>' : ""}`; t.hidden = false;
    if (undo) $("toastUndo").onclick = () => { t.hidden = true; undo(); };
    clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), cele ? 7000 : 5000);
  }

  // ---------- Meeting prep ----------
  async function discuss(p) {
    const s = S.status[p.key] || {};
    if (s.discuss) { location.hash = "#more"; return; }
    try { await api("agenda", { op: "add", text: `About “${p.title}”`, key: p.key }); await saveStatus(p.key, { discuss: true }); await loadAll(); toast("Added to your list for your supervisors (More tab)"); } catch (e) { alertBar(e); }
  }
  function agendaMd(items) {
    const m = byKey();
    return "# For the supervisor meeting (" + todayISO() + ")\n\n" + items.map((it) => { const p = m[it.key]; const s = p ? S.status[p.key] || {} : {};
      return "- " + it.text + (p ? `\n  - Paper: ${p.title} (${p.authors}, ${p.year}) ${p.url}` + (composeNote(s) ? "\n  - My notes: " + composeNote(s).replace(/\n/g, "; ") : "") : ""); }).join("\n");
  }
  function renderAgenda() {
    const m = byKey(); const open = S.agenda.filter((a) => !a.done), old = S.agenda.filter((a) => a.done).slice().reverse();
    const item = (it, isOld) => { const p = m[it.key]; const s = p ? S.status[p.key] || {} : {};
      return `<div class="agenda-item"><div><div>${isOld ? `<strong>${esc(it.text)}</strong>` : `<input class="aEdit" data-aid="${esc(it.id)}" value="${esc(it.text)}" aria-label="Question">`}</div>
        ${p ? `<div class="ctx"><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.title)}</a>${composeNote(s) ? " · " + esc(composeNote(s).split("\n")[0]) : ""}</div>` : ""}
        ${isOld ? `<div class="ctx">Discussed ${esc(it.done.slice(0, 10))}</div>` : ""}</div>
        ${isOld ? "" : `<button class="btn needs-write" data-adone="${esc(it.id)}">Discussed</button>`}</div>`; };
    $("agendaList").innerHTML = open.length ? open.map((it) => item(it, false)).join("") : '<p class="empty">Nothing on the list yet.</p>';
    $("agendaOld").innerHTML = old.length ? old.map((it) => item(it, true)).join("") : '<p class="empty">Nothing yet.</p>';
    $("agendaList").querySelectorAll("[data-adone]").forEach((b) => (b.onclick = () => agendaDone([b.dataset.adone])));
    $("agendaList").querySelectorAll(".aEdit").forEach((i) => i.addEventListener("change", () => api("agenda", { id: i.dataset.aid, text: i.value }).catch(alertBar)));
  }
  async function agendaDone(ids) {
    const m = byKey();
    try { for (const id of ids) { await api("agenda", { id, done: new Date().toISOString() }); const it = S.agenda.find((a) => a.id === id); if (it && it.key && m[it.key]) await api("status", { key: it.key, patch: { discuss: "" } }); } await loadAll(); } catch (e) { alertBar(e); }
  }

  // ---------- Writing, digests ----------
  function renderDrafts() {
    const queued = S.requests.filter((r) => r.status === "queued");
    $("draftList").innerHTML = queued.map((r) => `<article class="card"><span class="eyebrow">Queued ${esc(r.created.slice(0, 10))}</span><h3>${esc(r.topic)}</h3><p class="hint">Will be drafted in the next morning update.</p></article>`).join("") +
      S.drafts.map((d, i) => `<article class="card"><span class="eyebrow">${esc((d.created || "").slice(0, 10))} · ${d.cited || 0} cited · ${esc(d.file || "")}</span><h3>${esc(d.topic)}</h3>
        <pre class="draft">${esc(d.md)}</pre><div class="actions"><button class="btn" data-dcopy="${i}" data-what="md">Copy Markdown</button><button class="btn" data-dcopy="${i}" data-what="bib">Copy BibTeX</button><span class="status" id="dcs${i}"></span></div></article>`).join("");
    $("draftList").querySelectorAll("[data-dcopy]").forEach((b) => (b.onclick = async () => { const d = S.drafts[+b.dataset.dcopy]; try { await navigator.clipboard.writeText(b.dataset.what === "md" ? d.md : d.bib); $("dcs" + b.dataset.dcopy).textContent = "Copied"; } catch (e) { $("dcs" + b.dataset.dcopy).textContent = "Copy failed; the file is in " + d.file; } }));
  }
  async function submitDraft(now) {
    const topic = $("dTopic").value.trim(); if (!topic) return;
    $("dStatus").textContent = now ? "Drafting… this can take a minute." : "Queuing…";
    try { const r = await api("draft", { topic, instructions: $("dInstr").value.trim(), now }); await loadAll(); $("dStatus").textContent = r.queued ? "Queued for the next morning update." : "Done."; $("draftForm").reset(); }
    catch (e) { $("dStatus").textContent = "Could not draft: " + e.message; }
  }
  function mdToHtml(md) {
    const inline = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\*(.+?)\*/g, "<em>$1</em>").replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    let out = "", inList = false;
    for (const line of String(md || "").split("\n")) {
      const h = line.match(/^#{1,4}\s+(.*)/), li = line.match(/^\s*[-*]\s+(.*)/);
      if (li) { if (!inList) { out += "<ul>"; inList = true; } out += "<li>" + inline(li[1]) + "</li>"; continue; }
      if (inList) { out += "</ul>"; inList = false; }
      if (h) out += "<h3>" + inline(h[1]) + "</h3>"; else if (line.trim()) out += "<p>" + inline(line) + "</p>";
    }
    return out + (inList ? "</ul>" : "");
  }
  function renderDigests() {
    if (!S.digests.length) return;
    $("digestList").innerHTML = S.digests.map((d, i) => `<details ${i === 0 ? "open" : ""}><summary>Week ending ${esc(d.id)}</summary><div class="md">${mdToHtml(d.md)}</div></details>`).join("");
  }

  // ---------- Quick sort ----------
  const QS = { list: [], i: 0, undo: [] };
  function qsCandidates() { return papers().filter((p) => !st(p.key) && p.pass >= 1).sort((a, b) => a.pass - b.pass || a.seq - b.seq); }
  function qsOpen() { QS.list = qsCandidates(); QS.i = 0; QS.undo = []; $("qs").hidden = false; qsShow(); }
  function qsClose() { $("qs").hidden = true; renderAll(); }
  function qsShow() {
    const p = QS.list[QS.i];
    if (!p) { $("qsCard").innerHTML = '<h3 id="qsTitle">All sorted.</h3><p class="empty">Every paper on the path has a decision.</p>'; $("qsProg").textContent = ""; return; }
    $("qsProg").textContent = `${QS.i + 1} of ${QS.list.length} · ${PASS[p.pass] || ""}`;
    $("qsCard").innerHTML = `<span class="chip" style="color:${tcolor(p.track)}">${esc(S.tracks[p.track] || p.track)}</span>
      <h3 id="qsTitle">${esc(p.title)}</h3><div class="pass">${esc(p.authors)} · ${esc(p.year)}${p.byJes ? " · Jes / group" : ""}</div><p class="hint">${esc(p.why)}</p>
      <a href="${esc(p.url)}" target="_blank" rel="noopener">Open the paper</a>`;
  }
  async function qsAct(a) {
    if (a === "undo") { const u = QS.undo.pop(); if (!u) return; QS.i = u.i; if (u.state) { try { await api("status", { key: u.key, patch: { state: "" } }); delete S.status[u.key]; } catch (e) { alertBar(e); } } qsShow(); return; }
    const p = QS.list[QS.i]; if (!p) return;
    if (a !== "keep") { S.status[p.key] = { state: a, at: new Date().toISOString() }; api("status", { key: p.key, patch: { state: a }, msg: "quick sort: " + p.key + " -> " + a }).catch(alertBar); }
    QS.undo.push({ i: QS.i, key: p.key, state: a !== "keep" ? a : "" }); QS.i++; qsShow();
    $("qsInfo").textContent = `${QS.i} sorted this session`;
  }

  // ---------- Discover ----------
  function discCard(d) {
    const r = (S.reactions[d.id] || {}).reaction || "";
    return `<article class="card ${r === "meh" ? "dim" : ""}">
      <div class="meta"><span class="eyebrow">${esc(d.date || "")}</span>${d.track ? `<span class="chip" style="color:${tcolor(d.track)}">${esc(S.tracks[d.track] || d.track)}</span>` : ""}<span>${esc(d.venue || "")}</span></div>
      <h3><a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.title)}</a></h3>
      <div class="pass">${esc(d.authors || "")} ${esc(d.year || "")}</div>
      ${d.summary ? `<p>${esc(d.summary)}</p>` : ""}
      ${(d.takeaways || []).length ? `<ul>${d.takeaways.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}
      ${d.keyFigure ? `<div class="fig"><span class="eyebrow">Key figure</span><span>${esc(d.keyFigure)}</span>${d.figUrl ? `<a href="${esc(d.figUrl)}" target="_blank" rel="noopener">Open the figure</a>` : ""}</div>` : d.figUrl ? `<div class="fig"><a href="${esc(d.figUrl)}" target="_blank" rel="noopener">Browse the figures</a></div>` : ""}
      ${d.relevance ? `<div class="foryou"><strong>For your work:</strong> ${esc(d.relevance)}</div>` : ""}
      ${(d.tags || []).length ? `<div class="tagrow">${d.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>` : ""}
      <div class="actions needs-write">
        ${r === "added" ? addedBadge((S.reactions[d.id] || {}).addedKey || "d-" + d.id) : `<button class="btn primary" data-dadd="${esc(d.id)}">Add to my path</button>`}
        <button class="btn ${r === "like" ? "done" : ""}" data-dr="like" data-did="${esc(d.id)}" aria-pressed="${r === "like"}">Interesting</button>
        <button class="btn meh ${r === "meh" ? "on" : ""}" data-dr="meh" data-did="${esc(d.id)}" aria-pressed="${r === "meh"}">Not for me</button>
        <button class="btn ghost" data-dread="${esc(d.id)}">I read it</button>
      </div></article>`;
  }
  function queuePos(key) {
    const st_ = st(key); if (DONE.has(st_)) return st_ === "skimmed" ? "skimmed" : "read";
    if ((todayPaper() || {}).key === key) return "tonight";
    const i = upcoming(60).findIndex((x) => x.key === key); return i >= 0 ? `#${i + 1} in line` : st_ === "later" ? "later" : "waiting for its prerequisites";
  }
  function addedBadge(key) {
    if (!byKey()[key]) return `<button class="btn done" disabled>On your path</button>`;
    return `<a href="#" class="btn done" data-open="${esc(key)}" title="Open it">On your path · ${esc(queuePos(key))}</a>`;
  }
  function renderDisc() {
    if (S.interests && S.interests.summary) $("interests").textContent = "What your reads and reactions say so far: " + S.interests.summary;
    const fresh = S.disc.filter((d) => d.date === todayISO() && !(S.reactions[d.id] || {}).reaction).length;
    $("discBadge").hidden = !fresh; $("discBadge").textContent = fresh;
    if (!S.disc.length) return;
    const latest = S.disc[0].date; const now = S.disc.filter((d) => d.date === latest), old = S.disc.filter((d) => d.date !== latest);
    $("disc").innerHTML = now.map(discCard).join("");
    $("discOlder").hidden = !old.length; $("discOld").innerHTML = old.map(discCard).join("");
    document.querySelectorAll("[data-dr]").forEach((b) => (b.onclick = () => react(b.dataset.did, b.dataset.dr)));
    document.querySelectorAll("[data-dadd]").forEach((b) => (b.onclick = () => addFromDisc(b.dataset.dadd)));
    document.querySelectorAll("[data-dread]").forEach((b) => (b.onclick = () => readFromDisc(b.dataset.dread)));
  }
  async function react(id, r) {
    const cur = (S.reactions[id] || {}).reaction || ""; if (cur === "added") return;
    const next = cur === r ? "" : r;
    S.reactions[id] = { reaction: next, at: new Date().toISOString() }; renderDisc();
    try { await api("reaction", { id, reaction: next }); } catch (e) { alertBar(e); }
  }
  async function addFromDisc(id) {
    const d = S.disc.find((x) => x.id === id); if (!d) return;
    // land right after the next two papers in your queue: soon, without jumping in front of everything
    const q = upcoming(3); const key = "d-" + id;
    const seq = q.length >= 3 ? +(q[2].seq + 0.01).toFixed(3) : q.length ? +(q[q.length - 1].seq + 0.01).toFixed(3) : papers().length + 1;
    const doc = { key, seq, addedAt: new Date().toISOString(), track: d.track || "PML", pass: 1, title: d.title, authors: d.authors || "", year: d.year || "", url: d.url, zotero: "", inZotero: false, byJes: false, prereqs: [], why: d.summary || "Added from Discover.", source: "discover", triaged: false };
    try { await api("paper", doc); await api("reaction", { id, reaction: "added", addedKey: key }); await loadAll(); const pos = upcoming(40).findIndex((x) => x.key === key); toast(`Added to your path${pos >= 0 ? `, #${pos + 1} in line` : ""}: ${d.title}`); } catch (e) { alertBar(e); }
  }
  function readFromDisc(id) {
    const d = S.disc.find((x) => x.id === id); if (!d) return;
    location.hash = "#library"; $("logBox").open = true;
    $("lQuery").value = d.url; $("lTitle").value = d.title; $("lAuthors").value = d.authors || ""; $("lYear").value = d.year || ""; if (d.track) $("lTrack").value = d.track;
    $("lMatch").textContent = "Filled in from Discover. Add a line to remember it by if you like, then log it."; $("lNote").focus();
  }

  // ---------- Log a read ----------
  function setLogStars(n) { S.logRating = n; $("lStars").innerHTML = [1, 2, 3, 4, 5].map((i) => `<button type="button" data-lr="${i}" class="${n >= i ? "on" : ""}" aria-label="${i} of 5">★</button>`).join(""); $("lStars").querySelectorAll("[data-lr]").forEach((b) => (b.onclick = () => setLogStars(S.logRating === +b.dataset.lr ? 0 : +b.dataset.lr))); }
  function normTitle(t) { return String(t || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
  function idFromQuery(q) { let m; q = q.trim(); if ((m = q.match(/(\d{4}\.\d{4,5})(v\d+)?/))) return "arXiv:" + m[1]; if ((m = q.match(/(10\.\d{4,9}\/[^\s?#]+)/))) return m[1].replace(/[.,;]$/, ""); return ""; }
  function findOnPlan(q, title) { const id = idFromQuery(q).toLowerCase(); const t = normTitle(title || q); return S.papers.find((p) => (id && ident(p).toLowerCase() === id) || (t.length > 12 && normTitle(p.title) === t)); }
  function showMatch() {
    const p = findOnPlan($("lQuery").value, $("lTitle").value);
    $("lMatch").textContent = p ? `On your path (${p.track}): “${p.title}”. Logging it marks it read and the plan moves past it.` : ($("lTitle").value ? "Not on your path. It will be logged as an independent read." : "");
  }
  async function lookup() {
    const q = $("lQuery").value.trim(); if (!q) return; $("lMatch").textContent = "Looking up…";
    try { const j = await (await fetch("api/lookup?q=" + encodeURIComponent(q))).json();
      if (j && j.title) { $("lTitle").value = j.title; $("lAuthors").value = j.authors || ""; $("lYear").value = j.year || ""; if (j.url) $("lQuery").value = j.url; }
      else $("lMatch").textContent = "Couldn't find it. Fill in the title yourself."; }
    catch (e) { $("lMatch").textContent = "Lookup needs the local server. Fill in the title yourself."; }
    showMatch();
  }
  async function submitLog(e) {
    e.preventDefault(); $("lStatus").textContent = "Saving…"; const tm = readTmpl("l");
    const body = { query: $("lQuery").value.trim(), title: $("lTitle").value.trim(), authors: $("lAuthors").value.trim(), year: $("lYear").value.trim(), date: $("lDate").value || todayISO(), track: $("lTrack").value, note: tm.note, notes: tm.notes, rating: S.logRating || undefined };
    if (!body.title && !findOnPlan(body.query, "")) { $("lStatus").textContent = "Add a title (or press Look up)."; return; }
    try { const j = await api("log", body); await loadAll(); checkMilestones();
      $("lStatus").textContent = j.matched ? "Marked as read on your path." : "Logged as an independent read.";
      e.target.reset(); setLogStars(0); $("lDate").value = todayISO(); $("lMatch").textContent = ""; document.querySelector('[data-tmpl="l"]').innerHTML = tmplHTML("l"); }
    catch (err) { $("lStatus").textContent = "Could not save: " + err.message; }
  }

  // ---------- progress, list ----------
  function renderProgress() {
    const all = papers(); const done = all.filter((p) => DONE.has(st(p.key)));
    const core = all.filter((p) => p.pass === 1), coreDone = core.filter((p) => DONE.has(st(p.key)));
    const ind = S.papers.filter((p) => p.source === "independent").length;
    $("summary").innerHTML = `<span><b>${done.length}</b> of ${all.length} done</span><span><b>${coreDone.length}</b> of ${core.length} core</span><span><b>${ind}</b> independent reads</span>`;
    $("progress").innerHTML = trackOrder().map((t) => { const ps = all.filter((p) => p.track === t), d = ps.filter((p) => DONE.has(st(p.key))).length, pct = ps.length ? Math.round((100 * d) / ps.length) : 0;
      return `<div class="prow"><div class="top"><span>${esc(S.tracks[t])}</span><span class="num">${d}/${ps.length}</span></div><div class="bar"><span style="width:${pct}%;background:${tcolor(t)}"></span></div></div>`; }).join("");
  }
  function renderList() {
    const t = $("fTrack").value, ps = $("fPass").value, fs = $("fState").value, q = $("fText").value.trim().toLowerCase();
    let rows = papers().filter((p) => (!t || p.track === t) && (!ps || String(p.pass) === ps) &&
      (!fs || (fs === "jes" && p.byJes) || (fs === "open" && !DONE.has(st(p.key)) && st(p.key) !== "later") || (fs === "done" && DONE.has(st(p.key))) || (fs === "later" && st(p.key) === "later")) &&
      (!q || (p.title + " " + p.authors).toLowerCase().includes(q)));
    const total = rows.length; rows = rows.slice(0, S.limit);
    $("list").innerHTML = rows.length ? rows.map((p) => rowHTML(p)).join("") : '<p class="empty" style="padding:10px 0">No papers match these filters.</p>';
    bindRows($("list")); $("more").hidden = total <= S.limit;
  }

  // ---------- Library & exports ----------
  function libRows() {
    const mode = $("lState").value, q = $("lText").value.trim().toLowerCase();
    return allPapers().filter((p) => { const s = S.status[p.key] || {};
      const ok = mode === "all" || (mode === "read" && s.state === "read") || (mode === "skimmed" && s.state === "skimmed") || (mode === "independent" && p.source === "independent") || (mode === "noted" && s.note) || (mode === "engaged" && ((DONE.has(s.state) && s.state !== "skipped") || s.note || s.rating));
      return ok && (!q || (p.title + " " + p.authors + " " + (s.note || "")).toLowerCase().includes(q)); })
      .sort((a, b) => ((S.status[b.key] || {}).at || "").localeCompare((S.status[a.key] || {}).at || ""));
  }
  function renderLib() {
    const rows = libRows();
    $("libBody").innerHTML = rows.length ? rows.map((p) => { const s = S.status[p.key] || {};
      return `<tr><td><a href="#" data-open="${esc(p.key)}">${esc(p.title)}</a> <a class="ext" href="${esc(p.url)}" target="_blank" rel="noopener" aria-label="Open the paper" title="Open the paper">↗</a><div class="pass">${esc(p.authors)} ${esc(p.year)}${ident(p) ? " · " + esc(ident(p)) : ""}${p.source === "independent" ? " · independent read" : ""}</div></td>
        <td><span class="chip" style="color:${tcolor(p.track)}">${esc(p.track || "?")}</span></td><td>${esc(s.state || "open")}</td><td class="pass">${esc(readDate(s))}</td><td>${s.rating || ""}</td><td class="note">${esc(composeNote(s)).replace(/\n/g, "<br>")}${s.zoteroItem ? '<div class="pass">In Zotero</div>' : (S.zsync[p.key] ? `<div class="pass">Zotero: ${esc(S.zsync[p.key].result)}</div>` : "")}</td></tr>`; }).join("")
      : '<tr><td colspan="6" class="empty">Nothing here yet. Papers you finish, rate or log show up here.</td></tr>';
  }
  function bibKey(p) { const a = (p.authors || "anon").split(/[ ,&]/)[0].normalize("NFD").replace(/[^A-Za-z]/g, "").toLowerCase() || "anon"; const w = (p.title || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").split(" ").find((x) => x.length > 3) || "paper"; return a + (p.year || "") + w; }
  function exportData(kind) {
    const rows = libRows(); const s_ = (k) => S.status[k] || {};
    if (kind === "json") return { name: "reading-path.json", text: JSON.stringify({ exported: new Date().toISOString(), tracks: S.tracks, papers: allPapers().map((p) => Object.assign({}, p, { id: ident(p), status: s_(p.key) })), days: S.days, discover: S.disc, reactions: S.reactions, interests: S.interests, tutor: S.tutor }, null, 1) };
    if (kind === "csv") { const c = (v) => '"' + String(v ?? "").replace(/"/g, '""') + '"';
      return { name: "reading-path.csv", text: ["key,title,authors,year,track,state,date,rating,note,identifier,url"].concat(rows.map((p) => { const s = s_(p.key); return [p.key, p.title, p.authors, p.year, p.track, s.state || "", readDate(s), s.rating || "", composeNote(s), ident(p), p.url].map(c).join(","); })).join("\n") }; }
    if (kind === "bib") return { name: "reading-path.bib", text: rows.map((p) => { const s = s_(p.key), id = ident(p);
      return `@misc{${bibKey(p)},\n  title = {{${p.title}}},\n  author = {${p.authors}},\n  year = {${p.year}},\n  url = {${p.url}},` + (id.startsWith("arXiv:") ? `\n  eprint = {${id.slice(6)}},\n  archivePrefix = {arXiv},` : id ? `\n  doi = {${id}},` : "") + (composeNote(s) ? `\n  annote = {${composeNote(s).replace(/[{}]/g, "").replace(/\n/g, "; ")}},` : "") + `\n  keywords = {reading-path, ${p.track}${s.state ? ", " + s.state : ""}}\n}`; }).join("\n\n") };
    if (kind === "md") return { name: "reading-notes.md", text: "# Reading notes\n\n" + rows.map((p) => { const s = s_(p.key); return `## ${p.title}\n${p.authors} (${p.year}) · ${p.track} · ${s.state || "open"}${s.rating ? " · " + s.rating + "/5" : ""}${readDate(s) ? " · " + readDate(s) : ""}\n${p.url}\n\n${composeNote(s) || "_No note._"}\n`; }).join("\n") };
  }
  function doExport(kind) {
    const { name, text } = exportData(kind); const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" })); a.download = name; document.body.appendChild(a); a.click(); a.remove();
    $("expStatus").textContent = "Saved " + name;
  }

  // ---------- add to path, settings ----------
  async function submitAdd(e) {
    e.preventDefault(); const all = papers(); const title = $("aTitle").value.trim(); if (!title) return;
    let track = $("aTrack").value, newTrack = null, seq;
    if (track === "+new") {
      const name = $("aTrackName").value.trim(); if (!name) { $("aStatus").textContent = "Give the new field a name."; return; }
      const hit = Object.entries(S.tracks).find(([, v]) => v.toLowerCase() === name.toLowerCase());
      if (hit) track = hit[0]; else { newTrack = { code: trackCode(name), name }; track = newTrack.code; }
    }
    if ($("aWhen").value === "next") { const open = all.filter((p) => !DONE.has(st(p.key)) && p.key !== S.days[0]?.paper); seq = open.length ? open[0].seq - 0.5 : all.length + 1; }
    else { const same = all.filter((p) => p.pass === 2); seq = same.length ? Math.max(...same.map((p) => p.seq)) + 0.5 : all.length + 1; }
    const au = $("aAuthors").value.trim(); const ym = au.match(/(19|20)\d\d/);
    const doc = { key: "u" + Date.now().toString(36), seq, track, pass: $("aWhen").value === "next" ? 1 : 2, title, authors: au.replace(/,?\s*(19|20)\d\d\s*$/, ""), year: ym ? +ym[0] : "", url: $("aUrl").value.trim() || "https://scholar.google.com/scholar?q=" + encodeURIComponent(title), zotero: "", inZotero: false, byJes: false, prereqs: [], why: $("aWhy").value.trim() || "Added by you.", source: "you", triaged: false };
    if (newTrack) doc.newTrack = newTrack;
    $("aStatus").textContent = "Adding…";
    try {
      const f = $("aPdf").files[0]; if (f) doc.pdf = await pdfBase64(f);
      await api("paper", doc); await loadAll(); $("aStatus").textContent = "Added to the path"; e.target.reset();
      S.lastAdded = doc.key; $("aAsk").hidden = false; $("aTrackName").hidden = true; if (newTrack) fillTrackSelects();
    } catch (err) { $("aStatus").textContent = "Could not add it: " + err.message; }
  }
  function trackCode(name) {
    const w = name.normalize("NFD").toUpperCase().replace(/[^A-Z ]/g, "").split(/\s+/).filter(Boolean);
    let c = (w.length > 1 ? w.map((x) => x[0]).join("") : w[0] || "").slice(0, 4);
    if (c.length < 2) c = (c + "FLD").slice(0, 3);
    for (let i = 2, b = c; S.tracks[c]; i++) c = b + i;
    return c;
  }
  const pdfBase64 = (f) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.onerror = rej; r.readAsDataURL(f); });
  function fillSettings() { $("sGoal").value = setting("weeklyGoal", 5); $("sRecall").checked = !!setting("recall", false); $("sNotes").checked = !!setting("structuredNotes", false); }
  async function saveSettings(e) {
    e.preventDefault();
    const body = { weeklyGoal: Math.max(1, Math.min(20, +$("sGoal").value || 5)), recall: $("sRecall").checked, structuredNotes: $("sNotes").checked };
    try { await api("settings", body); Object.assign(S.settings, body); $("setStatus").textContent = "Saved"; renderAll(); document.querySelector('[data-tmpl="l"]').innerHTML = tmplHTML("l"); } catch (err) { $("setStatus").textContent = "Could not save: " + err.message; }
  }
  function fillTrackSelects() {
    const opts = Object.entries(S.tracks).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("");
    $("fTrack").innerHTML = '<option value="">All fields</option>' + opts; $("aTrack").innerHTML = opts + '<option value="+new">+ New field…</option>';
    $("lTrack").innerHTML = '<option value="">Field: let Claude decide</option>' + opts;
  }

  // ---------- tabs ----------
  function route() {
    let h = (location.hash || "#today").slice(1);
    const alias = { "today-s": "today", log: "library", meeting: "more", writing: "more", digests: "more", recall: "today", path: "atlas" };
    if (alias[h]) { if (h === "log") setTimeout(() => ($("logBox").open = true), 0); h = alias[h]; }
    if (!TABS.includes(h)) h = "today";
    document.querySelectorAll("[data-panel]").forEach((s) => (s.hidden = s.dataset.panel !== h));
    document.querySelectorAll("[data-tab]").forEach((a) => a.setAttribute("aria-selected", String(a.dataset.tab === h)));
    $("pop").hidden = true;
    document.body.dataset.view = h === "today" || h === "atlas" ? "sky" : "plate";
    const changed = SKY.routed !== h; SKY.routed = h;
    if (h === "ask" && S.loaded) fillAskSelect();
    if (h === "today" && S.loaded) placeCourse();
    window.scrollTo(0, 0);
    if (changed && S.loaded) requestAnimationFrame(() => focusSky(true));
  }
  window.addEventListener("hashchange", route);

  function renderAll() {
    if (!S.loaded) return;
    renderJourney(); renderToday(); renderCourse(); renderDrawer(); renderRecall(); renderSky(); renderAtlas(); renderDisc(); renderAgenda(); renderProgress(); renderList(); renderDrafts(); renderLib(); renderHeatmap(); renderDigests(); renderAskMemory();
  }

  // ---------- wiring ----------
  ["fTrack", "fPass", "fState"].forEach((id) => $(id).addEventListener("change", () => { S.limit = 60; renderList(); }));
  let tm; $("fText").addEventListener("input", () => { clearTimeout(tm); tm = setTimeout(() => { S.limit = 60; renderList(); }, 150); });
  $("more").onclick = () => { S.limit += 80; renderList(); };
  $("addForm").addEventListener("submit", submitAdd);
  $("aTrack").onchange = () => { $("aTrackName").hidden = $("aTrack").value !== "+new"; if (!$("aTrackName").hidden) $("aTrackName").focus(); };
  $("aAsk").onclick = () => goAsk(S.lastAdded);
  $("logForm").addEventListener("submit", submitLog);
  $("lLookup").onclick = lookup;
  ["lQuery", "lTitle"].forEach((id) => $(id).addEventListener("change", showMatch));
  $("lDate").value = todayISO(); setLogStars(0); document.querySelector('[data-tmpl="l"]').innerHTML = tmplHTML("l");
  $("agendaForm").addEventListener("submit", async (e) => { e.preventDefault(); const t = $("agendaText").value.trim(); if (!t) return; try { await api("agenda", { op: "add", text: t }); $("agendaText").value = ""; await loadAll(); } catch (err) { alertBar(err); } });
  $("agendaCopy").onclick = async () => { const md = agendaMd(S.agenda.filter((a) => !a.done)); try { await navigator.clipboard.writeText(md); $("agendaStatus").textContent = "Copied"; } catch (e) { $("agendaStatus").textContent = "Copy failed"; } };
  $("agendaDoneAll").onclick = () => agendaDone(S.agenda.filter((a) => !a.done).map((a) => a.id));
  $("draftForm").addEventListener("submit", (e) => { e.preventDefault(); submitDraft(true); });
  $("dQueue").onclick = () => submitDraft(false);
  $("zsyncAll").onclick = async () => { try { const r = await api("zotero-sync-all", {}); $("expStatus").textContent = r.queued + " papers queued for Zotero"; } catch (e) { alertBar(e); } };
  $("settingsForm").addEventListener("submit", saveSettings);
  $("askGo").onclick = () => askGo(false); $("askPreviewBtn").onclick = () => askGo(true);
  $("askPaper").addEventListener("change", () => { S.askKey = $("askPaper").value; $("askPreview").hidden = true; });
  $("tutorSave").onclick = tutorSave;
  $("styleSave").onclick = async () => { const lines = $("stylePrefs").value.split("\n").map((x) => x.trim()).filter(Boolean); try { await api("tutor", { op: "style", lines }); S.tutor.style = lines; $("styleStatus").textContent = "Saved"; } catch (e) { $("styleStatus").textContent = "Could not save: " + e.message; } };
  $("qsOpen").onclick = qsOpen; $("qsClose").onclick = qsClose;
  document.querySelectorAll("[data-qs]").forEach((b) => (b.onclick = () => qsAct(b.dataset.qs)));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { $("pop").hidden = true; if (S.drawer) closePaper(); }
    if ($("qs").hidden || e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
    const k = e.key.toLowerCase(); const map = { k: "known", w: "keep", n: "skipped", u: "undo", arrowleft: "known", arrowright: "keep", arrowdown: "skipped" };
    if (k === "escape") return qsClose(); if (map[k]) { e.preventDefault(); qsAct(map[k]); } });
  document.querySelectorAll("[data-exp]").forEach((b) => (b.onclick = () => doExport(b.dataset.exp)));
  $("copyIds").onclick = async () => {
    const ids = libRows().map(ident).filter(Boolean).join("\n"); const box = $("idsBox"); box.value = ids; box.hidden = false;
    try { await navigator.clipboard.writeText(ids); $("expStatus").textContent = ids.split("\n").filter(Boolean).length + " identifiers copied"; } catch (e) { box.select(); $("expStatus").textContent = "Select the text below and copy it"; }
  };
  $("lState").addEventListener("change", renderLib);
  let lt; $("lText").addEventListener("input", () => { clearTimeout(lt); lt = setTimeout(renderLib, 150); });

  // ---------- theme: follow the system, or pin light / dark ----------
  const IC = (d) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true">${d}</svg>`;
  const THEMES = [["", IC('<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16Z" fill="currentColor"/>'), "Theme: follows your system"],
    ["light", IC('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'), "Theme: light (printed chart)"],
    ["dark", IC('<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z"/>'), "Theme: dark (night sky)"]];
  function themeNow() { return document.documentElement.dataset.theme || ""; }
  function showTheme() { const t = THEMES.find((x) => x[0] === themeNow()) || THEMES[0]; $("themeBtn").innerHTML = t[1]; $("themeBtn").title = t[2] + ". Click to change."; $("themeBtn").setAttribute("aria-label", t[2]); }
  $("themeBtn").onclick = () => {
    const i = THEMES.findIndex((x) => x[0] === themeNow()); const next = THEMES[(i + 1) % THEMES.length][0];
    if (next) document.documentElement.dataset.theme = next; else delete document.documentElement.dataset.theme;
    try { if (next) localStorage.setItem("rp-theme", next); else localStorage.removeItem("rp-theme"); } catch (e) { /* private window */ }
    showTheme(); toast(THEMES.find((x) => x[0] === next)[2]);
  };
  showTheme();

  initSky();
  route();
  (async () => { await detectServer(); await loadAll(); fillAskSelect(); checkMilestones(); focusSky(false); })();
  setInterval(() => { if (document.visibilityState === "visible" && $("qs").hidden && document.activeElement.tagName !== "INPUT" && document.activeElement.tagName !== "TEXTAREA") loadAll(); }, 60000);
})();
