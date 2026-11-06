"""Two-way Zotero link for Reading Path.

Push (needs config.json -> zotero.userId + zotero.apiKey, see README):
  when a paper is marked read/known or its note changes, tag the Zotero item ("read"/"known" + "reading-path"),
  write your structured note as a child note (updated in place later), and add read papers that aren't in
  your library to a "Reading Path" collection.
Pull (no key needed): your PDF highlights and comments, read from a copy of the local zotero.sqlite.
"""
import html, json, os, re, shutil, sqlite3, tempfile, threading, time, urllib.parse
import rpcore as core

API = os.environ.get("RP_ZOTERO_API", "https://api.zotero.org")
_q = []; _ev = threading.Event()


def cfg():
    z = core.config().get("zotero") or {}
    return z if z.get("userId") and z.get("apiKey") else None


def _req(method, path, body=None, headers=None):
    z = cfg()
    h = {"Zotero-API-Key": z["apiKey"], "Zotero-API-Version": "3", "Content-Type": "application/json", **(headers or {})}
    st, hd, txt = core.http(API + "/users/%s%s" % (z["userId"], path), data=json.dumps(body).encode() if body is not None else None,
                            headers=h, method=method)
    return st, hd, (json.loads(txt) if txt.strip() else None)


def _find_item(p):
    if p.get("zotero"):
        try:
            return _req("GET", "/items/" + p["zotero"])[2]
        except Exception:
            pass
    q = urllib.parse.quote(p["title"][:80])
    _, _, items = _req("GET", "/items/top?qmode=titleCreatorYear&limit=10&q=" + q)
    pid = core.ident(p.get("url"))
    for it in items or []:
        d = it["data"]
        if pid and (core.ident("https://doi.org/" + d.get("DOI", "")) == pid or pid[6:] in (d.get("url", "") + d.get("archiveID", ""))):
            return it
        if core.norm(d.get("title")) == core.norm(p["title"]):
            return it
    return None


def _collection():
    z = cfg(); name = z.get("collection", "Reading Path")
    _, _, cols = _req("GET", "/collections?limit=100")
    for c in cols or []:
        if c["data"]["name"] == name:
            return c["key"]
    _, _, r = _req("POST", "/collections", [{"name": name}])
    return list(r["successful"].values())[0]["key"]


def _create_item(p):
    meta = core.lookup(p.get("url") or p["title"]) or {}
    names = meta.get("authorList") or []
    creators = [{"creatorType": "author", "lastName": n.split()[-1], "firstName": " ".join(n.split()[:-1])} for n in names] or \
               [{"creatorType": "author", "name": p.get("authors", "")}]
    i = core.ident(p.get("url"))
    item = {"itemType": "preprint" if i.startswith("arxiv:") else "journalArticle", "title": p["title"], "creators": creators,
            "date": str(p.get("year", "")), "url": p.get("url", ""), "collections": [_collection()],
            "tags": [{"tag": "reading-path"}], "abstractNote": meta.get("abstract", "")}
    if i.startswith("arxiv:"):
        item.update({"repository": "arXiv", "archiveID": "arXiv:" + i[6:]})
    elif i:
        item["DOI"] = i
    _, _, r = _req("POST", "/items", [item])
    ok = (r or {}).get("successful") or {}
    return list(ok.values())[0] if ok else None


def _note_html(p, s):
    n = s.get("notes") or {}
    rows = [("Takeaway", s.get("note")), ("Problem", n.get("problem")), ("Method / key equation", n.get("method")),
            ("Limitation", n.get("limitation")), ("Use for my work", n.get("use"))]
    body = "".join("<p><strong>%s:</strong> %s</p>" % (k, html.escape(v)) for k, v in rows if v)
    meta = "<p><em>Reading Path · %s%s%s</em></p>" % (s.get("state", ""), " · %s/5" % s["rating"] if s.get("rating") else "",
                                                      " · " + s.get("readOn", "") if s.get("readOn") else "")
    return "<h2>Reading notes</h2>" + body + meta


def sync_paper(key):
    """Push one paper's state to Zotero. Returns a short result string."""
    if not cfg():
        return "zotero not configured"
    papers = {p["key"]: p for p in core.load("papers")["papers"]}
    p = papers.get(key); s = core.load("status").get(key, {})
    if not p or s.get("state") not in ("read", "known") and not s.get("note"):
        return "nothing to sync"
    item = _find_item(p)
    if item is None:
        if s.get("state") != "read":
            return "not in your Zotero (papers you read are added automatically)"
        item = _create_item(p)
        if not item:
            return "could not create item"
        item = _req("GET", "/items/" + item["key"])[2]
    d = item["data"]; ik = item["key"]
    tags = {t["tag"] for t in d.get("tags", [])} | {"reading-path"} | ({s["state"]} if s.get("state") in ("read", "known") else set())
    if tags != {t["tag"] for t in d.get("tags", [])}:
        _req("PATCH", "/items/" + ik, {"tags": [{"tag": t} for t in sorted(tags)]}, {"If-Unmodified-Since-Version": str(item["version"])})
    note_key = s.get("zoteroNote")
    if core.compose_note(s):
        nh = _note_html(p, s)
        if note_key:
            try:
                ver = _req("GET", "/items/" + note_key)[2]["version"]
                _req("PATCH", "/items/" + note_key, {"note": nh}, {"If-Unmodified-Since-Version": str(ver)})
            except Exception:
                note_key = None
        if not note_key:
            _, _, r = _req("POST", "/items", [{"itemType": "note", "parentItem": ik, "note": nh, "tags": [{"tag": "reading-path"}]}])
            ok = (r or {}).get("successful") or {}
            note_key = list(ok.values())[0]["key"] if ok else None
    # remember the links without triggering another sync
    with core.LOCK:
        st = core.load("status")
        if key in st:
            st[key].update({"zoteroItem": ik, **({"zoteroNote": note_key} if note_key else {})})
            core.save("status", st)
        if not p.get("zotero"):
            pp = core.load("papers")
            for x in pp["papers"]:
                if x["key"] == key:
                    x["zotero"] = ik; x["inZotero"] = True
            core.save("papers", pp)
    return "synced"


def _worker():
    while True:
        _ev.wait(); _ev.clear()
        while _q:
            key = _q.pop(0)
            try:
                res = sync_paper(key)
            except Exception as e:
                res = "error: %s" % e
            log = core.load("zsync") if os.path.exists(os.path.join(core.DATA, "zsync.json")) else {}
            log[key] = {"at": core.now(), "result": res}
            with core.LOCK:
                core.save("zsync", log)
            time.sleep(1)


core.DEFAULTS["zsync"] = {}


def hook(key, status):
    if cfg() and (status.get("state") in ("read", "known") or status.get("note")):
        if key not in _q:
            _q.append(key)
        _ev.set()


def start():
    threading.Thread(target=_worker, daemon=True).start()
    core.HOOKS.append(hook)


def annotations(zotero_key):
    """Highlights and comments for an item, from a copy of the local Zotero database."""
    zdir = os.path.expanduser((core.config().get("zotero") or {}).get("dataDir", "~/Zotero"))
    db = os.path.join(zdir, "zotero.sqlite")
    if not zotero_key or not os.path.exists(db):
        return []
    tmp = os.path.join(tempfile.gettempdir(), "rp-zotero.sqlite")
    if not os.path.exists(tmp) or os.path.getmtime(tmp) < os.path.getmtime(db):
        shutil.copy2(db, tmp)
    c = sqlite3.connect(tmp)
    try:
        rows = c.execute("""select a.text, a.comment, a.color, a.pageLabel from items i
            join itemAttachments t on t.parentItemID = i.itemID
            join itemAnnotations a on a.parentItemID = t.itemID
            where i.key = ? order by a.sortIndex""", (zotero_key,)).fetchall()
    except sqlite3.Error:
        rows = []
    finally:
        c.close()
    return [{"text": r[0] or "", "comment": r[1] or "", "color": r[2] or "", "page": r[3] or ""} for r in rows]
