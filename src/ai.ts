import { Router, Response } from 'express';
import { db, uid } from './db';
import { config } from './config';
import { Authed } from './auth';

export const ai = Router();

// Resolve which AI provider + key to use for an org: the org's own key if they
// saved one, otherwise the platform key (if the operator set one), otherwise none.
function getOrgAI(orgId?: string): { provider: string; key: string } {
  if (orgId) {
    const c: any = db.prepare("SELECT data_encrypted, scopes FROM integration_credentials WHERE org_id = ? AND provider = 'ai'").get(orgId);
    if (c) {
      try { const d = JSON.parse(c.data_encrypted); if (d && d.key) return { provider: d.provider || c.scopes || 'anthropic', key: d.key }; } catch { /* ignore */ }
    }
  }
  return { provider: 'anthropic', key: config.anthropicKey || '' };
}
function getOrgKey(orgId?: string): string {
  return getOrgAI(orgId).key;
}

type ChatMsg = { role: string; content: string };
async function chat(provider: string, key: string, system: string, messages: ChatMsg[], maxTokens: number): Promise<string> {
  const useOpenAI = provider === 'openai' || (/^sk-/.test(key) && !/^sk-ant-/.test(key));
  if (useOpenAI) {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: config.openaiModel, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, ...messages] }),
    });
    const data: any = await r.json();
    if (!r.ok) throw new Error(data?.error?.message || 'AI error');
    return (data.choices?.[0]?.message?.content || '').trim();
  }
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: config.anthropicModel, max_tokens: maxTokens, system, messages }),
  });
  const data: any = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || 'AI error');
  return (data.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim();
}

async function complete(system: string, user: string, maxTokens = 1024, orgId?: string): Promise<string> {
  const { provider, key } = getOrgAI(orgId);
  if (!key) return `[AI is off] Add your AI key in Settings → AI provider to turn it on.`;
  return chat(provider, key, system, [{ role: 'user', content: user }], maxTokens);
}

function orgContext(orgId: string): string {
  const org: any = db.prepare('SELECT * FROM organizations WHERE id = ?').get(orgId);
  const clients: any[] = db.prepare('SELECT * FROM clients WHERE org_id = ?').all(orgId);
  const lines = [`Studio: ${org?.name}`, `Clients (${clients.length}):`];
  for (const c of clients) {
    const spent = (db.prepare("SELECT COALESCE(SUM(amount),0) s FROM orders WHERE client_id = ? AND paid = 1").get(c.id) as any).s;
    lines.push(`- ${c.name} | ${c.contract_status} ($${c.contract_value}) | spent $${spent} | contact ${c.contact_name || '-'} ${c.contact_email || ''}`);
  }
  const tasks: any[] = db.prepare('SELECT title, due FROM tasks WHERE org_id = ? AND done = 0').all(orgId);
  lines.push('Open tasks: ' + (tasks.map((t) => t.title + (t.due ? ` (due ${t.due})` : '')).join('; ') || 'none'));
  return lines.join('\n');
}

// --- Per-client integration management ---

// Save (or clear) the org's own AI key + provider. Key is never returned.
ai.post('/integrations/ai', (req: Authed, res: Response) => {
  const { provider, key } = req.body || {};
  if (key) {
    db.prepare(`INSERT INTO integration_credentials (id, org_id, provider, data_encrypted, scopes)
                VALUES (?,?, 'ai', ?, ?)
                ON CONFLICT(org_id, provider) DO UPDATE SET data_encrypted = excluded.data_encrypted, scopes = excluded.scopes`)
      // PRODUCTION: encrypt this at rest (KMS/libsodium) before storing.
      .run(uid(), req.orgId, JSON.stringify({ provider: provider || 'anthropic', key }), provider || 'anthropic');
  } else {
    // empty key clears the credential (turn AI off / fall back to platform key)
    db.prepare("DELETE FROM integration_credentials WHERE org_id = ? AND provider = 'ai'").run(req.orgId);
  }
  res.json({ ok: true, hasKey: !!getOrgKey(req.orgId) });
});

// Status of this org's integrations (never returns secrets).
ai.get('/integrations/status', (req: Authed, res: Response) => {
  const aiCred: any = db.prepare("SELECT scopes FROM integration_credentials WHERE org_id = ? AND provider = 'ai'").get(req.orgId);
  const gmail: any = db.prepare("SELECT account_email FROM integration_credentials WHERE org_id = ? AND provider = 'gmail'").get(req.orgId);
  res.json({
    ai: { hasKey: !!getOrgKey(req.orgId), usingOwnKey: !!aiCred, provider: aiCred?.scopes || (config.anthropicKey ? 'platform' : 'none') },
    gmail: { connected: !!gmail, email: gmail?.account_email || '' },
  });
});

// --- AI endpoints (all org-scoped; use the org's key) ---

ai.post('/ai/draft-email', async (req: Authed, res: Response) => {
  const { topic, to, clientId } = req.body || {};
  let thread = '';
  if (clientId) {
    const rows: any[] = db.prepare('SELECT direction, subject, body FROM emails WHERE client_id = ? AND org_id = ? ORDER BY sent_at DESC LIMIT 4').all(clientId, req.orgId);
    thread = rows.map((r) => `[${r.direction}] ${r.subject}: ${r.body}`).join('\n---\n');
  }
  try {
    const txt = await complete(
      'You write warm, professional client emails for a sports-photography studio. Output a ready-to-send email body only (no subject).',
      `Recipient: ${to || ''}\nTopic: ${topic || 'a friendly update'}\nContext:\n${orgContext(req.orgId!)}\nPrior thread:\n${thread || '(none)'}`,
      800, req.orgId,
    );
    res.json({ text: txt });
  } catch (e) { res.status(502).json({ error: (e as Error).message }); }
});

ai.post('/ai/generate-contract', async (req: Authed, res: Response) => {
  const { clientId } = req.body || {};
  const c: any = clientId ? db.prepare('SELECT * FROM clients WHERE id = ? AND org_id = ?').get(clientId, req.orgId) : null;
  try {
    const txt = await complete(
      'You draft concise, plain-English sports-photography service agreements with numbered sections (parties, scope, scheduling, deliverables, pricing, payment, cancellation, image rights & model release, term & renewal, signatures).',
      `Studio context:\n${orgContext(req.orgId!)}\nClient: ${c ? c.name + ' (' + (c.district || '') + ')' : '(unspecified)'}\nContract value: $${c?.contract_value || 0}`,
      1600, req.orgId,
    );
    res.json({ text: txt });
  } catch (e) { res.status(502).json({ error: (e as Error).message }); }
});

ai.post('/ai/assistant', async (req: Authed, res: Response) => {
  const { message } = req.body || {};
  try {
    const txt = await complete(
      `You are the assistant inside a sports-photography platform. Be concise and specific to this studio's data. Data:\n${orgContext(req.orgId!)}`,
      String(message || ''), 1024, req.orgId,
    );
    res.json({ text: txt });
  } catch (e) { res.status(502).json({ error: (e as Error).message }); }
});

ai.post('/ai/summarize', async (req: Authed, res: Response) => {
  const { clientId } = req.body || {};
  const rows: any[] = db.prepare('SELECT direction, subject, body FROM emails WHERE client_id = ? AND org_id = ?').all(clientId, req.orgId);
  try {
    const txt = await complete('Summarize this client email history into 3-5 crisp bullet points and one suggested next action.',
      rows.map((r) => `[${r.direction}] ${r.subject}: ${r.body}`).join('\n') || 'No emails.', 600, req.orgId);
    res.json({ text: txt });
  } catch (e) { res.status(502).json({ error: (e as Error).message }); }
});

// Generic passthrough used by the front end's callAI({system,messages}).
ai.post('/ai/complete', async (req: Authed, res: Response) => {
  const { system, messages, max_tokens } = req.body || {};
  const { provider, key } = getOrgAI(req.orgId);
  if (!key) return res.json({ text: '[AI is off] Add your AI key in Settings → AI provider to turn it on.' });
  try {
    const txt = await chat(provider, key, system || '', messages || [], max_tokens || 1024);
    res.json({ text: txt });
  } catch (e) { res.status(502).json({ error: (e as Error).message }); }
});

export const aiEnabled = !!config.anthropicKey;
