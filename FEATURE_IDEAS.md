# Feature Ideas

Concrete additions that fit what this tool actually does: delete your own Slack messages (and thread replies) in bulk, from Chrome's authenticated session, with age filters. Nothing here turns it into a bot, a hosted service, or something that touches other people's accounts, that would break the whole point of the design.

1. **Keyword/regex filter.** Add `--match "regex"` and `--exclude "regex"` so you can target "delete anything containing 'oops'" instead of only filtering by age. Straightforward to bolt onto the existing filter step in `conversations.history` results.

2. **Pinned-message protection.** Right now a pinned message with your name on it gets deleted like any other. Check `pinned_to` (or call `pins.list` once per channel) and skip pinned messages by default, with a `--include-pinned` escape hatch for people who actually want them gone.

3. **Attachment/file warning.** Deleting a message that has a file attached deletes the file too, that's easy to not realize until it's gone. Detect `message.files` and either skip those messages by default or print a distinct warning line before deleting them.

4. **Channel name resolution.** Currently you have to pass a channel ID or a full Slack URL. Add a lookup step (`conversations.list` filtered by name) so `./delete.sh general` works the same as pasting the URL.

5. **Multi-workspace awareness.** The token extraction (`for (var k in ts) return ts[k].token`) just grabs whichever team object comes first in `localConfig_v2`. Anyone in more than one Slack workspace in the same Chrome profile is silently pointed at the wrong one. Fix: match the team ID against the channel/URL being operated on, or add `--workspace` to disambiguate.

6. **Reaction-aware skip.** Add `--skip-reacted` to leave alone any message that has reactions from other people, useful for not deleting something that turned into a small moment in the channel.

7. **Interactive per-message review.** `-y` currently means "confirm once, delete everything that matched." A `--review` mode that steps through each match with y/n/a/q (yes / no / all / quit) gives a middle ground between full manual and full auto for a first run in an unfamiliar channel.

8. **Post-run summary stats.** After a run, print counts: messages scanned, deleted, skipped by filter, skipped by error, thread replies deleted. The `--log` JSON already has the raw data, this just means printing a rollup to stdout instead of requiring someone to parse the log file by hand.

9. **`--log`-as-checkpoint / resume.** If a run gets interrupted (Chrome closes, network blip, laptop sleeps), re-running currently starts over and re-scans everything. Read back the `--log` file if it exists and skip message IDs already marked deleted, so a big cleanup job in a busy channel can survive an interruption.

10. **Config profiles.** A `.slack-tidyup.json` (gitignored, next to `.env`) holding named option sets, e.g. `"monthly": {"months": 3, "quiet": true, "yes": true}`, invoked as `./delete.sh --profile monthly C0123456`. Saves retyping the same flag combination for a recurring cleanup.

11. **Batch channel list from a file.** `--channels-file list.txt` reading one channel ID/URL per line, so a recurring cleanup across a dozen channels doesn't mean a dozen positional arguments on one command line.

12. **Dry-run diff export.** Extend `--dry-run` to optionally write the matched-message list to a file (`--dry-run --log preview.json`) so it can be reviewed, diffed against a previous run, or handed to someone else for a sanity check before the real deletion run.

13. **`--doctor` preflight check.** A command that checks the three things that silently break this tool: Chrome is running, a Slack tab exists in the front window, and "Allow JavaScript from Apple Events" is turned on. Right now a missing permission just produces a cryptic AppleScript error partway through a run.

14. **Rate-limit backoff tuning.** `--retry` currently means "retry once." Slack's `chat.delete` rate limit (roughly 1 request/second on Tier 3 endpoints, worse under load) means a very large cleanup can still trip 429s. Add `--retry-count N` and honor the `Retry-After` header Slack sends back instead of a fixed single retry.

15. **DM and group-DM support, explicitly documented.** The API calls (`conversations.history`, `chat.delete`) already work on DM and MPDM conversation IDs, nothing in the code path restricts to public channels, but the README and `--help` text only talk about "channel." Confirm it works and document it, since "delete my old DM messages" is a very likely real use case.

16. **Launchd/cron wrapper with a lockfile.** A small wrapper script for scheduled runs (`--quiet --yes` already exist for non-interactive use) that takes a file lock so two scheduled runs can't overlap and race on the same channel.

17. **Thread-reply-count ceiling as a documented, adjustable constant.** The tool currently skips deleting your replies in threads with 50+ replies (per the README). Pull that `50` into a named constant or a `--thread-reply-limit` flag instead of a hardcoded number buried in the JS payload, Slack's own UI pagination behavior around large threads has changed before.

18. **`--stats-only` mode.** Run the full scan and filter pipeline, print the summary from idea #8, but never call `chat.delete` at all, no confirmation prompt, no dry-run banner. Useful for "how many messages do I even have in this channel" without any deletion intent whatsoever.

19. **Undo-safety export.** Before deleting, optionally write full message text + timestamp + permalink to a local file (`--backup FILE`), separate from `--log`'s pass/fail record. Slack's API has no undelete, so for someone who wants a personal record before running this against, say, three years of a channel, this is the difference between "gone" and "gone but I have a copy."

20. **Age filter on thread replies independent of the parent.** Right now age filters apply to the top-level message; once a message passes the filter, its replies get deleted regardless of when the reply itself was posted. A `--reply-age` option (or documenting the current behavior clearly, if it's intentional) closes a real gap between what someone expects `-m 3` to do and what it actually does to an old thread with a reply from yesterday.
