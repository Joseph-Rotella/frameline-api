import { Router, Response } from 'express';
import { db, uid } from './db';
import { config } from './config';
import { Authed } from './auth';

/*
 * Plaid bank connections. Uses Plaid's REST API directly (no SDK), same style as payments.ts.
 *
 * Flow:
 *   1. POST /plaid/link-token        → front end opens Plaid Link with the returned link_token
 *   2. POST /plaid/exchange          → front end sends the public_token Link gave it; we store the access_token
 *   3. GET  /plaid/accounts          → balances for every linked bank
 *   4. GET  /plaid/transactions      → new/changed transactions since the last call (transactions/sync)
 *   5. DELETE /plaid/items/:id       → unlink a bank
 *
 * Sandbox only: POST /plaid/sandbox/connect links a fake bank in one call (no Link UI needed),
 * so the whole flow can be tested from the smoke-test console or curl.
 */

export const plaid = Router();

const HOSTS: Record<string, string> = {
  sandbox: 'https://sandbox.plaid.com',
  development: 'https://development.plaid.com',
  production: 'https://production.plaid.com',
};

export const plaidEnabled = !!(config.plaid.clientId && config.plaid.secret);
const baseUrl = HOSTS[config.plaid.env] || HOSTS.sandbox;

async function plaidPost(path: string, body: Record<string, unknown>): Promise<any> {
  const r = await fetch(baseUrl + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: config.plaid.clientId, secret: config.plaid.secret, ...body }),
  });
  const data: any = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err: any = new Error(data?.error_message || `Plaid ${path} failed (${r.status})`);
    err.status = r.status;
    err.plaid = { error_type: data?.error_type, error_code: data?.error_code, request_id: data?.request_id };
    throw err;
  }
  return data;
}

function fail(res: Response, e: any) {
  res.status(e?.status && e.status < 500 ? 400 : 502).json({ error: e?.message || 'plaid error', ...(e?.plaid || {}) });
}

function notConfigured(res: Response) {
  return res.status(503).json({ configured: false, message: 'Set PLAID_CLIENT_ID, PLAID_SECRET and PLAID_ENV to enable bank linking.' });
}

function saveItem(orgId: string, itemId: string, accessToken: string, institution: string | null) {
  const existing: any = db.prepare('SELECT id FROM plaid_items WHERE item_id = ?').get(itemId);
  if (existing) {
    db.prepare('UPDATE plaid_items SET access_token = ?, institution_name = COALESCE(?, institution_name) WHERE id = ?')
      .run(accessToken, institution, existing.id);
    return existing.id;
  }
  const id = uid();
  db.prepare('INSERT INTO plaid_items (id, org_id, item_id, access_token, institution_name) VALUES (?,?,?,?,?)')
    .run(id, orgId, itemId, accessToken, institution);
  return id;
}

function itemsFor(orgId: string): any[] {
  return db.prepare('SELECT * FROM plaid_items WHERE org_id = ? ORDER BY created_at').all(orgId);
}

// 1. Link token for Plaid Link on the front end.
plaid.post('/plaid/link-token', async (req: Authed, res: Response) => {
  if (!plaidEnabled) return notConfigured(res);
  try {
    const data = await plaidPost('/link/token/create', {
      user: { client_user_id: String(req.orgId) },
      client_name: 'Frameline',
      products: ['transactions'],
      country_codes: ['US'],
      language: 'en',
    });
    res.json({ link_token: data.link_token, expiration: data.expiration, env: config.plaid.env });
  } catch (e) { fail(res, e); }
});

// 2. Exchange the public_token from Link for a stored access_token.
plaid.post('/plaid/exchange', async (req: Authed, res: Response) => {
  if (!plaidEnabled) return notConfigured(res);
  const { public_token, institution_name } = req.body || {};
  if (!public_token) return res.status(400).json({ error: 'public_token required' });
  try {
    const data = await plaidPost('/item/public_token/exchange', { public_token });
    const id = saveItem(String(req.orgId), data.item_id, data.access_token, institution_name || null);
    res.json({ ok: true, id, institution_name: institution_name || null });
  } catch (e) { fail(res, e); }
});

// Sandbox shortcut: link a fake bank without the Link UI.
plaid.post('/plaid/sandbox/connect', async (req: Authed, res: Response) => {
  if (!plaidEnabled) return notConfigured(res);
  if (config.plaid.env !== 'sandbox') return res.status(400).json({ error: 'only available when PLAID_ENV=sandbox' });
  const institution_id = (req.body && req.body.institution_id) || 'ins_109508'; // "First Platypus Bank"
  try {
    const pub = await plaidPost('/sandbox/public_token/create', { institution_id, initial_products: ['transactions'] });
    const ex = await plaidPost('/item/public_token/exchange', { public_token: pub.public_token });
    const id = saveItem(String(req.orgId), ex.item_id, ex.access_token, 'Sandbox Bank');
    res.json({ ok: true, id, institution_name: 'Sandbox Bank' });
  } catch (e) { fail(res, e); }
});

// List linked banks (never returns access tokens).
plaid.get('/plaid/items', (req: Authed, res: Response) => {
  const rows = itemsFor(String(req.orgId)).map((r) => ({ id: r.id, institution_name: r.institution_name, created_at: r.created_at }));
  res.json({ configured: plaidEnabled, env: config.plaid.env, items: rows });
});

// 3. Accounts + balances across every linked bank.
plaid.get('/plaid/accounts', async (req: Authed, res: Response) => {
  if (!plaidEnabled) return notConfigured(res);
  try {
    const out: any[] = [];
    for (const item of itemsFor(String(req.orgId))) {
      const data = await plaidPost('/accounts/get', { access_token: item.access_token });
      for (const a of data.accounts || []) {
        out.push({
          item_id: item.id,
          institution_name: item.institution_name,
          account_id: a.account_id,
          name: a.name,
          mask: a.mask,
          type: a.type,
          subtype: a.subtype,
          balance_current: a.balances?.current ?? null,
          balance_available: a.balances?.available ?? null,
          currency: a.balances?.iso_currency_code || 'USD',
        });
      }
    }
    res.json({ accounts: out });
  } catch (e) { fail(res, e); }
});

// 4. Transactions via /transactions/sync. Returns changes since the last call;
//    pass ?full=1 to restart from the beginning (e.g. on first load of a page).
plaid.get('/plaid/transactions', async (req: Authed, res: Response) => {
  if (!plaidEnabled) return notConfigured(res);
  const full = req.query.full === '1';
  try {
    const added: any[] = [], modified: any[] = [], removed: any[] = [];
    for (const item of itemsFor(String(req.orgId))) {
      let cursor: string | undefined = full ? undefined : item.cursor || undefined;
      let hasMore = true;
      let pages = 0;
      while (hasMore && pages < 20) {
        const data = await plaidPost('/transactions/sync', { access_token: item.access_token, ...(cursor ? { cursor } : {}), count: 500 });
        const tag = (t: any) => ({
          item_id: item.id,
          institution_name: item.institution_name,
          transaction_id: t.transaction_id,
          account_id: t.account_id,
          date: t.date,
          name: t.merchant_name || t.name,
          amount: t.amount, // Plaid: positive = money out, negative = money in
          category: t.personal_finance_category?.primary || (t.category || [])[0] || null,
          pending: !!t.pending,
        });
        added.push(...(data.added || []).map(tag));
        modified.push(...(data.modified || []).map(tag));
        removed.push(...(data.removed || []).map((t: any) => ({ item_id: item.id, transaction_id: t.transaction_id })));
        cursor = data.next_cursor;
        hasMore = !!data.has_more;
        pages++;
      }
      db.prepare('UPDATE plaid_items SET cursor = ? WHERE id = ?').run(cursor || null, item.id);
    }
    added.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    res.json({ added, modified, removed });
  } catch (e) { fail(res, e); }
});

// 5. Unlink a bank.
plaid.delete('/plaid/items/:id', async (req: Authed, res: Response) => {
  const item: any = db.prepare('SELECT * FROM plaid_items WHERE id = ? AND org_id = ?').get(req.params.id, req.orgId);
  if (!item) return res.status(404).json({ error: 'not found' });
  if (plaidEnabled) {
    try { await plaidPost('/item/remove', { access_token: item.access_token }); } catch { /* remove locally anyway */ }
  }
  db.prepare('DELETE FROM plaid_items WHERE id = ?').run(item.id);
  res.json({ ok: true });
});
