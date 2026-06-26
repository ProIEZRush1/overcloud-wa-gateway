import express from 'express';
import { config } from './config.js';
import { logger } from './logger.js';

/** Build the control API the Laravel panel uses to drive the gateway. */
export function buildServer(manager) {
  const app = express();
  app.use(express.json({ limit: '30mb' }));

  // Health is open; everything else needs the shared token.
  app.get('/health', (_req, res) => res.json({ ok: true, sessions: manager.all().length }));

  app.use((req, res, next) => {
    if (req.get('X-Gateway-Token') !== config.token) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    next();
  });

  const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
    logger.error({ path: req.path, err: err.message }, 'request failed');
    res.status(400).json({ error: err.message });
  });

  const requireSession = (req) => {
    const session = manager.get(req.params.name);
    if (!session) throw new Error(`unknown session: ${req.params.name}`);
    return session;
  };

  app.get('/sessions', wrap((_req, res) => res.json(manager.all())));

  app.post('/sessions/:name/connect', wrap(async (req, res) => {
    const session = await manager.connect(req.params.name);
    res.json(session.statusObject());
  }));

  app.get('/sessions/:name', wrap((req, res) => res.json(requireSession(req).statusObject())));

  app.get('/sessions/:name/qr', wrap((req, res) => {
    const session = requireSession(req);
    res.json({ session: session.name, status: session.status, qr: session.qrDataUrl });
  }));

  app.post('/sessions/:name/logout', wrap(async (req, res) => {
    await requireSession(req).logout();
    res.json({ ok: true });
  }));

  app.delete('/sessions/:name', wrap(async (req, res) => res.json(await manager.remove(req.params.name))));

  app.post('/sessions/:name/send', wrap(async (req, res) => {
    const session = requireSession(req);
    const { to, text, media, quoted, interactive } = req.body;
    const result = interactive
      ? await session.sendInteractive(to, interactive)
      : media
        ? await session.sendMedia(to, media)
        : await session.sendText(to, text, { quoted });
    res.json({ ok: true, wa_message_id: result?.key?.id ?? null });
  }));

  app.post('/sessions/:name/pair', wrap(async (req, res) => {
    const code = await requireSession(req).requestPairingCode(req.body.phone);
    res.json({ ok: true, code });
  }));

  app.post('/sessions/:name/group', wrap(async (req, res) => {
    const { subject, participants } = req.body;
    res.json(await requireSession(req).createGroup(subject, participants ?? []));
  }));

  app.post('/sessions/:name/group/participants', wrap(async (req, res) => {
    const { jid, participants, action } = req.body;
    res.json(await requireSession(req).updateParticipants(jid, participants ?? [], action));
  }));

  app.post('/sessions/:name/group/subject', wrap(async (req, res) => {
    const { jid, subject } = req.body;
    res.json(await requireSession(req).updateSubject(jid, subject));
  }));

  app.get('/sessions/:name/group/:jid/invite', wrap(async (req, res) => {
    res.json(await requireSession(req).groupInviteCode(req.params.jid));
  }));

  app.post('/sessions/:name/presence', wrap(async (req, res) => {
    const { to, type } = req.body;
    res.json(await requireSession(req).sendPresence(to, type));
  }));

  app.post('/sessions/:name/read', wrap(async (req, res) => {
    res.json(await requireSession(req).markRead(req.body.keys ?? []));
  }));

  return app;
}
