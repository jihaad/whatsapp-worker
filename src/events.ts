import { EventEmitter } from 'node:events';

/**
 * Worker-wide operational event bus. Domain code (sessions.ts, message
 * routes, etc.) publishes one of the typed events below; subscribers are the
 * SSE endpoint at GET /events (consumed by the dashboard) and — when ad-hoc
 * inspection is useful — pino logs.
 *
 * This is intentionally a **separate channel from pino logs**: pino is the
 * durable record (queryable, redacted, JSON), while the event bus is the
 * realtime fan-out for in-browser viewing. Both fire at the same call sites.
 *
 * Events carry full data (e.g. unredacted phone numbers); redaction is the
 * UI's job so the operator can opt-in to revealing details.
 */

export type WorkerEventType =
  | 'session.init'
  | 'session.qr'
  | 'session.ready'
  | 'session.authenticated'
  | 'session.disconnected'
  | 'session.auth_failure'
  | 'session.deleted'
  | 'message.sent'
  | 'message.failed'
  | 'bulk.started'
  | 'bulk.completed';

export interface WorkerEvent {
  type: WorkerEventType;
  ts: string;
  data: Record<string, unknown>;
}

// Ring buffer of recent events. Served as backfill to every new SSE
// subscriber so reconnects (and fresh tabs) don't show a blank feed.
// Specifically defends against the common "tsx-watch restart" gap: the
// dashboard's SSE socket closes, reconnects ~1.5s later, and any events
// published during that window would otherwise be lost.
const RECENT_BUFFER_SIZE = 100;

class WorkerEventBus extends EventEmitter {
  private recent: WorkerEvent[] = [];

  publish(type: WorkerEventType, data: Record<string, unknown> = {}): void {
    const event: WorkerEvent = { type, ts: new Date().toISOString(), data };
    this.recent.push(event);
    if (this.recent.length > RECENT_BUFFER_SIZE) this.recent.shift();
    this.emit('event', event);
  }

  /** Snapshot of the most recent events (oldest first). Used for backfill. */
  snapshot(): readonly WorkerEvent[] {
    return this.recent;
  }
}

export const eventBus = new WorkerEventBus();
// EventEmitter defaults to a 10-listener warning threshold. Multiple
// dashboard tabs each register a listener, so raise the ceiling.
eventBus.setMaxListeners(100);
