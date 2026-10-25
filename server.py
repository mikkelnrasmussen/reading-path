#!/usr/bin/env python3
"""Reading Path local server.

Serves the site and lets it write to the JSON files in ./data. Python 3.8+, no dependencies.

    python3 server.py              # http://localhost:8765
    python3 server.py --port 9000
    python3 server.py --no-git     # don't auto-commit changes

If git is installed, the folder is turned into a git repository on first start and every
change made through the site is committed, so your notes have a full history and the folder
can be pushed to GitHub (see README.md).
"""
import argparse, datetime as dt, difflib, json, os, re, shutil, subprocess, sys, threading
import urllib.parse, urllib.request, xml.etree.ElementTree as ET
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, "data")
LOCK = threading.Lock()
GIT = {"on": False}
DEFAULTS = {"papers": {"tracks": {}, "papers": []}, "status": {}, "days": [], "discover": [], "reactions": {}, "interests": {}}


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def load(name):
    try:
        with open(os.path.join(DATA, name + ".json"), encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return json.loads(json.dumps(DEFAULTS[name]))


def save(name, obj):
    path = os.path.join(DATA, name + ".json")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
        f.write("\n")
    os.replace(tmp, path)


def git(*args):
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True)


def commit(msg):
    if not GIT["on"]:
        return
    git("add", "data")
    git("commit", "-q", "-m", msg)


def setup_git(enabled):
    if not enabled or not shutil.which("git"):
        return
    if not os.path.isdir(os.path.join(ROOT, ".git")):
        if git("init", "-q").returncode != 0:
            return
        gi = os.path.join(ROOT, ".gitignore")
        if not os.path.exists(gi):
            with open(gi, "w") as f:
                f.write("*.tmp\n__pycache__/\n.DS_Store\nreading-path.json\n")
        git("add", "-A")
        r = git("commit", "-q", "-m", "Reading Path: initial commit")
        if r.returncode != 0 and "user.email" in (r.stderr or ""):
            print("git: set your name/email (git config --global user.name/user.email) to enable history.")
            return
    GIT["on"] = True


# ---------- identifiers & lookup ----------

def ident(url):
    u = url or ""
    m = re.search(r"arxiv\.org/(?:abs|pdf|html)/(\d{4}\.\d{4,5})", u)
    if m:
        return "arxiv:" + m.group(1)
    m = re.search(r"doi\.org/(10\.[^?#\s]+)", u)
    if m:
        return urllib.parse.unquote(m.group(1)).lower()
    m = re.search(r"biorxiv\.org/content/(10\.\d+/[^v?#\s]+)", u)
    return m.group(1).lower() if m else ""


def ident_from_query(q):
    q = (q or "").strip()
    m = re.search(r"(\d{4}\.\d{4,5})(v\d+)?", q)
    if m and ("arxiv" in q.lower() or re.fullmatch(r"(arxiv:)?\d{4}\.\d{4,5}(v\d+)?", q, re.I)):
        return "arxiv:" + m.group(1)
    m = re.search(r"(10\.\d{4,9}/[^\s?#]+)", q)
    if m:
        return m.group(1).rstrip(".,;").lower()
    return ""


def norm(t):
    return re.sub(r"[^a-z0-9]+", " ", (t or "").lower()).strip()


def short_authors(names):
    last = [n.split()[-1] for n in names if n.strip()]
    if not last:
        return ""
    if len(last) == 1:
        return last[0]
    if len(last) <= 3:
        return ", ".join(last[:-1]) + " & " + last[-1]
    return last[0] + " et al."


def http_get(url, accept=None):
    req = urllib.request.Request(url, headers={"User-Agent": "ReadingPath/1.0 (personal reading tracker)", **({"Accept": accept} if accept else {})})
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.read().decode("utf-8", "replace")


def arxiv_query(params):
    x = http_get("https://export.arxiv.org/api/query?" + urllib.parse.urlencode(params))
    ns = {"a": "http://www.w3.org/2005/Atom"}
    e = ET.fromstring(x).find("a:entry", ns)
    if e is None or e.find("a:title", ns) is None:
        return None
    aid = re.search(r"abs/(\d{4}\.\d{4,5})", e.find("a:id", ns).text or "")
    if not aid:
        return None
    return {"title": re.sub(r"\s+", " ", e.find("a:title", ns).text).strip(),
            "authors": short_authors([a.find("a:name", ns).text for a in e.findall("a:author", ns)]),
            "year": int((e.find("a:published", ns).text or "0")[:4]),
            "url": "https://arxiv.org/abs/" + aid.group(1),
            "abstract": re.sub(r"\s+", " ", e.find("a:summary", ns).text or "").strip()}


def crossref(doi=None, title=None):
    if doi:
        j = json.loads(http_get("https://api.crossref.org/works/" + urllib.parse.quote(doi)))["message"]
    else:
        items = json.loads(http_get("https://api.crossref.org/works?rows=1&query.bibliographic=" + urllib.parse.quote(title)))["message"]["items"]
        if not items:
            return None
        j = items[0]
        if difflib.SequenceMatcher(None, norm((j.get("title") or [""])[0]), norm(title)).ratio() < 0.85:
            return None
    names = [((a.get("given") or "") + " " + (a.get("family") or "")).strip() for a in j.get("author", [])]
    year = (j.get("issued", {}).get("date-parts") or [[None]])[0][0]
    return {"title": (j.get("title") or [""])[0], "authors": short_authors(names), "year": year,
            "url": "https://doi.org/" + j["DOI"], "venue": (j.get("container-title") or [""])[0]}


def lookup(q):
    i = ident_from_query(q)
    try:
        if i.startswith("arxiv:"):
            return arxiv_query({"id_list": i[6:]})
        if i:
            return crossref(doi=i)
        r = arxiv_query({"search_query": 'ti:"' + q.replace('"', "") + '"', "max_results": 1})
        if r and difflib.SequenceMatcher(None, norm(r["title"]), norm(q)).ratio() > 0.85:
            return r
        return crossref(title=q)
    except Exception as e:  # network errors, parse errors
        return {"error": str(e)}


def find_paper(papers, query, title):
    i = ident_from_query(query) or ident(query)
    t = norm(title or "")
    for p in papers:
        if i and ident(p.get("url")) == i:
            return p
    for p in papers:
        if t and len(t) > 12 and difflib.SequenceMatcher(None, norm(p.get("title")), t).ratio() > 0.93:
            return p
    return None


# ---------- HTTP ----------

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, fmt, *args):
        if "/api/" in (args[0] if args else ""):
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
        u = urllib.parse.urlparse(self.path)
        if u.path == "/api/ping":
            return self.send_json({"ok": True, "git": GIT["on"]})
        if u.path == "/api/lookup":
            q = urllib.parse.parse_qs(u.query).get("q", [""])[0]
            return self.send_json(lookup(q) or {})
        return super().do_GET()

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        except json.JSONDecodeError:
            return self.send_json({"error": "bad JSON"}, 400)
        try:
            with LOCK:
                out = self.route(path, body)
        except KeyError as e:
            return self.send_json({"error": "missing field %s" % e}, 400)
        if out is None:
            return self.send_json({"error": "not found"}, 404)
        self.send_json(out)

    def route(self, path, b):
        if path == "/api/status":
            s = load("status"); key = b["key"]
            s[key] = {**{k: v for k, v in b["patch"].items() if v not in (None, "")}, "at": now()}
            if not s[key].get("state") and not s[key].get("note") and not s[key].get("rating"):
                s.pop(key)
            save("status", s); commit("status: %s -> %s" % (key, b["patch"].get("state") or "note/rating"))
            return {"ok": True}
        if path == "/api/day":
            days = [d for d in load("days") if d["id"] != b["id"]]
            days.insert(0, {k: v for k, v in b.items() if k in ("id", "paper", "brief", "news", "replaced", "summary", "takeaways", "keyFigure", "figUrl", "relevance")})
            days.sort(key=lambda d: d["id"], reverse=True)
            save("days", days); commit("day %s: %s" % (b["id"], b["paper"]))
            return {"ok": True}
        if path == "/api/paper":
            p = load("papers"); doc = b
            if any(x["key"] == doc["key"] for x in p["papers"]):
                return {"error": "key exists"}
            doc.setdefault("addedAt", now()); p["papers"].append(doc)
            save("papers", p); commit("add paper: %s" % doc.get("title", doc["key"])[:60])
            return {"ok": True, "key": doc["key"]}
        if path == "/api/reaction":
            r = load("reactions")
            if b.get("reaction"):
                r[b["id"]] = {"reaction": b["reaction"], "at": now(), **({"addedKey": b["addedKey"]} if b.get("addedKey") else {})}
            else:
                r.pop(b["id"], None)
            save("reactions", r); commit("discover %s: %s" % (b["id"], b.get("reaction") or "cleared"))
            return {"ok": True}
        if path == "/api/log":
            return log_read(b)
        return None


def log_read(b):
    """Log a paper read outside the plan. On the path -> mark read. Otherwise -> independent read."""
    p = load("papers"); s = load("status")
    date = b.get("date") or dt.date.today().isoformat()
    hit = find_paper(p["papers"], b.get("query", ""), b.get("title", ""))
    entry = {"state": "read", "readOn": date, "via": "logged", "at": now()}
    if b.get("note"): entry["note"] = b["note"]
    if b.get("rating"): entry["rating"] = int(b["rating"])
    if hit:
        prev = s.get(hit["key"], {})
        s[hit["key"]] = {**prev, **entry}
        save("status", s); commit("logged read (on path): %s" % hit["title"][:60])
        return {"ok": True, "matched": True, "key": hit["key"]}
    title = (b.get("title") or "").strip()
    if not title:
        q0 = (b.get("query") or "").strip()
        meta = lookup(q0) or {}
        if meta.get("error"): meta = {}
        title = meta.get("title") or ("" if (ident_from_query(q0) or q0.startswith("http")) else q0)
        b = {**meta, **{k: v for k, v in b.items() if v}}
    if not title:
        return {"error": "no title"}
    q = b.get("query", "")
    url = b.get("url") or (q if q.startswith("http") else ("https://arxiv.org/abs/" + ident_from_query(q)[6:] if ident_from_query(q).startswith("arxiv:") else ("https://doi.org/" + ident_from_query(q) if ident_from_query(q) else "https://scholar.google.com/scholar?q=" + urllib.parse.quote_plus(title))))
    key = "i-" + re.sub(r"[^a-z0-9]+", "-", norm(title))[:40].strip("-") + "-" + dt.datetime.now().strftime("%H%M%S")
    year = b.get("year")
    try: year = int(year)
    except (TypeError, ValueError): year = ""
    p["papers"].append({"key": key, "seq": None, "track": b.get("track") or "", "pass": 0, "title": title,
                        "authors": b.get("authors", ""), "year": year, "url": url, "zotero": "", "inZotero": False,
                        "byJes": False, "prereqs": [], "why": "Read independently on %s." % date,
                        "source": "independent", "triaged": False, "addedAt": now()})
    s[key] = entry
    save("papers", p); save("status", s); commit("logged independent read: %s" % title[:60])
    return {"ok": True, "matched": False, "key": key}


def main():
    ap = argparse.ArgumentParser(description="Reading Path local server")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--no-git", action="store_true")
    a = ap.parse_args()
    os.makedirs(DATA, exist_ok=True)
    setup_git(not a.no_git)
    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    print("Reading Path on http://localhost:%d  (git history: %s)  Ctrl+C to stop" % (a.port, "on" if GIT["on"] else "off"))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
