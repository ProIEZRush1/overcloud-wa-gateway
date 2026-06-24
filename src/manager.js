import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { logger } from './logger.js';
import { Session } from './session.js';

/** Owns every WhatsApp session and persists the set of known sessions. */
export class SessionManager {
  constructor() {
    this.sessions = new Map();
  }

  async loadPersisted() {
    await fs.mkdir(path.dirname(config.sessionsFile), { recursive: true });
    let names = [];
    try {
      names = JSON.parse(await fs.readFile(config.sessionsFile, 'utf8'));
    } catch {
      names = [];
    }
    for (const name of names) {
      logger.info({ session: name }, 'resuming session');
      await this.connect(name).catch((e) => logger.error({ session: name, err: e.message }, 'resume failed'));
    }
  }

  async persist() {
    await fs.writeFile(config.sessionsFile, JSON.stringify([...this.sessions.keys()], null, 2));
  }

  get(name) {
    return this.sessions.get(name) ?? null;
  }

  async connect(name) {
    let session = this.sessions.get(name);
    if (!session) {
      session = new Session(name);
      this.sessions.set(name, session);
      await this.persist();
    }
    await session.start();
    return session;
  }

  async remove(name) {
    const session = this.sessions.get(name);
    if (session) {
      await session.stop();
      await session.clearAuth();
      this.sessions.delete(name);
      await this.persist();
    }
    return { ok: true };
  }

  all() {
    return [...this.sessions.values()].map((s) => s.statusObject());
  }
}
