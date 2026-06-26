/** Turn a phone number or JID into a WhatsApp user JID. */
export function toJid(recipient) {
  if (!recipient) throw new Error('recipient required');
  if (recipient.includes('@')) return recipient;
  const digits = String(recipient).replace(/\D/g, '');
  return `${digits}@s.whatsapp.net`;
}

const MEDIA_KEYS = {
  imageMessage: 'image',
  videoMessage: 'video',
  audioMessage: 'audio',
  documentMessage: 'document',
  stickerMessage: 'sticker',
  documentWithCaptionMessage: 'document',
};

/**
 * Flatten a Baileys message into a normalized shape the panel understands.
 * Returns { type, text, caption, media } where media = { key, mimetype, fileName }.
 */
export function describeMessage(message) {
  if (!message) return { type: 'system', text: null, caption: null, media: null };

  // Unwrap ephemeral / view-once / device wrappers.
  let m = message;
  if (m.ephemeralMessage) m = m.ephemeralMessage.message ?? m;
  if (m.viewOnceMessage) m = m.viewOnceMessage.message ?? m;
  if (m.viewOnceMessageV2) m = m.viewOnceMessageV2.message ?? m;
  if (m.documentWithCaptionMessage) m = m.documentWithCaptionMessage.message ?? m;

  if (m.conversation) {
    return { type: 'text', text: m.conversation, caption: null, media: null };
  }
  if (m.extendedTextMessage) {
    return { type: 'text', text: m.extendedTextMessage.text ?? '', caption: null, media: null };
  }

  for (const [key, type] of Object.entries(MEDIA_KEYS)) {
    if (m[key]) {
      const node = m[key];
      return {
        type,
        text: null,
        caption: node.caption ?? null,
        media: {
          key,
          mimetype: node.mimetype ?? null,
          fileName: node.fileName ?? node.title ?? null,
        },
      };
    }
  }

  if (m.locationMessage) {
    const l = m.locationMessage;
    return { type: 'location', text: `${l.degreesLatitude},${l.degreesLongitude}`, caption: l.name ?? null, media: null };
  }
  if (m.contactMessage) {
    return { type: 'contact', text: m.contactMessage.displayName ?? null, caption: null, media: null };
  }

  // Client picked an option from an interactive menu / native flow → treat as text.
  if (m.listResponseMessage) {
    const r = m.listResponseMessage;
    return { type: 'text', text: r.title ?? r.singleSelectReply?.selectedRowId ?? '', caption: null, media: null };
  }
  if (m.buttonsResponseMessage) {
    const r = m.buttonsResponseMessage;
    return { type: 'text', text: r.selectedDisplayText ?? r.selectedButtonId ?? '', caption: null, media: null };
  }
  if (m.interactiveResponseMessage) {
    let picked = m.interactiveResponseMessage.body?.text ?? '';
    try {
      const p = JSON.parse(m.interactiveResponseMessage.nativeFlowResponseMessage?.paramsJson ?? '{}');
      picked = p.id || p.selected_id || p.title || picked;
    } catch (e) { /* keep body text */ }
    return { type: 'text', text: picked, caption: null, media: null };
  }
  if (m.templateButtonReplyMessage) {
    return { type: 'text', text: m.templateButtonReplyMessage.selectedDisplayText ?? '', caption: null, media: null };
  }

  return { type: 'system', text: null, caption: null, media: null };
}

export const isOwnJid = (jid, ownJid) => jid && ownJid && jid.split(':')[0].split('@')[0] === ownJid.split(':')[0].split('@')[0];
