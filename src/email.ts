import { Router, Request, Response } from 'express';
import { db, uid, nowISO } from './db';
import { config } from './config';
import { Authed } from './auth';

export const email = Router();
// Public router: Google redirects the browser here with no auth header, so it
// must NOT sit behind requireAuth. The org is identified via the OAuth state param.
export const emailPublic = Router();

// Send an email. v0 records it to the client thread (the front end's mailto hand-off
// still delivers from the user's address). When Gmail is connected with valid tokens,
// this is where the real Gmail API send goes — see sendViaGmail() below.
email.post('/emails/send', async (req: Authed, res: Response) => {
  const { clientId, to, subject, body, attachments, fromName } = req.body || {};
  if (!to) return res.status(400).json({ error: 'recipient (to) required' });

  const cred: any = db.prepare("SELECT * FROM integration_credentials WHERE org_id = ? AND provider = 'gmail'").get(req.orgId);
  let gmailMessageId: string | null = null;
  let delivered = false;
  let sendError = '';

  if (cred) {
    try {
      gmailMessageId = await sendViaGmail(req.orgId!, { to, subject, body, fromName });
      delivered = true;
    } catch (e) {
      sendError = (e as Error).message;
      console.warn('Gmail send failed, recording only:', sendError);
    }
  }

  const id = uid();
  db.prepare(`INSERT INTO emails (id, org_id, client_id, contact_email, direction, subject, body, gmail_message_id, attachments, sent_at)
              VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, req.orgId, clientId || null, to, 'sent', subject || '', body || '', gmailMessageId,
         JSON.stringify(attachments || []), nowISO());

  res.status(201).json({
    id, delivered, via: delivered ? 'gmail-api' : 'recorded',
    error: sendError || undefined,
    note: delivered ? 'Sent through connected Gmail.' : (cred ? ('Gmail did not deliver: ' + sendError) : 'Recorded. Connect Gmail to deliver.'),
  });
});

email.get('/emails', (req: Authed, res: Response) => {
  const dir = req.query.direction;
  const where = ['org_id = ?']; const params: any[] = [req.orgId];
  if (dir) { where.push('direction = ?'); params.push(dir); }
  if (req.query.clientId) { where.push('client_id = ?'); params.push(req.query.clientId); }
  const rows = db.prepare(`SELECT * FROM emails WHERE ${where.join(' AND ')} ORDER BY sent_at DESC`).all(...params);
  res.json(rows.map((r: any) => ({ ...r, attachments: safeParse(r.attachments) })));
});

// --- Gmail OAuth (real flow; needs GOOGLE_* env + a Google Cloud project) ---

email.get('/integrations/gmail/connect', (req: Authed, res: Response) => {
  if (!config.google.clientId) {
    return res.json({ configured: false, message: 'Set GOOGLE_CLIENT_ID/SECRET in .env to enable real Gmail OAuth. Until then the front end uses the mailto hand-off.' });
  }
  const scope = encodeURIComponent('https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly');
  // state should be a signed value tying the callback to this org; simplified here.
  const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${config.google.clientId}` +
    `&redirect_uri=${encodeURIComponent(config.google.redirectUri)}` +
    `&response_type=code&access_type=offline&prompt=consent&scope=${scope}&state=${req.orgId}`;
  res.json({ configured: true, url });
});

emailPublic.get('/integrations/gmail/callback', async (req: Request, res: Response) => {
  const code = String(req.query.code || '');
  const orgId = String(req.query.state || '');
  if (!code || !config.google.clientId) return res.status(400).send('Missing code or Google config.');
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: config.google.clientId, client_secret: config.google.clientSecret,
        redirect_uri: config.google.redirectUri, grant_type: 'authorization_code',
      }),
    });
    const tokens: any = await tokenRes.json();
    if (!tokens.access_token) return res.status(400).json(tokens);
    tokens.expires_at = Date.now() + (tokens.expires_in || 3600) * 1000;
    // PRODUCTION: encrypt this blob at rest (KMS/libsodium) before storing.
    db.prepare(`INSERT INTO integration_credentials (id, org_id, provider, data_encrypted, scopes)
                VALUES (?,?,?,?,?)
                ON CONFLICT(org_id, provider) DO UPDATE SET data_encrypted = excluded.data_encrypted`)
      .run(uid(), orgId, 'gmail', JSON.stringify(tokens), 'gmail.send gmail.readonly');
    res.send('Gmail connected. You can close this tab and return to the app.');
  } catch (e) {
    res.status(500).send('OAuth exchange failed: ' + (e as Error).message);
  }
});

email.post('/integrations/gmail/disconnect', (req: Authed, res: Response) => {
  db.prepare("DELETE FROM integration_credentials WHERE org_id = ? AND provider = 'gmail'").run(req.orgId);
  res.json({ ok: true });
});

// Return a valid Gmail access token for the org, refreshing it via the stored
// refresh_token when the current one has expired. Keeps Gmail working past the ~1h token life.
async function getGmailAccessToken(orgId: string): Promise<string> {
  const cred: any = db.prepare("SELECT * FROM integration_credentials WHERE org_id = ? AND provider = 'gmail'").get(orgId);
  if (!cred) throw new Error('Gmail not connected');
  const tokens: any = JSON.parse(cred.data_encrypted);
  if (tokens.access_token && tokens.expires_at && Date.now() < tokens.expires_at - 60000) return tokens.access_token;
  if (!tokens.refresh_token) throw new Error('Gmail session expired — please reconnect Gmail in Settings.');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.google.clientId, client_secret: config.google.clientSecret,
      refresh_token: tokens.refresh_token, grant_type: 'refresh_token',
    }),
  });
  const data: any = await r.json();
  if (!data.access_token) throw new Error(data?.error_description || 'Could not refresh Gmail — please reconnect.');
  tokens.access_token = data.access_token;
  tokens.expires_at = Date.now() + (data.expires_in || 3600) * 1000;
  db.prepare("UPDATE integration_credentials SET data_encrypted = ? WHERE org_id = ? AND provider = 'gmail'").run(JSON.stringify(tokens), orgId);
  return tokens.access_token;
}

function decodeB64(d: string): string {
  return Buffer.from((d || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}
function extractBody(payload: any): string {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) return decodeB64(payload.body.data);
  if (payload.parts) {
    const plain = payload.parts.find((p: any) => p.mimeType === 'text/plain');
    if (plain?.body?.data) return decodeB64(plain.body.data);
    for (const p of payload.parts) { const b = extractBody(p); if (b) return b; }
  }
  if (payload.body?.data) return decodeB64(payload.body.data);
  return '';
}

// Read recent inbox messages from the connected Gmail (uses the gmail.readonly scope).
email.get('/gmail/messages', async (req: Authed, res: Response) => {
  const cred: any = db.prepare("SELECT 1 FROM integration_credentials WHERE org_id = ? AND provider = 'gmail'").get(req.orgId);
  if (!cred) return res.json({ connected: false, messages: [] });
  try {
    const token = await getGmailAccessToken(req.orgId!);
    const listR = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=20&q=' + encodeURIComponent('in:inbox newer_than:60d'), { headers: { Authorization: `Bearer ${token}` } });
    const list: any = await listR.json();
    if (!listR.ok) throw new Error(list?.error?.message || 'Gmail read error');
    const messages: any[] = [];
    for (const ref of (list.messages || [])) {
      const mR = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${ref.id}?format=full`, { headers: { Authorization: `Bearer ${token}` } });
      const m: any = await mR.json();
      if (!mR.ok) continue;
      const headers = (m.payload?.headers || []) as any[];
      const h = (n: string) => (headers.find((x) => x.name.toLowerCase() === n.toLowerCase())?.value) || '';
      const from = h('From');
      const fromEmail = (from.match(/<([^>]+)>/)?.[1] || from).trim().toLowerCase();
      messages.push({
        id: m.id, from, fromEmail, subject: h('Subject'),
        date: new Date(Number(m.internalDate || Date.now())).toISOString(),
        snippet: (m.snippet || '').slice(0, 300),
        body: extractBody(m.payload).slice(0, 4000),
      });
    }
    res.json({ connected: true, messages });
  } catch (e) {
    res.status(502).json({ connected: true, error: (e as Error).message, messages: [] });
  }
});

// RFC 2047: non-ASCII header text (em dashes, accents, emoji) must be encoded,
// otherwise mail clients show it as garbage like "â€”".
function encodeHeader(text: string): string {
  const t = String(text || '').replace(/[\r\n]+/g, ' ');
  return /^[\x20-\x7E]*$/.test(t) ? t : `=?UTF-8?B?${Buffer.from(t, 'utf8').toString('base64')}?=`;
}

// Display name for the From line: quoted if plain ASCII, RFC 2047-encoded otherwise.
function displayName(name: string): string {
  const n = name.replace(/["\\\r\n]/g, '');
  return /^[\x20-\x7E]*$/.test(n) ? `"${n}"` : encodeHeader(n);
}

// The connected Gmail account's address (needed to build the "From" line). Cached with the tokens.
async function getGmailAddress(orgId: string, accessToken: string): Promise<string> {
  const cred: any = db.prepare("SELECT * FROM integration_credentials WHERE org_id = ? AND provider = 'gmail'").get(orgId);
  const tokens: any = cred ? JSON.parse(cred.data_encrypted) : {};
  if (tokens.email_address) return tokens.email_address;
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: { Authorization: `Bearer ${accessToken}` } });
  const data: any = await r.json();
  if (!r.ok || !data.emailAddress) return '';
  tokens.email_address = data.emailAddress;
  db.prepare("UPDATE integration_credentials SET data_encrypted = ? WHERE org_id = ? AND provider = 'gmail'").run(JSON.stringify(tokens), orgId);
  return data.emailAddress;
}

export async function sendViaGmail(orgId: string, msg: { to: string; subject: string; body: string; fromName?: string }): Promise<string> {
  const accessToken = await getGmailAccessToken(orgId);

  // "From" shows the studio name instead of the Google account's personal name ("Joseph Ai").
  // Priority: name sent with the email > studio name saved on the backend account > STUDIO_FROM_NAME env var.
  const org: any = db.prepare('SELECT name FROM organizations WHERE id = ?').get(orgId);
  const studioName = String(msg.fromName || org?.name || process.env.STUDIO_FROM_NAME || '').trim();
  let fromAddress = '';
  try { fromAddress = await getGmailAddress(orgId, accessToken); } catch { /* fall back to Gmail default */ }
  const fromLine = fromAddress
    ? `From: ${studioName ? `${displayName(studioName)} ` : ''}<${fromAddress}>\r\n`
    : '';

  // HTML bodies (invoices/receipts) go as text/html; plain-text bodies (sign-in codes, lead alerts) as text/plain.
  const isHtml = /<\/?[a-z][\s\S]*>/i.test(msg.body || '');
  // Base64 the body so UTF-8 characters (em dashes, accents) arrive intact instead of as "Ã¢Â€Â".
  const bodyB64 = (Buffer.from(msg.body || '', 'utf8').toString('base64').match(/.{1,76}/g) || []).join('\r\n');

  const mime =
    fromLine +
    `To: ${msg.to}\r\n` +
    `Subject: ${encodeHeader(msg.subject || '')}\r\n` +
    `MIME-Version: 1.0\r\n` +
    `Content-Type: ${isHtml ? 'text/html' : 'text/plain'}; charset=UTF-8\r\n` +
    `Content-Transfer-Encoding: base64\r\n\r\n` +
    bodyB64;

  const raw = Buffer.from(mime, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
  });
  const data: any = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || 'gmail send error');
  return data.id;
}

function safeParse(s: any) { try { return JSON.parse(s); } catch { return []; } }
