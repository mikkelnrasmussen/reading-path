# Reading Path ("Reading Sky")

Mikkel's daily paper-reading system: one paper a day on an ordered path through his PhD fields, plus
Discover picks, course-prep chapters, notes and a Q&A hand-off to Claude. Mikkel is a PhD student at
DTU Compute (supervisors Jes Frellsen and Kristoffer; also the Isoform Analysis Group) working on
generative models for single-cell isoform expression.

Everything is local and dependency-free: a static site (vanilla JS, no build step), a Python 3 stdlib
server, and JSON files in `data/`. The folder is a git repo; the server auto-commits data changes.

## Run it

    python3 server.py            # http://localhost:8765  (--port N, --no-git)
    ./rp today | next | ls | show KEY | read KEY | skim KEY | busy until YYYY-MM-DD | ...   # terminal client (./rp -h)

- Site-only changes (index.html, assets/*): reload the page (Cmd+Shift+R).
- Changes to server.py / rpcore.py / zotero_sync.py: restart the server
  (`lsof -ti tcp:8765 | xargs kill; python3 server.py`). Starting a second copy prints "already running".
- Without the server (e.g. GitHub Pages) the site is read-only.

## Files

    index.html            all tabs: Tonight, Sky chart, Ask, Discover, Logbook, More (+ paper drawer, quick sort)
    assets/app.js         the whole front end (one IIFE; state in S; renderAll() redraws everything)
    assets/style.css      "Reading Sky" design: light = printed star atlas, dark = night sky; tokens on :root,
                          dark via prefers-color-scheme and :root[data-theme]; track colours --t-<TRACK>
    assets/themes/        old preview themes, unused
    server.py             static files + JSON write API (/api/*), related-work drafts, git sync loop
    rpcore.py             shared core for server.py and rp: load/save (atomic), set_status, recall, agenda,
                          settings_update (whitelisted keys!), tutor_update, log_read, git commit/sync, lookup
    rp                    terminal client (same rules as the site)
    zotero_sync.py        optional Zotero web-API push + local sqlite annotation reader (config.json)
    books/                PDFs for book/course sessions (gitignored: copyrighted)
    drafts/               generated related-work drafts (.md + .bib)
    config.json           API keys (Zotero, Anthropic) — gitignored, never commit; see config.example.json

## Data model (data/*.json)

- `papers.json` `{tracks: {CODE: name}, papers: [...]}`. A paper: `key, seq, track, pass (1 core, 2
  recommended, 3 deep dive), title, authors, year, url, prereqs[], background[] (non-blocking), why,
  source, triaged, byJes, zotero, inZotero, addedAt?`.
  - `seq` = position on the path (fractions allowed; null = off-plan, e.g. independent reads).
  - Book/course sessions also have `book, file (books/…pdf), pages ("55–65")`; their `url` is
    `books/<file>.pdf#page=N`, served by the local server.
  - `due: YYYY-MM-DD` = course-prep chapter (track DLC) read alongside the daily paper, never the daily pick.
  - `pickOn: YYYY-MM-DD` = a planned daily paper for that date.
  - Tracks: GRP (Jes's group, newest first), PML, DLC, ISO, COMP, DIF, FLOW, OT, GEO, DISC, CTRL, TRF,
    GRL, PROT, SC. Sky-chart order is `ORDER` in app.js.
  - Sources: catalog sources, `you` (add form, keys `u…`), `discover` (keys `d-<id>`), `zotero` (morning
    intake, keys `z-…`), `independent`, `gap`, `followup`, `new`, `jes-new`.
- `status.json` `{key: {state, at, readOn?, rating?, note?, notes? {problem, method, limitation, use, text},
  discuss?, ...}}` — Mikkel's own data. States: `read | skimmed | known | later | skipped`. Empty values in
  a patch delete fields (`rpcore.set_status`).
- `days.json` newest first: `{id: date, paper, summary, takeaways[3], keyFigure, figUrl, relevance, brief,
  news, replaced[], finished[], extras[], carried?}`. `extras` = course-prep briefs
  `{paper, summary, takeaways, pitfalls, links}`. The server's `/api/day` whitelists these fields.
- `settings.json` `{weeklyGoal, recall, structuredNotes, milestonesSeen, busyUntil?, pauses[{from,to}]}`.
- Also: `discover.json` + `reactions.json` (like / meh / added), `interests.json`, `tutor.json` (answer-style
  prefs, struggles, past Q&A from Claude chats), `recall.json` (only used if settings.recall), `agenda.json`
  (supervisor meeting list), `requests.json` / `drafts.json`, `digests.json`, `zsync.json`.

## Planning rules (keep app.js `upcoming()`, rp `upcoming()` and the morning task in sync)

- DONE = read, skimmed, known, skipped. A prerequisite counts as covered only when DONE —
  being assigned on an earlier day does NOT count, so nothing that builds on an unread paper unlocks.
- Next paper = papers with a `pickOn <= today` first, then lowest `seq` whose prereqs are covered.
  Excluded: DONE, `later` < 10 days old, anything with `due`, and tonight's (latest day's) paper.
  Unread picks from earlier days are simply back in the queue.
- The plan waits: if the latest day's paper is unread, the morning task carries it over
  (`carried: true`) instead of picking a new one. Tonight shows "Day N with this paper".
- Skimmed = enough to move on (unlocks dependants, counts for the streak), flagged for a proper read
  (Logbook filter "Skimmed"). Briefs of later papers point to what to revisit.
- Pauses ("Busy? Pause…" / `rp busy`): `busyUntil` + `pauses`. No new picks; paused weekdays (and
  weekends) never break the streak. Course chapters keep their dates.
- Course days: when DLC chapters are due/overdue, the course panel moves above the daily paper,
  which is labelled optional.
- Undoing "done" on a paper finished earlier today makes it tonight's paper again; "Read it tonight"
  in the paper drawer/star pop-up swaps tonight's paper.
- Discover "Add to my path" places the paper right after the next two in line and shows its
  position ("#3 in line"); recently added papers are listed on the Sky chart and ringed on the map.

## Scheduled tasks also edit data/ (keep them in mind)

Two Claude scheduled tasks (claude.ai, run in the cloud, reaching this folder via the Claude desktop app):
- "Morning reading update" (weekdays 7:45/10:45/13:45 Europe/Stockholm): Zotero intake, triage of new
  papers, interest profile, the daily pick (rules above), day summaries, course-prep `extras`, 3 Discover
  picks, queued related-work drafts.
- "Weekly reading digest" (Fridays): writes `digests.json`.
They only write `data/` and `drafts/`, never run git, and re-read files before writing.
If you change the data model or planning rules, the task prompts must be updated too (from a
claude.ai / Cowork chat) — say so to Mikkel.

## Conventions

- No build step, no npm dependencies in the site; Python stdlib only.
- Never overwrite Mikkel's own fields in status.json / settings.json / tutor.json from code paths that
  aren't his explicit action. Write JSON with `ensure_ascii=False, indent=1`.
- Settings keys must be added to the whitelist in `rpcore.settings_update`.
- Attribute names in app.js are global-ish (several renderers use `document.querySelectorAll`): use
  unique `data-*` names (a past bug: the drawer's rating stars reused Discover's `data-dr`).
- Test UI changes in a browser at desktop and phone width, light and dark.
- Writing style for anything Mikkel reads: plain, short, no jargon without explanation.
