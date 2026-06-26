import path from 'node:path';
import fs from 'node:fs/promises';
import { Boom } from '@hapi/boom';
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  downloadMediaMessage,
  Browsers,
  jidNormalizedUser,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import { config } from './config.js';
import { childLogger } from './logger.js';
import { laravel } from './laravel.js';
import { toJid, describeMessage } from './util.js';

/**
 * Wraps a single WhatsApp connection (one number) and bridges it to the panel.
 */
export class Session {
  constructor(name) {
    this.name = name;
    this.log = childLogger({ session: name });
    this.sock = null;
    this.status = 'disconnected';
    this.qr = null;            // raw QR string
    this.qrDataUrl = null;     // PNG data URL for the panel
    this.me = null;            // { id, name }
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.stopping = false;
    this.heartbeat = null;
  }

  get authPath() {
    return path.join(config.authDir, this.name);
  }

  async start() {
    this.stopping = false;
    clearTimeout(this.reconnectTimer);
    // Ensure only ONE live socket per number — a second socket triggers a WA
    // "conflict" (replaced) that loops and eventually logs the device out.
    if (this.sock) {
      try {
        this.sock.ev.removeAllListeners();
        this.sock.end(undefined);
      } catch {
        // already closed
      }
      this.sock = null;
    }
    await fs.mkdir(this.authPath, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(this.authPath);
    const { version } = await fetchLatestBaileysVersion();

    this.sock = makeWASocket({
      version,
      auth: state,
      browser: Browsers.macOS('Overcloud'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      logger: this.log,
    });

    this.sock.ev.on('creds.update', saveCreds);
    this.sock.ev.on('connection.update', (u) => this.onConnectionUpdate(u));
    this.sock.ev.on('messages.upsert', (u) => this.onMessagesUpsert(u));
    this.sock.ev.on('messages.update', (u) => this.onMessagesUpdate(u));

    // Heartbeat: re-assert the current status periodically so a single dropped status webhook
    // self-heals (otherwise the panel can show "connected" while the device is actually offline).
    if (!this.heartbeat) {
      this.heartbeat = setInterval(() => {
        laravel.status({ session: this.name, status: this.status, jid: this.me?.id ?? null, phone: this.phone() });
      }, 60_000);
    }

    this.setStatus('connecting');
    return this;
  }

  setStatus(status, extra = {}) {
    this.status = status;
    laravel.status({ session: this.name, status, jid: this.me?.id ?? null, phone: this.phone(), ...extra });
  }

  phone() {
    return this.me?.id ? this.me.id.split(':')[0].split('@')[0] : null;
  }

  async onConnectionUpdate(update) {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      this.qr = qr;
      this.qrDataUrl = await QRCode.toDataURL(qr);
      this.setStatus('qr_pending', { qr: this.qrDataUrl });
      this.log.info('QR generated, waiting for scan');
    }

    if (connection === 'open') {
      this.qr = null;
      this.qrDataUrl = null;
      this.reconnectAttempts = 0;
      this.me = this.sock.user ? { id: jidNormalizedUser(this.sock.user.id), name: this.sock.user.name } : null;
      this.setStatus('connected');
      this.log.info({ me: this.me }, 'connection open');
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output?.statusCode
        : undefined;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      if (loggedOut) {
        this.log.warn('logged out — clearing auth');
        await this.clearAuth();
        this.setStatus('logged_out');
        return;
      }

      // A second socket REPLACED us (connectionReplaced/440), or the session is bad/forbidden.
      // Reconnecting here makes two sockets ping-pong the device into a real logout — so stop,
      // surface 'replaced', and let an explicit restart bring it back.
      const terminalCodes = [DisconnectReason.connectionReplaced, DisconnectReason.badSession, DisconnectReason.forbidden]
        .filter((c) => c !== undefined);
      if (terminalCodes.includes(statusCode)) {
        this.log.warn({ statusCode }, 'terminal disconnect — not auto-reconnecting');
        this.setStatus('replaced');
        return;
      }

      // Cap reconnect attempts so a hard-down upstream doesn't loop forever (and silently).
      if (this.reconnectAttempts >= (config.maxReconnectAttempts ?? 20)) {
        this.log.error({ attempts: this.reconnectAttempts }, 'giving up reconnect after too many attempts');
        this.setStatus('disconnected');
        return;
      }
      if (!this.stopping) this.scheduleReconnect();
    }
  }

  scheduleReconnect() {
    this.reconnectAttempts += 1;
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, config.maxReconnectDelay);
    this.setStatus('connecting');
    this.log.info({ attempt: this.reconnectAttempts, delay }, 'scheduling reconnect');
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.start().catch((e) => this.log.error(e, 'reconnect failed')), delay);
  }

  async onMessagesUpsert({ messages, type }) {
    // 'notify' = live messages; 'append' = backlog synced on reconnect (messages that arrived
    // while we were down). Process both so a deploy/restart never loses inbound messages — the
    // panel dedupes by wa_message_id, so any overlap is harmless.
    if (type !== 'notify' && type !== 'append') return;
    for (const msg of messages) {
      try {
        await this.forwardMessage(msg);
      } catch (err) {
        this.log.error({ err: err.message }, 'failed to forward message');
      }
    }
  }

  async forwardMessage(msg) {
    const remoteJid = msg.key?.remoteJid;
    if (!remoteJid || remoteJid === 'status@broadcast' || remoteJid.endsWith('@newsletter')) return;
    if (msg.message?.protocolMessage || msg.message?.senderKeyDistributionMessage) return;

    const described = describeMessage(msg.message);
    const isGroup = remoteJid.endsWith('@g.us');

    const payload = {
      session: this.name,
      account_jid: this.me?.id ?? null,
      message: {
        wa_message_id: msg.key.id,
        chat_jid: remoteJid,
        is_group: isGroup,
        from_me: !!msg.key.fromMe,
        sender_jid: msg.key.participant ?? (msg.key.fromMe ? this.me?.id : remoteJid),
        push_name: msg.pushName ?? null,
        type: described.type,
        text: described.text,
        caption: described.caption,
        timestamp: Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000),
        media: null,
      },
    };

    if (described.media) {
      payload.message.media = await this.tryDownloadMedia(msg, described.media);
    }

    await laravel.inbound(payload);
  }

  async tryDownloadMedia(msg, mediaInfo) {
    try {
      const buffer = await downloadMediaMessage(
        msg,
        'buffer',
        {},
        { logger: this.log, reuploadRequest: this.sock.updateMediaMessage },
      );
      const meta = { mimetype: mediaInfo.mimetype, fileName: mediaInfo.fileName, size: buffer.length, base64: null, stored_path: null };

      // Always keep a copy on disk; inline base64 only when small enough.
      await fs.mkdir(config.mediaDir, { recursive: true });
      const ext = (mediaInfo.fileName?.split('.').pop() || mediaInfo.mimetype?.split('/').pop() || 'bin').slice(0, 8);
      const stored = path.join(config.mediaDir, `${this.name}-${msg.key.id}.${ext}`);
      await fs.writeFile(stored, buffer);
      meta.stored_path = stored;

      if (buffer.length <= config.maxInlineMedia) {
        meta.base64 = buffer.toString('base64');
      } else {
        // Too big to inline → the panel currently can't ingest it (it reads base64 only). Don't drop
        // it silently: log it with the on-disk path so it's recoverable and the gap is visible.
        this.log.warn(
          { size: buffer.length, max: config.maxInlineMedia, stored, wa_message_id: msg.key.id },
          'media exceeds inline limit — forwarded WITHOUT base64 (kept on disk only)',
        );
      }
      return meta;
    } catch (err) {
      this.log.warn({ err: err.message }, 'media download failed');
      return { mimetype: mediaInfo.mimetype, fileName: mediaInfo.fileName, size: null, base64: null, stored_path: null, error: err.message };
    }
  }

  onMessagesUpdate(updates) {
    for (const u of updates) {
      const status = u.update?.status;
      if (status === undefined) continue;
      laravel.receipt({ session: this.name, wa_message_id: u.key?.id, chat_jid: u.key?.remoteJid, status });
    }
  }

  // ---- outbound actions -------------------------------------------------

  ensureReady() {
    if (!this.sock || this.status !== 'connected') {
      throw new Error(`session ${this.name} not connected (status: ${this.status})`);
    }
  }

  // Request an 8-char pairing code (no QR scan needed). $phone = digits only, with country code.
  async requestPairingCode(phone) {
    if (!this.sock) throw new Error(`session ${this.name} has no socket`);
    if (this.sock.authState?.creds?.registered) throw new Error('already registered');
    const digits = String(phone).replace(/[^0-9]/g, '');
    const code = await this.sock.requestPairingCode(digits);
    this.log.info({ session: this.name, phone: digits }, 'pairing code requested');
    return code;
  }

  async sendText(to, text, { quoted } = {}) {
    this.ensureReady();
    return this.sock.sendMessage(toJid(to), { text }, quoted ? { quoted } : {});
  }

  async sendMedia(to, { base64, mimetype, fileName, caption, kind }) {
    this.ensureReady();
    const buffer = Buffer.from(base64, 'base64');
    const jid = toJid(to);
    const content = kind === 'image'
      ? { image: buffer, caption: caption ?? undefined }
      : kind === 'video'
        ? { video: buffer, caption: caption ?? undefined }
        : kind === 'audio'
          ? { audio: buffer, mimetype: mimetype ?? 'audio/mpeg' }
          : { document: buffer, mimetype: mimetype ?? 'application/octet-stream', fileName: fileName ?? 'archivo' };
    return this.sock.sendMessage(jid, content);
  }

  // Send a native interactive message (in-chat menu). Shape:
  // { body, footer?, title?, buttons:[{type:'quick_reply'|'cta_url'|'single_select', text, ...}],
  //   or sections:[{title, rows:[{header,title,description,id}]}] for a selection list }
  async sendInteractive(to, spec = {}) {
    this.ensureReady();
    const jid = toJid(to);
    const buttons = [];

    if (Array.isArray(spec.sections) && spec.sections.length) {
      // Single-select list (the "menu, client picks" use case).
      buttons.push({
        name: 'single_select',
        buttonParamsJson: JSON.stringify({
          title: spec.button || 'Ver opciones',
          sections: spec.sections.map((s) => ({
            title: s.title || '',
            rows: (s.rows || []).map((r) => ({
              header: r.header || '',
              title: r.title || '',
              description: r.description || '',
              id: r.id || r.title || '',
            })),
          })),
        }),
      });
    }
    for (const b of spec.buttons || []) {
      if (b.type === 'cta_url') {
        buttons.push({ name: 'cta_url', buttonParamsJson: JSON.stringify({ display_text: b.text, url: b.url, merchant_url: b.url }) });
      } else {
        buttons.push({ name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: b.text, id: b.id || b.text }) });
      }
    }

    const content = {
      interactiveMessage: {
        body: { text: spec.body || '' },
        footer: spec.footer ? { text: spec.footer } : undefined,
        header: spec.title ? { title: spec.title, subtitle: spec.subtitle || '', hasMediaAttachment: false } : undefined,
        nativeFlowMessage: { buttons, messageVersion: 1 },
      },
    };
    return this.sock.sendMessage(jid, content);
  }

  async createGroup(subject, participants = []) {
    this.ensureReady();
    const jids = participants.map(toJid);
    const res = await this.sock.groupCreate(subject, jids);
    return { jid: res.id, subject, participants: res.participants };
  }

  async updateParticipants(groupJid, participants, action) {
    this.ensureReady();
    return this.sock.groupParticipantsUpdate(groupJid, participants.map(toJid), action);
  }

  async updateSubject(groupJid, subject) {
    this.ensureReady();
    await this.sock.groupUpdateSubject(groupJid, subject);
    return { jid: groupJid, subject };
  }

  async groupInviteCode(groupJid) {
    this.ensureReady();
    const code = await this.sock.groupInviteCode(groupJid);
    return { jid: groupJid, code, url: `https://chat.whatsapp.com/${code}` };
  }

  async sendPresence(to, type = 'composing') {
    this.ensureReady();
    const jid = toJid(to);
    await this.sock.presenceSubscribe(jid).catch(() => {});
    await this.sock.sendPresenceUpdate(type, jid);
    return { ok: true };
  }

  async markRead(keys) {
    this.ensureReady();
    await this.sock.readMessages(keys);
    return { ok: true };
  }

  async logout() {
    try {
      await this.sock?.logout();
    } catch (e) {
      this.log.warn(e, 'logout error');
    }
    await this.clearAuth();
    this.setStatus('logged_out');
  }

  async stop() {
    this.stopping = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.heartbeat);
    this.heartbeat = null;
    try {
      this.sock?.end?.(undefined);
    } catch { /* noop */ }
    this.setStatus('disconnected');
  }

  async clearAuth() {
    await fs.rm(this.authPath, { recursive: true, force: true }).catch(() => {});
  }

  statusObject() {
    return {
      session: this.name,
      status: this.status,
      jid: this.me?.id ?? null,
      phone: this.phone(),
      name: this.me?.name ?? null,
      qr: this.qrDataUrl,
    };
  }
}
