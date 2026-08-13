# Build Log

How this repo went from nothing to its current state, and the exact steps to rebuild it from scratch. Written from real git history (`git log --stat`), not guesswork.

## History, commit by commit

1. **`193fbc0` - Initial commit: Slack bulk message deleter (shell + Node versions)**
   Landed all at once: `delete.sh`, `delete.js`, `README.md`, `.env.example`, `.gitignore`. Both scripts already had full option parsing (age filters, dry-run, limit, log, quiet, verbose, retry) and the AppleScript-into-Chrome mechanism working.

2. **`268d081` - Add CI workflow with syntax checks for delete scripts**
   Added `.github/workflows/ci.yml`. Runs `bash -n delete.sh` and `node --check delete.js` on every push and PR, just syntax validation, no real Slack calls (there's nothing to mock a real Chrome+Slack session with in CI).

3. **`bb5c73d` - ci: add workflow to block AI attribution in commits**
   Added `.github/workflows/ai-attribution-check.yml`. Scans commit metadata and file contents for AI tool names/emails.

4. **`f9cc0aa` - chore: trigger GitHub re-index**
   Empty commit, no file changes. Used to nudge GitHub's search indexer.

5. **`1ef483c` - ci: upgrade AI attribution check to cover author/committer fields**
   Widened the attribution check to also scan `%an`/`%ae`/`%cn`/`%ce`, not just commit messages.

6. **`1908956` - docs: add design workflow documentation**
   Added `docs/DESIGN.md` with Mermaid diagrams of the token-extraction flow and the deletion flow.

7. **`a003479` - docs: remove em dashes from README**
   Prose cleanup across `README.md`, `delete.js`, `delete.sh`, `docs/DESIGN.md`.

8. **`f670b9c` - ci: stop AI attribution check from flagging itself and normal GitHub merges**
   Fixed false positives: the check was matching its own workflow file and normal GitHub merge-commit text.

That's the whole history: 8 commits, one branch (`main`), no tags, no releases, no package.json (deliberately, neither script has a dependency).

## Rebuilding from zero, with no manual/human input

An agent (or a very patient script) can reconstruct this repo from nothing by running the steps below in order. Nothing here needs a human to click, type a token, or make a judgment call, every step is mechanical.

### Step 1: Scaffold the directory

```bash
mkdir landonkea-slack-tidyup && cd landonkea-slack-tidyup
git init
```

### Step 2: Write `.gitignore`

Must exclude `.env` (personal Slack member ID), `.DS_Store`, and `*.log` / `*.json.log` (output from the `--log` flag). See the current `.gitignore` for the exact contents.

### Step 3: Write `.env.example`

A template with `SLACK_USER_ID=` and a comment block explaining where to find that ID in the Slack app UI. No real value goes in this file, ever.

### Step 4: Write `delete.sh`

The Bash implementation. Structurally it needs:
- A `.env` loader (`source` guarded by `set -a`/`set +a`) that exits with an error if `SLACK_USER_ID` is missing.
- A `parse_duration()` helper converting `30d`/`4w`/`3m` strings into a day count.
- Argument parsing for: `-a/--auto`, `-d/--days`, `-w/--weeks`, `-m/--months`, `--after`, `--before`, `--dry-run`, `-y/--yes`, `--limit`, `--log`, `--quiet`, `--verbose`, `--retry/--no-retry`, `-h/--help`.
- An embedded JavaScript payload (as a heredoc or escaped string) that runs inside the Slack tab: reads the token out of `localStorage.localConfig_v2`, calls `conversations.history` / `conversations.replies` via synchronous `XMLHttpRequest` (not `fetch`, Slack's CSRF handling blocks async calls from injected code), filters to the user's own messages, and calls `chat.delete`.
- An AppleScript wrapper (built as a temp file, invoked with `osascript`) that tells Chrome to execute that JavaScript in the active tab and return the result.

### Step 5: Write `delete.js`

Same behavior as `delete.sh`, ported to Node: `.env` parsing done by hand (splitting on `=`, no dotenv dependency), the same option set, `execSync('osascript ...')` instead of calling `osascript` from Bash directly, same embedded browser-side JS.

### Step 6: Write `README.md`

Explains the AppleScript-to-Chrome-to-Slack-API mechanism, why synchronous `XMLHttpRequest` is required, requirements (macOS, Chrome with "Allow JavaScript from Apple Events" turned on, optionally Node), setup (`cp .env.example .env`), usage for both scripts, and a short note on Slack's terms of service (this only automates the user's own already-authenticated session).

### Step 7: Commit the initial state

```bash
git add .gitignore .env.example delete.sh delete.js README.md
git commit -m "Initial commit: Slack bulk message deleter (shell + Node versions)"
```

### Step 8: Add CI

`.github/workflows/ci.yml`, triggered on push to `main` and on pull requests, running `bash -n delete.sh` and `node --check delete.js`.

### Step 9: Add the AI-attribution guard

`.github/workflows/ai-attribution-check.yml`, scanning commit author/committer fields and message bodies, plus a repo-wide grep, for AI tool names and no-reply addresses. Exclude the workflow file itself from the file-content scan (it necessarily contains the tool names it's blocking) and exclude normal GitHub merge-commit text from false-triggering.

### Step 10: Add design docs

`docs/DESIGN.md` with Mermaid diagrams for the token-extraction sequence and the deletion flowchart, plus a file-relationship table.

### Step 11: Editorial pass

Sweep `README.md`, both scripts' comments, and `docs/DESIGN.md` for stray em dashes or other AI-sounding phrasing and clean it up.

### What can't be automated

Two things in this repo are inherently outside automation:
- The actual Slack member ID in `.env` has to come from a real logged-in Slack session (Profile -> "..." -> Copy member ID). It's gitignored on purpose.
- Actually running either script requires a real Chrome window, logged into `app.slack.com`, with "Allow JavaScript from Apple Events" turned on. CI can check syntax but can't exercise the real deletion path, there's no headless equivalent of an already-authenticated Chrome session with the accessibility permission granted.
