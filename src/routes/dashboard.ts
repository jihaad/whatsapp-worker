import { Router } from 'express';

const router = Router();

/**
 * Operator dashboard. Public HTML (no secrets baked in). Prompts for the
 * worker secret on first load, stashes it in sessionStorage, and uses
 * fetch-based SSE so X-Worker-Secret rides on the /events stream.
 *
 * Layout priority: outgoing messages are the centerpiece. Sessions and
 * session-lifecycle events are secondary, in a compact sidebar.
 * Phone numbers are masked to last-4 by default; the reveal toggle shows
 * them for ops debugging.
 */
router.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(HTML);
});

export default router;

const HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>WhatsApp Worker — dashboard</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<script src="https://cdn.tailwindcss.com"></script>
<style>
  :root {
    --bg-base:    #0a0a0a;
    --bg-card:    #131313;
    --bg-elev:    #1a1a1a;
    --border-1:   rgba(255,255,255,0.06);
    --border-2:   rgba(255,255,255,0.10);
  }
  html, body { background: var(--bg-base); }
  body {
    color: #ededed;
    font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', sans-serif;
    font-feature-settings: 'cv11', 'ss01', 'tnum';
  }
  .surface { background: var(--bg-card); border: 1px solid var(--border-1); }
  .surface-elev { background: var(--bg-elev); border: 1px solid var(--border-2); }
  .hairline { border-color: var(--border-1); }
  .num { font-variant-numeric: tabular-nums; letter-spacing: -0.02em; }
  .mono { font-family: ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, monospace; }

  /* Subtle radial accent at top */
  .stage::before {
    content: ''; position: fixed; inset: 0 0 auto 0; height: 240px; pointer-events: none;
    background: radial-gradient(ellipse 50% 100% at 50% 0%, rgba(16,185,129,0.05), transparent 60%);
  }

  /* Hero stat cards */
  .stat {
    background: linear-gradient(180deg, rgba(255,255,255,0.025), transparent 60%), var(--bg-card);
    border: 1px solid var(--border-1);
    transition: border-color 0.18s ease, transform 0.18s ease;
  }
  .stat:hover { border-color: var(--border-2); }

  /* Segmented filter pill bar */
  .seg { background: var(--bg-card); border: 1px solid var(--border-1); }
  .seg-btn {
    transition: background 0.15s ease, color 0.15s ease;
    color: #a3a3a3;
  }
  .seg-btn:hover:not(.is-active) { color: #ededed; background: rgba(255,255,255,0.04); }
  .seg-btn.is-active { color: #ededed; background: var(--bg-elev); box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset; }
  .seg-btn .count {
    font-variant-numeric: tabular-nums;
    background: rgba(255,255,255,0.06); color: #a3a3a3;
    padding: 1px 7px; border-radius: 999px; font-size: 11px; margin-left: 8px;
  }
  .seg-btn.is-active .count { background: rgba(255,255,255,0.10); color: #ededed; }
  .seg-btn[data-filter="sent"].is-active   { color: #34d399; }
  .seg-btn[data-filter="failed"].is-active { color: #fb7185; }
  .seg-btn[data-filter="bulk"].is-active   { color: #fbbf24; }

  /* Event rows */
  .row { animation: row-in 0.28s ease-out; }
  @keyframes row-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
  .replay { opacity: 0.55; }
  .row:hover { background: rgba(255,255,255,0.025); }

  /* Avatar bubble per event */
  .bubble {
    width: 36px; height: 36px; border-radius: 999px;
    display: flex; align-items: center; justify-content: center;
    font-size: 14px; font-weight: 600;
    flex-shrink: 0;
  }
  .bubble-sent   { background: rgba(16,185,129,0.12);  color: #34d399; border: 1px solid rgba(16,185,129,0.20); }
  .bubble-failed { background: rgba(244,63,94,0.12);   color: #fb7185; border: 1px solid rgba(244,63,94,0.22); }
  .bubble-bulk   { background: rgba(245,158,11,0.12);  color: #fbbf24; border: 1px solid rgba(245,158,11,0.22); }

  /* Connection pulse */
  .pulse { animation: pulse-dot 2s ease-in-out infinite; }
  @keyframes pulse-dot {
    0%, 100% { box-shadow: 0 0 0 0 rgba(16,185,129,0.6); }
    50%      { box-shadow: 0 0 0 6px rgba(16,185,129,0); }
  }

  .copy-flash { animation: copy-flash 0.6s ease-out; }
  @keyframes copy-flash { 0% { background: rgba(34,197,94,0.18); } 100% { background: transparent; } }

  /* Scrollbar polish */
  ::-webkit-scrollbar { width: 8px; height: 8px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 4px; }
  ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.16); }

  /* Status pill */
  .status-pill {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 4px 10px; border-radius: 999px; font-size: 12px;
    background: var(--bg-card); border: 1px solid var(--border-1);
  }
  .dot { width: 8px; height: 8px; border-radius: 999px; }
</style>
</head>
<body class="stage min-h-screen">

<!-- Auth modal -->
<div id="auth-modal" class="hidden fixed inset-0 z-50 flex items-center justify-center p-4" style="background: rgba(0,0,0,0.85); backdrop-filter: blur(8px);">
  <form id="auth-form" class="surface-elev rounded-2xl p-7 w-full max-w-md shadow-2xl">
    <h2 class="text-xl font-semibold mb-1">Worker secret</h2>
    <p class="text-sm text-neutral-400 mb-5">Paste your <code class="mono text-neutral-200 bg-neutral-900 px-1.5 py-0.5 rounded">WHATSAPP_WORKER_SECRET</code>. Stored in sessionStorage only.</p>
    <input id="auth-input" type="password" autocomplete="off" autofocus
           class="w-full bg-neutral-950 border border-neutral-800 rounded-lg px-4 py-3 text-sm mono focus:outline-none focus:border-emerald-500/60 transition-colors" />
    <button type="submit" class="mt-4 w-full bg-emerald-500 hover:bg-emerald-400 text-neutral-950 rounded-lg py-3 text-sm font-semibold transition-colors">
      Connect
    </button>
  </form>
</div>

<!-- ===== Header ===== -->
<header class="relative z-10 px-6 py-4 flex items-center gap-4 hairline border-b">
  <div class="flex items-center gap-3">
    <div class="w-8 h-8 rounded-lg bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-400 font-semibold">W</div>
    <h1 class="text-base font-semibold tracking-tight">WhatsApp Worker</h1>
  </div>

  <div id="status" class="status-pill text-neutral-400">
    <span class="dot bg-neutral-500"></span>
    <span>disconnected</span>
  </div>

  <div class="ml-auto flex items-center gap-4 text-sm text-neutral-400">
    <label class="flex items-center gap-2 cursor-pointer select-none hover:text-neutral-200 transition-colors">
      <input id="reveal" type="checkbox" class="accent-amber-500" />
      <span>show numbers</span>
    </label>
    <button id="clear-feed" class="hover:text-neutral-200 transition-colors">Clear</button>
    <button id="logout" class="hover:text-neutral-200 transition-colors">Forget secret</button>
  </div>
</header>

<!-- ===== Stat strip ===== -->
<section class="px-6 py-5 relative z-10">
  <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
    <div class="stat rounded-xl p-5">
      <div class="text-xs uppercase tracking-[0.14em] text-neutral-500 mb-2.5">Sent</div>
      <div id="m-sent" class="num text-4xl font-semibold text-emerald-400">0</div>
      <div class="mt-2 flex items-center gap-1.5 text-[11px] text-neutral-500">
        <span class="dot bg-emerald-500/60"></span> delivered to WhatsApp
      </div>
    </div>
    <div class="stat rounded-xl p-5">
      <div class="text-xs uppercase tracking-[0.14em] text-neutral-500 mb-2.5">Failed</div>
      <div id="m-failed" class="num text-4xl font-semibold text-rose-400">0</div>
      <div class="mt-2 flex items-center gap-1.5 text-[11px] text-neutral-500">
        <span class="dot bg-rose-500/60"></span> upstream + rate-limit
      </div>
    </div>
    <div class="stat rounded-xl p-5">
      <div class="text-xs uppercase tracking-[0.14em] text-neutral-500 mb-2.5">Success rate</div>
      <div id="m-rate" class="num text-4xl font-semibold text-neutral-200">—</div>
      <div class="mt-2 flex items-center gap-1.5 text-[11px] text-neutral-500">
        sent / (sent + failed)
      </div>
    </div>
    <div class="stat rounded-xl p-5">
      <div class="text-xs uppercase tracking-[0.14em] text-neutral-500 mb-2.5">Throughput</div>
      <div class="flex items-baseline gap-2">
        <div id="m-throughput" class="num text-4xl font-semibold text-sky-400">0</div>
        <div class="text-xs text-neutral-500">msgs / min</div>
      </div>
      <div class="mt-2 flex items-center gap-1.5 text-[11px] text-neutral-500">
        rolling 60s window
      </div>
    </div>
  </div>
</section>

<!-- ===== Main grid ===== -->
<main class="px-6 pb-6 grid grid-cols-1 lg:grid-cols-7 gap-4 relative z-10" style="min-height: calc(100vh - 280px)">

  <!-- Messages -->
  <section class="lg:col-span-5 surface rounded-xl flex flex-col overflow-hidden" style="max-height: calc(100vh - 280px)">
    <!-- Filter tab bar (big) -->
    <div class="p-4 hairline border-b flex items-center flex-wrap gap-3">
      <div class="seg rounded-xl p-1 flex gap-1">
        <button data-filter="all"    class="seg-btn is-active px-5 py-2.5 rounded-lg text-sm font-medium">All     <span class="count" id="cnt-all">0</span></button>
        <button data-filter="sent"   class="seg-btn px-5 py-2.5 rounded-lg text-sm font-medium">Sent    <span class="count" id="cnt-sent">0</span></button>
        <button data-filter="failed" class="seg-btn px-5 py-2.5 rounded-lg text-sm font-medium">Failed  <span class="count" id="cnt-failed">0</span></button>
        <button data-filter="bulk"   class="seg-btn px-5 py-2.5 rounded-lg text-sm font-medium">Bulk    <span class="count" id="cnt-bulk">0</span></button>
      </div>
      <span id="feed-count" class="ml-auto text-xs text-neutral-500 num">0 events</span>
    </div>

    <div id="messages" class="flex-1 overflow-auto"></div>
    <div id="messages-empty" class="hidden flex-1 flex flex-col items-center justify-center text-center px-6 py-12">
      <div class="w-14 h-14 rounded-2xl bg-neutral-900 border border-neutral-800 flex items-center justify-center text-2xl mb-4">💬</div>
      <div class="text-neutral-300 font-medium mb-1">No messages yet</div>
      <div class="text-sm text-neutral-500">Send a message and it will appear here in real time.</div>
    </div>
  </section>

  <!-- Sidebar -->
  <aside class="lg:col-span-2 flex flex-col gap-4" style="max-height: calc(100vh - 280px)">
    <!-- Sessions card -->
    <div class="surface rounded-xl flex flex-col overflow-hidden flex-1 min-h-[200px]">
      <div class="px-4 py-3 hairline border-b flex items-center justify-between">
        <div class="text-xs uppercase tracking-[0.14em] text-neutral-500 font-medium">Sessions</div>
        <span id="sessions-count" class="text-xs text-neutral-500 num bg-neutral-900 px-2 py-0.5 rounded-full">0</span>
      </div>
      <div id="sessions" class="overflow-auto p-3 space-y-2 text-xs"></div>
    </div>

    <!-- System events card -->
    <div class="surface rounded-xl flex flex-col overflow-hidden flex-1 min-h-[200px]">
      <div class="px-4 py-3 hairline border-b text-xs uppercase tracking-[0.14em] text-neutral-500 font-medium">
        System events
      </div>
      <div id="system" class="flex-1 overflow-auto p-3 space-y-1.5 mono text-[11px]"></div>
    </div>
  </aside>
</main>

<script>
const $ = (id) => document.getElementById(id);
const MAX_FEED = 500;
const POLL_INTERVAL_MS = 5000;
const THROUGHPUT_WINDOW_MS = 60_000;

let secret = sessionStorage.getItem('worker-secret') || '';
let reveal = false;
let currentFilter = 'all';
const counters = { sent: 0, failed: 0 };
const recentSendTimestamps = [];
const allMessages = [];

const LOCAL_CACHE_KEY = 'worker-dashboard-messages';
const LOCAL_CACHE_LIMIT = 500;
function loadCache() {
  try { const raw = localStorage.getItem(LOCAL_CACHE_KEY); if (!raw) return [];
    const arr = JSON.parse(raw); return Array.isArray(arr) ? arr : []; } catch { return []; }
}
function saveCache() {
  try { localStorage.setItem(LOCAL_CACHE_KEY, JSON.stringify(allMessages.slice(0, LOCAL_CACHE_LIMIT))); } catch {}
}
function eventKey(ev) {
  const d = ev.data || {};
  return ev.ts + '|' + ev.type + '|' + (d.sessionId ?? '') + '|' + (d.recipient ?? '') + '|' + (d.batchId ?? '') + '|' + (d.messageId ?? '');
}

// ---------- helpers ----------

function setStatus(text, dotCls, pillExtra) {
  $('status').innerHTML = '<span class="dot ' + dotCls + '"></span><span>' + text + '</span>';
  $('status').className = 'status-pill ' + (pillExtra || '');
}

function maskPhone(p) {
  if (!p) return '';
  if (reveal) return p;
  const digits = String(p).replace(/\\D/g, '');
  if (digits.length <= 4) return digits;
  return '••• ' + digits.slice(-4);
}

function shortId(id, n = 8) {
  if (!id) return '';
  return String(id).slice(0, n);
}

function timeStr(ts) {
  return new Date(ts).toLocaleTimeString();
}

async function copyToClipboard(text, el) {
  try {
    await navigator.clipboard.writeText(text);
    if (el) { el.classList.add('copy-flash'); setTimeout(() => el.classList.remove('copy-flash'), 600); }
  } catch {}
}

function updateCounters() {
  $('m-sent').textContent = counters.sent;
  $('m-failed').textContent = counters.failed;
  const total = counters.sent + counters.failed;
  $('m-rate').textContent = total === 0 ? '—' : Math.round((counters.sent / total) * 100) + '%';
  const cutoff = Date.now() - THROUGHPUT_WINDOW_MS;
  while (recentSendTimestamps.length && recentSendTimestamps[0] < cutoff) recentSendTimestamps.shift();
  $('m-throughput').textContent = recentSendTimestamps.length;
  updateFilterCounts();
}
setInterval(updateCounters, 5000);

function updateFilterCounts() {
  const all = allMessages.length;
  let sent = 0, failed = 0, bulk = 0;
  for (const ev of allMessages) {
    if (ev.type === 'message.sent') sent++;
    else if (ev.type === 'message.failed') failed++;
    else if (ev.type.startsWith('bulk.')) bulk++;
  }
  $('cnt-all').textContent = all;
  $('cnt-sent').textContent = sent;
  $('cnt-failed').textContent = failed;
  $('cnt-bulk').textContent = bulk;
}

// ---------- message rendering ----------

function eventMatchesFilter(ev) {
  if (currentFilter === 'all') return true;
  if (currentFilter === 'sent')   return ev.type === 'message.sent';
  if (currentFilter === 'failed') return ev.type === 'message.failed';
  if (currentFilter === 'bulk')   return ev.type.startsWith('bulk.');
  return true;
}

function renderMessageRow(ev) {
  const row = document.createElement('div');
  row.className = 'row px-5 py-4 hairline border-b transition-colors' + (ev.replay ? ' replay' : '');

  const d = ev.data || {};
  const isSent   = ev.type === 'message.sent';
  const isFailed = ev.type === 'message.failed';
  const isBulkS  = ev.type === 'bulk.started';
  const isBulkC  = ev.type === 'bulk.completed';

  const bubbleCls =
    isSent   ? 'bubble-sent'   :
    isFailed ? 'bubble-failed' :
                'bubble-bulk';
  const bubbleIcon =
    isSent   ? '✓' :
    isFailed ? '✗' :
    isBulkS  ? '▶' : '✓';

  const statusLabel =
    isSent   ? '<span class="text-emerald-400">Sent</span>' :
    isFailed ? '<span class="text-rose-400">Failed</span>' :
    isBulkS  ? '<span class="text-amber-400">Bulk started</span>' :
    isBulkC  ? '<span class="text-amber-300">Bulk done</span>' :
    '<span class="text-neutral-400">' + ev.type + '</span>';

  // Primary line (the headline of the row)
  let headline = '';
  if (isSent || isFailed) {
    headline = '<span class="text-neutral-100 mono text-[15px]">' + maskPhone(d.recipient) + '</span>';
  } else if (isBulkS) {
    headline = '<span class="text-neutral-100 text-[15px]">' + d.total + ' messages queued</span>';
  } else if (isBulkC) {
    const total = Number(d.total ?? 0); const ok = Number(d.succeeded ?? 0); const bad = Number(d.failed ?? 0);
    headline = '<span class="text-neutral-100 text-[15px]">' + ok + ' of ' + total + ' sent</span>'
      + (bad > 0 ? ' <span class="text-rose-400">· ' + bad + ' failed</span>' : '');
  }

  // Meta chips (session id, batch id, message id, error reason)
  const chips = [];
  if (d.sessionId)             chips.push('<span class="meta-chip text-sky-300/90 hover:text-sky-300" data-copy="' + d.sessionId + '" title="' + d.sessionId + ' — click to copy">session ' + shortId(d.sessionId) + '</span>');
  if (d.batchId)               chips.push('<span class="meta-chip text-amber-300/90 hover:text-amber-300" data-copy="' + d.batchId + '" title="' + d.batchId + ' — click to copy">batch ' + shortId(d.batchId) + '</span>');
  if (isSent && d.messageId)   chips.push('<span class="meta-chip text-neutral-400 hover:text-neutral-200" data-copy="' + d.messageId + '" title="' + d.messageId + ' — click to copy">msg ' + shortId(d.messageId, 12) + '</span>');
  if (isFailed && d.reason)    chips.push('<span class="text-rose-300/80 text-[11px]">' + d.reason + '</span>');

  row.innerHTML =
    '<div class="flex items-start gap-4">' +
    '  <div class="bubble ' + bubbleCls + '">' + bubbleIcon + '</div>' +
    '  <div class="flex-1 min-w-0">' +
    '    <div class="flex items-baseline gap-3 flex-wrap">' +
    '      <div class="text-xs font-semibold uppercase tracking-wide">' + statusLabel + '</div>' +
    '      <div class="flex-1 truncate min-w-0">' + headline + '</div>' +
    '      <div class="text-[11px] text-neutral-500 num shrink-0">' + timeStr(ev.ts) + '</div>' +
    '    </div>' +
    (chips.length ? '    <div class="mt-2 flex flex-wrap gap-2 text-[11px] mono">' + chips.join('') + '</div>' : '') +
    '  </div>' +
    '</div>';

  // Styling for meta chips (rendered through innerHTML, attach event listeners now)
  for (const el of row.querySelectorAll('.meta-chip')) {
    el.style.cursor = 'pointer';
    el.style.background = 'rgba(255,255,255,0.04)';
    el.style.padding = '2px 8px';
    el.style.borderRadius = '999px';
    el.style.transition = 'background 0.15s ease, color 0.15s ease';
    el.addEventListener('mouseenter', () => { el.style.background = 'rgba(255,255,255,0.08)'; });
    el.addEventListener('mouseleave', () => { el.style.background = 'rgba(255,255,255,0.04)'; });
    el.addEventListener('click', () => copyToClipboard(el.dataset.copy, el));
  }
  return row;
}

function appendMessage(ev) {
  allMessages.unshift(ev);
  while (allMessages.length > MAX_FEED) allMessages.pop();
  if (!eventMatchesFilter(ev)) { updateFeedCount(); updateFilterCounts(); return; }
  const row = renderMessageRow(ev);
  const feed = $('messages');
  feed.prepend(row);
  while (feed.children.length > MAX_FEED) feed.lastChild.remove();
  $('messages-empty').classList.toggle('hidden', feed.children.length > 0);
  updateFeedCount();
  updateFilterCounts();
}

function rerenderFeed() {
  const feed = $('messages'); feed.innerHTML = '';
  for (const ev of allMessages) {
    if (!eventMatchesFilter(ev)) continue;
    feed.appendChild(renderMessageRow(ev));
  }
  $('messages-empty').classList.toggle('hidden', feed.children.length > 0);
  updateFeedCount();
}

function updateFeedCount() {
  const n = allMessages.filter(eventMatchesFilter).length;
  $('feed-count').textContent = n + (n === 1 ? ' event' : ' events');
}

// ---------- system events (sidebar) ----------

function renderSystemRow(ev) {
  const row = document.createElement('div');
  row.className = 'flex items-baseline gap-2' + (ev.replay ? ' replay' : '');
  const colour =
    ev.type.includes('failed')       ? 'text-rose-400' :
    ev.type.includes('disconnected') ? 'text-rose-400' :
    ev.type.includes('auth_failure') ? 'text-rose-400' :
    ev.type === 'session.ready'      ? 'text-emerald-400' :
    'text-sky-300';
  const d = ev.data || {};
  const detail = d.phoneNumber ? maskPhone(d.phoneNumber) : (d.reason ?? '');
  row.innerHTML =
    '<span class="text-neutral-600 num shrink-0">' + timeStr(ev.ts).slice(0, 8) + '</span>' +
    '<span class="' + colour + ' shrink-0">' + ev.type.replace('session.', '') + '</span>' +
    '<span class="text-neutral-500 truncate">' + (d.sessionId ? shortId(d.sessionId, 8) : '') + (detail ? ' · ' + detail : '') + '</span>';
  return row;
}

function appendSystem(ev) {
  const box = $('system'); box.prepend(renderSystemRow(ev));
  while (box.children.length > 80) box.lastChild.remove();
}

// ---------- sessions panel ----------

let lastSessions = [];
function renderSessions() {
  const box = $('sessions');
  $('sessions-count').textContent = lastSessions.length;
  box.innerHTML = '';
  if (lastSessions.length === 0) {
    box.innerHTML = '<div class="text-neutral-600 italic text-xs text-center py-6">No sessions yet</div>';
    return;
  }
  const statusStyle = {
    ready:        { dot: 'bg-emerald-400', text: 'text-emerald-400' },
    qr_pending:   { dot: 'bg-amber-400',   text: 'text-amber-400' },
    connecting:   { dot: 'bg-sky-400',     text: 'text-sky-400' },
    disconnected: { dot: 'bg-neutral-500', text: 'text-neutral-500' },
  };
  for (const s of lastSessions) {
    const row = document.createElement('div');
    row.className = 'surface-elev rounded-lg p-3 hover:border-neutral-700 transition-colors';
    const st = statusStyle[s.status] ?? statusStyle.disconnected;
    const sid = s.sessionId || '';
    row.innerHTML =
      '<div class="flex items-center justify-between gap-2 mb-2">' +
      '  <div class="flex items-center gap-1.5">' +
      '    <span class="dot ' + st.dot + '"></span>' +
      '    <span class="' + st.text + ' text-[11px] uppercase tracking-wide font-medium">' + s.status + '</span>' +
      '  </div>' +
      '  <span class="text-neutral-500 num text-[11px]">' + maskPhone(s.phoneNumber) + '</span>' +
      '</div>' +
      '<div data-copy="' + sid + '" title="click to copy" class="mono text-[10px] text-neutral-400 break-all leading-tight cursor-pointer hover:text-neutral-200 transition-colors">' + sid + '</div>';
    const idEl = row.querySelector('[data-copy]');
    idEl.addEventListener('click', () => copyToClipboard(idEl.dataset.copy, idEl));
    box.appendChild(row);
  }
}

// ---------- dispatcher ----------

function handleEvent(ev) {
  if (ev.type === 'message.sent') { counters.sent++; if (!ev.replay) recentSendTimestamps.push(Date.now()); appendMessage(ev); }
  else if (ev.type === 'message.failed') { counters.failed++; appendMessage(ev); }
  else if (ev.type === 'bulk.started' || ev.type === 'bulk.completed') { appendMessage(ev); }
  else if (ev.type.startsWith('session.')) { appendSystem(ev); }
  updateCounters();
}

// ---------- fetching ----------

async function refreshSessions() {
  try {
    const r = await fetch('/v1/sessions?limit=200', { headers: { 'X-Worker-Secret': secret } });
    if (!r.ok) { if (r.status === 401) promptForSecret(); return; }
    const body = await r.json();
    lastSessions = body.sessions || [];
    renderSessions();
  } catch (err) { console.warn('refreshSessions:', err); }
}

async function fetchRecent() {
  try {
    const r = await fetch('/events/recent?limit=500', { headers: { 'X-Worker-Secret': secret } });
    if (!r.ok) return [];
    const body = await r.json();
    return Array.isArray(body.events) ? body.events : [];
  } catch { return []; }
}

function mergeAndRender(events) {
  const seen = new Set(allMessages.map(eventKey));
  for (const ev of events) {
    const k = eventKey(ev);
    if (seen.has(k)) continue;
    seen.add(k);
    allMessages.push({ ...ev, replay: true });
    if (ev.type === 'message.sent')   counters.sent++;
    if (ev.type === 'message.failed') counters.failed++;
  }
  allMessages.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  while (allMessages.length > MAX_FEED) allMessages.pop();
  rerenderFeed();
  updateCounters();
}

async function streamEvents() {
  if (!secret) return;
  setStatus('connecting…', 'bg-neutral-500', 'text-neutral-400');

  let response;
  try { response = await fetch('/events', { headers: { 'X-Worker-Secret': secret } }); }
  catch { setStatus('disconnected', 'bg-rose-500', 'text-rose-300'); setTimeout(streamEvents, 3000); return; }

  if (!response.ok) {
    if (response.status === 401) { promptForSecret(); return; }
    setStatus('HTTP ' + response.status, 'bg-rose-500', 'text-rose-300');
    setTimeout(streamEvents, 3000);
    return;
  }

  setStatus('Live', 'bg-emerald-500 pulse', 'text-emerald-400');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\\n\\n');
    buf = parts.pop();
    for (const chunk of parts) {
      const m = chunk.match(/^data: (.+)$/m);
      if (!m) continue;
      try { const ev = JSON.parse(m[1]); if (ev.type === 'connected') continue; handleEvent(ev); } catch {}
    }
  }
  setStatus('disconnected', 'bg-rose-500', 'text-rose-300');
  setTimeout(streamEvents, 1500);
}

// ---------- secret modal ----------

function promptForSecret() {
  $('auth-modal').classList.remove('hidden');
  $('auth-input').focus();
}

$('auth-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('auth-input').value.trim();
  if (!v) return;
  secret = v;
  sessionStorage.setItem('worker-secret', v);
  $('auth-input').value = '';
  $('auth-modal').classList.add('hidden');
  start();
});

$('logout').addEventListener('click', () => {
  sessionStorage.removeItem('worker-secret');
  location.reload();
});

// ---------- UI controls ----------

$('reveal').addEventListener('change', (e) => {
  reveal = e.target.checked;
  rerenderFeed();
  renderSessions();
});

$('clear-feed').addEventListener('click', () => {
  allMessages.length = 0;
  counters.sent = 0; counters.failed = 0;
  recentSendTimestamps.length = 0;
  localStorage.removeItem(LOCAL_CACHE_KEY);
  rerenderFeed();
  updateCounters();
});

for (const btn of document.querySelectorAll('.seg-btn')) {
  btn.addEventListener('click', () => {
    currentFilter = btn.dataset.filter;
    for (const b of document.querySelectorAll('.seg-btn')) b.classList.remove('is-active');
    btn.classList.add('is-active');
    rerenderFeed();
  });
}

async function start() {
  const cached = loadCache();
  if (cached.length) mergeAndRender(cached.map((ev) => ({ ...ev, replay: true })));
  fetchRecent().then((events) => { if (events.length) mergeAndRender(events); saveCache(); });
  refreshSessions();
  setInterval(refreshSessions, POLL_INTERVAL_MS);
  setInterval(saveCache, 5000);
  streamEvents();
}

if (secret) start();
else promptForSecret();
</script>
</body>
</html>`;
