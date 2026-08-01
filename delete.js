// ============================================
// Slack Message Deleter (Node.js version)
// ============================================
// Deletes YOUR messages from any Slack channel using Chrome's browser session.
// Works by injecting JavaScript into Chrome via AppleScript — no tokens stored
// on disk, no browser extensions needed. The token lives in Chrome's localStorage
// and the auth cookies live in Chrome's cookie jar, so both stay safe.
//
// REQUIREMENTS:
//   1. Node.js installed (comes with `brew install node` or Xcode)
//   2. Chrome open with Slack loaded (app.slack.com)
//   3. Chrome: View > Developer > Allow JavaScript from Apple Events (one-time)
//
// USAGE:
//   node delete.js [OPTIONS] URL_OR_CHANNEL_ID [URL_OR_CHANNEL_ID2 ...]
//
// Run with no arguments to see full help.
// ============================================

// ---- Imports ----
const { execSync } = require('child_process');
const fs = require('fs');

// ---- Load .env (kept out of git so no personal Slack IDs are ever committed) ----
try {
  require('fs').readFileSync(require('path').join(__dirname, '.env'), 'utf-8')
    .split('\n')
    .filter(line => line.includes('=') && !line.trim().startsWith('#'))
    .forEach(line => {
      const [key, ...rest] = line.split('=');
      if (!process.env[key.trim()]) process.env[key.trim()] = rest.join('=').trim();
    });
} catch (e) { /* no .env file — fall through to the SLACK_USER_ID check below */ }

// ---- Constants ----
const MY_USER_ID = process.env.SLACK_USER_ID;  // Your Slack member ID — only YOUR messages get deleted
if (!MY_USER_ID) {
  console.error('ERROR: SLACK_USER_ID is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}
const TMP_JS = '/tmp/slack_runner.js';   // Temp file for JS code injected into Chrome
const TMP_AS = '/tmp/slack_runner.scpt'; // Temp file for AppleScript that executes the JS

// ============================================
// CORE: Execute JavaScript in Chrome via AppleScript
// ============================================
// AppleScript tells Chrome to run JS in the active tab. We use this to make
// API calls from Chrome's same-origin context (app.slack.com), so Chrome's
// auth cookies are automatically included — no token theft needed.
//
// Why sync XHR? Slack's JS intercepts async fetch() and adds CSRF protection.
// Sync XHR bypasses that. AppleScript's `execute javascript` only returns
// values from synchronous code — async results come back empty.
function runJS(code) {
  fs.writeFileSync(TMP_JS, code);
  fs.writeFileSync(TMP_AS,
    'tell application "Google Chrome"\n' +
    'set jsResult to execute active tab of front window javascript (read POSIX file "/tmp/slack_runner.js")\n' +
    'return jsResult\n' +
    'end tell'
  );
  return execSync('osascript /tmp/slack_runner.scpt', {
    encoding: 'utf-8',
    timeout: 180000  // 3 minutes — AppleScript kills the command after this
  }).trim();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============================================
// CORE: Slack API wrapper
// ============================================
// Makes POST requests to Slack's API from inside Chrome's context.
// Token is sent as a POST body parameter (`token=`), NOT as a header.
let TOKEN = null;

function api(method, body) {
  const bodyStr = 'token=' + encodeURIComponent(TOKEN) + '&' +
    Object.entries(body)
      .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
      .join('&');
  const js = `(function(){
    var x=new XMLHttpRequest();
    x.open('POST','/api/${method}',false);
    x.setRequestHeader('Content-Type','application/x-www-form-urlencoded');
    x.send('${bodyStr.replace(/'/g, "\\'")}');
    return x.responseText;
  })()`;
  return JSON.parse(runJS(js));
}

// ============================================
// VERBOSE LOGGING HELPER
// ============================================
// When --verbose is set, print detailed info about what the script is doing.
// When --quiet is set, suppress everything except errors.
// Normal mode: print per-message results.
let VERBOSE = false;
let QUIET = false;

function log(msg) { if (VERBOSE) console.log('  [verbose] ' + msg); }
function logDelete(m) {
  if (!QUIET) console.log('    ✓ [' + (m.rpl ? 'reply' : 'msg') + '] "' + m.txt + '..."');
}
function logFail(err, m) {
  console.log('    ✗ ' + err + (m ? ': "' + m.txt + '..."' : ''));
}

// ============================================
// RETRY HELPER
// ============================================
// Attempts an API call up to 2 times (initial + 1 retry).
// Retries on network errors, timeouts, and transient Slack errors.
// Returns the API response or null if all attempts failed.
async function apiWithRetry(method, body) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = api(method, body);
      if (r.ok) return r;
      // Don't retry "message_not_found" or "cant_delete_message" — they won't succeed on retry
      if (r.error === 'message_not_found' || r.error === 'cant_delete_message') return r;
      // Other errors (rate_limited, temporarily_unavailable, etc.) — retry once
      if (attempt === 1) {
        log('Attempt 1 failed (' + r.error + '), retrying in 1s...');
        await sleep(1000);
        continue;
      }
      return r; // Second attempt failed — give up
    } catch (e) {
      // Network/timeout error
      if (attempt === 1) {
        log('Attempt 1 threw (' + e.message.substring(0, 40) + '), retrying in 1s...');
        await sleep(1000);
        continue;
      }
      throw e; // Second attempt failed — let caller handle it
    }
  }
}

// ============================================
// DELETE ONE MESSAGE (with retry + logging)
// ============================================
// Deletes a single message. Handles logging, retries, and limit checking.
// Returns true if deleted, false if skipped/failed.
async function deleteOne(m, opts, logEntries, grandTotal) {
  if (opts.limit > 0 && grandTotal.deleted >= opts.limit) return false;

  try {
    const r = await apiWithRetry('chat.delete', { channel: m.ch, ts: m.ts });
    if (r.ok) {
      grandTotal.deleted++;
      logDelete(m);
      logEntries.push({ channel: m.ch, ts: m.ts, text: m.txt, type: m.rpl ? 'reply' : 'msg', status: 'deleted' });
      return true;
    } else if (r.error !== 'cant_delete_message') {
      grandTotal.failed++;
      logFail(r.error, m);
      logEntries.push({ channel: m.ch, ts: m.ts, text: m.txt, type: m.rpl ? 'reply' : 'msg', status: 'failed', error: r.error });
    }
  } catch (e) {
    grandTotal.failed++;
    logFail(e.message.substring(0, 60), m);
  }
  await sleep(350); // Rate limit: ~3 deletions per second
  return false;
}

// ============================================
// ARGUMENT PARSING
// ============================================
function parseArgs(args) {
  const opts = {
    urls: [],        auto: false,     days: 0,         weeks: 0,
    months: 0,       after: 0,        before: 0,       dryRun: false,
    yes: false,      limit: 0,        logFile: null,   quiet: false,
    verbose: false   // --verbose: extra debug output
  };
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === '-a' || a === '--auto') { opts.auto = true; i++; }
    else if (a === '-d' || a === '--days') { opts.days = parseInt(args[++i]) || 0; i++; }
    else if (a === '-w' || a === '--weeks') { opts.weeks = parseInt(args[++i]) || 0; i++; }
    else if (a === '-m' || a === '--months') { opts.months = parseInt(args[++i]) || 0; i++; }
    else if (a === '--after') { opts.after = parseDuration(args[++i]); i++; }
    else if (a === '--before') { opts.before = parseDuration(args[++i]); i++; }
    else if (a === '--dry-run') { opts.dryRun = true; i++; }
    else if (a === '-y' || a === '--yes') { opts.yes = true; i++; }
    else if (a === '--limit') { opts.limit = parseInt(args[++i]) || 0; i++; }
    else if (a === '--log') { opts.logFile = args[++i]; i++; }
    else if (a === '--quiet') { opts.quiet = true; i++; }
    else if (a === '--verbose') { opts.verbose = true; i++; }
    else { opts.urls.push(a); i++; }
  }
  return opts;
}

function parseDuration(str) {
  if (!str) return 0;
  const num = parseInt(str) || 0;
  if (str.endsWith('d')) return num;
  if (str.endsWith('w')) return num * 7;
  if (str.endsWith('m')) return num * 30;
  return num;
}

// ============================================
// CHANNEL URL PARSING
// ============================================
function extractChannel(urlOrId) {
  if (/^C[A-Z0-9]+$/.test(urlOrId)) return { teamId: null, channelId: urlOrId };
  const match = urlOrId.match(/slack\.com\/client\/([A-Z0-9]+)\/([A-Z0-9]+)/);
  if (match) return { teamId: match[1], channelId: match[2] };
  const match2 = urlOrId.match(/slack\.com\/(?:client\/[^/]+\/|archives\/|channel\/)([A-Z0-9]+)/);
  if (match2) return { teamId: null, channelId: match2[1] };
  console.error('Could not parse: ' + urlOrId);
  return null;
}

function getAutoTabUrl() {
  try { return runJS('window.location.href'); } catch (e) { return null; }
}

function cutoffTimestamp(days) {
  if (days <= 0) return 0;
  return (Date.now() / 1000) - (days * 86400);
}

function parseTimeframe(opts) {
  return opts.days + (opts.weeks * 7) + (opts.months * 30);
}

function buildTimeFilter(opts) {
  const beforeDays = opts.before || (opts.days + opts.weeks * 7 + opts.months * 30);
  return {
    olderThan: cutoffTimestamp(beforeDays),
    newerThan: opts.after > 0 ? cutoffTimestamp(opts.after) : 0
  };
}

// ============================================
// CHANNEL SCANNING: Find all YOUR messages
// ============================================
// Scans a channel's history + thread replies to find every message
// you posted that matches the time filter.
async function processChannel(chId, filter) {
  let toDelete = [];
  let cursor = null;
  let pageCount = 0;

  do {
    const body = { channel: chId, limit: '100', inclusive: 'true' };
    if (cursor) body.cursor = cursor;

    let hist;
    try { hist = api('conversations.history', body); } catch (e) { break; }
    if (!hist.ok) break;
    const msgs = hist.messages || [];
    pageCount++;
    log('Fetched page ' + pageCount + ': ' + msgs.length + ' messages');

    for (const m of msgs) {
      const msgTs = parseFloat(m.ts);
      if (filter.newerThan > 0 && msgTs < filter.newerThan) continue;
      if (filter.olderThan > 0 && msgTs > filter.olderThan) continue;

      if (m.user === MY_USER_ID) {
        toDelete.push({ ch: chId, ts: m.ts, txt: (m.text || '').substring(0, 60), rpl: false });
      }

      // Scan thread replies (skip threads with 50+ replies)
      if (m.reply_count > 0 && m.reply_count < 50) {
        let tc = null;
        do {
          const tp = { channel: chId, ts: m.thread_ts || m.ts, limit: '100' };
          if (tc) tp.cursor = tc;
          let rd;
          try { rd = api('conversations.replies', tp); } catch (e) { tc = null; break; }
          if (rd.ok) {
            for (const r of (rd.messages || [])) {
              const rTs = parseFloat(r.ts);
              if (filter.newerThan > 0 && rTs < filter.newerThan) continue;
              if (filter.olderThan > 0 && rTs > filter.olderThan) continue;
              if (r.user === MY_USER_ID && r.ts !== m.ts && !toDelete.find(d => d.ts === r.ts)) {
                toDelete.push({ ch: chId, ts: r.ts, txt: (r.text || '').substring(0, 60), rpl: true });
              }
            }
            tc = rd.response_metadata && rd.response_metadata.next_cursor || null;
          } else { tc = null; }
        } while (tc);
      }
    }
    cursor = hist.response_metadata && hist.response_metadata.next_cursor || null;
  } while (cursor);

  log('Scan complete: found ' + toDelete.length + ' messages to delete across ' + pageCount + ' pages');
  return toDelete;
}

// ============================================
// HUGE CHANNEL BATCH PROCESSOR
// ============================================
// For channels with 7000+ messages that cause AppleScript timeouts.
// Deletes in batches of 100 — scan a page, delete what we find, repeat.
async function processHugeChannel(chId, filter, opts, logEntries, grandTotal) {
  let toDelete = [];
  let cursor = null;
  let totalScanned = 0;

  do {
    const body = { channel: chId, limit: '100', inclusive: 'true' };
    if (cursor) body.cursor = cursor;

    let hist;
    try { hist = api('conversations.history', body); } catch (e) { break; }
    if (!hist.ok) break;
    const msgs = hist.messages || [];
    totalScanned += msgs.length;
    log('Batch scan: ' + totalScanned + ' scanned so far');

    for (const m of msgs) {
      const msgTs = parseFloat(m.ts);
      if (filter.newerThan > 0 && msgTs < filter.newerThan) continue;
      if (filter.olderThan > 0 && msgTs > filter.olderThan) continue;

      if (m.user === MY_USER_ID) {
        toDelete.push({ ch: chId, ts: m.ts, txt: (m.text || '').substring(0, 60), rpl: false });
      }
      if (m.reply_count > 0 && m.reply_count < 50) {
        let tc = null;
        do {
          const tp = { channel: chId, ts: m.thread_ts || m.ts, limit: '100' };
          if (tc) tp.cursor = tc;
          let rd;
          try { rd = api('conversations.replies', tp); } catch (e) { tc = null; break; }
          if (rd.ok) {
            for (const r of (rd.messages || [])) {
              const rTs = parseFloat(r.ts);
              if (filter.newerThan > 0 && rTs < filter.newerThan) continue;
              if (filter.olderThan > 0 && rTs > filter.olderThan) continue;
              if (r.user === MY_USER_ID && r.ts !== m.ts && !toDelete.find(d => d.ts === r.ts)) {
                toDelete.push({ ch: chId, ts: r.ts, txt: (r.text || '').substring(0, 60), rpl: true });
              }
            }
            tc = rd.response_metadata && rd.response_metadata.next_cursor || null;
          } else { tc = null; }
        } while (tc);
      }
    }

    cursor = hist.response_metadata && hist.response_metadata.next_cursor || null;

    // Batch delete: if we got a full page, delete now and continue
    if (msgs.length === 100 && toDelete.length > 0) {
      for (const m of toDelete) {
        if (opts.limit > 0 && grandTotal.deleted >= opts.limit) break;
        await deleteOne(m, opts, logEntries, grandTotal);
      }
      process.stdout.write('  (' + totalScanned + ' scanned, ' + grandTotal.deleted + ' deleted so far)\n    ');
      toDelete = [];
    }
  } while (cursor);

  // Delete any remaining messages from the last incomplete batch
  for (const m of toDelete) {
    if (opts.limit > 0 && grandTotal.deleted >= opts.limit) break;
    await deleteOne(m, opts, logEntries, grandTotal);
  }
}

// ============================================
// DRY RUN: Show what would be deleted
// ============================================
async function dryRun(channels, filter, logEntries) {
  let totalFound = 0;
  for (const chId of channels) {
    process.stdout.write(chId + ': scanning... ');
    try {
      const toDelete = await processChannel(chId, filter);
      console.log(toDelete.length + ' messages');
      for (const m of toDelete) {
        const prefix = m.rpl ? '[reply]' : '[msg]';
        console.log('    ' + prefix + ' "' + m.txt + '..."');
        totalFound++;
        if (logEntries) logEntries.push({ channel: chId, ts: m.ts, text: m.txt, type: m.rpl ? 'reply' : 'msg' });
      }
    } catch (e) {
      try {
        console.log('(huge channel, counting in batches)');
        const tempGrand = { deleted: 0, failed: 0 };
        const toDelete = await processHugeChannel(chId, filter, { limit: 0 }, [], tempGrand);
        totalFound += toDelete.length;
        if (logEntries) toDelete.forEach(m => logEntries.push({ channel: chId, ts: m.ts, text: m.txt, type: m.rpl ? 'reply' : 'msg' }));
      } catch (e2) {
        console.log('ERROR: ' + e2.message.substring(0, 60));
      }
    }
  }
  console.log('\nWould delete: ' + totalFound + ' messages');
  return totalFound;
}

// ============================================
// MAIN
// ============================================
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  VERBOSE = opts.verbose;
  QUIET = opts.quiet;
  const filter = buildTimeFilter(opts);

  // Handle -a flag
  if (opts.auto) {
    try {
      const url = getAutoTabUrl();
      if (url && url.includes('slack.com')) { opts.urls.push(url); }
      else { console.error('Current Chrome tab is not Slack.'); process.exit(1); }
    } catch (e) {
      console.error('Cannot read Chrome tab. Is Chrome open with Slack?');
      process.exit(1);
    }
  }

  // Show help
  if (opts.urls.length === 0) {
    console.log('Usage: node delete.js [OPTIONS] URL_OR_CHANNEL_ID [URL_OR_CHANNEL_ID2] ...');
    console.log('');
    console.log('Options:');
    console.log('  -a, --auto        Auto-detect channel from current Chrome tab');
    console.log('  -d, --days N      Only delete messages older than N days');
    console.log('  -w, --weeks N     Only delete messages older than N weeks');
    console.log('  -m, --months N    Only delete messages older than N months');
    console.log('  --after Xd/Xw/Xm  Only delete messages NEWER than X days/weeks/months');
    console.log('  --before Xd/Xw/Xm Only delete messages OLDER than X days/weeks/months');
    console.log('  --dry-run         Show what would be deleted without deleting');
    console.log('  -y, --yes         Skip confirmation prompt');
    console.log('  --limit N         Stop after N deletions');
    console.log('  --log FILE        Save results to a log file');
    console.log('  --quiet           Minimal output');
    console.log('  --verbose         Extra debug output');
    console.log('');
    console.log('Examples:');
    console.log('  node delete.js https://app.slack.com/client/TEAMID/CHANNELID');
    console.log('  node delete.js CHANNELID1 CHANNELID2');
    console.log('  node delete.js -a');
    console.log('  node delete.js -d 30 CHANNELID');
    console.log('  node delete.js --after 6d --before 3m CHANNELID');
    console.log('  node delete.js --dry-run --after 6d --before 3m CHANNELID');
    console.log('  node delete.js --limit 50 -y CHANNELID');
    console.log('  node delete.js --log results.json --after 30d CHANNELID');
    console.log('  node delete.js --verbose --after 30d CHANNELID');
    process.exit(0);
  }

  // Parse URLs
  const channels = [];
  let teamId = null;
  for (const url of opts.urls) {
    const parsed = extractChannel(url);
    if (parsed) { channels.push(parsed.channelId); if (parsed.teamId) teamId = parsed.teamId; }
  }
  if (channels.length === 0) { console.error('No valid channels found.'); process.exit(1); }

  // Extract token
  log('Extracting Slack token from Chrome localStorage...');
  TOKEN = runJS(
    '(function(){var c=JSON.parse(localStorage.getItem("localConfig_v2")||"{}");var ts=c.teams||{};for(var k in ts){if(!teamId||k===teamId)return ts[k].token;}return "NO_TOKEN";})()'
      .replace('teamId', teamId ? `'${teamId}'` : 'null')
  );
  if (!TOKEN || TOKEN === 'NO_TOKEN') { console.error('Not logged into Slack in Chrome.'); process.exit(1); }

  // Verify auth
  log('Verifying token with auth.test...');
  const auth = api('auth.test', {});
  if (!auth.ok) { console.error('Auth failed:', auth.error); process.exit(1); }
  console.log('Logged in as: ' + auth.user);

  // Print filters
  if (opts.after > 0 && opts.before > 0) console.log('Timeframe: between ' + opts.after + ' and ' + opts.before + ' days ago');
  else if (opts.before > 0) console.log('Timeframe: only messages older than ' + opts.before + ' days');
  else if (opts.after > 0) console.log('Timeframe: only messages newer than ' + opts.after + ' days');
  else if (parseTimeframe(opts) > 0) console.log('Timeframe: only messages older than ' + parseTimeframe(opts) + ' days');
  if (opts.limit > 0) console.log('Limit: stopping after ' + opts.limit + ' deletions');
  if (opts.dryRun) console.log('MODE: DRY RUN (no messages will be deleted)');
  console.log('');

  let logEntries = [];

  // Dry run
  if (opts.dryRun) {
    await dryRun(channels, filter, logEntries);
    if (opts.logFile && logEntries.length > 0) {
      fs.writeFileSync(opts.logFile, JSON.stringify(logEntries, null, 2));
      console.log('Results saved to: ' + opts.logFile);
    }
    return;
  }

  // Confirm
  if (!opts.yes) {
    let totalFound = 0;
    for (const chId of channels) {
      try { const td = await processChannel(chId, filter); totalFound += td.length; } catch (e) { /* skip */ }
    }
    if (totalFound === 0) { console.log('No messages found to delete.'); return; }
    process.stdout.write('\nDelete ' + totalFound + ' messages? (y/N): ');
    const answer = await new Promise(resolve => {
      process.stdin.once('data', data => resolve(data.toString().trim().toLowerCase()));
      setTimeout(() => resolve('n'), 30000);
    });
    if (answer !== 'y' && answer !== 'yes') { console.log('Cancelled.'); return; }
    console.log('');
  }

  // Delete
  let grandTotal = { deleted: 0, failed: 0 };

  for (const chId of channels) {
    if (opts.limit > 0 && grandTotal.deleted >= opts.limit) break;

    process.stdout.write(chId + ': scanning... ');
    try {
      const toDelete = await processChannel(chId, filter);
      console.log(toDelete.length + ' messages');

      for (const m of toDelete) {
        if (opts.limit > 0 && grandTotal.deleted >= opts.limit) {
          console.log('  Limit reached (' + opts.limit + ').');
          break;
        }
        await deleteOne(m, opts, logEntries, grandTotal);
      }
    } catch (e) {
      // Timeout — fall back to batch mode for huge channels
      console.log('TIMEOUT - trying batch mode...');
      try {
        await processHugeChannel(chId, filter, opts, logEntries, grandTotal);
      } catch (e2) {
        console.log('FAILED - ' + e2.message.substring(0, 60));
      }
    }
  }

  console.log('\nGrand total — Deleted: ' + grandTotal.deleted + ', Failed: ' + grandTotal.failed);
  if (opts.logFile) {
    fs.writeFileSync(opts.logFile, JSON.stringify(logEntries, null, 2));
    console.log('Results saved to: ' + opts.logFile);
  }
}

main().catch(console.error);
