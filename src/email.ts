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
  const { clientId, to, subject, body, attachments } = req.body || {};
  if (!to) return res.status(400).json({ error: 'recipient (to) required' });

  const cred: any = db.prepare("SELECT * FROM integration_credentials WHERE org_id = ? AND provider = 'gmail'").get(req.orgId);
  let gmailMessageId: string | null = null;
  let delivered = false;

  if (cred) {
    try {
      gmailMessageId = await sendViaGmail(cred, { to, subject, body });
      delivered = true;
    } catch (e) {
      // Fall back to record-only; surface the reason for debugging.
      console.warn('Gmail send failed, recording only:', (e as Error).message);
    }
  }

  const id = uid();
  db.prepare(`INSERT INTO emails (id, org_id, client_id, contact_email, direction, subject, body, gmail_message_id, attachments, sent_at)
              VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, req.orgId, clientId || null, to, 'sent', subject || '', body || '', gmailMessageId,
         JSON.stringify(attachments || []), nowISO());

  res.status(201).json({ id, delivered, via: delivered ? 'gmail-api' : 'recorded', note: delivered ? 'Sent through connected Gmail.' : 'Recorded to thread. Connect Gmail (or use the mailto hand-off) to deliver.' });
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
    // PRODUCTION: encrypt this blob at rest (KMS/libsodium) before storing.
    db.prepare(`INSERT INTO integration_credentials (id, org_id, provider, data_encrypted, scopes)
                VALUES (?,?,?,?,?)
                ON CONFLICT(org_id, provider) DO UPDATE SET data_encrypted = excluded.data_encrypted`)
      .run(uid(), orgId, 'gmail', JSON.stringify(tokens), 'gmail.send gmail.readonly');
    res.send('Gmail connected. You can close this tab and return to Frameline.');
  } catch (e) {
    res.status(500).send('OAuth exchange failed: ' + (e as Error).message);
  }
});

email.post('/integrations/gmail/disconnect', (req: Authed, res: Response) => {
  db.prepare("DELETE FROM integration_credentials WHERE org_id = ? AND provider = 'gmail'").run(req.orgId);
  res.json({ ok: true });
});

async function sendViaGmail(cred: any, msg: { to: string; subject: string; body: string }): Promise<string> {
  const tokens = JSON.parse(cred.data_encrypted);
  // NOTE: production must refresh the access token using the refresh_token when expired.
  const raw = Buffer.from(
    `To: ${msg.to}\r\nSubject: ${msg.subject}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${msg.body}`
  ).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokens.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
  });
  const data: any = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || 'gmail send error');
  return data.id;
}

function safeParse(s: any) { try { return JSON.parse(s); } catch { return []; } }
