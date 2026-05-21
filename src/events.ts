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
  | 'bulk.completed'
  // HTTP request trace — captured by src/middleware/request-trace.ts and
  // shown in the dashboard's Network panel. Intentionally NOT persisted
  // by event-persistence.ts (would explode the DB on busy days).
  | 'http.request';

export interface WorkerEvent {
  type: WorkerEventType;
  ts: string;
  data: Record<string, unknown>;
}

// Two parallel ring buffers — one for session / message / bulk events, one
// for http.request traces. Both replayed on every new SSE subscriber so
// reconnects (and fresh dashboard tabs) don't start blank.
//
// Why two buffers instead of one combined: http.request fires on every API
// call — at 30 sends/min plus dashboard polling, a shared 100-slot ring
// would fill with http traces in seconds and push out the messaging
// signal that's actually load-bearing for ops debugging. Splitting keeps
// each category's history independent.
//
// Sizes: 100 messages (low frequency, want history); 200 http traces
// (higher volume; lifetime is just the dashboard's working memory anyway).
// Both live for the process lifetime only — restart wipes them.
const RECENT_MESSAGE_BUFFER_SIZE = 100;
const RECENT_HTTP_BUFFER_SIZE = 200;

class WorkerEventBus extends EventEmitter {
  private recentMessages: WorkerEvent[] = [];
  private recentHttp: WorkerEvent[] = [];

  publish(type: WorkerEventType, data: Record<string, unknown> = {}): void {
    const event: WorkerEvent = { type, ts: new Date().toISOString(), data };
    if (type === 'http.request') {
      this.recentHttp.push(event);
      if (this.recentHttp.length > RECENT_HTTP_BUFFER_SIZE) this.recentHttp.shift();
    } else {
      this.recentMessages.push(event);
      if (this.recentMessages.length > RECENT_MESSAGE_BUFFER_SIZE) this.recentMessages.shift();
    }
    this.emit('event', event);
  }

  /** Recent session / message / bulk events (oldest first). */
  snapshot(): readonly WorkerEvent[] {
    return this.recentMessages;
  }

  /** Recent http.request traces (oldest first) — for Network panel backfill. */
  snapshotHttp(): readonly WorkerEvent[] {
    return this.recentHttp;
  }
}

export const eventBus = new WorkerEventBus();
// EventEmitter defaults to a 10-listener warning threshold. Multiple
// dashboard tabs each register a listener, so raise the ceiling.
eventBus.setMaxListeners(100);
