"""Shared core for Reading Path: data files, identifiers, lookup, logging, recall, agenda, BibTeX, git.

Used by server.py (the website) and rp (the terminal tool). Standard library only.
"""
import datetime as dt, difflib, json, os, re, shutil, subprocess, threading
import urllib.parse, urllib.request, xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, "data")
LOCK = threading.RLock()
GIT = {"on": False, "remote": False, "last_sync": "", "error": ""}
DEFAULTS = {"papers": {"tracks": {}, "papers": []}, "status": {}, "days": [], "discover": [], "reactions": {},
            "interests": {}, "recall": {}, "agenda": [], "requests": [], "drafts": [], "digests": [],
            "settings": {"weeklyGoal": 5, "recall": False, "structuredNotes": False, "milestonesSeen": []},
            "tutor": {"style": [], "struggles": [], "qa": []}}
RECALL_DAYS = [7, 30, 90, 180]  # days after reading; "shaky" repeats after 3 days
DONE = {"read", "known", "skipped", "skimmed"}  # skimmed = enough to move on, flagged for a proper read later


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def today():
    return dt.date.today().isoformat()


def load(name):
    try:
        with open(os.path.join(DATA, name + ".json"), encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return json.loads(json.dumps(DEFAULTS[name]))


def save(name, obj):
    os.makedirs(DATA, exist_ok=True)
    path = os.path.join(DATA, name + ".json")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
        f.write("\n")
    os.replace(tmp, path)


def config():
    try:
        with open(os.path.join(ROOT, "config.json"), encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


# ---------- git ----------

def git(*args, timeout=60):
    try:
        return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, timeout=timeout)
    except Exception as e:  # git missing or hung
        class R: returncode = 1; stdout = ""; stderr = str(e)
        return R()


def setup_git(enabled=True):
    if not enabled or not shutil.which("git"):
        return
    if not os.path.isdir(os.path.join(ROOT, ".git")):
        if git("init", "-q").returncode != 0:
            return
        git("checkout", "-q", "-b", "main")
    gi = os.path.join(ROOT, ".gitignore")
    want = ["*.tmp", "__pycache__/", ".DS_Store", "reading-path*.json", "config.json"]
    have = open(gi).read().split("\n") if os.path.exists(gi) else []
    if any(w not in have for w in want):
        with open(gi, "w") as f:
            f.write("\n".join(dict.fromkeys(have + want)).strip() + "\n")
    if git("rev-parse", "HEAD").returncode != 0:
        git("add", "-A")
        r = git("commit", "-q", "-m", "Reading Path: initial commit")
        if r.returncode != 0 and "user.email" in (r.stderr or ""):
            print("git: set your name/email (git config --global user.name / user.email) to enable history.")
            return
    GIT["on"] = True
    GIT["remote"] = bool(git("remote").stdout.strip())


def commit(msg):
    if not GIT["on"]:
        return False
    git("add", *[d for d in ("data", "drafts") if os.path.isdir(os.path.join(ROOT, d))])
    return git("commit", "-q", "-m", msg).returncode == 0


def sync_remote():
    """Pull then push, if a remote is configured. Returns an error string or ''."""
    if not (GIT["on"] and GIT["remote"]):
        return ""
    with LOCK:
        commit("local changes")
        if git("rev-parse", "--abbrev-ref", "@{u}").returncode != 0:
            br = git("rev-parse", "--abbrev-ref", "HEAD").stdout.strip() or "main"
            git("fetch", "-q", "origin", timeout=90)
            if git("rev-parse", "--verify", "-q", "origin/" + br).returncode == 0:
                git("branch", "-q", "--set-upstream-to=origin/" + br)
            else:
                r = git("push", "-q", "-u", "origin", "HEAD", timeout=90)
                GIT["error"] = "" if r.returncode == 0 else "push failed: " + (r.stderr or "").strip()[:200]
                GIT["last_sync"] = now()
                return GIT["error"]
        r = git("pull", "--rebase", "--autostash", "-q", timeout=90)
        if r.returncode != 0:
            git("rebase", "--abort")
            GIT["error"] = "pull failed: " + (r.stderr or r.stdout).strip()[:200]
            return GIT["error"]
        r = git("push", "-q", timeout=90)
        GIT["error"] = "" if r.returncode == 0 else "push failed: " + (r.stderr or "").strip()[:200]
        GIT["last_sync"] = now()
        return GIT["error"]


# ---------- identifiers, lookup ----------

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
    last = [n.split()[-1] for n in names if n and n.strip()]
    if not last:
        return ""
    if len(last) == 1:
        return last[0]
    if len(last) <= 3:
        return ", ".join(last[:-1]) + " & " + last[-1]
    return last[0] + " et al."


def http(url, data=None, headers=None, method=None, timeout=25):
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"User-Agent": "ReadingPath/1.1 (personal reading tracker)", **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, dict(r.headers), r.read().decode("utf-8", "replace")


def arxiv_query(params):
    _, _, x = http("https://export.arxiv.org/api/query?" + urllib.parse.urlencode(params))
    ns = {"a": "http://www.w3.org/2005/Atom"}
    e = ET.fromstring(x).find("a:entry", ns)
    if e is None or e.find("a:title", ns) is None:
        return None
    aid = re.search(r"abs/(\d{4}\.\d{4,5})", e.find("a:id", ns).text or "")
    if not aid:
        return None
    names = [a.find("a:name", ns).text for a in e.findall("a:author", ns)]
    return {"title": re.sub(r"\s+", " ", e.find("a:title", ns).text).strip(), "authors": short_authors(names),
            "authorList": names, "year": int((e.find("a:published", ns).text or "0")[:4]),
            "url": "https://arxiv.org/abs/" + aid.group(1),
            "abstract": re.sub(r"\s+", " ", e.find("a:summary", ns).text or "").strip()}


def crossref(doi=None, title=None):
    if doi:
        j = json.loads(http("https://api.crossref.org/works/" + urllib.parse.quote(doi))[2])["message"]
    else:
        items = json.loads(http("https://api.crossref.org/works?rows=1&query.bibliographic=" + urllib.parse.quote(title))[2])["message"]["items"]
        if not items:
            return None
        j = items[0]
        if difflib.SequenceMatcher(None, norm((j.get("title") or [""])[0]), norm(title)).ratio() < 0.85:
            return None
    names = [((a.get("given") or "") + " " + (a.get("family") or "")).strip() for a in j.get("author", [])]
    year = (j.get("issued", {}).get("date-parts") or [[None]])[0][0]
    return {"title": (j.get("title") or [""])[0], "authors": short_authors(names), "authorList": names, "year": year,
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
    except Exception as e:
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


# ---------- status, recall, agenda ----------

HOOKS = []  # callables(key, status) run after a status change (e.g. Zotero sync)


def compose_note(s):
    n = s.get("notes") or {}
    parts = [s.get("note", "")] + ["%s: %s" % (lab, n[k]) for k, lab in
                                   (("problem", "Problem"), ("method", "Method"), ("limitation", "Limitation"), ("use", "Use for my work")) if n.get(k)]
    return "\n".join(p for p in parts if p)


def schedule_recall(key, read_on):
    r = load("recall")
    if key in r:
        return
    d = dt.date.fromisoformat(read_on[:10]) if read_on else dt.date.today()
    r[key] = {"stage": 0, "due": (d + dt.timedelta(days=RECALL_DAYS[0])).isoformat(), "questions": [], "history": []}
    save("recall", r)


def set_status(key, patch, msg=None):
    """Merge patch into status[key]; schedules recall on first read; runs hooks; commits."""
    with LOCK:
        s = load("status")
        cur = dict(s.get(key, {}))
        for k, v in patch.items():
            if v in (None, "") or v == {}:
                cur.pop(k, None)
            else:
                cur[k] = v
        cur["at"] = now()
        if cur.get("state") in ("read", "skimmed") and not cur.get("readOn"):
            cur["readOn"] = today()
        if not any(cur.get(k) for k in ("state", "note", "notes", "rating", "discuss")):
            s.pop(key, None)
        else:
            s[key] = cur
        save("status", s)
        if cur.get("state") == "read":
            schedule_recall(key, cur.get("readOn"))
        commit(msg or "status: %s" % key)
    for h in HOOKS:
        try:
            h(key, cur)
        except Exception as e:  # never break saving because of a hook
            print("hook error:", e)
    return cur


def recall_result(key, result):
    with LOCK:
        r = load("recall"); e = r.get(key)
        if not e:
            return None
        e.setdefault("history", []).append({"date": today(), "result": result, "stage": e["stage"]})
        if result == "remembered":
            e["stage"] += 1
            if e["stage"] >= len(RECALL_DAYS):
                e["done"] = True; e["due"] = ""
            else:
                e["due"] = (dt.date.today() + dt.timedelta(days=RECALL_DAYS[e["stage"]] - RECALL_DAYS[e["stage"] - 1])).isoformat()
        else:
            e["due"] = (dt.date.today() + dt.timedelta(days=3)).isoformat()
        save("recall", r); commit("recall %s: %s" % (key, result))
        return e


def agenda_add(text, key=None):
    with LOCK:
        a = load("agenda")
        item = {"id": "a" + dt.datetime.now().strftime("%y%m%d%H%M%S%f")[:16], "text": text.strip(), "key": key or "", "created": now(), "done": ""}
        a.append(item); save("agenda", a); commit("agenda: add")
        return item


def agenda_update(id_, **fields):
    with LOCK:
        a = load("agenda")
        for it in a:
            if it["id"] == id_:
                it.update({k: v for k, v in fields.items() if v is not None})
        save("agenda", a); commit("agenda: update")


def log_read(b):
    """Log a paper read outside the plan. On the path -> mark read. Otherwise -> independent read."""
    with LOCK:
        p = load("papers")
        date = b.get("date") or today()
        hit = find_paper(p["papers"], b.get("query", ""), b.get("title", ""))
        patch = {"state": "read", "readOn": date, "via": "logged", "note": b.get("note"), "notes": b.get("notes") or None,
                 "rating": int(b["rating"]) if b.get("rating") else None}
        if hit:
            set_status(hit["key"], patch, "logged read (on path): %s" % hit["title"][:60])
            return {"ok": True, "matched": True, "key": hit["key"]}
        title = (b.get("title") or "").strip()
        meta = {}
        if not title:
            q0 = (b.get("query") or "").strip()
            meta = lookup(q0) or {}
            if meta.get("error"):
                meta = {}
            title = meta.get("title") or ("" if (ident_from_query(q0) or q0.startswith("http")) else q0)
        if not title:
            return {"error": "no title"}
        q = b.get("query", ""); qi = ident_from_query(q)
        url = b.get("url") or meta.get("url") or (q if q.startswith("http") else ("https://arxiv.org/abs/" + qi[6:] if qi.startswith("arxiv:") else ("https://doi.org/" + qi if qi else "https://scholar.google.com/scholar?q=" + urllib.parse.quote_plus(title))))
        key = "i-" + re.sub(r"[^a-z0-9]+", "-", norm(title))[:40].strip("-") + "-" + dt.datetime.now().strftime("%H%M%S")
        year = b.get("year") or meta.get("year")
        try:
            year = int(year)
        except (TypeError, ValueError):
            year = ""
        p["papers"].append({"key": key, "seq": None, "track": b.get("track") or "", "pass": 0, "title": title,
                            "authors": b.get("authors") or meta.get("authors", ""), "year": year, "url": url, "zotero": "",
                            "inZotero": False, "byJes": False, "prereqs": [], "why": "Read independently on %s." % date,
                            "source": "independent", "triaged": False, "addedAt": now()})
        save("papers", p)
    set_status(key, patch, "logged independent read: %s" % title[:60])
    return {"ok": True, "matched": False, "key": key}


# ---------- BibTeX ----------

def bibkey(p):
    a = re.sub(r"[^a-z]", "", (p.get("authors") or "anon").split()[0].split(",")[0].lower()) or "anon"
    w = next((x for x in re.sub(r"[^a-z0-9 ]", "", (p.get("title") or "").lower()).split() if len(x) > 3), "paper")
    return "%s%s%s" % (a, p.get("year") or "", w)


def bibentry(p, status=None):
    s = status or {}; i = ident(p.get("url"))
    note = compose_note(s).replace("{", "").replace("}", "").replace("\n", "; ")
    extra = ("  eprint = {%s},\n  archivePrefix = {arXiv},\n" % i[6:]) if i.startswith("arxiv:") else ("  doi = {%s},\n" % i if i else "")
    return ("@misc{%s,\n  title = {{%s}},\n  author = {%s},\n  year = {%s},\n  url = {%s},\n%s%s  keywords = {reading-path, %s, %s}\n}"
            % (bibkey(p), p["title"], p.get("authors", ""), p.get("year", ""), p.get("url", ""), extra,
               ("  annote = {%s},\n" % note) if note else "", p.get("track", ""), s.get("state", "open")))


# ---------- settings & tutor memory ----------

def settings_update(patch):
    with LOCK:
        st = load("settings")
        st.update({k: v for k, v in patch.items() if k in ("weeklyGoal", "recall", "structuredNotes", "milestonesSeen", "busyUntil", "pauses")})
        if not st.get("busyUntil"): st.pop("busyUntil", None)
        save("settings", st); commit("settings")
        return st


def tutor_update(b):
    """op=style: replace answer-style preferences. op=merge: add a chat wrap-up (questions, struggled concepts, style feedback)."""
    with LOCK:
        t = load("tutor")
        for k in ("style", "struggles", "qa"):
            t.setdefault(k, [])
        if b.get("op") == "style":
            t["style"] = [str(x).strip() for x in b.get("lines", []) if str(x).strip()][:20]
        else:
            paper = b.get("paper", ""); d = today()
            for q in b.get("questions") or []:
                if isinstance(q, dict) and q.get("q"):
                    t["qa"].append({"paper": paper, "date": d, "q": q["q"].strip()[:500], "gist": (q.get("gist") or "").strip()[:800]})
            have = {x["concept"].lower() for x in t["struggles"]}
            for c in b.get("struggled") or []:
                c = str(c).strip()
                if c and c.lower() not in have:
                    t["struggles"].append({"concept": c[:120], "paper": paper, "date": d}); have.add(c.lower())
            style = b.get("style") or {}
            for k, prefix in (("liked", ""), ("disliked", "Avoid: ")):
                v = str(style.get(k) or "").strip()
                if v and prefix + v not in t["style"]:
                    t["style"].append(prefix + v)
            t["style"] = t["style"][-20:]; t["qa"] = t["qa"][-400:]
        save("tutor", t); commit("tutor memory")
        return t
