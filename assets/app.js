// Reading Path — standalone front end.
// Reads data/*.json. When served by server.py it can also write through /api/*.
// On static hosting (GitHub Pages, any web server) it runs read-only.
(function () {
  "use strict";
  const PASS = { 1: "Core", 2: "Recommended", 3: "Deep dive" };
  const DONE = new Set(["read", "known", "skipped"]);
  const FILES = ["papers", "status", "days", "discover", "reactions", "interests"];
  const S = { papers: [], tracks: {}, status: {}, days: [], disc: [], reactions: {}, interests: {}, writable: false, limit: 60, loaded: false, logRating: 0 };
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const tcolor = (t) => `var(--t-${t}, var(--accent))`;
  const todayISO = () => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };

  // ---------- data access ----------
  async function loadAll() {
    const got = await Promise.all(FILES.map((f) => fetch(`data/${f}.json`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null)));
    const [papers, status, days, disc, reactions, interests] = got;
    if (!papers) { $("today").innerHTML = '<p class="empty">Could not load data/papers.json. Open the site through <code>python3 server.py</code> or a web server, not as a file.</p>'; return; }
    S.papers = papers.papers || []; S.tracks = papers.tracks || {};
    S.status = status || {}; S.days = (days || []).slice().sort((a, b) => b.id.localeCompare(a.id));
    S.disc = (disc || []).slice().sort((a, b) => b.id.localeCompare(a.id));
    S.reactions = reactions || {}; S.interests = interests || {};
    S.loaded = true; fillTrackSelects(); renderAll();
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
    if (!S.writable) { m.hidden = false; m.className = "modebar warn"; m.textContent = "Read-only copy. To mark papers, add notes or log reads, run python3 server.py in your ReadingPath folder and open http://localhost:8765."; }
    else if (S.server && S.server.git === false) { m.hidden = false; m.className = "modebar"; m.textContent = "Running locally. Git isn't set up in this folder, so changes are saved but not versioned."; }
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
  // Same rule as the morning update: lowest seq whose prerequisites are done or already assigned.
  function upcoming(n, exclude) {
    const assigned = new Set(); S.days.forEach((d) => { assigned.add(d.paper); (d.replaced || []).forEach((k) => assigned.add(k)); });
    const ex = new Set(exclude || []); const now = Date.now(); const out = [];
    const ok = (k) => DONE.has(st(k)) || assigned.has(k) || ex.has(k) || out.some((o) => o.key === k);
    for (const p of papers()) {
      if (out.length >= n) break;
      const s = S.status[p.key] || {};
      if (DONE.has(s.state) || assigned.has(p.key) || ex.has(p.key)) continue;
      if (s.state === "later" && s.at && now - Date.parse(s.at) < 10 * 864e5) continue;
      if ((p.prereqs || []).every(ok)) out.push(p);
    }
    return out;
  }

  // ---------- Today ----------
  function btn(state, label, cur) { return `<button class="btn needs-write ${cur === state ? "done" : ""}" data-state="${state}" aria-pressed="${cur === state}">${label}</button>`; }
  function renderToday() {
    const box = $("today"); const m = byKey(); const day = S.days[0];
    if (!S.loaded) return;
    const isToday = day && day.id === todayISO();
    if (!day || !m[day.paper]) {
      const nx = upcoming(1)[0];
      box.innerHTML = `<p class="empty">No paper scheduled yet.${nx ? ` Next on your path: <strong>${esc(nx.title)}</strong>.` : ""}</p>${nx ? `<div class="actions needs-write"><button class="btn primary" id="startNext">Start it now</button></div>` : ""}`;
      if ($("startNext")) $("startNext").onclick = () => startDay(nx.key);
      return;
    }
    const p = m[day.paper]; const s = S.status[p.key] || {}; const state = s.state || "";
    const pre = (p.prereqs || []).concat(p.background || []).map((k) => m[k]).filter(Boolean);
    box.innerHTML = `
      <div class="meta"><span class="eyebrow">${isToday ? "Today" : "Latest pick"} · ${esc(day.id)}</span>
        <span class="chip" style="color:${tcolor(p.track)}">${esc(S.tracks[p.track] || p.track)}</span>
        <span class="pass">#${p.seq} · ${PASS[p.pass] || ""}</span></div>
      <h3>${esc(p.title)}</h3>
      <div class="meta"><span>${esc(p.authors)}</span><span>${esc(p.year)}</span>${p.byJes ? `<span class="jes">${p.track === "GRP" ? "Your group" : "Jes Frellsen"}</span>` : ""}${p.inZotero ? "<span>In your Zotero</span>" : ""}${p.source === "supervisor" ? "<span>On the group reading list</span>" : ""}</div>
      ${day.summary ? `<div class="dsec"><span class="eyebrow">Summary</span><p>${esc(day.summary)}</p></div>` : ""}
      ${(day.takeaways || []).length ? `<div class="dsec"><span class="eyebrow">Key takeaways</span><ul>${day.takeaways.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></div>` : ""}
      ${day.keyFigure ? `<div class="fig"><span class="eyebrow">Key figure</span><span>${esc(day.keyFigure)}</span>${day.figUrl ? `<a href="${esc(day.figUrl)}" target="_blank" rel="noopener">Open the figure</a>` : ""}</div>` : ""}
      ${day.relevance ? `<div class="foryou"><strong>For your work:</strong> ${esc(day.relevance)}</div>` : ""}
      ${day.brief ? `<div class="dsec"><span class="eyebrow">How to read it</span><p class="brief">${esc(day.brief)}</p></div>` : ""}
      ${!day.summary ? `<p class="pass">The summary and takeaways arrive with the next morning update.</p>` : ""}
      <p class="why">${esc(p.why)}</p>
      ${pre.length ? `<p class="builds">${p.track === "GRP" ? "Background" : "Builds on"}: ${pre.map((q) => esc(q.title) + (DONE.has(st(q.key)) ? " ✓" : "")).join(" · ")}</p>` : ""}
      <div class="links"><a class="btn primary" href="${esc(p.url)}" target="_blank" rel="noopener">Open paper</a>
        ${p.zotero ? `<a class="btn" href="zotero://select/library/items/${esc(p.zotero)}">Show in Zotero</a>` : ""}</div>
      <div class="actions needs-write">
        ${btn("read", "Read it", state)}${btn("known", "Already knew it", state)}${btn("later", "Later", state)}${btn("skipped", "Skip", state)}
        <span class="stars" aria-label="Rating">${[1, 2, 3, 4, 5].map((i) => `<button data-r="${i}" class="${(s.rating || 0) >= i ? "on" : ""}" aria-label="${i} of 5">★</button>`).join("")}</span>
        <span class="pass">Known, Later or Skip swaps in the next paper.</span>
      </div>
      <div class="note needs-write"><label class="eyebrow" for="noteBox">Your takeaway</label>
        <textarea id="noteBox" placeholder="One or two sentences: the key idea, and what you'd use it for.">${esc(s.note || "")}</textarea>
        <div class="actions"><button class="btn" id="saveNote">Save note</button><span class="status" id="noteStatus"></span></div></div>
      ${!S.writable && s.note ? `<p class="brief"><strong>Your note:</strong> ${esc(s.note)}</p>` : ""}
      <div class="upnext"><span class="eyebrow">Up next, if you have time today</span><div id="upnextList"></div></div>
      ${day.news ? `<p class="news"><strong>Also new this week:</strong> ${esc(day.news)}</p>` : ""}`;
    box.querySelectorAll("[data-state]").forEach((b) => (b.onclick = () => setState(p.key, b.dataset.state)));
    box.querySelectorAll("[data-r]").forEach((b) => (b.onclick = () => saveStatus(p.key, { rating: +b.dataset.r })));
    if ($("saveNote")) $("saveNote").onclick = async () => { $("noteStatus").textContent = "Saving…"; const ok = await saveStatus(p.key, { note: $("noteBox").value.trim() }); $("noteStatus").textContent = ok ? "Saved" : "Could not save."; };
    const ups = upcoming(3, [p.key]);
    $("upnextList").innerHTML = ups.length ? ups.map((q) => rowHTML(q)).join("") : '<p class="empty">Nothing else is unlocked yet.</p>';
    bindRows($("upnextList"));
  }

  // ---------- writes ----------
  async function saveStatus(key, patch) {
    const prev = S.status[key] || {}; const next = Object.assign({}, prev, patch, { at: new Date().toISOString() });
    S.status[key] = next; renderAll();
    try { await api("status", { key, patch: next }); return true; } catch (e) { S.status[key] = prev; renderAll(); alertBar(e); return false; }
  }
  async function setState(key, state) {
    const cur = st(key); const nextState = cur === state ? "" : state;
    const ok = await saveStatus(key, { state: nextState });
    if (ok && S.days[0] && S.days[0].paper === key && ["known", "skipped", "later"].includes(nextState)) await replaceToday(key);
  }
  async function replaceToday(oldKey) {
    const id = todayISO(); const cur = S.days[0]; const same = cur && cur.id === id;
    const next = upcoming(1, [oldKey])[0]; if (!next) return;
    const doc = { id, paper: next.key, brief: "", news: same ? cur.news || "" : "", replaced: [...(same ? cur.replaced || [] : []), oldKey] };
    try { await api("day", doc); await loadAll(); } catch (e) { alertBar(e); }
  }
  async function startDay(key) { try { await api("day", { id: todayISO(), paper: key, brief: "", news: "" }); await loadAll(); } catch (e) { alertBar(e); } }
  function alertBar(e) { const m = $("mode"); m.hidden = false; m.className = "modebar warn"; m.textContent = "Could not save: " + (e.message || e) + ". Is server.py still running?"; }

  // ---------- rows ----------
  function rowHTML(p, todayKey) {
    const s = st(p.key);
    return `<div class="row ${DONE.has(s) ? "isdone" : ""} ${p.key === todayKey ? "istoday" : ""}">
      <span class="n">${p.seq == null ? "—" : p.seq % 1 ? p.seq.toFixed(1) : p.seq}</span>
      <div class="t"><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.title)}</a>
        <div class="sub"><span class="chip" style="color:${tcolor(p.track)}">${esc(p.track || "?")}</span>${p.byJes ? `<span class="jes">${p.track === "GRP" ? "Group" : "Jes"}</span>` : ""}<span>${esc(p.authors)} ${esc(p.year)}</span><span class="pass">${PASS[p.pass] || (p.source === "independent" ? "Independent read" : "")}</span>${p.inZotero ? "<span>Zotero</span>" : ""}</div></div>
      <div class="seg needs-write" role="group" aria-label="Status">${[["read", "Read"], ["known", "Known"], ["later", "Later"]].map(([k, l]) => `<button data-k="${esc(p.key)}" data-s="${k}" class="${s === k ? "on" : ""}" aria-pressed="${s === k}">${l}</button>`).join("")}</div></div>`;
  }
  function bindRows(el) { el.querySelectorAll("[data-k]").forEach((b) => (b.onclick = () => setState(b.dataset.k, b.dataset.s))); }

  // ---------- Discover ----------
  function discCard(d) {
    const r = (S.reactions[d.id] || {}).reaction || "";
    return `<article class="card ${r === "meh" ? "dim" : ""}">
      <div style="display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center;color:var(--muted);font-size:.85rem"><span class="eyebrow">${esc(d.date || "")}</span>${d.track ? `<span class="chip" style="color:${tcolor(d.track)}">${esc(S.tracks[d.track] || d.track)}</span>` : ""}<span>${esc(d.venue || "")}</span></div>
      <h3><a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.title)}</a></h3>
      <div style="color:var(--muted);font-size:.88rem">${esc(d.authors || "")} ${esc(d.year || "")}</div>
      ${d.summary ? `<p>${esc(d.summary)}</p>` : ""}
      ${(d.takeaways || []).length ? `<ul>${d.takeaways.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}
      ${d.keyFigure ? `<div class="fig"><span class="eyebrow">Key figure</span><span>${esc(d.keyFigure)}</span>${d.figUrl ? `<a href="${esc(d.figUrl)}" target="_blank" rel="noopener">Open the figure</a>` : ""}</div>` : d.figUrl ? `<div class="fig"><a href="${esc(d.figUrl)}" target="_blank" rel="noopener">Browse the figures</a></div>` : ""}
      ${d.relevance ? `<div class="foryou"><strong>For your work:</strong> ${esc(d.relevance)}</div>` : ""}
      ${(d.tags || []).length ? `<div class="tagrow">${d.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>` : ""}
      <div class="actions needs-write">
        <button class="btn ${r === "added" ? "done" : "primary"}" data-dadd="${esc(d.id)}" ${r === "added" ? "disabled" : ""}>${r === "added" ? "On your reading list" : "Add to reading list"}</button>
        <button class="btn ${r === "like" ? "done" : ""}" data-dr="like" data-did="${esc(d.id)}" aria-pressed="${r === "like"}">Interesting</button>
        <button class="btn meh ${r === "meh" ? "on" : ""}" data-dr="meh" data-did="${esc(d.id)}" aria-pressed="${r === "meh"}">Not for me</button>
        <button class="btn" data-dread="${esc(d.id)}">I read it</button>
      </div></article>`;
  }
  function renderDisc() {
    if (S.interests && S.interests.summary) $("interests").textContent = "What your reactions and reads say so far: " + S.interests.summary;
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
    const open = papers().filter((p) => !DONE.has(st(p.key)) && p.key !== S.days[0]?.paper);
    const key = "d-" + id;
    const doc = { key, seq: open.length ? open[0].seq + 0.5 : papers().length + 1, track: d.track || "PML", pass: 1, title: d.title, authors: d.authors || "", year: d.year || "", url: d.url, zotero: "", inZotero: false, byJes: false, prereqs: [], why: d.summary || "Added from Discover.", source: "discover", triaged: false };
    try { await api("paper", doc); await api("reaction", { id, reaction: "added", addedKey: key }); await loadAll(); } catch (e) { alertBar(e); }
  }
  async function readFromDisc(id) {
    const d = S.disc.find((x) => x.id === id); if (!d) return;
    $("lQuery").value = d.url; $("lTitle").value = d.title; $("lAuthors").value = d.authors || ""; $("lYear").value = d.year || ""; if (d.track) $("lTrack").value = d.track;
    $("lMatch").textContent = "Filled in from Discover. Add a takeaway if you like, then log it."; location.hash = "#log"; $("lNote").focus();
  }

  // ---------- Log a read ----------
  function setLogStars(n) { S.logRating = n; $("lStars").innerHTML = [1, 2, 3, 4, 5].map((i) => `<button type="button" data-lr="${i}" class="${n >= i ? "on" : ""}" aria-label="${i} of 5">★</button>`).join(""); $("lStars").querySelectorAll("[data-lr]").forEach((b) => (b.onclick = () => setLogStars(S.logRating === +b.dataset.lr ? 0 : +b.dataset.lr))); }
  function normTitle(t) { return String(t || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
  function idFromQuery(q) {
    let m; q = q.trim();
    if ((m = q.match(/(\d{4}\.\d{4,5})(v\d+)?/))) return "arXiv:" + m[1];
    if ((m = q.match(/(10\.\d{4,9}\/[^\s?#]+)/))) return m[1].replace(/[.,;]$/, "");
    return "";
  }
  function findOnPlan(q, title) {
    const id = idFromQuery(q).toLowerCase(); const t = normTitle(title || q);
    return S.papers.find((p) => (id && ident(p).toLowerCase() === id) || (t.length > 12 && normTitle(p.title) === t));
  }
  function showMatch() {
    const p = findOnPlan($("lQuery").value, $("lTitle").value);
    $("lMatch").textContent = p ? `On your path (#${p.seq ?? "—"}, ${p.track}): “${p.title}”. Logging it marks it read and the plan moves past it.` : ($("lTitle").value ? "Not on your path. It will be logged as an independent read." : "");
    return p;
  }
  async function lookup() {
    const q = $("lQuery").value.trim(); if (!q) return;
    $("lMatch").textContent = "Looking up…";
    try {
      const r = await fetch("api/lookup?q=" + encodeURIComponent(q)); const j = await r.json();
      if (j && j.title) { $("lTitle").value = j.title; $("lAuthors").value = j.authors || ""; $("lYear").value = j.year || ""; if (j.url) $("lQuery").value = j.url; }
      else $("lMatch").textContent = "Couldn't find it. Fill in the title yourself.";
    } catch (e) { $("lMatch").textContent = "Lookup needs the local server. Fill in the title yourself."; }
    showMatch();
  }
  async function submitLog(e) {
    e.preventDefault(); $("lStatus").textContent = "Saving…";
    const body = { query: $("lQuery").value.trim(), title: $("lTitle").value.trim(), authors: $("lAuthors").value.trim(), year: $("lYear").value.trim(), date: $("lDate").value || todayISO(), track: $("lTrack").value, note: $("lNote").value.trim(), rating: S.logRating || undefined };
    if (!body.title && !findOnPlan(body.query, "")) { $("lStatus").textContent = "Add a title (or press Look up)."; return; }
    try {
      const j = await api("log", body); await loadAll();
      $("lStatus").textContent = j.matched ? "Marked as read on your path." : "Logged as an independent read.";
      e.target.reset(); setLogStars(0); $("lDate").value = todayISO(); $("lMatch").textContent = "";
    } catch (err) { $("lStatus").textContent = "Could not save: " + err.message; }
  }

  // ---------- progress, history, path ----------
  function renderProgress() {
    const all = papers(); const done = all.filter((p) => DONE.has(st(p.key)));
    const core = all.filter((p) => p.pass === 1), coreDone = core.filter((p) => DONE.has(st(p.key)));
    const ind = S.papers.filter((p) => p.source === "independent").length;
    $("summary").innerHTML = `<span><b>${done.length}</b> of ${all.length} done</span><span><b>${coreDone.length}</b> of ${core.length} core</span><span><b>${all.filter((p) => st(p.key) === "read").length}</b> read on the path</span><span><b>${ind}</b> independent reads</span>`;
    $("progress").innerHTML = Object.keys(S.tracks).map((t) => {
      const ps = all.filter((p) => p.track === t), d = ps.filter((p) => DONE.has(st(p.key))).length, pct = ps.length ? Math.round((100 * d) / ps.length) : 0;
      return `<div class="prow"><div class="top"><span>${esc(S.tracks[t])}</span><span class="num">${d}/${ps.length}</span></div><div class="bar"><span style="width:${pct}%;background:${tcolor(t)}"></span></div></div>`;
    }).join("");
  }
  function renderHist() {
    const m = byKey(); if (!S.days.length) return;
    $("hist").innerHTML = S.days.slice(0, 10).map((d) => { const p = m[d.paper]; if (!p) return ""; const s = st(p.key);
      return `<div><span class="d">${esc(d.id)}</span><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.title)}</a><span class="pass">${s ? esc(s) : "open"}</span></div>`; }).join("");
  }
  function renderList() {
    if (!S.loaded) return;
    const t = $("fTrack").value, ps = $("fPass").value, fs = $("fState").value, q = $("fText").value.trim().toLowerCase();
    const todayKey = S.days[0]?.paper;
    let rows = papers().filter((p) => (!t || p.track === t) && (!ps || String(p.pass) === ps) &&
      (!fs || (fs === "jes" && p.byJes) || (fs === "open" && !DONE.has(st(p.key)) && st(p.key) !== "later") || (fs === "done" && DONE.has(st(p.key))) || (fs === "later" && st(p.key) === "later")) &&
      (!q || (p.title + " " + p.authors).toLowerCase().includes(q)));
    const total = rows.length; rows = rows.slice(0, S.limit);
    $("list").innerHTML = rows.length ? rows.map((p) => rowHTML(p, todayKey)).join("") : '<p class="empty" style="padding:10px 0">No papers match these filters.</p>';
    bindRows($("list")); $("more").hidden = total <= S.limit;
  }

  // ---------- Library & exports ----------
  function libRows() {
    const mode = $("lState").value, q = $("lText").value.trim().toLowerCase();
    return allPapers().filter((p) => { const s = S.status[p.key] || {};
      const ok = mode === "all" || (mode === "read" && s.state === "read") || (mode === "independent" && p.source === "independent") || (mode === "noted" && s.note) || (mode === "engaged" && ((DONE.has(s.state) && s.state !== "skipped") || s.note || s.rating));
      return ok && (!q || (p.title + " " + p.authors + " " + (s.note || "")).toLowerCase().includes(q)); })
      .sort((a, b) => ((S.status[b.key] || {}).at || "").localeCompare((S.status[a.key] || {}).at || ""));
  }
  function renderLib() {
    if (!S.loaded) return; const rows = libRows();
    $("libBody").innerHTML = rows.length ? rows.map((p) => { const s = S.status[p.key] || {};
      return `<tr><td><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.title)}</a><div style="color:var(--muted);font-size:.8rem">${esc(p.authors)} ${esc(p.year)}${ident(p) ? " · " + esc(ident(p)) : ""}${p.source === "independent" ? " · independent read" : ""}</div></td>
        <td><span class="chip" style="color:${tcolor(p.track)}">${esc(p.track || "?")}</span></td><td>${esc(s.state || "open")}</td><td class="pass">${esc((s.readOn || s.at || "").slice(0, 10))}</td><td>${s.rating || ""}</td><td class="note">${esc(s.note || "")}</td></tr>`; }).join("")
      : '<tr><td colspan="6" class="empty">Nothing here yet. Papers you mark as read or known, rate, annotate or log show up here.</td></tr>';
  }
  function bibKey(p) { const a = (p.authors || "anon").split(/[ ,&]/)[0].normalize("NFD").replace(/[^A-Za-z]/g, "").toLowerCase() || "anon"; const w = (p.title || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").split(" ").find((x) => x.length > 3) || "paper"; return a + (p.year || "") + w; }
  function exportData(kind) {
    const rows = libRows(); const s_ = (k) => S.status[k] || {};
    if (kind === "json") return { name: "reading-path.json", text: JSON.stringify({ exported: new Date().toISOString(), tracks: S.tracks, papers: allPapers().map((p) => Object.assign({}, p, { id: ident(p), status: s_(p.key) })), days: S.days, discover: S.disc, reactions: S.reactions, interests: S.interests }, null, 1) };
    if (kind === "csv") { const c = (v) => '"' + String(v ?? "").replace(/"/g, '""') + '"';
      return { name: "reading-path.csv", text: ["key,title,authors,year,track,state,date,rating,note,identifier,url"].concat(rows.map((p) => { const s = s_(p.key); return [p.key, p.title, p.authors, p.year, p.track, s.state || "", (s.readOn || s.at || "").slice(0, 10), s.rating || "", s.note || "", ident(p), p.url].map(c).join(","); })).join("\n") }; }
    if (kind === "bib") return { name: "reading-path.bib", text: rows.map((p) => { const s = s_(p.key), id = ident(p);
      return `@misc{${bibKey(p)},\n  title = {{${p.title}}},\n  author = {${p.authors}},\n  year = {${p.year}},\n  url = {${p.url}},` + (id.startsWith("arXiv:") ? `\n  eprint = {${id.slice(6)}},\n  archivePrefix = {arXiv},` : id ? `\n  doi = {${id}},` : "") + (s.note ? `\n  annote = {${s.note.replace(/[{}]/g, "")}},` : "") + `\n  keywords = {reading-path, ${p.track}${s.state ? ", " + s.state : ""}}\n}`; }).join("\n\n") };
    if (kind === "md") return { name: "reading-notes.md", text: "# Reading notes\n\n" + rows.map((p) => { const s = s_(p.key); return `## ${p.title}\n${p.authors} (${p.year}) · ${p.track} · ${s.state || "open"}${s.rating ? " · " + s.rating + "/5" : ""}${s.at ? " · " + (s.readOn || s.at).slice(0, 10) : ""}\n${p.url}\n\n${s.note || "_No note._"}\n`; }).join("\n") };
  }
  function doExport(kind) {
    const { name, text } = exportData(kind); const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" })); a.download = name; document.body.appendChild(a); a.click(); a.remove();
    $("expStatus").textContent = "Saved " + name;
  }

  // ---------- add to path form ----------
  async function submitAdd(e) {
    e.preventDefault(); const all = papers(); const title = $("aTitle").value.trim(); if (!title) return;
    const track = $("aTrack").value; let seq;
    if ($("aWhen").value === "next") { const open = all.filter((p) => !DONE.has(st(p.key)) && p.key !== S.days[0]?.paper); seq = open.length ? open[0].seq - 0.5 : all.length + 1; }
    else { const same = all.filter((p) => p.pass === 2); seq = same.length ? Math.max(...same.map((p) => p.seq)) + 0.5 : all.length + 1; }
    const au = $("aAuthors").value.trim(); const ym = au.match(/(19|20)\d\d/);
    const doc = { key: "u" + Date.now().toString(36), seq, track, pass: $("aWhen").value === "next" ? 1 : 2, title, authors: au.replace(/,?\s*(19|20)\d\d\s*$/, ""), year: ym ? +ym[0] : "", url: $("aUrl").value.trim() || "https://scholar.google.com/scholar?q=" + encodeURIComponent(title), zotero: "", inZotero: false, byJes: false, prereqs: [], why: $("aWhy").value.trim() || "Added by you.", source: "you", triaged: false };
    $("aStatus").textContent = "Adding…";
    try { await api("paper", doc); await loadAll(); $("aStatus").textContent = "Added to the path"; e.target.reset(); } catch (err) { $("aStatus").textContent = "Could not add it: " + err.message; }
  }

  function fillTrackSelects() {
    const opts = Object.entries(S.tracks).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("");
    const keepF = $("fTrack").value, keepA = $("aTrack").value, keepL = $("lTrack").value;
    $("fTrack").innerHTML = '<option value="">All fields</option>' + opts; $("aTrack").innerHTML = opts;
    $("lTrack").innerHTML = '<option value="">Field: let Claude decide</option>' + opts;
    $("fTrack").value = keepF; if (keepA) $("aTrack").value = keepA; $("lTrack").value = keepL;
  }
  function renderAll() { if (!S.loaded) return; renderToday(); renderDisc(); renderProgress(); renderHist(); renderList(); renderLib(); }

  // ---------- wiring ----------
  ["fTrack", "fPass", "fState"].forEach((id) => $(id).addEventListener("change", () => { S.limit = 60; renderList(); }));
  let tm; $("fText").addEventListener("input", () => { clearTimeout(tm); tm = setTimeout(() => { S.limit = 60; renderList(); }, 150); });
  $("more").onclick = () => { S.limit += 80; renderList(); };
  $("addForm").addEventListener("submit", submitAdd);
  $("logForm").addEventListener("submit", submitLog);
  $("lLookup").onclick = lookup;
  ["lQuery", "lTitle"].forEach((id) => $(id).addEventListener("change", showMatch));
  $("lDate").value = todayISO(); setLogStars(0);
  document.querySelectorAll("[data-exp]").forEach((b) => (b.onclick = () => doExport(b.dataset.exp)));
  $("copyIds").onclick = async () => {
    const ids = libRows().map(ident).filter(Boolean).join("\n"); const box = $("idsBox"); box.value = ids; box.hidden = false;
    try { await navigator.clipboard.writeText(ids); $("expStatus").textContent = ids.split("\n").filter(Boolean).length + " identifiers copied"; } catch (e) { box.select(); $("expStatus").textContent = "Select the text below and copy it"; }
  };
  $("lState").addEventListener("change", renderLib);
  let lt; $("lText").addEventListener("input", () => { clearTimeout(lt); lt = setTimeout(renderLib, 150); });

  (async () => { await detectServer(); await loadAll(); })();
  // Pick up changes written by the morning update or the terminal.
  setInterval(() => { if (document.visibilityState === "visible") loadAll(); }, 60000);
})();
