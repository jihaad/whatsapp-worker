/**
 * Per-send body variation — the last anti-ban layer.
 *
 * Appends one of N benign trailing whitespace variants picked at random per
 * send. Goal: make 100 identical-input messages produce 100 byte-different
 * outputs, so WhatsApp's exact-match spam scorer doesn't see a single
 * fingerprint repeated across recipients.
 *
 * **The recipient sees no visible change.** WhatsApp's UI trims display
 * trailing whitespace (regular spaces, NBSPs, newlines all collapse to
 * nothing at end-of-message). Bytes on the wire differ; pixels on screen
 * don't.
 *
 * Why whitespace-only (not emoji / closer text):
 *  - School messages cover payment confirmations, attendance notes, invoice
 *    reminders. Sticking a random 📚 on a payment confirmation reads oddly.
 *  - Visible variants would need per-template editorial review. Whitespace
 *    is content-neutral.
 *  - Invisible Unicode (ZWSP, ZWNJ) is itself a spam signal in some
 *    detectors. Whitespace is benign.
 *
 * Disabled when `WHATSAPP_BODY_VARIATION=off`. Default: on.
 */

// Escape sequences only — keep the source readable. Each entry is a distinct
// byte sequence so 100 identical inputs map to 8 distinct outputs.
const NBSP = ' ';
const TAIL_VARIANTS: readonly string[] = [
  ' ',                  // single regular space
  '  ',                 // two regular spaces
  '\n',                 // single newline
  '\n ',                // newline then space
  ' \n',                // space then newline
  NBSP,                 // non-breaking space (looks like a space, different byte)
  ` ${NBSP}`,           // space then NBSP
  `${NBSP} `,           // NBSP then space
];

const ENABLED = (process.env.WHATSAPP_BODY_VARIATION ?? 'on').toLowerCase() !== 'off';

export function varyBody(body: string): string {
  if (!ENABLED) return body;
  if (!body) return body;
  const tail = TAIL_VARIANTS[Math.floor(Math.random() * TAIL_VARIANTS.length)]!;
  return body + tail;
}
