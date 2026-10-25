# Reading Path

Your daily reading plan, Discover feed and reading library: a small static website plus plain JSON files.
Nothing here depends on Claude; Claude's morning update just edits the files in `data/`.

## Start it

Double-click **Reading Path.command** (first time: right-click → Open, to get past macOS's unsigned-script warning),
or in a terminal:

    cd ~/Documents/ReadingPath
    python3 server.py          # then open http://localhost:8765

Stop it with Ctrl+C. Optional: `echo 'export PATH="$HOME/Documents/ReadingPath:$PATH"' >> ~/.zshrc`
to use `rp` from anywhere (`rp serve` starts the site too).

## What lives where

| File | Written by | What |
|---|---|---|
| `data/papers.json` | Claude (plan), you (added/logged papers) | every paper: plan order, field, prerequisites, why |
| `data/status.json` | you | read / known / later / skipped, ratings, notes, dates |
| `data/days.json` | Claude, you (swaps) | daily picks with summary, takeaways, relevance |
| `data/discover.json` | Claude | Discover feed items |
| `data/reactions.json` | you | your Discover reactions |
| `data/interests.json` | Claude | the interest profile built from your reads and reactions |

`server.py` turns the folder into a git repository on first start and commits every change you make
in the site, so you have full history. (`rp` writes commit too.)

## Reading outside the plan

Use **Log a read** on the site, or `rp log <arXiv id | DOI | link | title> -n "note" -r 4`.

- On your path already: marked read with the date; the plan moves past it and anything that depended
  on it unlocks.
- Not on your path: stored as an independent read (in your library, not in the plan). The next morning
  update gives it a field, counts it as a strong interest signal for your Discover picks and plan,
  and may queue one or two papers it builds on or that follow from it.

## Putting it online

The site works on any static host; without `server.py` it opens read-only (no editing, no logging).

GitHub Pages:

    cd ~/Documents/ReadingPath
    gh repo create reading-path --private --source . --push     # or create the repo on github.com and git push
    # Settings → Pages → Deploy from branch → main / (root)

Keep in mind that a Pages site is public even if the repository is private (unless your plan
restricts Pages access), so your notes and ratings would be visible. Options: publish without notes,
keep it local, or use a host with password protection. After that, `rp publish` commits and pushes.
