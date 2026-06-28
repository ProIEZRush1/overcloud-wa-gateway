import axios from 'axios';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { logger } from './logger.js';

const client = axios.create({
  baseURL: config.laravelUrl,
  timeout: 20_000,
  headers: { 'X-Gateway-Token': config.token, 'Content-Type': 'application/json' },
});

// Buffer lives on the persistent volume so messages survive a panel restart/deploy.
const bufferDir = process.env.BUFFER_DIR ?? path.join(config.authDir, '..', 'buffer');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tryPost(pathname, payload) {
  const { data } = await client.post(pathname, payload);
  return data;
}

/**
 * Fire a webhook at the Laravel panel with retries. Inbound messages that still
 * fail (e.g. the panel is mid-deploy) are buffered to disk and re-sent later, so
 * a client message is never lost during a deploy.
 */
async function post(pathname, payload, { buffer = false } = {}) {
  for (let i = 0; i < 3; i++) {
    try {
      return await tryPost(pathname, payload);
    } catch (err) {
      logger.warn({ pathname, attempt: i + 1, err: err?.response?.status ?? err.message }, 'laravel webhook failed');
      await sleep(1000 * (i + 1));
    }
  }
  if (buffer) {
    await bufferPayload(pathname, payload);
  }
  return null;
}

async function bufferPayload(pathname, payload) {
  try {
    await fs.mkdir(bufferDir, { recursive: true });
    const id = payload?.message?.wa_message_id ?? `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    await fs.writeFile(path.join(bufferDir, `${id}.json`), JSON.stringify({ pathname, payload }), 'utf8');
    logger.warn({ id }, 'buffered inbound for later delivery');
  } catch (e) {
    logger.error({ err: e.message }, 'failed to buffer inbound');
  }
}

// Periodically re-deliver buffered messages once the panel is reachable again.
// The panel dedupes by wa_message_id, so re-posting an already-delivered message is safe.
let flushing = false;
async function flushBuffer() {
  // Don't let a slow pass overlap the next tick — the POST timeout (20s) exceeds the 15s interval,
  // and two passes re-posting the same not-yet-unlinked file would duplicate the message + reply.
  if (flushing) return;
  flushing = true;
  try {
    let files;
    try {
      files = await fs.readdir(bufferDir);
    } catch {
      return; // no buffer yet
    }
    // Recover any file left "claimed" by a crashed previous pass.
    for (const f of files.filter((f) => f.endsWith('.processing'))) {
      try { await fs.rename(path.join(bufferDir, f), path.join(bufferDir, f.replace(/\.processing$/, ''))); } catch {}
    }
    const pending = (await fs.readdir(bufferDir)).filter((f) => f.endsWith('.json'));
    for (const f of pending) {
      const fp = path.join(bufferDir, f);
      const claim = `${fp}.processing`;
      // Claim the file by renaming so it can never be picked up twice.
      try { await fs.rename(fp, claim); } catch { continue; }
      try {
        const { pathname, payload } = JSON.parse(await fs.readFile(claim, 'utf8'));
        await tryPost(pathname, payload);
        await fs.unlink(claim);
        logger.info({ file: f }, 'redelivered buffered inbound');
      } catch (e) {
        // panel still down or this one failed — un-claim and stop; retry next pass.
        try { await fs.rename(claim, fp); } catch {}
        break;
      }
    }
  } finally {
    flushing = false;
  }
}

setInterval(() => { flushBuffer().catch(() => {}); }, 15_000);

export const laravel = {
  inbound: (payload) => post('/api/wa/inbound', payload, { buffer: true }),
  status: (payload) => post('/api/wa/status', payload),
  receipt: (payload) => post('/api/wa/receipt', payload),
  groupEvent: (payload) => post('/api/wa/group-event', payload),
};
