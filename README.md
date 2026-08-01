# landonkea-slack-tidyup

Deletes your own messages (and thread replies) from a Slack channel, in bulk, with age filters.

## How it works

AppleScript tells Chrome to run JavaScript in the active tab. That JavaScript runs inside `app.slack.com`'s own page, so it reuses Chrome's already-authenticated session: the Slack API token comes out of `localStorage` (`localConfig_v2`) and auth cookies ride along automatically on same-origin requests. Nothing is read from or written to disk except the two throwaway files in `/tmp` used to hand the JS/AppleScript to `osascript`, and (optionally) a `--log` file you point at yourself.

Slack's async `fetch()` calls get intercepted with CSRF protection, so both scripts deliberately use **synchronous** `XMLHttpRequest` instead — that's also why AppleScript can read a return value at all (`execute javascript` only returns values from synchronous code).

Two implementations, same behavior:
- `delete.sh` — pure Bash + `osascript`, no dependencies beyond macOS and Chrome.
- `delete.js` — Node.js version of the same logic.

Both also delete your replies inside threads (`conversations.replies`) on channels where a message has fewer than 50 replies, not just top-level channel messages.

## Requirements

- macOS (AppleScript is macOS-only)
- Google Chrome, open, logged into Slack (`app.slack.com`)
- Chrome: **View → Developer → Allow JavaScript from Apple Events** (one-time setup)
- For the `.js` version: Node.js

## Setup

```bash
cp .env.example .env
# then edit .env and set SLACK_USER_ID to your own Slack member ID
# (Slack app -> profile picture -> Profile -> "..." -> Copy member ID)
```

Your Slack member ID is personal to your account, so it lives in `.env` (gitignored) rather than in the script — this repo never contains anyone's actual Slack identifiers.

## Usage

```bash
./delete.sh [OPTIONS] URL_OR_CHANNEL_ID [URL_OR_CHANNEL_ID2 ...]
# or
node delete.js [OPTIONS] URL_OR_CHANNEL_ID ...
```

Run either with `--help` (or no arguments) to see the full option list — age filters (`-d`/`-w`/`-m`, `--after`, `--before`), `--dry-run`, `--limit`, `--log`, etc.

## A note on Slack's Terms of Service

This automates actions against your own account using your own already-authenticated session — it doesn't touch anyone else's account or data. Use it for personal message cleanup, not as an unattended or shared service.
