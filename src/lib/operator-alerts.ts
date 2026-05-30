/**
 * Operator alerts — pings the human when a session needs hands-on attention
 * (login rejected, saved blob thrown out on restart, or a send couldn't get
 * the session connected). Delivery is ntfy.sh: the worker POSTs a plain-text
 * message to a topic the operator has subscribed to in the ntfy phone app.
 *
 * Disabled unless `ALERT_NTFY_TOPIC` is set, so dev / local runs stay silent.
 * Deliberately does NOT alert on plain `session.disconnected` — that self-heals
 * via the watchdog and would page on every network blip. Only the cases that
 * genuinely need a manual reset get through, and each is rate-limited per
 * (session, kind) so a flapping session can't spam the phone.
 */
import { logger } from '../logger';

const log = logger.child({ component: 'operator-alerts' });

// ntfy config. Topic is the on/off switch. Server defaults to the public
// instance; point ALERT_NTFY_SERVER at a self-hosted one if wanted. Token is
// only needed for access-protected topics.
const NTFY_TOPIC = process.env.ALERT_NTFY_TOPIC;
const NTFY_SERVER = (process.env.ALERT_NTFY_SERVER ?? 'https://ntfy.sh').replace(/\/+$/, '');
const NTFY_TOKEN = process.env.ALERT_NTFY_TOKEN;

// Don't re-page for the same session+kind more than once per window — a
// flapping session or a burst of blocked sends shouldn't drain the phone.
const ALERT_COOLDOWN_MS = Number(process.env.ALERT_COOLDOWN_MS) || 15 * 60_000;
const lastSent = new Map<string, number>();

export type SessionAlertKind =
  | 'auth_failure'
  | 'restore_rejected'
  | 'connect_timeout'
  | 'stuck_connecting';

const TITLES: Record<SessionAlertKind, string> = {
  auth_failure: 'WhatsApp session login rejected',
  restore_rejected: 'WhatsApp session needs re-linking',
  connect_timeout: 'WhatsApp session not connecting',
  stuck_connecting: 'WhatsApp session stuck connecting',
};

/**
 * Fire an operator alert for a session problem. No-op when alerts are disabled
 * or the same (session, kind) fired within the cooldown window. Fire-and-forget
 * — never throws, so callers on hot paths (send / lifecycle handlers) can call
 * it without a try/catch.
 */
export function alertSessionProblem(sessionId: string, kind: SessionAlertKind, detail?: string): void {
  if (!NTFY_TOPIC) return; // alerts disabled

  const key = `${sessionId}:${kind}`;
  const now = Date.now();
  const prev = lastSent.get(key);
  if (prev && now - prev < ALERT_COOLDOWN_MS) return; // still within cooldown
  lastSent.set(key, now);

  const body = [
    `Session: ${sessionId}`,
    detail ? `Detail: ${detail}` : null,
    'A manual reset may be required — check the dashboard or re-link the session.',
  ]
    .filter(Boolean)
    .join('\n');

  void deliver(TITLES[kind], body);
}

async function deliver(title: string, body: string): Promise<void> {
  try {
    const res = await fetch(`${NTFY_SERVER}/${NTFY_TOPIC}`, {
      method: 'POST',
      headers: {
        Title: title,
        Priority: 'high',
        Tags: 'warning',
        ...(NTFY_TOKEN ? { Authorization: `Bearer ${NTFY_TOKEN}` } : {}),
      },
      body,
      // Don't let a hung ntfy server wedge the caller's request.
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) log.warn({ status: res.status }, 'ntfy alert POST returned non-2xx');
  } catch (err) {
    log.warn({ err }, 'ntfy alert POST failed');
  }
}
