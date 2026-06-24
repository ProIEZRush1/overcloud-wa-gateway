import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

export const config = {
  port: parseInt(process.env.PORT ?? '8088', 10),
  // Shared secret: both directions (panel→gateway and gateway→panel) must present it.
  token: process.env.GATEWAY_TOKEN ?? 'change-me',
  // Where the Laravel panel receives inbound webhooks.
  laravelUrl: (process.env.LARAVEL_URL ?? 'http://overcloud.test').replace(/\/$/, ''),
  authDir: process.env.AUTH_DIR ?? path.join(root, 'storage', 'auth'),
  mediaDir: process.env.MEDIA_DIR ?? path.join(root, 'storage', 'media'),
  sessionsFile: process.env.SESSIONS_FILE ?? path.join(root, 'storage', 'sessions.json'),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  // Max media size (bytes) we inline as base64 into the inbound webhook.
  maxInlineMedia: parseInt(process.env.MAX_INLINE_MEDIA ?? String(16 * 1024 * 1024), 10),
  // Reconnect backoff ceiling (ms).
  maxReconnectDelay: 30_000,
};
