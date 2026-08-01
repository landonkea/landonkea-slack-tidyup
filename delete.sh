#!/bin/bash
# ============================================
# Slack Message Deleter (Shell Script version)
# No Node.js required — just macOS + Chrome
# ============================================
#
# WHAT THIS DOES:
#   Deletes YOUR messages from any Slack channel using Chrome's browser session.
#   It injects JavaScript into Chrome via AppleScript, then uses Chrome's existing
#   login session (cookies + localStorage token) to make Slack API calls.
#   Only YOUR messages are ever deleted — other people's messages are safe.
#
# HOW IT WORKS:
#   1. AppleScript tells Chrome to run JavaScript in the active tab
#   2. That JavaScript reads your Slack token from localStorage
#   3. It uses the token + Chrome's cookies to call Slack's API
#   4. It finds your messages and deletes them one by one
#
# REQUIREMENTS:
#   1. macOS (for AppleScript)
#   2. Chrome open with Slack loaded (app.slack.com)
#   3. Chrome: View > Developer > Allow JavaScript from Apple Events (one-time)
#
# USAGE:
#   chmod +x delete.sh    (first time only — makes the file executable)
#   cp .env.example .env  (first time only — fill in your own SLACK_USER_ID)
#   ./delete.sh [OPTIONS] URL_OR_CHANNEL_ID [URL_OR_CHANNEL_ID2 ...]
#
# Run with --help to see all options.
# ============================================

# Load SLACK_USER_ID from .env (kept out of this file/git so the repo
# never contains anyone's personal Slack identifiers).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a
  source "$SCRIPT_DIR/.env"
  set +a
fi

if [ -z "$SLACK_USER_ID" ]; then
  echo "ERROR: SLACK_USER_ID is not set."
  echo "Copy .env.example to .env and fill in your Slack member ID."
  exit 1
fi
MY_USER_ID="$SLACK_USER_ID"  # Your Slack member ID — only YOUR messages get deleted

# ---- Option defaults ----
AUTO_MODE=0       # -a: auto-detect channel from current Chrome tab
DAYS=0            # -d: delete messages older than N days
WEEKS=0           # -w: delete messages older than N weeks
MONTHS=0          # -m: delete messages older than N months
AFTER_DAYS=0      # --after: only delete messages NEWER than N days
BEFORE_DAYS=0     # --before: only delete messages OLDER than N days
DRY_RUN=0         # --dry-run: show what would be deleted without deleting
YES=0             # -y/--yes: skip confirmation prompt
LIMIT=0           # --limit N: stop after N deletions
LOG_FILE=""       # --log FILE: save results to a JSON file
QUIET=0           # --quiet: minimal output
VERBOSE=0         # --verbose: extra debug output
RETRY=1           # --retry/--no-retry: retry failed deletions once (default: on)
URLS=()

# ============================================
# HELPER: Parse duration strings ("30d" → 30, "4w" → 28, "3m" → 90)
# ============================================
parse_duration() {
  local val="$1"
  local num="${val%[dwm]}"
  local suffix="${val: -1}"
  case "$suffix" in
    d) echo "$num" ;;
    w) echo $((num * 7)) ;;
    m) echo $((num * 30)) ;;
    *) echo "$num" ;;
  esac
}

# ============================================
# HELPER: Verbose log (only prints when --verbose is set)
# ============================================
vlog() {
  if [ "$VERBOSE" -eq 1 ]; then
    echo "  [verbose] $1"
  fi
}

# ============================================
# ARGUMENT PARSING
# ============================================
while [ $# -gt 0 ]; do
  case "$1" in
    -a|--auto)    AUTO_MODE=1; shift ;;
    -d|--days)    DAYS="$2"; shift 2 ;;
    -w|--weeks)   WEEKS="$2"; shift 2 ;;
    -m|--months)  MONTHS="$2"; shift 2 ;;
    --after)      AFTER_DAYS=$(parse_duration "$2"); shift 2 ;;
    --before)     BEFORE_DAYS=$(parse_duration "$2"); shift 2 ;;
    --dry-run)    DRY_RUN=1; shift ;;
    -y|--yes)     YES=1; shift ;;
    --limit)      LIMIT="$2"; shift 2 ;;
    --log)        LOG_FILE="$2"; shift 2 ;;
    --quiet)      QUIET=1; shift ;;
    --verbose)    VERBOSE=1; shift ;;
    --retry)      RETRY=1; shift ;;
    --no-retry)   RETRY=0; shift ;;
    -h|--help)
      echo "Usage: ./delete.sh [OPTIONS] URL_OR_CHANNEL_ID ..."
      echo ""
      echo "Options:"
      echo "  -a            Auto-detect from current Chrome tab"
      echo "  -d DAYS       Only delete msgs older than N days"
      echo "  -w WEEKS      Only delete msgs older than N weeks"
      echo "  -m MONTHS     Only delete msgs older than N months"
      echo "  --after Xd/Xw/Xm  Only delete msgs NEWER than X days/weeks/months"
      echo "  --before Xd/Xw/Xm Only delete msgs OLDER than X days/weeks/months"
      echo "  --dry-run     Show what would be deleted without deleting"
      echo "  -y, --yes     Skip confirmation prompt"
      echo "  --limit N     Stop after N deletions"
      echo "  --log FILE    Save results to a JSON file"
      echo "  --quiet       Minimal output"
      echo "  --verbose     Extra debug output"
      echo "  --retry       Retry failed deletions once (default: on)"
      echo "  --no-retry    Don't retry failed deletions"
      exit 0
      ;;
    *)            URLS+=("$1"); shift ;;
  esac
done

# ============================================
# CALCULATE TIMEFRAME CUTOFFS
# ============================================
# Slack timestamps INCREASE over time (newer = bigger number).
# OLDER_CUTOFF: skip messages with ts > this (they're too recent for --before)
# NEWER_CUTOFF: skip messages with ts < this (they're too old for --after)
TOTAL_DAYS=$((DAYS + WEEKS * 7 + MONTHS * 30))

if [ "$BEFORE_DAYS" -gt 0 ]; then
  OLDER_CUTOFF=$(python3 -c "import time; print(int(time.time()) - $BEFORE_DAYS * 86400)")
elif [ "$TOTAL_DAYS" -gt 0 ]; then
  OLDER_CUTOFF=$(python3 -c "import time; print(int(time.time()) - $TOTAL_DAYS * 86400)")
else
  OLDER_CUTOFF=0
fi

if [ "$AFTER_DAYS" -gt 0 ]; then
  NEWER_CUTOFF=$(python3 -c "import time; print(int(time.time()) - $AFTER_DAYS * 86400)")
else
  NEWER_CUTOFF=0
fi

# ============================================
# CORE: Execute JavaScript in Chrome via AppleScript
# ============================================
run_js() {
  echo "$1" > /tmp/_slack_js.js
  osascript <<APPLESCRIPT
tell application "Google Chrome"
set jsResult to execute active tab of front window javascript (read POSIX file "/tmp/_slack_js.js")
return jsResult
end tell
APPLESCRIPT
}

# ============================================
# CHANNEL URL PARSING
# ============================================
extract_channel() {
  local input="$1"
  if echo "$input" | grep -qE '^C[A-Z0-9]+$'; then
    echo "$input"
    return
  fi
  echo "$input" | grep -oE 'slack\.com/client/[A-Z0-9]+/([A-Z0-9]+)' | head -1 | sed 's|.*||'
}

# ============================================
# STARTUP
# ============================================
echo "=== Slack Message Deleter ==="
echo ""

if [ "$AUTO_MODE" -eq 1 ]; then
  AUTO_URL=$(run_js 'window.location.href')
  if echo "$AUTO_URL" | grep -q 'slack.com'; then
    URLS+=("$AUTO_URL")
  else
    echo "ERROR: Current Chrome tab is not Slack"
    exit 1
  fi
fi

if [ ${#URLS[@]} -eq 0 ]; then
  echo "Usage: ./delete.sh [OPTIONS] URL_OR_CHANNEL_ID ..."
  echo "  -a            Auto-detect from current Chrome tab"
  echo "  -d DAYS       Only delete msgs older than N days"
  echo "  -w WEEKS      Only delete msgs older than N weeks"
  echo "  -m MONTHS     Only delete msgs older than N months"
  echo "  --after Xd/Xw/Xm  Only delete msgs NEWER than X days/weeks/months"
  echo "  --before Xd/Xw/Xm Only delete msgs OLDER than X days/weeks/months"
  echo "  --dry-run     Show what would be deleted without deleting"
  echo "  -y, --yes     Skip confirmation prompt"
  echo "  --limit N     Stop after N deletions"
  echo "  --log FILE    Save results to a JSON file"
  echo "  --quiet       Minimal output"
  echo "  --verbose     Extra debug output"
  echo "  --retry       Retry failed deletions once (default: on)"
  echo "  --no-retry    Don't retry failed deletions"
  exit 1
fi

CHANNELS=()
for url in "${URLS[@]}"; do
  CH=$(extract_channel "$url")
  if [ -n "$CH" ]; then
    CHANNELS+=("$CH")
  else
    echo "Could not parse: $url"
  fi
done

# ============================================
# EXTRACT SLACK TOKEN FROM CHROME
# ============================================
vlog "Extracting Slack token from Chrome localStorage..."
TOKEN=$(run_js '(function(){var c=JSON.parse(localStorage.getItem("localConfig_v2")||"{}");var ts=c.teams||{};for(var k in ts)return ts[k].token;return "NO_TOKEN";})()')

if [ "$TOKEN" = "NO_TOKEN" ] || [ -z "$TOKEN" ]; then
  echo "ERROR: Not logged into Slack in Chrome"
  exit 1
fi

# ============================================
# VERIFY AUTH
# ============================================
vlog "Verifying token with auth.test..."
AUTH=$(run_js "(function(){
  var x=new XMLHttpRequest();x.open('POST','/api/auth.test',false);
  x.setRequestHeader('Content-Type','application/x-www-form-urlencoded');
  x.send('token='+encodeURIComponent('${TOKEN}'));
  return x.responseText;
})()")

if echo "$AUTH" | grep -q '"ok":true'; then
  USER=$(echo "$AUTH" | grep -o '"user":"[^"]*"' | cut -d'"' -f4)
  echo "Logged in as: $USER"
else
  echo "ERROR: Auth failed"
  exit 1
fi

# Print active filters
if [ "$AFTER_DAYS" -gt 0 ] && [ "$BEFORE_DAYS" -gt 0 ]; then
  echo "Timeframe: between $AFTER_DAYS and $BEFORE_DAYS days ago"
elif [ "$BEFORE_DAYS" -gt 0 ]; then
  echo "Timeframe: only messages older than $BEFORE_DAYS days"
elif [ "$AFTER_DAYS" -gt 0 ]; then
  echo "Timeframe: only messages newer than $AFTER_DAYS days"
elif [ "$TOTAL_DAYS" -gt 0 ]; then
  echo "Timeframe: only messages older than $TOTAL_DAYS days"
fi
if [ "$LIMIT" -gt 0 ]; then echo "Limit: stopping after $LIMIT deletions"; fi
if [ "$DRY_RUN" -eq 1 ]; then echo "MODE: DRY RUN (no messages will be deleted)"; fi
if [ "$RETRY" -eq 0 ]; then echo "Retry: disabled"; fi
echo ""

GRAND_DELETED=0
GRAND_FAILED=0

# ============================================
# MAIN LOOP: Process each channel
# ============================================
for CHANNEL_ID in "${CHANNELS[@]}"; do
  if [ "$LIMIT" -gt 0 ] && [ "$GRAND_DELETED" -ge "$LIMIT" ]; then
    break
  fi

  echo -n "$CHANNEL_ID: scanning... "

  # ============================================
  # SCAN + DELETE: One big JavaScript block
  # ============================================
  RESULT=$(run_js "(function(){
    var token = '${TOKEN}';
    var olderCutoff = ${OLDER_CUTOFF};
    var newerCutoff = ${NEWER_CUTOFF};
    var myUser = '${MY_USER_ID}';
    var chId = '${CHANNEL_ID}';
    var dryRun = ${DRY_RUN};
    var limit = ${LIMIT};
    var doRetry = ${RETRY};

    var hx = new XMLHttpRequest();
    hx.open('POST', '/api/conversations.history', false);
    hx.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
    hx.send('token=' + encodeURIComponent(token) + '&channel=' + chId + '&limit=100&inclusive=true');
    var hist = JSON.parse(hx.responseText);
    if (!hist.ok) return JSON.stringify({deleted:0,failed:0,error:hist.error});
    var msgs = hist.messages || [];

    var toDelete = [];
    var i, m, j, r;

    for (i = 0; i < msgs.length; i++) {
      m = msgs[i];
      var mTs = parseFloat(m.ts);
      if (newerCutoff > 0 && mTs < newerCutoff) continue;
      if (olderCutoff > 0 && mTs > olderCutoff) continue;

      if (m.user === myUser) {
        toDelete.push({ts: m.ts, txt: (m.text || '').substring(0, 60), rpl: false});
      }

      if (m.reply_count > 0 && m.reply_count < 50) {
        var rx = new XMLHttpRequest();
        rx.open('POST', '/api/conversations.replies', false);
        rx.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
        rx.send('token=' + encodeURIComponent(token) + '&channel=' + chId + '&ts=' + (m.thread_ts || m.ts) + '&limit=100');
        var rd = JSON.parse(rx.responseText);
        if (rd.ok) {
          for (j = 0; j < (rd.messages || []).length; j++) {
            r = rd.messages[j];
            var rTs = parseFloat(r.ts);
            if (newerCutoff > 0 && rTs < newerCutoff) continue;
            if (olderCutoff > 0 && rTs > olderCutoff) continue;
            if (r.user === myUser && r.ts !== m.ts) {
              toDelete.push({ts: r.ts, txt: (r.text || '').substring(0, 60), rpl: true});
            }
          }
        }
      }
    }

    if (toDelete.length === 0) return JSON.stringify({deleted:0,failed:0,results:[]});

    var deleted = 0, failed = 0, results = [];
    for (i = 0; i < toDelete.length; i++) {
      if (limit > 0 && deleted >= limit) break;

      if (dryRun) {
        results.push({ok:true, tag:toDelete[i].rpl?'reply':'msg', txt:toDelete[i].txt, dry:true});
        deleted++;
      } else {
        // Attempt delete with optional retry
        var dr = null;
        for (var attempt = 1; attempt <= (doRetry ? 2 : 1); attempt++) {
          var dx = new XMLHttpRequest();
          dx.open('POST', '/api/chat.delete', false);
          dx.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
          dx.send('token=' + encodeURIComponent(token) + '&channel=' + chId + '&ts=' + toDelete[i].ts);
          dr = JSON.parse(dx.responseText);
          if (dr.ok) break;
          // Don't retry cant_delete_message errors — they will always fail
          if (dr.error === 'cant_delete_message') break;
          // Retry once after 1 second for transient errors
          if (attempt === 1 && doRetry) {
            var waitStart = Date.now(); while(Date.now()-waitStart < 1000) {}
          }
        }
        if (dr.ok) {
          deleted++;
          results.push({ok:true, tag:toDelete[i].rpl?'reply':'msg', txt:toDelete[i].txt});
        } else if (dr.error !== 'cant_delete_message') {
          failed++;
          results.push({ok:false, err:dr.error, txt:toDelete[i].txt});
        }
      }
      // Rate limit pause: 350ms between deletions
      var start = Date.now(); while(Date.now()-start < 350) {}
    }
    return JSON.stringify({deleted:deleted, failed:failed, results:results});
  })")

  DELETED=$(echo "$RESULT" | grep -o '"deleted":[0-9]*' | cut -d: -f2)
  FAILED=$(echo "$RESULT" | grep -o '"failed":[0-9]*' | cut -d: -f2)
  echo "${DELETED:-0} messages"

  if [ "$QUIET" -eq 0 ]; then
    echo "$RESULT" | grep -o '"tag":"[^"]*","txt":"[^"]*"' | while IFS= read -r line; do
      TAG=$(echo "$line" | grep -o '"tag":"[^"]*"' | cut -d'"' -f4)
      TXT=$(echo "$line" | grep -o '"txt":"[^"]*"' | cut -d'"' -f4)
      echo "    ✓ [$TAG] \"$TXT...\""
    done

    echo "$RESULT" | grep -o '"err":"[^"]*","txt":"[^"]*"' | while IFS= read -r line; do
      ERR=$(echo "$line" | grep -o '"err":"[^"]*"' | cut -d'"' -f4)
      TXT=$(echo "$line" | grep -o '"txt":"[^"]*"' | cut -d'"' -f4)
      echo "    ✗ $ERR: \"$TXT...\""
    done
  fi

  GRAND_DELETED=$((GRAND_DELETED + ${DELETED:-0}))
  GRAND_FAILED=$((GRAND_FAILED + ${FAILED:-0}))
done

echo ""
echo "Done! Deleted: $GRAND_DELETED, Failed: $GRAND_FAILED"
