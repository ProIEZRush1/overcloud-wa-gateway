import axios from 'axios';
import { config } from './config.js';
import { logger } from './logger.js';

const client = axios.create({
  baseURL: config.laravelUrl,
  timeout: 20_000,
  headers: { 'X-Gateway-Token': config.token, 'Content-Type': 'application/json' },
});

/**
 * Fire a webhook at the Laravel panel. Failures are logged but never thrown —
 * the gateway must keep running even if the panel is briefly down.
 */
async function post(pathname, payload) {
  try {
    const { data } = await client.post(pathname, payload);
    return data;
  } catch (err) {
    logger.warn({ pathname, err: err?.response?.status ?? err.message }, 'laravel webhook failed');
    return null;
  }
}

export const laravel = {
  inbound: (payload) => post('/api/wa/inbound', payload),
  status: (payload) => post('/api/wa/status', payload),
  receipt: (payload) => post('/api/wa/receipt', payload),
};
