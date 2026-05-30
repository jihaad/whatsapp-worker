/**
 * WhatsApp message acknowledgement levels, mirroring whatsapp-web.js's
 * `MessageAck` enum. The ack climbs monotonically as the recipient's device
 * confirms receipt:
 *
 *   -1 error · 0 pending · 1 sent (server) · 2 delivered · 3 read · 4 played
 *
 * "delivered" (2) proves the message reached the recipient's device.
 * "read" (3) only ever arrives if the recipient has read receipts (blue
 * ticks) enabled — with them off you'll see 2 and never 3. That's a
 * WhatsApp privacy setting, not something the worker can influence.
 */

export const ACK_LABEL: Record<number, string> = {
  [-1]: 'error',
  0: 'pending',
  1: 'sent',
  2: 'delivered',
  3: 'read',
  4: 'played',
};

/**
 * Human/caller-facing status string for an ack level. `null`/`undefined`
 * (message handed to the client but no server ack observed yet) maps to
 * 'pending'.
 */
export function ackLabel(ack: number | null | undefined): string {
  if (ack === null || ack === undefined) return 'pending';
  return ACK_LABEL[ack] ?? 'unknown';
}
