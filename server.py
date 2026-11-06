#!/usr/bin/env python3
"""Reading Path local server. Serves the site and lets it write to ./data. Python 3.8+, no dependencies.

    python3 server.py              # http://localhost:8765
    python3 server.py --port 9000
    python3 server.py --no-git     # don't commit or sync

Git: on first start the folder becomes a git repository and every change is committed. If the repository
has a remote (e.g. GitHub), it is pulled on start and every 10 minutes, and changes are pushed.
Optional integrations live in config.json (see config.example.json): Zotero two-way sync and instant
related-work drafts through the Anthropic API.
"""
import argparse, base64, json, os, re, sys, threading, time, urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import rpcore as core
import zotero_sync

load, save, now = core.load, core.save, core.now


# ---------- related-work drafts ----------

def draft_context(topic, keys=None):
    papers = {p["key"]: p for p in load("papers")["papers"]}; st = load("status")
    pool = [k for k, s in st.items() if s.get("state") in ("read", "known") and k in papers]
    if keys:
        pool = [k for k in keys if k in papers]
    lines = []
    for k in pool:
        p = papers[k]; s = st.get(k, {})
        lines.append("[@%s] %s (%s, %s). Field: %s. Why on path: %s%s" % (
            core.bibkey(p), p["title"], p.get("authors", ""), p.get("year", ""), p.get("track", ""), p.get("why", ""),
            ("\n  My notes: " + core.compose_note(s).replace("\n", " | ")) if core.compose_note(s) else ""))
    return lines, papers


def draft_now(req):
    a = core.config().get("anthropic") or {}
    if not a.get("apiKey"):
        return None
    lines, papers = draft_context(req["topic"], req.get("keys"))
    prompt = ("Write a related-work section (2-4 paragraphs, academic, precise, no hype) on: %s\n\n"
              "Context: the author is a PhD student building generative models for single-cell isoform expression "
              "(CTMC / generator matching on the lattice simplex, hierarchical NB + multinomial models).\n\n"
              "Use ONLY the papers below, which the author has read. Cite with pandoc keys exactly as given, e.g. [@key] "
              "or [@key1; @key2]. Use the author's notes where they help. Group papers by idea, say how they relate, and end "
              "with the gap the author's work addresses if the notes make it clear; otherwise end with an open question. "
              "Skip papers that are not relevant. Do not invent results.\n%s\n\nPapers:\n%s"
              % (req["topic"], ("Extra instructions: " + req["instructions"]) if req.get("instructions") else "", "\n".join(lines)))
    body = {"model": a.get("model", "claude-opus-5-5"), "max_tokens": 2500, "messages": [{"role": "user", "content": prompt}]}
    _, _, txt = core.http("https://api.anthropic.com/v1/messages", json.dumps(body).encode(),
                          {"x-api-key": a["apiKey"], "anthropic-version": "2023-06-01", "content-type": "application/json"}, timeout=180)
    md = "".join(b.get("text", "") for b in json.loads(txt)["content"])
    return finish_draft(req, md, papers)


def finish_draft(req, md, papers=None):
    papers = papers or {p["key"]: p for p in load("papers")["papers"]}; st = load("status")
    bykey = {core.bibkey(p): p for p in papers.values()}
    cited = list(dict.fromkeys(re.findall(r"@([A-Za-z0-9_\-:]+)", md)))
    bib = "\n\n".join(core.bibentry(bykey[c], st.get(bykey[c]["key"])) for c in cited if c in bykey)
    slug = re.sub(r"[^a-z0-9]+", "-", req["topic"].lower()).strip("-")[:50] or "draft"
    os.makedirs(os.path.join(core.ROOT, "drafts"), exist_ok=True)
    with open(os.path.join(core.ROOT, "drafts", slug + ".md"), "w", encoding="utf-8") as f:
        f.write("# Related work: %s\n\n%s\n" % (req["topic"], md))
    with open(os.path.join(core.ROOT, "drafts", slug + ".bib"), "w", encoding="utf-8") as f:
        f.write(bib + "\n")
    with core.LOCK:
        d = load("drafts")
        d = [x for x in d if x["id"] != req["id"]]
        d.insert(0, {"id": req["id"], "topic": req["topic"], "created": now(), "md": md, "bib": bib, "file": "drafts/%s.md" % slug, "cited": len(cited)})
        save("drafts", d)
        r = load("requests")
        for x in r:
            if x["id"] == req["id"]:
                x["status"] = "done"
        save("requests", r)
        core.commit("draft: %s" % req["topic"][:50])
    return d[0]


# ---------- HTTP ----------

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=core.ROOT, **kw)

    def log_message(self, fmt, *args):
        if args and "/api/" in str(args[0]):
            sys.stderr.write("%s\n" % (fmt % args))

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_json(self, obj, code=200):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path); q = urllib.parse.parse_qs(u.query)
        if u.path == "/api/ping":
            with core.LOCK:
                core.commit("update from morning task or terminal")  # no-op when nothing changed
            cfg = core.config()
            return self.send_json({"ok": True, "git": core.GIT["on"], "remote": core.GIT["remote"], "syncError": core.GIT["error"],
                                   "lastSync": core.GIT["last_sync"], "zotero": bool(zotero_sync.cfg()),
                                   "instantDrafts": bool((cfg.get("anthropic") or {}).get("apiKey"))})
        if u.path == "/api/lookup":
            return self.send_json(core.lookup(q.get("q", [""])[0]) or {})
        if u.path == "/api/annotations":
            return self.send_json(zotero_sync.annotations(q.get("key", [""])[0]))
        return super().do_GET()

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        except json.JSONDecodeError:
            return self.send_json({"error": "bad JSON"}, 400)
        try:
            out = self.route(path, body)
        except KeyError as e:
            return self.send_json({"error": "missing field %s" % e}, 400)
        except Exception as e:
            return self.send_json({"error": str(e)}, 500)
        if out is None:
            return self.send_json({"error": "not found"}, 404)
        self.send_json(out)

    def route(self, path, b):
        if path == "/api/status":
            return {"ok": True, "status": core.set_status(b["key"], b["patch"], b.get("msg"))}
        if path == "/api/day":
            with core.LOCK:
                days = [d for d in load("days") if d["id"] != b["id"]]
                days.insert(0, {k: v for k, v in b.items() if k in ("id", "paper", "brief", "news", "replaced", "finished", "extras", "summary", "takeaways", "keyFigure", "figUrl", "relevance")})
                days.sort(key=lambda d: d["id"], reverse=True)
                save("days", days); core.commit("day %s: %s" % (b["id"], b["paper"]))
            return {"ok": True}
        if path == "/api/paper":
            with core.LOCK:
                p = load("papers")
                if any(x["key"] == b["key"] for x in p["papers"]):
                    return {"error": "key exists"}
                nt = b.pop("newTrack", None)
                if nt:
                    code, name = nt["code"].strip().upper(), nt["name"].strip()
                    if not re.fullmatch(r"[A-Z][A-Z0-9]{1,5}", code) or not name:
                        raise ValueError("bad field code or name")
                    p["tracks"].setdefault(code, name); b["track"] = code
                pdf = b.pop("pdf", None)
                if pdf:
                    if not re.fullmatch(r"[A-Za-z0-9_-]+", b["key"]):
                        raise ValueError("bad key")
                    raw = base64.b64decode(pdf)
                    if not raw.startswith(b"%PDF"):
                        raise ValueError("that file is not a PDF")
                    os.makedirs(os.path.join(core.ROOT, "uploads"), exist_ok=True)
                    b["file"] = "uploads/%s.pdf" % b["key"]
                    with open(os.path.join(core.ROOT, b["file"]), "wb") as f:
                        f.write(raw)
                    if not b.get("url") or "scholar.google" in b["url"]:
                        b["url"] = b["file"]
                b.setdefault("addedAt", now()); p["papers"].append(b)
                save("papers", p); core.commit("add paper: %s" % b.get("title", b["key"])[:60])
            return {"ok": True, "key": b["key"]}
        if path == "/api/reaction":
            with core.LOCK:
                r = load("reactions")
                if b.get("reaction"):
                    r[b["id"]] = {"reaction": b["reaction"], "at": now(), **({"addedKey": b["addedKey"]} if b.get("addedKey") else {})}
                else:
                    r.pop(b["id"], None)
                save("reactions", r); core.commit("discover %s: %s" % (b["id"], b.get("reaction") or "cleared"))
            return {"ok": True}
        if path == "/api/log":
            return core.log_read(b)
        if path == "/api/recall":
            return {"ok": True, "entry": core.recall_result(b["key"], b["result"])}
        if path == "/api/agenda":
            if b.get("op") == "add":
                return {"ok": True, "item": core.agenda_add(b["text"], b.get("key"))}
            core.agenda_update(b["id"], text=b.get("text"), done=b.get("done"))
            return {"ok": True}
        if path == "/api/draft":
            req = {"id": "r" + time.strftime("%y%m%d%H%M%S"), "topic": b["topic"].strip(), "instructions": b.get("instructions", ""),
                   "keys": b.get("keys") or [], "created": now(), "status": "queued"}
            if b.get("now"):
                d = draft_now(req)
                if d:
                    return {"ok": True, "draft": d}
            with core.LOCK:
                r = load("requests"); r.append(req); save("requests", r); core.commit("draft request: %s" % req["topic"][:50])
            return {"ok": True, "queued": True}
        if path == "/api/settings":
            return {"ok": True, "settings": core.settings_update(b)}
        if path == "/api/tutor":
            return {"ok": True, "tutor": core.tutor_update(b)}
        if path == "/api/zotero-sync-all":
            st = load("status"); n = 0
            for k, s in st.items():
                if s.get("state") in ("read", "known") or s.get("note"):
                    zotero_sync.hook(k, s); n += 1
            return {"ok": True, "queued": n}
        return None


def git_loop():
    while True:
        err = core.sync_remote()
        if err:
            print("git sync:", err)
        time.sleep(600)


def main():
    ap = argparse.ArgumentParser(description="Reading Path local server")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--no-git", action="store_true")
    a = ap.parse_args()
    os.makedirs(core.DATA, exist_ok=True)
    core.setup_git(not a.no_git)
    zotero_sync.start()
    if core.GIT["remote"]:
        threading.Thread(target=git_loop, daemon=True).start()
    try:
        srv = ThreadingHTTPServer((a.host, a.port), Handler)
    except OSError as e:
        if e.errno not in (48, 98):  # address already in use (macOS, Linux)
            raise
        try:
            import urllib.request
            urllib.request.urlopen("http://localhost:%d/api/ping" % a.port, timeout=3).read()
            print("Reading Path is already running on http://localhost:%d (just reload the page)." % a.port)
            print("To restart it:  lsof -ti tcp:%d | xargs kill   and run this again." % a.port)
        except Exception:
            print("Port %d is used by another program. Try:  python3 server.py --port %d" % (a.port, a.port + 1))
        sys.exit(0)
    print("Reading Path on http://localhost:%d  (git: %s%s, zotero: %s)  Ctrl+C to stop" % (
        a.port, "on" if core.GIT["on"] else "off", " + remote sync" if core.GIT["remote"] else "", "on" if zotero_sync.cfg() else "off"))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
