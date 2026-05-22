import { readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { logger } from '../logger';

const log = logger.child({ component: 'env-writer' });

/**
 * Atomically rewrite a subset of keys in the worker's `.env` file while
 * preserving all other lines (comments, blank lines, keys we didn't touch).
 *
 * Used by the runtime-editable config endpoints (currently just
 * /v1/config/quiet-hours) so operator UI changes survive a restart without
 * touching the database or any external service.
 *
 * The write is atomic: contents are flushed to `.env.tmp` first, then
 * renamed over `.env` in a single `rename` syscall. A crash mid-write
 * leaves either the old or new file intact — never a half-written one.
 *
 * **Note on quoting:** values are written as `KEY="value"` regardless of
 * whether the existing line used quotes. Node's `process.loadEnvFile`
 * (and any standard dotenv parser) strips surrounding double quotes, so
 * this is safe. Values containing `"` or `\` are escaped.
 */
export async function writeEnvVars(updates: Record<string, string | number>): Promise<void> {
  const envPath = resolve(process.cwd(), '.env');
  let existing = '';
  try { existing = await readFile(envPath, 'utf8'); }
  catch (err: unknown) {
    if ((err as { code?: string }).code !== 'ENOENT') throw err;
    log.warn({ envPath }, '.env not found — creating a fresh file');
  }

  const lines = existing.split('\n');
  const remaining = new Set(Object.keys(updates));

  // Replace in-place for keys already present. Match lines that look like
  // `KEY=...` allowing leading whitespace; ignore commented-out lines.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=/);
    if (!m) continue;
    const key = m[1]!;
    if (!remaining.has(key)) continue;
    lines[i] = `${key}=${quote(String(updates[key]))}`;
    remaining.delete(key);
  }

  // Append any keys that weren't present, with a trailing newline so the
  // file ends cleanly. Group all appended keys together with a header
  // comment for traceability.
  if (remaining.size > 0) {
    if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
    lines.push('# Added by worker runtime config editor');
    for (const key of remaining) {
      lines.push(`${key}=${quote(String(updates[key]))}`);
    }
  }

  const next = lines.join('\n');
  const tmpPath = envPath + '.tmp';
  await writeFile(tmpPath, next, { encoding: 'utf8', mode: 0o600 });
  await rename(tmpPath, envPath);
  log.info({ keys: Object.keys(updates) }, 'rewrote .env');
}

function quote(v: string): string {
  // Always quote — handles spaces, =, and shell metacharacters uniformly.
  // Escape backslashes and double quotes so the value survives parsing.
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
