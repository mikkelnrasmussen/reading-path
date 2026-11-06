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
| `data/recall.json` | both | recall schedule and questions |
| `data/agenda.json` | you | meeting-prep list |
| `data/requests.json`, `data/drafts.json` | you, Claude | related-work requests and drafts (also in `drafts/`) |
| `data/digests.json` | Claude | weekly digests |
| `config.json` | you | optional API keys (git-ignored) |

`server.py` turns the folder into a git repository on first start and commits every change you make
in the site, so you have full history. (`rp` writes commit too.)

## Daily habits the site supports

- **Recall.** A week, a month, three months and six months after you read a paper, a question about it
  comes back in the Recall section (or `rp recall`). The morning update writes the questions from the
  paper and your notes. "Shaky" brings it back in three days.
- **Structured notes.** A one-line takeaway plus optional fields: problem, method / key equation,
  limitation, use for my work. They end up in exports, BibTeX `annote`, Zotero and recall answers.
- **Meeting prep.** "Discuss with supervisors" on a paper, or add a question in Meeting prep (`rp agenda add "..."`).
  Copy the list as Markdown before the meeting and mark items discussed afterwards.
- **Quick sort.** Go through undecided papers one at a time (K = know it, W = want to read, N = not for me,
  U = undo). Also `rp sort`.
- **Writing.** Ask for a related-work draft on a topic. It uses only papers you've read or know and your
  notes, cites with the same keys as the BibTeX export, and saves `drafts/<topic>.md` + `.bib`.
  Queued drafts are written by the next morning update; with an Anthropic API key in `config.json`
  the "Draft now" button (and `rp draft`) writes it immediately.
- **Weekly digest.** Friday afternoon: what you read, your notes, recall results, interest drift and
  next week's plan. Shown under Digests and sent to you as a notification.

## Optional integrations (config.json)

Copy `config.example.json` to `config.json` (it is git-ignored, so keys never get committed) and fill in:

- **Zotero** (`zotero.userId`, `zotero.apiKey`): create a key at zotero.org/settings/keys with
  "Allow library access" and "Allow write access"; the userID is shown on the same page. When you mark a
  paper read or known, its Zotero item gets the tags `read`/`known` and `reading-path`, and your notes
  are written as a child note (updated when you edit them). Papers you read that aren't in your library
  are added to a "Reading Path" collection. "Sync notes to Zotero" in Library pushes everything once.
  Your PDF highlights from Zotero are shown on today's paper (read locally, no key needed).
- **Anthropic** (`anthropic.apiKey`, `anthropic.model`): enables instant related-work drafts.

Restart `server.py` after editing `config.json`.

## Reading outside the plan

Use **Log a read** on the site, or `rp log <arXiv id | DOI | link | title> -n "note" -r 4`.

- On your path already: marked read with the date; the plan moves past it and anything that depended
  on it unlocks.
- Not on your path: stored as an independent read (in your library, not in the plan). The next morning
  update gives it a field, counts it as a strong interest signal for your Discover picks and plan,
  and may queue one or two papers it builds on or that follow from it.

## Sync through GitHub (optional)

If the folder has a git remote, `server.py` pulls on start and every 10 minutes and pushes your changes,
and `rp publish` does the same on demand. This keeps several machines in sync and is the first step to
letting the morning update run in the cloud while your Mac sleeps:

    cd ~/Documents/ReadingPath
    gh repo create reading-path --private --source . --push   # or create it on github.com, then:
    # git remote add origin git@github.com:<you>/reading-path.git && git push -u origin main

## Putting it online

The site works on any static host; without `server.py` it opens read-only (no editing, no logging).

GitHub Pages:

    cd ~/Documents/ReadingPath
    gh repo create reading-path --private --source . --push     # or create the repo on github.com and git push
    # Settings → Pages → Deploy from branch → main / (root)

Keep in mind that a Pages site is public even if the repository is private (unless your plan
restricts Pages access), so your notes and ratings would be visible. Options: publish without notes,
keep it local, or use a host with password protection. After that, `rp publish` commits and pushes.
