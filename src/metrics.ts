import { Counter, Registry } from 'prom-client';

export const registry = new Registry();

export const messagesSent = new Counter({
  name: 'whatsapp_messages_sent_total',
  help: 'Total WhatsApp messages successfully sent',
  labelNames: ['type'] as const,
  registers: [registry],
});

export const messagesFailed = new Counter({
  name: 'whatsapp_messages_failed_total',
  help: 'Total WhatsApp messages that failed to send',
  labelNames: ['type', 'reason'] as const,
  registers: [registry],
});

export const bulkBatchesStarted = new Counter({
  name: 'whatsapp_bulk_batches_started_total',
  help: 'Total bulk send batches accepted',
  registers: [registry],
});
