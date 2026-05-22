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
<!-- WhatsApp glyph favicon. Inline SVG (data URI) — no external request,
     no licensing fetch. Glyph is the SimpleIcons WhatsApp path (CC0). -->
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><circle cx='12' cy='12' r='12' fill='%2325D366'/><path fill='%23fff' d='M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347M5.96 18.04l.4-.214a7.78 7.78 0 003.97 1.088h.003c4.299 0 7.797-3.498 7.799-7.797a7.74 7.74 0 00-2.282-5.516 7.74 7.74 0 00-5.51-2.286C6.043 3.315 2.546 6.813 2.545 11.112a7.74 7.74 0 001.19 4.146l.185.295-.787 2.877z'/></svg>" />
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

  /* Header action chips — unified pill styling for reveal / clear / forget
     secret. Visually matches the mode-tab seg-btn aesthetic. */
  .action-pill {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 6px 10px; border-radius: 8px; font-size: 12px;
    color: #a3a3a3;
    background: var(--bg-card); border: 1px solid var(--border-1);
    transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
    cursor: pointer; white-space: nowrap;
    /* mobile tappable target: 44px ish */
    min-height: 32px;
  }
  .action-pill:hover { color: #ededed; background: var(--bg-elev); border-color: var(--border-2); }
  .action-pill .action-icon {
    font-size: 11px; line-height: 1;
    width: 14px; text-align: center;
    color: #737373;
    transition: color 0.15s ease;
  }
  .action-pill:hover .action-icon { color: #d4d4d4; }
  .action-pill[data-on="true"] {
    color: #fbbf24;
    background: rgba(245,158,11,0.08);
    border-color: rgba(245,158,11,0.30);
  }
  .action-pill[data-on="true"] .action-icon { color: #fbbf24; }

  /* On very narrow screens (< 640px), action chips collapse to icon-only.
     Mode tabs stay legible because they sit on their own line. */
  @media (max-width: 639px) {
    .action-pill .action-label { display: none; }
    .action-pill { padding: 6px 8px; }
  }

  /* Hide horizontal scrollbar on mode-tab container so swipe-scroll on
     mobile doesn't leave a thick visible track. */
  .scrollbar-none::-webkit-scrollbar { display: none; }
  .scrollbar-none { scrollbar-width: none; }


  /* ===================================================================
     Mobile responsive layout (≤ 640px and progressive enhancement above)
     -------------------------------------------------------------------
     The dashboard is desktop-first by history. The rules below override
     spacing, typography, and layout for narrow screens so every field
     (phone, status, time, actions) stays visible and tap-friendly. No
     colour or design-language changes — purely structural.
     =================================================================== */

  /* Message rows — vertical-stack on mobile so the phone number never
     gets clipped by the status pill + timestamp competing for one row.
     Above 640px the original horizontal layout returns via msg-row-meta. */
  .msg-row { padding: 14px 16px; }
  .msg-row .bubble { width: 32px; height: 32px; font-size: 12px; }
  .msg-row-meta { display: flex; align-items: baseline; gap: 8px; justify-content: space-between; }
  .msg-row-headline { font-size: 14px; word-break: break-all; margin-top: 2px; }
  .msg-row-body { font-size: 13px; margin-top: 8px; padding-left: 10px;
                  border-left: 2px solid rgba(255,255,255,0.08);
                  color: #d4d4d4; white-space: pre-wrap; word-break: break-word; }
  .msg-row-chips { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 6px;
                   font-size: 11px; font-family: ui-monospace, 'SF Mono', Menlo, monospace; }
  @media (min-width: 640px) {
    .msg-row { padding: 16px 20px; }
    .msg-row .bubble { width: 36px; height: 36px; font-size: 14px; }
    .msg-row-headline { font-size: 15px; margin-top: 0; }
    .msg-row-chips { gap: 8px; }
  }

  /* Network rows — on mobile, summary column stacks so status/method are
     one line and the path is full-width below. */
  .net-summary { display: flex; flex-wrap: wrap; align-items: center;
                 gap: 8px 12px; padding: 12px 14px; cursor: pointer; }
  .net-summary:hover { background: rgba(255,255,255,0.02); }
  .net-summary .net-status { font-weight: 600; min-width: 36px; }
  .net-summary .net-method { min-width: 50px; font-weight: 600; font-size: 12px; }
  .net-summary .net-path { flex: 1 1 100%; order: 5; font-size: 12px;
                           color: #e5e5e5; word-break: break-all;
                           font-family: ui-monospace, 'SF Mono', Menlo, monospace; }
  .net-summary .net-latency, .net-summary .net-time { font-size: 11px; }
  .net-summary .net-caret { margin-left: auto; color: #525252; }
  @media (min-width: 768px) {
    .net-summary { flex-wrap: nowrap; padding: 12px 20px; gap: 16px; }
    .net-summary .net-path { flex: 1 1 auto; order: 0; font-size: 13px; color: #e5e5e5; }
    .net-summary .net-caret { margin-left: 0; }
  }

  /* Stat cards — smaller everything on mobile so 4 cards fit in 2×2 without
     truncation or overflow. */
  @media (max-width: 639px) {
    .stat { padding: 14px; }
    .stat .stat-num { font-size: 28px; }
    .stat .stat-label { font-size: 10px; letter-spacing: 0.10em; margin-bottom: 6px; }
    .stat .stat-foot { font-size: 10px; margin-top: 4px; }
  }

  /* Main grid heights — the desktop calc(100vh - 280px) assumes a single-row
     stat strip and one-line header. On mobile the stat strip is 2 rows and
     the header wraps, so use natural flow with sensible min/max heights. */
  @media (max-width: 1023px) {
    .messages-pane, .messages-aside { max-height: none !important; }
    .messages-pane { min-height: 420px; }
    .messages-aside > div { min-height: 180px; }
  }

  /* Tab-view panes (Network, Sessions full-tab) — the desktop uses
     calc(100vh - 90px). On mobile that's measured against a taller wrapped
     header, so override with min-height to keep the pane usable. */
  @media (max-width: 767px) {
    .tab-pane { max-height: none !important; min-height: calc(100vh - 200px) !important; }
  }

  /* Filter bars (the All/Sent/Failed/Bulk + 2xx/4xx/5xx rows) — let them
     scroll horizontally on mobile instead of wrapping into ugly multi-line
     stacks. The session dropdown + count drop onto a second row. */
  .filter-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 12px 14px; }
  .filter-bar .seg { overflow-x: auto; max-width: 100%; }
  .filter-bar .filter-meta { margin-left: auto; }
  @media (min-width: 768px) {
    .filter-bar { padding: 16px 20px; gap: 12px; }
  }

  /* Sessions tab card grid — single column on phones, two on wide. */
  .sess-grid { display: grid; grid-template-columns: 1fr; gap: 10px; padding: 14px; }
  @media (min-width: 768px) { .sess-grid { grid-template-columns: 1fr 1fr; gap: 12px; padding: 16px; } }

  /* Section padding utility — px-4 on mobile, px-6 on desktop. */
  .pane-pad { padding-left: 14px; padding-right: 14px; }
  @media (min-width: 768px) { .pane-pad { padding-left: 24px; padding-right: 24px; } }

  /* Modal — full-width on phones with edge breathing room; capped on desktop. */
  .modal-card { width: 100%; max-width: 32rem; padding: 20px; border-radius: 14px; }
  @media (min-width: 640px) { .modal-card { padding: 28px; border-radius: 16px; } }

  /* QR image inside the New-session modal — never wider than the viewport. */
  #ns-qr-img { width: 100%; max-width: 280px; height: auto; }

  /* Touch-friendly tap targets on phones */
  @media (max-width: 767px) {
    .action-pill, .seg-btn { min-height: 36px; }
    button { -webkit-tap-highlight-color: rgba(255,255,255,0.06); }
  }

  /* Header brand-row pills (status / uptime / sessions / quiet-hours) —
     four of these in a wrap-row can crowd a narrow phone, so tighten
     padding + typography below 640px. The labels stay readable. */
  @media (max-width: 639px) {
    .status-pill { padding: 3px 8px; font-size: 11px; gap: 5px; }
    .status-pill .dot { width: 7px; height: 7px; }
  }

  /* Sessions pill in "currently viewing Sessions" state — matches the
     active mode-tab styling so the operator can see at a glance which
     view is open. Set via setMode() toggling data-on. */
  #sess-stat-pill[data-on="true"] {
    background: var(--bg-elev);
    border-color: var(--border-2);
    color: #ededed;
  }
</style>
</head>
<body class="stage min-h-screen">

<!-- Quiet-hours editor modal — opened by clicking the quiet-hours pill -->
<div id="quiet-modal" class="hidden fixed inset-0 z-40 flex items-center justify-center p-4 overflow-y-auto" style="background: rgba(0,0,0,0.85); backdrop-filter: blur(8px);">
  <form id="quiet-form" class="surface-elev modal-card max-w-md shadow-2xl my-auto">
    <div class="flex items-start justify-between mb-1">
      <h2 class="text-xl font-semibold">Quiet hours</h2>
      <button id="quiet-close" type="button" class="text-neutral-500 hover:text-neutral-200 transition-colors text-lg leading-none">×</button>
    </div>
    <p class="text-sm text-neutral-400 mb-5">Sends outside this window return 503 + <code class="mono text-neutral-200 bg-neutral-900 px-1.5 py-0.5 rounded text-xs">QUIET_HOURS</code>. Set start=0 and end=24 to send anytime.</p>

    <label class="flex items-center gap-2 mb-4 cursor-pointer select-none">
      <input id="quiet-always" type="checkbox" class="accent-emerald-500" />
      <span class="text-sm text-neutral-300">Always live (no quiet window)</span>
    </label>

    <div id="quiet-window-fields" class="grid grid-cols-2 gap-3 mb-4">
      <div>
        <label class="block text-[11px] uppercase tracking-wider text-neutral-500 mb-1.5">Start hour</label>
        <input id="quiet-start" type="number" min="0" max="23" step="1"
               class="w-full bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-2 mono text-sm focus:outline-none focus:border-emerald-500/60 transition-colors" />
      </div>
      <div>
        <label class="block text-[11px] uppercase tracking-wider text-neutral-500 mb-1.5">End hour</label>
        <input id="quiet-end" type="number" min="1" max="24" step="1"
               class="w-full bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-2 mono text-sm focus:outline-none focus:border-emerald-500/60 transition-colors" />
      </div>
    </div>

    <label class="block text-[11px] uppercase tracking-wider text-neutral-500 mb-1.5">Timezone</label>
    <input id="quiet-tz" type="text" autocomplete="off" placeholder="Africa/Nairobi"
           class="w-full bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-2 mono text-sm focus:outline-none focus:border-emerald-500/60 transition-colors" />
    <p class="text-[11px] text-neutral-500 mt-1.5">IANA timezone name. Examples: <code class="mono text-neutral-300">Africa/Nairobi</code>, <code class="mono text-neutral-300">Europe/London</code>, <code class="mono text-neutral-300">America/New_York</code>.</p>
    <p id="quiet-tz-disabled-note" class="hidden text-[11px] text-amber-400/80 mt-1.5">⚠ Timezone has no effect while <strong>Always live</strong> is on — the worker skips the time check entirely. Saved value is kept for when a window is re-enabled.</p>

    <div id="quiet-error" class="hidden mt-3 text-[12px] text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-lg px-3 py-2"></div>

    <div class="mt-5 flex gap-2 justify-end">
      <button id="quiet-cancel" type="button" class="surface-elev rounded-lg px-4 py-2 text-sm text-neutral-300 hover:text-neutral-100">Cancel</button>
      <button id="quiet-save" type="submit" class="bg-emerald-500 hover:bg-emerald-400 text-neutral-950 rounded-lg px-4 py-2 text-sm font-semibold transition-colors">Save</button>
    </div>
    <p class="text-[11px] text-neutral-500 mt-3">Saved to <code class="mono text-neutral-300">.env</code> on the worker host — survives restart.</p>
  </form>
</div>

<!-- Auth modal -->
<div id="auth-modal" class="hidden fixed inset-0 z-50 flex items-center justify-center p-4" style="background: rgba(0,0,0,0.85); backdrop-filter: blur(8px);">
  <form id="auth-form" class="surface-elev modal-card shadow-2xl">
    <h2 class="text-xl font-semibold mb-1">Worker secret</h2>
    <p class="text-sm text-neutral-400 mb-5">Paste your <code class="mono text-neutral-200 bg-neutral-900 px-1.5 py-0.5 rounded">WHATSAPP_WORKER_SECRET</code>. Stored in sessionStorage only.</p>
    <input id="auth-input" type="password" autocomplete="off" autofocus
           class="w-full bg-neutral-950 border border-neutral-800 rounded-lg px-4 py-3 text-sm mono focus:outline-none focus:border-emerald-500/60 transition-colors" />
    <button type="submit" class="mt-4 w-full bg-emerald-500 hover:bg-emerald-400 text-neutral-950 rounded-lg py-3 text-sm font-semibold transition-colors">
      Connect
    </button>
  </form>
</div>

<!-- ===== Header =====
     Three independent regions in a parent flex. On mobile (flex-col) each
     region becomes its own full-width row, so the mode tabs can't crash
     into the action chips. On lg+ (flex-row + lg:items-center) they
     collapse into a single row: brand pills · tabs · actions, with
     lg:ml-auto on the actions block pushing it to the right edge. -->
<header class="relative z-10 px-3 sm:px-6 py-3 hairline border-b">
  <div class="flex flex-col lg:flex-row lg:items-center gap-2 lg:gap-3">
    <!-- Brand + state pills -->
    <div class="flex flex-wrap items-center gap-2 sm:gap-3 min-w-0">
      <div class="w-8 h-8 rounded-lg bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-400 font-semibold shrink-0">W</div>
      <h1 class="text-sm sm:text-base font-semibold tracking-tight truncate">WhatsApp Worker</h1>
      <div id="status" class="status-pill text-neutral-400">
        <span class="dot bg-neutral-500"></span>
        <span>disconnected</span>
      </div>
      <div class="status-pill text-neutral-400" title="Worker process uptime">
        <span class="text-neutral-500 text-[10px] uppercase tracking-wider">up</span>
        <span id="worker-uptime" class="num text-neutral-200">—</span>
      </div>
      <!-- Active sessions — counts from the in-memory lastSessions list,
           updated live by session.* SSE events. Click jumps to Sessions
           view (this pill replaces the old Sessions tab button). -->
      <button id="sess-stat-pill" class="status-pill text-neutral-400 cursor-pointer hover:text-neutral-200 hover:border-neutral-700 transition-colors" title="Active sessions — click to open Sessions view">
        <span class="dot bg-neutral-500" id="sess-stat-dot"></span>
        <span class="text-neutral-500 text-[10px] uppercase tracking-wider">sessions</span>
        <span id="sess-stat-text" class="num text-neutral-200">0 / 0</span>
      </button>
      <!-- Quiet-hours state — click to edit window. Colour reflects current
           mode: emerald = live, amber = quiet, neutral = always-live config. -->
      <button id="quiet-pill" class="status-pill text-neutral-400 cursor-pointer hover:text-neutral-200 hover:border-neutral-700 transition-colors" title="Quiet hours — click to edit">
        <span class="dot bg-neutral-500" id="quiet-pill-dot"></span>
        <span id="quiet-pill-label" class="text-neutral-200">—</span>
        <span id="quiet-pill-window" class="text-neutral-500 text-[10px] num">—</span>
      </button>
    </div>

    <!-- Mode tabs — own row on mobile, scrolls horizontally on overflow.
         Sessions tab is reached via the "sessions" pill on the brand row;
         keeping it out of the tab bar avoids redundancy. -->
    <div class="seg rounded-lg p-1 flex gap-1 overflow-x-auto scrollbar-none self-stretch lg:self-auto">
      <button data-mode="messages" class="mode-btn seg-btn is-active flex-1 lg:flex-initial px-3 sm:px-4 py-1.5 rounded-md text-xs font-medium whitespace-nowrap">Messages</button>
      <button data-mode="network"  class="mode-btn seg-btn flex-1 lg:flex-initial px-3 sm:px-4 py-1.5 rounded-md text-xs font-medium whitespace-nowrap">Network <span class="count" id="cnt-net">0</span></button>
    </div>

    <!-- Action chips — own row on mobile (right-aligned via justify-end);
         on desktop, ml-auto pushes them to the right edge of the header. -->
    <div class="flex items-center gap-1.5 justify-end lg:ml-auto">
      <button id="reveal-btn" class="action-pill" data-on="false" title="Toggle full phone-number display (off = last-4 masked)">
        <span class="action-icon" aria-hidden="true">○</span>
        <span class="action-label">Show numbers</span>
      </button>
      <button id="clear-feed" class="action-pill" title="Clear the current tab's local cache (server data is untouched)">
        <span class="action-icon" aria-hidden="true">✕</span>
        <span class="action-label">Clear</span>
      </button>
      <button id="logout" class="action-pill" title="Forget the stored worker secret on this device">
        <span class="action-icon" aria-hidden="true">⎋</span>
        <span class="action-label">Forget secret</span>
      </button>
    </div>
  </div>
</header>

<!-- ============================================================ -->
<!-- VIEW: Messages (default) ===================================== -->
<!-- ============================================================ -->
<div id="view-messages">

<!-- ===== Stat strip =====
     2×2 on phones (stat .stat-num gets resized via media query), 4×1 on lg+. -->
<section class="pane-pad py-4 sm:py-5 relative z-10">
  <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
    <div class="stat rounded-xl p-5">
      <div class="stat-label text-xs uppercase tracking-[0.14em] text-neutral-500 mb-2.5">Sent</div>
      <div id="m-sent" class="stat-num num text-4xl font-semibold text-emerald-400">0</div>
      <div class="stat-foot mt-2 flex items-center gap-1.5 text-[11px] text-neutral-500">
        <span class="dot bg-emerald-500/60"></span> delivered to WhatsApp
      </div>
    </div>
    <div class="stat rounded-xl p-5">
      <div class="stat-label text-xs uppercase tracking-[0.14em] text-neutral-500 mb-2.5">Failed</div>
      <div id="m-failed" class="stat-num num text-4xl font-semibold text-rose-400">0</div>
      <div class="stat-foot mt-2 flex items-center gap-1.5 text-[11px] text-neutral-500">
        <span class="dot bg-rose-500/60"></span> upstream + rate-limit
      </div>
    </div>
    <div class="stat rounded-xl p-5">
      <div class="stat-label text-xs uppercase tracking-[0.14em] text-neutral-500 mb-2.5">Success rate</div>
      <div id="m-rate" class="stat-num num text-4xl font-semibold text-neutral-200">—</div>
      <div class="stat-foot mt-2 flex items-center gap-1.5 text-[11px] text-neutral-500">
        sent / (sent + failed)
      </div>
    </div>
    <div class="stat rounded-xl p-5">
      <div class="stat-label text-xs uppercase tracking-[0.14em] text-neutral-500 mb-2.5">Throughput</div>
      <div class="flex items-baseline gap-2">
        <div id="m-throughput" class="stat-num num text-4xl font-semibold text-sky-400">0</div>
        <div class="text-xs text-neutral-500">msgs / min</div>
      </div>
      <div class="stat-foot mt-2 flex items-center gap-1.5 text-[11px] text-neutral-500">
        rolling 60s window
      </div>
    </div>
  </div>
</section>

<!-- ===== Main grid =====
     Mobile: stacked single column with natural height (panes use min-height
     via .messages-pane / .messages-aside in CSS). Desktop ≥ lg: 7-col grid
     with rigid calc(100vh - 280px) height so messages + sidebar both have
     internal scroll. -->
<main class="pane-pad pb-6 grid grid-cols-1 lg:grid-cols-7 gap-4 relative z-10 lg:min-h-[calc(100vh-280px)]">

  <!-- Messages -->
  <section class="messages-pane lg:col-span-5 surface rounded-xl flex flex-col overflow-hidden lg:max-h-[calc(100vh-280px)]">
    <!-- Filter tab bar — uses .filter-bar so paddings + horizontal scroll
         are uniform with the Network / Sessions filter bars on mobile. -->
    <div class="filter-bar hairline border-b">
      <div class="seg rounded-xl p-1 flex gap-1 scrollbar-none">
        <button data-filter="all"    class="seg-btn is-active px-3 sm:px-5 py-2 sm:py-2.5 rounded-lg text-sm font-medium whitespace-nowrap">All     <span class="count" id="cnt-all">0</span></button>
        <button data-filter="sent"   class="seg-btn px-3 sm:px-5 py-2 sm:py-2.5 rounded-lg text-sm font-medium whitespace-nowrap">Sent    <span class="count" id="cnt-sent">0</span></button>
        <button data-filter="failed" class="seg-btn px-3 sm:px-5 py-2 sm:py-2.5 rounded-lg text-sm font-medium whitespace-nowrap">Failed  <span class="count" id="cnt-failed">0</span></button>
        <button data-filter="bulk"   class="seg-btn px-3 sm:px-5 py-2 sm:py-2.5 rounded-lg text-sm font-medium whitespace-nowrap">Bulk    <span class="count" id="cnt-bulk">0</span></button>
      </div>
      <select id="session-filter" class="bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-2 text-xs mono text-neutral-300 hover:border-neutral-700 focus:outline-none focus:border-emerald-500/60 transition-colors max-w-[180px] sm:max-w-none truncate">
        <option value="">All sessions</option>
      </select>
      <span id="feed-count" class="filter-meta text-xs text-neutral-500 num">0 events</span>
    </div>

    <div id="messages" class="flex-1 overflow-auto"></div>
    <div id="messages-empty" class="hidden flex-1 flex flex-col items-center justify-center text-center px-6 py-12">
      <div class="w-14 h-14 rounded-2xl bg-neutral-900 border border-neutral-800 flex items-center justify-center text-2xl mb-4">💬</div>
      <div class="text-neutral-300 font-medium mb-1">No messages yet</div>
      <div class="text-sm text-neutral-500">Send a message and it will appear here in real time.</div>
    </div>
  </section>

  <!-- Sidebar -->
  <aside class="messages-aside lg:col-span-2 flex flex-col gap-4 lg:max-h-[calc(100vh-280px)]">
    <!-- Sessions card -->
    <div class="surface rounded-xl flex flex-col overflow-hidden flex-1">
      <div class="px-4 py-3 hairline border-b flex items-center justify-between">
        <div class="text-xs uppercase tracking-[0.14em] text-neutral-500 font-medium">Sessions</div>
        <div class="flex items-center gap-2">
          <button id="sessions-refresh" title="Refresh" class="text-neutral-500 hover:text-neutral-200 transition-colors text-xs">⟳</button>
          <span id="sessions-count" class="text-xs text-neutral-500 num bg-neutral-900 px-2 py-0.5 rounded-full">0</span>
        </div>
      </div>
      <div id="sessions" class="overflow-auto p-3 space-y-2 text-xs"></div>
    </div>

    <!-- System events card -->
    <div class="surface rounded-xl flex flex-col overflow-hidden flex-1">
      <div class="px-4 py-3 hairline border-b text-xs uppercase tracking-[0.14em] text-neutral-500 font-medium">
        System events
      </div>
      <div id="system" class="flex-1 overflow-auto p-3 space-y-1.5 mono text-[11px]"></div>
    </div>
  </aside>
</main>

</div>
<!-- /view-messages -->

<!-- ============================================================ -->
<!-- VIEW: Network ================================================ -->
<!-- ============================================================ -->
<div id="view-network" class="hidden pane-pad py-4 sm:py-5 relative z-10">
  <section class="tab-pane surface rounded-xl flex flex-col overflow-hidden" style="max-height: calc(100vh - 90px); min-height: calc(100vh - 90px);">
    <div class="filter-bar hairline border-b">
      <div class="seg rounded-xl p-1 flex gap-1 scrollbar-none">
        <button data-net-filter="all"    class="net-btn seg-btn is-active px-3 sm:px-5 py-2 sm:py-2.5 rounded-lg text-sm font-medium whitespace-nowrap">All     <span class="count" id="cnt-net-all">0</span></button>
        <button data-net-filter="2xx"    class="net-btn seg-btn px-3 sm:px-5 py-2 sm:py-2.5 rounded-lg text-sm font-medium whitespace-nowrap">2xx     <span class="count" id="cnt-net-2xx">0</span></button>
        <button data-net-filter="4xx"    class="net-btn seg-btn px-3 sm:px-5 py-2 sm:py-2.5 rounded-lg text-sm font-medium whitespace-nowrap">4xx     <span class="count" id="cnt-net-4xx">0</span></button>
        <button data-net-filter="5xx"    class="net-btn seg-btn px-3 sm:px-5 py-2 sm:py-2.5 rounded-lg text-sm font-medium whitespace-nowrap">5xx     <span class="count" id="cnt-net-5xx">0</span></button>
      </div>
      <label class="flex items-center gap-2 text-xs text-neutral-400 cursor-pointer select-none hover:text-neutral-200 transition-colors">
        <input id="show-internal" type="checkbox" class="accent-amber-500" />
        <span>show internal</span>
        <span id="cnt-internal" class="text-[10px] text-neutral-600 num">(0 hidden)</span>
      </label>
      <span id="net-count" class="filter-meta text-xs text-neutral-500 num">0 requests</span>
    </div>
    <div id="network" class="flex-1 overflow-auto"></div>
    <div id="network-empty" class="hidden flex-1 flex flex-col items-center justify-center text-center px-6 py-12">
      <div class="w-14 h-14 rounded-2xl bg-neutral-900 border border-neutral-800 flex items-center justify-center text-2xl mb-4">🛰️</div>
      <div class="text-neutral-300 font-medium mb-1">No requests yet</div>
      <div class="text-sm text-neutral-500">Hit any /v1/* endpoint and the request + response will appear here.</div>
    </div>
  </section>
</div>
<!-- /view-network -->

<!-- ============================================================ -->
<!-- VIEW: Sessions =============================================== -->
<!-- ============================================================ -->
<div id="view-sessions" class="hidden pane-pad py-4 sm:py-5 relative z-10">
  <section class="tab-pane surface rounded-xl flex flex-col overflow-hidden" style="max-height: calc(100vh - 90px); min-height: calc(100vh - 90px);">
    <div class="filter-bar hairline border-b">
      <button id="sess-new" class="bg-emerald-500 hover:bg-emerald-400 text-neutral-950 rounded-lg px-4 py-2 text-sm font-semibold transition-colors flex items-center gap-2 whitespace-nowrap">
        <span class="text-base leading-none">+</span> New session
      </button>
      <button id="sess-refresh-tab" class="surface-elev rounded-lg px-3 py-2 text-xs text-neutral-300 hover:text-neutral-100 hover:border-neutral-600 transition-colors whitespace-nowrap">⟳ Refresh</button>
      <span id="sess-summary" class="filter-meta text-xs text-neutral-500 num"></span>
    </div>
    <div id="sess-list" class="flex-1 overflow-auto sess-grid auto-rows-min"></div>
    <div id="sess-empty" class="hidden flex-1 flex flex-col items-center justify-center text-center px-6 py-12">
      <div class="w-14 h-14 rounded-2xl bg-neutral-900 border border-neutral-800 flex items-center justify-center text-2xl mb-4">📱</div>
      <div class="text-neutral-300 font-medium mb-1">No sessions linked yet</div>
      <div class="text-sm text-neutral-500 mb-4">Click <strong class="text-neutral-300">+ New session</strong> to generate a sessionId and scan the QR.</div>
    </div>
  </section>
</div>
<!-- /view-sessions -->

<!-- ============================================================ -->
<!-- MODAL: New session =========================================== -->
<!-- ============================================================ -->
<div id="new-session-modal" class="hidden fixed inset-0 z-40 flex items-center justify-center p-4 overflow-y-auto" style="background: rgba(0,0,0,0.85); backdrop-filter: blur(8px);">
  <div class="surface-elev modal-card max-w-lg shadow-2xl my-auto">
    <div class="flex items-start justify-between mb-1">
      <h2 class="text-xl font-semibold">New session</h2>
      <button id="ns-close" class="text-neutral-500 hover:text-neutral-200 transition-colors text-lg leading-none">×</button>
    </div>
    <p class="text-sm text-neutral-400 mb-5">Generate (or paste) a session UUID, then scan the QR with WhatsApp on your phone.</p>

    <!-- Step 1: choose id -->
    <div id="ns-step-id">
      <label class="block text-xs uppercase tracking-wider text-neutral-500 mb-2">Session ID</label>
      <div class="flex gap-2">
        <input id="ns-id" type="text" autocomplete="off"
               class="flex-1 bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-2 mono text-sm focus:outline-none focus:border-emerald-500/60 transition-colors" />
        <button id="ns-gen" class="surface-elev rounded-lg px-3 py-2 text-xs text-neutral-300 hover:text-neutral-100">Regenerate</button>
      </div>
      <p class="text-[11px] text-neutral-500 mt-2">Must be a UUID. Anything that identifies this session uniquely — the worker treats it as an opaque key.</p>
      <button id="ns-submit" class="mt-5 w-full bg-emerald-500 hover:bg-emerald-400 text-neutral-950 rounded-lg py-2.5 text-sm font-semibold transition-colors">Start linking</button>
    </div>

    <!-- Step 2: waiting for QR / scanning -->
    <div id="ns-step-qr" class="hidden text-center">
      <div id="ns-status-line" class="text-sm text-neutral-300 mb-3">Booting Chromium…</div>
      <div id="ns-qr-wrap" class="hidden inline-block p-4 bg-white rounded-xl">
        <img id="ns-qr-img" alt="QR code" class="block" width="280" height="280" />
      </div>
      <div class="mt-4 text-xs text-neutral-500">Open WhatsApp → Settings → Linked Devices → Link a device, and scan.</div>
      <button id="ns-cancel" class="mt-5 surface-elev rounded-lg px-4 py-2 text-xs text-neutral-300 hover:text-neutral-100">Cancel</button>
    </div>

    <!-- Step 3: ready -->
    <div id="ns-step-ready" class="hidden text-center">
      <div class="w-16 h-16 rounded-full bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center mx-auto mb-3 text-emerald-400 text-3xl">✓</div>
      <div class="text-base font-semibold text-neutral-100 mb-1">Linked</div>
      <div id="ns-ready-phone" class="text-sm text-neutral-400 mono mb-5"></div>
      <button id="ns-done" class="bg-emerald-500 hover:bg-emerald-400 text-neutral-950 rounded-lg px-5 py-2 text-sm font-semibold">Done</button>
    </div>

    <!-- Step error -->
    <div id="ns-step-error" class="hidden text-center">
      <div class="w-16 h-16 rounded-full bg-rose-500/15 border border-rose-500/30 flex items-center justify-center mx-auto mb-3 text-rose-400 text-3xl">!</div>
      <div class="text-base font-semibold text-neutral-100 mb-2">Couldn't link</div>
      <div id="ns-error-msg" class="text-sm text-rose-300 mb-5"></div>
      <button id="ns-error-back" class="surface-elev rounded-lg px-4 py-2 text-xs text-neutral-300 hover:text-neutral-100">Back</button>
    </div>
  </div>
</div>

<script>
const $ = (id) => document.getElementById(id);
const MAX_FEED = 500;
const MAX_NET = 300;
const THROUGHPUT_WINDOW_MS = 60_000;

let secret = sessionStorage.getItem('worker-secret') || '';
let reveal = false;
let currentFilter = 'all';
let currentMode = 'messages';      // 'messages' | 'network' | 'sessions'
let currentNetFilter = 'all';      // 'all' | '2xx' | '4xx' | '5xx'
let currentSessionFilter = '';     // '' = all sessions, otherwise sessionId
let showInternal = false;          // hide dashboard-originated traffic by default
const counters = { sent: 0, failed: 0 };
const recentSendTimestamps = [];
const allMessages = [];
const allRequests = [];

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
  if (currentSessionFilter) {
    const sid = ev.data && ev.data.sessionId;
    if (sid !== currentSessionFilter) return false;
  }
  if (currentFilter === 'all') return true;
  if (currentFilter === 'sent')   return ev.type === 'message.sent';
  if (currentFilter === 'failed') return ev.type === 'message.failed';
  if (currentFilter === 'bulk')   return ev.type.startsWith('bulk.');
  return true;
}

function updateSessionFilterOptions() {
  const sel = $('session-filter');
  if (!sel) return;
  const current = sel.value;
  // Only sessions with a linked phone number are filter-able — an unlinked
  // session has no messages worth filtering to. Sort phone numbers
  // alphabetically for stable ordering.
  const linked = lastSessions
    .filter((s) => !!s.phoneNumber)
    .sort((a, b) => String(a.phoneNumber).localeCompare(String(b.phoneNumber)));
  let html = '<option value="">All sessions</option>';
  for (const s of linked) {
    html += '<option value="' + s.sessionId + '">' + maskPhone(s.phoneNumber) + '</option>';
  }
  sel.innerHTML = html;
  // Preserve current selection if it still exists; otherwise reset to all.
  if (current && linked.some((s) => s.sessionId === current)) {
    sel.value = current;
  } else if (current) {
    sel.value = '';
    currentSessionFilter = '';
    rerenderFeed();
  }
}

function renderMessageRow(ev) {
  const row = document.createElement('div');
  row.className = 'row msg-row hairline border-b transition-colors' + (ev.replay ? ' replay' : '');

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

  // OVERRIDE badge — every message.* / bulk.* event the worker emits with
  // override:true gets a vivid pill so the operator can see at a glance
  // when a send bypassed all anti-ban gates. High signal, low frequency.
  const overrideBadge = d.override === true
    ? '<span class="ml-2 inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wider bg-rose-500/20 border border-rose-500/40 text-rose-300" title="Sent with X-Worker-Override — anti-ban gates bypassed">⚠ Override</span>'
    : '';

  // Headline content (recipient phone for sends, summary for bulk). Always
  // rendered on its OWN line below the status/time row, so on mobile a long
  // phone number can't get clipped by the timestamp competing for width.
  let headlineInner = '';
  if (isSent || isFailed) {
    headlineInner = '<span class="text-neutral-100 mono">' + maskPhone(d.recipient) + '</span>';
  } else if (isBulkS) {
    headlineInner = '<span class="text-neutral-100">' + d.total + ' messages queued</span>';
  } else if (isBulkC) {
    const total = Number(d.total ?? 0); const ok = Number(d.succeeded ?? 0); const bad = Number(d.failed ?? 0);
    headlineInner = '<span class="text-neutral-100">' + ok + ' of ' + total + ' sent</span>'
      + (bad > 0 ? ' <span class="text-rose-400">· ' + bad + ' failed</span>' : '');
  }

  // Meta chips (session id, batch id, message id, error reason)
  const chips = [];
  if (d.sessionId)             chips.push('<span class="meta-chip text-sky-300/90 hover:text-sky-300" data-copy="' + d.sessionId + '" title="' + d.sessionId + ' — click to copy">session ' + shortId(d.sessionId) + '</span>');
  if (d.batchId)               chips.push('<span class="meta-chip text-amber-300/90 hover:text-amber-300" data-copy="' + d.batchId + '" title="' + d.batchId + ' — click to copy">batch ' + shortId(d.batchId) + '</span>');
  if (isSent && d.messageId)   chips.push('<span class="meta-chip text-neutral-400 hover:text-neutral-200" data-copy="' + d.messageId + '" title="' + d.messageId + ' — click to copy">msg ' + shortId(d.messageId, 12) + '</span>');
  if (isFailed && d.reason)    chips.push('<span class="text-rose-300/80 text-[11px]">' + d.reason + '</span>');

  // Resend chip — only renders when we have enough data (sessionId + recipient
  // + body). Clicking triggers a fresh POST /v1/messages/send with
  // X-Worker-Override: 1 set, bypassing all anti-ban gates. Payload is
  // JSON-encoded into a data attribute so newlines / quotes in the body
  // ride safely through HTML.
  const canResend = (isSent || isFailed) && typeof d.sessionId === 'string'
    && typeof d.recipient === 'string' && typeof d.body === 'string' && d.body.length > 0;
  if (canResend) {
    const payload = JSON.stringify({ sessionId: d.sessionId, recipient: d.recipient, body: d.body });
    const escapedPayload = payload.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    chips.push('<button class="resend-chip" data-resend="' + escapedPayload + '" title="Resend with X-Worker-Override (bypasses every anti-ban gate)">↻ Resend</button>');
  }

  // Message body — shown for sent/failed events for debugging. The body is
  // already gated by the worker secret (only auth'd dashboard subscribers
  // see it) so no further redaction.
  let bodyBlock = '';
  if ((isSent || isFailed) && typeof d.body === 'string' && d.body.length > 0) {
    const truncated = d.body.length > 600 ? d.body.slice(0, 600) + '…' : d.body;
    const escaped = truncated.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    bodyBlock = '<div class="msg-row-body">' + escaped + '</div>';
  }

  // Layout: bubble + content column. Content has three stacked sections —
  // (1) meta row: status pill (+ override badge) on the left, timestamp on
  // the right. (2) headline (recipient phone / bulk summary) on its own
  // line so it can break-all on small viewports. (3) optional body. (4)
  // optional chips row (session/batch/msg/resend).
  row.innerHTML =
    '<div class="flex items-start gap-3 sm:gap-4">' +
    '  <div class="bubble ' + bubbleCls + '">' + bubbleIcon + '</div>' +
    '  <div class="flex-1 min-w-0">' +
    '    <div class="msg-row-meta">' +
    '      <div class="text-xs font-semibold uppercase tracking-wide flex items-center">' + statusLabel + overrideBadge + '</div>' +
    '      <div class="text-[11px] text-neutral-500 num shrink-0">' + timeStr(ev.ts) + '</div>' +
    '    </div>' +
    (headlineInner ? '<div class="msg-row-headline">' + headlineInner + '</div>' : '') +
    bodyBlock +
    (chips.length ? '<div class="msg-row-chips">' + chips.join('') + '</div>' : '') +
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
  // Resend chip — amber tint signals "bypasses anti-ban; use with intent".
  for (const el of row.querySelectorAll('.resend-chip')) {
    el.style.cursor = 'pointer';
    el.style.background = 'rgba(245,158,11,0.10)';
    el.style.border = '1px solid rgba(245,158,11,0.30)';
    el.style.color = '#fbbf24';
    el.style.padding = '2px 8px';
    el.style.borderRadius = '999px';
    el.style.fontWeight = '500';
    el.style.transition = 'background 0.15s ease';
    el.addEventListener('mouseenter', () => { if (!el.disabled) el.style.background = 'rgba(245,158,11,0.20)'; });
    el.addEventListener('mouseleave', () => { if (!el.disabled) el.style.background = 'rgba(245,158,11,0.10)'; });
    el.addEventListener('click', () => doResend(el));
  }
  return row;
}

// Resend handler — re-POSTs to /v1/messages/send with X-Worker-Override.
// Used by the ↻ Resend chip on message.sent / message.failed rows.
async function doResend(btn) {
  let payload;
  try { payload = JSON.parse(btn.dataset.resend); }
  catch { alert('Could not read resend payload'); return; }

  const masked = maskPhone(payload.recipient);
  if (!confirm(
    'Resend to ' + masked + ' with OVERRIDE?\\n\\n' +
    'This bypasses every anti-ban gate (quiet hours, rate limits, ' +
    'recipient cooldown, jitter). High ban risk — use for diagnostics ' +
    'or genuinely urgent sends only.'
  )) return;

  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '↻ Sending…';
  btn.style.opacity = '0.6';

  try {
    const r = await fetch('/v1/messages/send', {
      method: 'POST',
      headers: {
        'X-Worker-Secret': secret,
        'X-Worker-Override': '1',
        'X-Dashboard-Internal': '1',
        'Content-Type': 'application/json',
        // Random idempotency key so each click is a genuine new send (the
        // whole point of resend is to fire again, not replay a cached one).
        'Idempotency-Key': 'dashboard-resend-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      let errText = 'HTTP ' + r.status;
      try {
        const body = await r.json();
        if (body?.error?.message) errText = body.error.code + ': ' + body.error.message;
      } catch { /* non-json response */ }
      alert('Resend failed — ' + errText);
      btn.disabled = false;
      btn.style.opacity = '';
      btn.textContent = originalText;
      return;
    }
    // Success — leave the button in a "done" state so user sees confirmation.
    // The new send will also appear as a fresh ⚠ OVERRIDE row at the top of
    // the feed (via the SSE stream / event bus).
    btn.textContent = '✓ Resent';
    btn.style.background = 'rgba(16,185,129,0.18)';
    btn.style.borderColor = 'rgba(16,185,129,0.40)';
    btn.style.color = '#34d399';
    btn.style.opacity = '';
  } catch (err) {
    alert('Resend failed: ' + (err instanceof Error ? err.message : String(err)));
    btn.disabled = false;
    btn.style.opacity = '';
    btn.textContent = originalText;
  }
}

// Track which events are already rendered so live SSE events + ring-buffer
// replays + /events/recent + localStorage cache don't double-render.
const seenKeys = new Set();

function appendMessage(ev) {
  const k = eventKey(ev);
  if (seenKeys.has(k)) return false;
  seenKeys.add(k);
  allMessages.unshift(ev);
  while (allMessages.length > MAX_FEED) {
    const dropped = allMessages.pop();
    if (dropped) seenKeys.delete(eventKey(dropped));
  }
  if (!eventMatchesFilter(ev)) { updateFeedCount(); updateFilterCounts(); return true; }
  const row = renderMessageRow(ev);
  const feed = $('messages');
  feed.prepend(row);
  while (feed.children.length > MAX_FEED) feed.lastChild.remove();
  $('messages-empty').classList.toggle('hidden', feed.children.length > 0);
  updateFeedCount();
  updateFilterCounts();
  return true;
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

const seenSystemKeys = new Set();
function appendSystem(ev) {
  const k = eventKey(ev);
  if (seenSystemKeys.has(k)) return;
  seenSystemKeys.add(k);
  if (seenSystemKeys.size > 200) {
    // Cap memory: drop arbitrary 50 keys when the set grows large. Cheap
    // approximation of LRU — events are evicted from the DOM at 80 anyway.
    let i = 0; for (const old of seenSystemKeys) { if (i++ >= 50) break; seenSystemKeys.delete(old); }
  }
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
  updateSessionsPill();
}

// ---------- network panel ----------

function statusBucket(code) {
  if (code >= 500) return '5xx';
  if (code >= 400) return '4xx';
  if (code >= 200 && code < 300) return '2xx';
  return 'other';
}

function statusColour(code) {
  if (code >= 500) return 'text-rose-400';
  if (code >= 400) return 'text-amber-400';
  if (code >= 300) return 'text-sky-400';
  if (code >= 200) return 'text-emerald-400';
  return 'text-neutral-400';
}

function methodColour(m) {
  switch (m) {
    case 'GET':    return 'text-sky-300';
    case 'POST':   return 'text-emerald-300';
    case 'PUT':    return 'text-amber-300';
    case 'PATCH':  return 'text-amber-300';
    case 'DELETE': return 'text-rose-300';
    default:       return 'text-neutral-300';
  }
}

function prettyJson(text) {
  if (!text) return '';
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function netMatchesFilter(req) {
  if (req.internal && !showInternal) return false;
  if (currentNetFilter === 'all') return true;
  return statusBucket(req.status) === currentNetFilter;
}

function renderNetworkRow(req) {
  const wrap = document.createElement('div');
  wrap.className = 'row hairline border-b';

  const sc = statusColour(req.status);
  const mc = methodColour(req.method);
  const slow = req.latencyMs > 1000;

  const summary = document.createElement('div');
  summary.className = 'net-summary';
  summary.innerHTML =
    '<span class="net-status ' + sc + ' num">' + req.status + '</span>' +
    '<span class="net-method ' + mc + ' mono">' + req.method + '</span>' +
    '<span class="net-latency num ' + (slow ? 'text-amber-400' : 'text-neutral-500') + '">' + req.latencyMs + 'ms</span>' +
    '<span class="net-time text-neutral-500 num">' + timeStr(req.ts) + '</span>' +
    '<span class="net-caret">▸</span>' +
    '<span class="net-path">' + escapeHtml(req.path) + '</span>';

  const detail = document.createElement('div');
  detail.className = 'hidden px-4 sm:px-5 pb-4 grid grid-cols-1 lg:grid-cols-2 gap-3 sm:gap-4 text-[12px]';

  const headersBlock = req.reqHeaders
    ? Object.entries(req.reqHeaders).map(([k, v]) => '<div class="mono"><span class="text-neutral-500">' + escapeHtml(k) + ':</span> <span class="text-neutral-300">' + escapeHtml(typeof v === 'string' ? v : JSON.stringify(v)) + '</span></div>').join('')
    : '<div class="text-neutral-600 italic">(none)</div>';

  const reqBodyText = req.reqBody ? escapeHtml(prettyJson(req.reqBody)) + (req.reqBodyTruncated ? '\\n…(truncated)' : '') : '';
  const resBodyText = req.resBody ? escapeHtml(prettyJson(req.resBody)) + (req.resBodyTruncated ? '\\n…(truncated)' : '') : '';

  detail.innerHTML =
    '<div class="surface-elev rounded-lg p-3">' +
    '  <div class="text-[10px] uppercase tracking-wider text-neutral-500 mb-2 font-medium">Request headers</div>' +
    '  <div class="space-y-0.5 max-h-48 overflow-auto">' + headersBlock + '</div>' +
    '  <div class="text-[10px] uppercase tracking-wider text-neutral-500 mt-3 mb-2 font-medium">Request body</div>' +
    '  <pre class="mono text-[11px] text-neutral-300 whitespace-pre-wrap break-words max-h-48 overflow-auto">' + (reqBodyText || '<span class="text-neutral-600 italic">(empty)</span>') + '</pre>' +
    '</div>' +
    '<div class="surface-elev rounded-lg p-3">' +
    '  <div class="text-[10px] uppercase tracking-wider text-neutral-500 mb-2 font-medium">Response</div>' +
    '  <div class="mono text-[11px] space-y-0.5">' +
    '    <div><span class="text-neutral-500">status:</span> <span class="' + sc + '">' + req.status + '</span></div>' +
    '    <div><span class="text-neutral-500">content-type:</span> <span class="text-neutral-300">' + escapeHtml(String(req.contentType ?? '')) + '</span></div>' +
    '    <div><span class="text-neutral-500">latency:</span> <span class="' + (slow ? 'text-amber-400' : 'text-neutral-300') + '">' + req.latencyMs + 'ms</span></div>' +
    '    <div><span class="text-neutral-500">requestId:</span> <span class="text-neutral-300" data-copy="' + escapeHtml(req.requestId ?? '') + '">' + escapeHtml(req.requestId ?? '') + '</span></div>' +
    '    <div><span class="text-neutral-500">ip:</span> <span class="text-neutral-300">' + escapeHtml(String(req.ip ?? '')) + '</span></div>' +
    '  </div>' +
    '  <div class="text-[10px] uppercase tracking-wider text-neutral-500 mt-3 mb-2 font-medium">Response body</div>' +
    '  <pre class="mono text-[11px] text-neutral-300 whitespace-pre-wrap break-words max-h-48 overflow-auto">' + (resBodyText || '<span class="text-neutral-600 italic">(empty)</span>') + '</pre>' +
    '</div>';

  summary.addEventListener('click', () => {
    detail.classList.toggle('hidden');
    const caret = summary.querySelector('.net-caret');
    if (caret) caret.textContent = detail.classList.contains('hidden') ? '▸' : '▾';
  });

  wrap.appendChild(summary);
  wrap.appendChild(detail);
  return wrap;
}

const seenReqKeys = new Set();
function reqKey(r) {
  return (r.requestId ?? '') + '|' + r.ts + '|' + r.method + '|' + r.path;
}

function appendRequest(req) {
  const k = reqKey(req);
  if (seenReqKeys.has(k)) return false;
  seenReqKeys.add(k);
  allRequests.unshift(req);
  while (allRequests.length > MAX_NET) {
    const dropped = allRequests.pop();
    if (dropped) seenReqKeys.delete(reqKey(dropped));
  }
  updateNetCounts();
  if (!netMatchesFilter(req)) return true;
  const row = renderNetworkRow(req);
  const feed = $('network');
  feed.prepend(row);
  while (feed.children.length > MAX_NET) feed.lastChild.remove();
  $('network-empty').classList.toggle('hidden', feed.children.length > 0);
  return true;
}

function rerenderNetwork() {
  const feed = $('network'); feed.innerHTML = '';
  for (const r of allRequests) {
    if (!netMatchesFilter(r)) continue;
    feed.appendChild(renderNetworkRow(r));
  }
  $('network-empty').classList.toggle('hidden', feed.children.length > 0);
  updateNetCounts();
}

function updateNetCounts() {
  let n2 = 0, n4 = 0, n5 = 0, nInternal = 0;
  for (const r of allRequests) {
    if (r.internal) nInternal++;
    if (r.internal && !showInternal) continue;
    const b = statusBucket(r.status);
    if (b === '2xx') n2++; else if (b === '4xx') n4++; else if (b === '5xx') n5++;
  }
  const visibleTotal = showInternal ? allRequests.length : allRequests.length - nInternal;
  $('cnt-net').textContent     = visibleTotal;
  $('cnt-net-all').textContent = visibleTotal;
  $('cnt-net-2xx').textContent = n2;
  $('cnt-net-4xx').textContent = n4;
  $('cnt-net-5xx').textContent = n5;
  $('cnt-internal').textContent = '(' + nInternal + ' hidden)';
  const visible = allRequests.filter(netMatchesFilter).length;
  $('net-count').textContent = visible + (visible === 1 ? ' request' : ' requests');
}

// ---------- dispatcher ----------

function handleEvent(ev) {
  if (ev.type === 'message.sent') {
    if (appendMessage(ev)) { counters.sent++; if (!ev.replay) recentSendTimestamps.push(Date.now()); }
  } else if (ev.type === 'message.failed') {
    if (appendMessage(ev)) counters.failed++;
  } else if (ev.type === 'bulk.started' || ev.type === 'bulk.completed') {
    appendMessage(ev);
  } else if (ev.type === 'http.request') {
    appendRequest({ ...ev.data, ts: ev.ts });
  } else if (ev.type.startsWith('session.')) {
    appendSystem(ev);
    applySessionEvent(ev);
  }
  updateCounters();
}

// Apply a session.* event to the in-memory lastSessions array so the
// Sessions tab and sidebar update live without polling. The worker
// publishes enriched payloads (status / qrDataUrl / phoneNumber /
// lastActivity), so we just splice the row in/out and re-render.
function applySessionEvent(ev) {
  const d = ev.data || {};
  const sid = d.sessionId;
  if (!sid) return;

  if (ev.type === 'session.deleted') {
    const idx = lastSessions.findIndex((s) => s.sessionId === sid);
    if (idx >= 0) lastSessions.splice(idx, 1);
    expandedSessions.delete(sid);
  } else if (typeof d.status === 'string') {
    const row = {
      sessionId:    sid,
      status:       d.status,
      qrDataUrl:    d.qrDataUrl ?? null,
      phoneNumber:  d.phoneNumber ?? null,
      lastActivity: d.lastActivity ?? ev.ts,
      // readySince is set by the server on session.ready and cleared by the
      // server when leaving ready. On non-ready events the payload omits it
      // (so the server-side null isn't on the wire); explicitly null it out
      // here so the "connected for" pill disappears when the status flips.
      readySince:   d.status === 'ready' ? (d.readySince ?? null) : null,
    };
    const idx = lastSessions.findIndex((s) => s.sessionId === sid);
    if (idx >= 0) lastSessions[idx] = { ...lastSessions[idx], ...row };
    else lastSessions.push(row);
  }

  renderSessions();          // sidebar in Messages view
  renderSessionsTab();       // dedicated Sessions tab
  updateSessionFilterOptions();
}

// ---------- fetching ----------

async function refreshSessions() {
  try {
    const r = await fetch('/v1/sessions?limit=200', { headers: { 'X-Worker-Secret': secret, 'X-Dashboard-Internal': '1' } });
    if (!r.ok) { if (r.status === 401) promptForSecret(); return; }
    const body = await r.json();
    lastSessions = body.sessions || [];
    renderSessions();
    if (currentMode === 'sessions') renderSessionsTab();
    updateSessionFilterOptions();
  } catch (err) { console.warn('refreshSessions:', err); }
}

async function fetchRecent() {
  try {
    const r = await fetch('/events/recent?limit=500', { headers: { 'X-Worker-Secret': secret, 'X-Dashboard-Internal': '1' } });
    if (!r.ok) return [];
    const body = await r.json();
    return Array.isArray(body.events) ? body.events : [];
  } catch { return []; }
}

function mergeAndRender(events) {
  for (const ev of events) {
    const k = eventKey(ev);
    if (seenKeys.has(k)) continue;
    seenKeys.add(k);
    allMessages.push({ ...ev, replay: true });
    if (ev.type === 'message.sent')   counters.sent++;
    if (ev.type === 'message.failed') counters.failed++;
  }
  allMessages.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  while (allMessages.length > MAX_FEED) {
    const dropped = allMessages.pop();
    if (dropped) seenKeys.delete(eventKey(dropped));
  }
  rerenderFeed();
  updateCounters();
}

async function streamEvents() {
  if (!secret) return;
  setStatus('connecting…', 'bg-neutral-500', 'text-neutral-400');

  let response;
  try { response = await fetch('/events', { headers: { 'X-Worker-Secret': secret, 'X-Dashboard-Internal': '1' } }); }
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

$('reveal-btn').addEventListener('click', () => {
  reveal = !reveal;
  const btn = $('reveal-btn');
  btn.setAttribute('data-on', String(reveal));
  const icon = btn.querySelector('.action-icon');
  if (icon) icon.textContent = reveal ? '●' : '○';
  rerenderFeed();
  renderSessions();
  renderSessionsTab();
  updateSessionFilterOptions();
});

$('clear-feed').addEventListener('click', () => {
  if (currentMode === 'network') {
    allRequests.length = 0;
    seenReqKeys.clear();
    rerenderNetwork();
    return;
  }
  allMessages.length = 0;
  seenKeys.clear();
  counters.sent = 0; counters.failed = 0;
  recentSendTimestamps.length = 0;
  localStorage.removeItem(LOCAL_CACHE_KEY);
  rerenderFeed();
  updateCounters();
});

// Message filter (All / Sent / Failed / Bulk)
for (const btn of document.querySelectorAll('.seg-btn[data-filter]')) {
  btn.addEventListener('click', () => {
    currentFilter = btn.dataset.filter;
    for (const b of document.querySelectorAll('.seg-btn[data-filter]')) b.classList.remove('is-active');
    btn.classList.add('is-active');
    rerenderFeed();
  });
}

// Session filter dropdown
$('session-filter').addEventListener('change', (e) => {
  currentSessionFilter = e.target.value;
  rerenderFeed();
});

// Network status filter (All / 2xx / 4xx / 5xx)
for (const btn of document.querySelectorAll('.net-btn[data-net-filter]')) {
  btn.addEventListener('click', () => {
    currentNetFilter = btn.dataset.netFilter;
    for (const b of document.querySelectorAll('.net-btn[data-net-filter]')) b.classList.remove('is-active');
    btn.classList.add('is-active');
    rerenderNetwork();
  });
}

// Show internal toggle — hides/shows dashboard's own polling fetches.
$('show-internal').addEventListener('change', (e) => {
  showInternal = e.target.checked;
  rerenderNetwork();
});

// View mode (Messages / Network / Sessions)
//
// Sessions has no mode-btn in the tab bar (it's reached via the header
// session pill instead), so the active-class assignment is null-safe with
// ?.classList. The pill itself toggles a data-on="true" attribute so the
// operator gets visual feedback that the Sessions view is currently open.
function setMode(mode) {
  currentMode = mode;
  for (const b of document.querySelectorAll('.mode-btn[data-mode]')) b.classList.remove('is-active');
  document.querySelector('.mode-btn[data-mode="' + mode + '"]')?.classList.add('is-active');
  $('view-messages').classList.toggle('hidden', mode !== 'messages');
  $('view-network').classList.toggle('hidden',  mode !== 'network');
  $('view-sessions').classList.toggle('hidden', mode !== 'sessions');
  $('sess-stat-pill').setAttribute('data-on', mode === 'sessions' ? 'true' : 'false');
  if (mode === 'sessions') renderSessionsTab();
}
for (const btn of document.querySelectorAll('.mode-btn[data-mode]')) {
  btn.addEventListener('click', () => setMode(btn.dataset.mode));
}

// ---------- Sessions management tab ----------

const INTERNAL_HEADERS = () => ({ 'X-Worker-Secret': secret, 'X-Dashboard-Internal': '1' });

// ---------- uptime ticker ----------

let workerStartedAtMs = null;  // computed from /health on connect

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  const sr = s % 60;
  if (m < 60) return m + 'm ' + sr + 's';
  const h = Math.floor(m / 60);
  const mr = m % 60;
  if (h < 24) return h + 'h ' + mr + 'm';
  const d = Math.floor(h / 24);
  const hr = h % 24;
  return d + 'd ' + hr + 'h';
}

async function fetchWorkerUptime() {
  // /health is public — no auth header needed. Returns { ok, uptime } in seconds.
  try {
    const r = await fetch('/health', { headers: { 'X-Dashboard-Internal': '1' } });
    if (!r.ok) return;
    const body = await r.json();
    if (typeof body.uptime === 'number') {
      workerStartedAtMs = Date.now() - body.uptime * 1000;
    }
  } catch {}
}

// Single live-tick interval drives BOTH the worker-uptime header pill AND the
// per-session "connected for" labels in the Sessions tab. Cheap: we mutate
// textContent on a handful of DOM nodes; no full re-render.
function tickUptimes() {
  if (workerStartedAtMs !== null) {
    $('worker-uptime').textContent = formatDuration(Date.now() - workerStartedAtMs);
  }
  for (const el of document.querySelectorAll('[data-ready-since]')) {
    const since = Number(el.dataset.readySince);
    if (!Number.isFinite(since) || since <= 0) continue;
    el.textContent = formatDuration(Date.now() - since);
  }
}
setInterval(tickUptimes, 1000);

function relTime(iso) {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60)   return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60)   return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24)   return h + 'h ago';
  const d = Math.floor(h / 24);
  return d + 'd ago';
}

function statusBadge(status) {
  const map = {
    ready:        { dot: 'bg-emerald-400', text: 'text-emerald-400', bg: 'bg-emerald-500/10', label: 'ready' },
    qr_pending:   { dot: 'bg-amber-400',   text: 'text-amber-400',   bg: 'bg-amber-500/10',   label: 'qr pending' },
    connecting:   { dot: 'bg-sky-400',     text: 'text-sky-400',     bg: 'bg-sky-500/10',     label: 'connecting' },
    disconnected: { dot: 'bg-neutral-500', text: 'text-neutral-400', bg: 'bg-neutral-800',    label: 'disconnected' },
  };
  const s = map[status] ?? map.disconnected;
  return '<span class="' + s.bg + ' ' + s.text + ' inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium">'
    + '<span class="dot ' + s.dot + '"></span>' + s.label + '</span>';
}

// Track which session card is expanded (by sessionId), so re-renders preserve it.
const expandedSessions = new Set();

function renderSessionsTab() {
  const list = $('sess-list');
  const empty = $('sess-empty');
  const summary = $('sess-summary');
  const ready = lastSessions.filter((s) => s.status === 'ready').length;
  // Count badge on the tab button was removed when the Sessions mode tab
  // was deleted (the header session pill already shows the count).
  summary.textContent = lastSessions.length + ' total · ' + ready + ' ready';

  if (lastSessions.length === 0) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  list.innerHTML = '';

  for (const s of lastSessions) {
    const card = document.createElement('div');
    card.className = 'surface-elev rounded-xl overflow-hidden';
    const sid = s.sessionId;
    const isExpanded = expandedSessions.has(sid);

    const header = document.createElement('div');
    header.className = 'p-4 cursor-pointer hover:bg-white/[0.02] transition-colors';
    header.innerHTML =
      '<div class="flex items-start justify-between gap-3 mb-2">' +
      '  ' + statusBadge(s.status) +
      '  <div class="text-[11px] text-neutral-500 num shrink-0">' + relTime(s.lastActivity) + '</div>' +
      '</div>' +
      '<div class="mono text-[12px] text-neutral-300 truncate">' + sid + '</div>' +
      (s.phoneNumber
        ? '<div class="mt-1 mono text-[12px] text-neutral-500">' + maskPhone(s.phoneNumber) + '</div>'
        : '<div class="mt-1 text-[11px] text-neutral-600 italic">no phone linked yet</div>') +
      // Connected-for indicator. Only shown for ready sessions; the live
      // value ticks via data-ready-since (see tickUptimes). readySince comes
      // from the server (set on the "ready" event, cleared on disconnect).
      (s.status === 'ready' && s.readySince
        ? '<div class="mt-2 flex items-center gap-1.5 text-[11px] text-emerald-400/80">' +
          '  <span class="text-neutral-600 uppercase tracking-wider text-[9px]">connected</span>' +
          '  <span class="num" data-ready-since="' + new Date(s.readySince).getTime() + '">—</span>' +
          '</div>'
        : '');

    const detail = document.createElement('div');
    detail.className = 'hairline border-t px-4 py-3 space-y-3' + (isExpanded ? '' : ' hidden');

    // QR (qr_pending only)
    const qrBlock = (s.status === 'qr_pending' && s.qrDataUrl)
      ? '<div class="text-center">' +
        '  <div class="text-[10px] uppercase tracking-wider text-neutral-500 mb-2">Scan with WhatsApp</div>' +
        '  <div class="inline-block p-3 bg-white rounded-lg"><img src="' + s.qrDataUrl + '" alt="QR" width="200" height="200" class="block"/></div>' +
        '</div>'
      : '';

    detail.innerHTML =
      qrBlock +
      '<div class="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px]">' +
      '  <div><div class="text-neutral-500">last activity</div><div class="text-neutral-300 mono break-all">' + (s.lastActivity || '—') + '</div></div>' +
      '  <div><div class="text-neutral-500">phone</div><div class="text-neutral-300 mono break-all">' + (s.phoneNumber ? maskPhone(s.phoneNumber) : '—') + '</div></div>' +
      '</div>' +
      '<div class="flex gap-2 pt-1 flex-wrap">' +
      '  <button data-act="refresh" data-sid="' + sid + '" class="surface-elev rounded-md px-3 py-1.5 text-xs text-neutral-300 hover:text-neutral-100">⟳ Refresh</button>' +
      (s.status === 'disconnected'
        ? '  <button data-act="reconnect" data-sid="' + sid + '" class="bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 rounded-md px-3 py-1.5 text-xs text-emerald-300 hover:text-emerald-200">⤴ Reconnect</button>'
        : '') +
      '  <button data-act="copy"    data-sid="' + sid + '" class="surface-elev rounded-md px-3 py-1.5 text-xs text-neutral-300 hover:text-neutral-100">Copy ID</button>' +
      '  <button data-act="delete"  data-sid="' + sid + '" class="ml-auto bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/30 rounded-md px-3 py-1.5 text-xs text-rose-300 hover:text-rose-200">Delete</button>' +
      '</div>';

    header.addEventListener('click', () => {
      if (expandedSessions.has(sid)) { expandedSessions.delete(sid); detail.classList.add('hidden'); }
      else { expandedSessions.add(sid); detail.classList.remove('hidden'); }
    });

    detail.addEventListener('click', async (ev) => {
      const btn = ev.target.closest('[data-act]');
      if (!btn) return;
      const id = btn.dataset.sid;
      if (btn.dataset.act === 'copy') return copyToClipboard(id, btn);
      if (btn.dataset.act === 'refresh') return refreshOneSession(id);
      if (btn.dataset.act === 'delete') return deleteSessionWithConfirm(id);
      if (btn.dataset.act === 'reconnect') return reconnectSession(id, btn);
    });

    card.appendChild(header);
    card.appendChild(detail);
    list.appendChild(card);
  }
}

// Reconnect a disconnected session. POSTing /v1/sessions/:id on a session
// that exists in-memory as "disconnected" triggers a server-side forced
// reinit (bypasses the 15min ban-safety cooldown for explicit operator
// action; in-flight lock still applies). Disables the button while the
// request is in flight, then polls the session for ~30s to surface the
// status flip back to "ready" (or "qr_pending" if WhatsApp rejected the
// blob).
async function reconnectSession(sid, btn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.style.opacity = '0.5';
  btn.textContent = 'Reconnecting…';
  try {
    const r = await fetch('/v1/sessions/' + encodeURIComponent(sid), {
      method: 'POST',
      headers: INTERNAL_HEADERS(),
    });
    if (!r.ok) {
      btn.textContent = 'Failed (' + r.status + ')';
      setTimeout(() => { btn.textContent = original; btn.disabled = false; btn.style.opacity = ''; }, 3000);
      return;
    }
    // Poll the session for ~30s to surface the status flip live in the UI.
    // The server emits session.* events too, so applySessionEvent will also
    // catch the change — but polling is robust if the SSE happens to be
    // mid-reconnect.
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500));
      const fresh = await fetch('/v1/sessions/' + encodeURIComponent(sid), { headers: INTERNAL_HEADERS() });
      if (!fresh.ok) continue;
      const body = await fresh.json();
      const status = body.session?.status;
      if (status === 'ready' || status === 'qr_pending') break;
    }
    await refreshSessions();
    renderSessionsTab();
  } catch (err) {
    btn.textContent = 'Failed';
    setTimeout(() => { btn.textContent = original; btn.disabled = false; btn.style.opacity = ''; }, 3000);
  }
}

async function refreshOneSession(sid) {
  try {
    const r = await fetch('/v1/sessions/' + encodeURIComponent(sid), { headers: INTERNAL_HEADERS() });
    if (!r.ok) return;
    const body = await r.json();
    if (!body.session) return;
    const idx = lastSessions.findIndex((s) => s.sessionId === sid);
    if (idx >= 0) lastSessions[idx] = body.session; else lastSessions.push(body.session);
    renderSessionsTab();
    renderSessions(); // sidebar
  } catch {}
}

async function deleteSessionWithConfirm(sid) {
  if (!confirm('Delete session ' + sid.slice(0, 8) + '… ?\\n\\nThis unlinks the WhatsApp account. The phone will need a new QR scan to re-link.')) return;
  try {
    const r = await fetch('/v1/sessions/' + encodeURIComponent(sid), { method: 'DELETE', headers: INTERNAL_HEADERS() });
    if (!r.ok) { alert('Delete failed (HTTP ' + r.status + ')'); return; }
    expandedSessions.delete(sid);
    await refreshSessions();
    renderSessionsTab();
  } catch (err) {
    alert('Delete failed: ' + (err instanceof Error ? err.message : String(err)));
  }
}

$('sess-refresh-tab').addEventListener('click', async () => {
  await refreshSessions();
  renderSessionsTab();
});

// ---------- New session modal ----------

let nsPollTimer = null;
function nsShow(step) {
  for (const id of ['ns-step-id', 'ns-step-qr', 'ns-step-ready', 'ns-step-error']) {
    $(id).classList.toggle('hidden', id !== 'ns-step-' + step);
  }
}
function nsOpen() {
  $('ns-id').value = (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(16));
  $('ns-error-msg').textContent = '';
  nsShow('id');
  $('new-session-modal').classList.remove('hidden');
  $('ns-id').focus();
  $('ns-id').select();
}
function nsClose() {
  $('new-session-modal').classList.add('hidden');
  if (nsPollTimer) { clearInterval(nsPollTimer); nsPollTimer = null; }
}
function nsError(msg) {
  if (nsPollTimer) { clearInterval(nsPollTimer); nsPollTimer = null; }
  $('ns-error-msg').textContent = msg;
  nsShow('error');
}
async function nsStartLinking() {
  const sid = $('ns-id').value.trim();
  if (!sid) { alert('Session ID is required'); return; }

  $('ns-status-line').textContent = 'Booting Chromium…';
  $('ns-qr-wrap').classList.add('hidden');
  nsShow('qr');

  try {
    const r = await fetch('/v1/sessions/' + encodeURIComponent(sid), {
      method: 'POST',
      headers: INTERNAL_HEADERS(),
    });
    if (!r.ok) { nsError('Init failed (HTTP ' + r.status + ')'); return; }
  } catch (err) {
    nsError('Init failed: ' + (err instanceof Error ? err.message : String(err)));
    return;
  }

  // Poll for status. Worker emits qrDataUrl when ready to scan; once status
  // flips to 'ready' we wrap up.
  nsPollTimer = setInterval(async () => {
    try {
      const r = await fetch('/v1/sessions/' + encodeURIComponent(sid), { headers: INTERNAL_HEADERS() });
      if (!r.ok) return;
      const body = await r.json();
      const s = body.session;
      if (!s) return;

      if (s.status === 'qr_pending' && s.qrDataUrl) {
        $('ns-status-line').textContent = 'Scan the QR with WhatsApp';
        $('ns-qr-img').src = s.qrDataUrl;
        $('ns-qr-wrap').classList.remove('hidden');
      } else if (s.status === 'connecting') {
        $('ns-status-line').textContent = 'Connecting…';
      } else if (s.status === 'ready') {
        clearInterval(nsPollTimer); nsPollTimer = null;
        $('ns-ready-phone').textContent = s.phoneNumber ? maskPhone(s.phoneNumber) : '';
        nsShow('ready');
        await refreshSessions();
        renderSessionsTab();
      } else if (s.status === 'disconnected') {
        nsError('Session disconnected before scan completed. Try again.');
      }
    } catch {}
  }, 2000);
}

$('sess-new').addEventListener('click', nsOpen);
$('ns-close').addEventListener('click', nsClose);
$('ns-cancel').addEventListener('click', nsClose);
$('ns-done').addEventListener('click', nsClose);
$('ns-error-back').addEventListener('click', () => nsShow('id'));
$('ns-gen').addEventListener('click', () => {
  $('ns-id').value = (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(16));
  $('ns-id').focus(); $('ns-id').select();
});
$('ns-submit').addEventListener('click', nsStartLinking);
$('ns-id').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); nsStartLinking(); } });

// ---------- Header pills: active sessions + quiet hours ----------

function updateSessionsPill() {
  const total = lastSessions.length;
  const ready = lastSessions.filter((s) => s.status === 'ready').length;
  $('sess-stat-text').textContent = ready + ' / ' + total;
  const dot = $('sess-stat-dot');
  // Colour: emerald = all ready, amber = some down, neutral = none yet.
  if (total === 0)            dot.className = 'dot bg-neutral-500';
  else if (ready === total)   dot.className = 'dot bg-emerald-500';
  else if (ready === 0)       dot.className = 'dot bg-rose-500';
  else                        dot.className = 'dot bg-amber-500';
}

let quietCfg = null;  // { start, end, tz, state, retryAfter }

function pad2(n) { return String(n).padStart(2, '0'); }

function paintQuietPill() {
  if (!quietCfg) return;
  const alwaysLive = quietCfg.start === 0 && quietCfg.end === 24;
  const isQuiet = quietCfg.state === 'quiet';
  const label = alwaysLive ? 'Always live' : (isQuiet ? 'Quiet' : 'Live');
  const window = alwaysLive ? '24h' : (pad2(quietCfg.start) + '–' + pad2(quietCfg.end));
  $('quiet-pill-label').textContent = label;
  $('quiet-pill-window').textContent = window;
  const dot = $('quiet-pill-dot');
  if (alwaysLive)     dot.className = 'dot bg-neutral-500';
  else if (isQuiet)   dot.className = 'dot bg-amber-500';
  else                dot.className = 'dot bg-emerald-500';
}

async function fetchQuietHours() {
  try {
    const r = await fetch('/v1/config/quiet-hours', { headers: INTERNAL_HEADERS() });
    if (!r.ok) { if (r.status === 401) promptForSecret(); return; }
    quietCfg = await r.json();
    paintQuietPill();
  } catch (err) { console.warn('fetchQuietHours:', err); }
}

// Re-paint Live/Quiet every minute — the window boundary is hour-precision
// so polling every 60s is plenty. No new fetch needed unless config changed.
setInterval(() => {
  if (!quietCfg) return;
  const alwaysLive = quietCfg.start === 0 && quietCfg.end === 24;
  if (alwaysLive) { quietCfg.state = 'live'; paintQuietPill(); return; }
  const now = new Date();
  // Use Intl to extract the hour in the configured tz.
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: quietCfg.tz, hour: 'numeric', hour12: false });
  const hour = parseInt(fmt.format(now), 10);
  const isQuiet = hour < quietCfg.start || hour >= quietCfg.end;
  quietCfg.state = isQuiet ? 'quiet' : 'live';
  paintQuietPill();
}, 60_000);

// Click pill → jump to Sessions tab.
$('sess-stat-pill').addEventListener('click', () => setMode('sessions'));

// Quiet-hours modal open / close / save.
function openQuietModal() {
  if (!quietCfg) { fetchQuietHours().then(openQuietModal); return; }
  $('quiet-error').classList.add('hidden');
  $('quiet-start').value = quietCfg.start;
  $('quiet-end').value   = quietCfg.end;
  $('quiet-tz').value    = quietCfg.tz;
  const alwaysLive = quietCfg.start === 0 && quietCfg.end === 24;
  $('quiet-always').checked = alwaysLive;
  $('quiet-window-fields').style.opacity = alwaysLive ? '0.4' : '';
  $('quiet-start').disabled = alwaysLive;
  $('quiet-end').disabled = alwaysLive;
  $('quiet-tz-disabled-note').classList.toggle('hidden', !alwaysLive);
  $('quiet-modal').classList.remove('hidden');
}
function closeQuietModal() { $('quiet-modal').classList.add('hidden'); }

$('quiet-pill').addEventListener('click', openQuietModal);
$('quiet-close').addEventListener('click', closeQuietModal);
$('quiet-cancel').addEventListener('click', closeQuietModal);

$('quiet-always').addEventListener('change', (e) => {
  const on = e.target.checked;
  $('quiet-window-fields').style.opacity = on ? '0.4' : '';
  $('quiet-start').disabled = on;
  $('quiet-end').disabled = on;
  $('quiet-tz-disabled-note').classList.toggle('hidden', !on);
  if (on) { $('quiet-start').value = 0; $('quiet-end').value = 24; }
});

$('quiet-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const start = Number($('quiet-start').value);
  const end   = Number($('quiet-end').value);
  const tz    = $('quiet-tz').value.trim();
  const errBox = $('quiet-error');
  errBox.classList.add('hidden');

  if (!Number.isInteger(start) || start < 0 || start > 23) { showQuietError('Start must be 0–23'); return; }
  if (!Number.isInteger(end)   || end   < 1 || end   > 24) { showQuietError('End must be 1–24'); return; }
  if (end <= start) { showQuietError('End must be greater than start'); return; }
  if (!tz)          { showQuietError('Timezone is required'); return; }

  const saveBtn = $('quiet-save');
  saveBtn.disabled = true;
  saveBtn.style.opacity = '0.6';
  saveBtn.textContent = 'Saving…';
  try {
    const r = await fetch('/v1/config/quiet-hours', {
      method: 'PUT',
      headers: { ...INTERNAL_HEADERS(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ start, end, tz }),
    });
    if (!r.ok) {
      let msg = 'HTTP ' + r.status;
      try { const body = await r.json(); if (body?.error?.message) msg = body.error.message; } catch {}
      showQuietError(msg);
      return;
    }
    quietCfg = await r.json();
    paintQuietPill();
    closeQuietModal();
  } catch (err) {
    showQuietError(err instanceof Error ? err.message : String(err));
  } finally {
    saveBtn.disabled = false;
    saveBtn.style.opacity = '';
    saveBtn.textContent = 'Save';
  }
});

function showQuietError(msg) {
  const box = $('quiet-error');
  box.textContent = msg;
  box.classList.remove('hidden');
}

async function start() {
  const cached = loadCache();
  if (cached.length) mergeAndRender(cached.map((ev) => ({ ...ev, replay: true })));
  fetchRecent().then((events) => { if (events.length) mergeAndRender(events); saveCache(); });
  // Worker uptime: one-shot fetch of /health gives us the process start
  // time; tickUptimes() then runs every 1s to update the header label.
  fetchWorkerUptime();
  // Sessions sidebar is fetched ONCE on load; thereafter use the manual
  // refresh button on the Sessions card. Polling was purely cosmetic — the
  // WhatsApp Web keepalive is owned by Chromium, not the HTTP endpoint.
  refreshSessions();
  // Quiet-hours config — one-shot fetch on connect. Updates come from the
  // settings modal's PUT response or the 60s re-paint timer.
  fetchQuietHours();
  setInterval(saveCache, 5000);
  streamEvents();
}

$('sessions-refresh').addEventListener('click', () => {
  const btn = $('sessions-refresh');
  btn.style.opacity = '0.4';
  refreshSessions().finally(() => { btn.style.opacity = ''; });
});

if (secret) start();
else promptForSecret();
</script>
</body>
</html>`;
