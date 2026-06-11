import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { db, uid, nowISO } from './db';
import { config } from './config';
import { Authed } from './auth';

const DAY = 86400000;
const SHARE_DAYS = 30;
const publicBase = (req: Request) => `${req.protocol}://${req.get('host')}`;
const plusDays = (d: number) => new Date(Date.now() + d * DAY).toISOString();
const isExpired = (g: any) => !g.expires_at || Date.parse(g.expires_at) < Date.now();

function shareInfo(req: Request, g: any) {
  const expired = !!g.share_token && !!g.expires_at && Date.parse(g.expires_at) < Date.now();
  const active = !!g.share_token && !!g.expires_at && !expired;
  return {
    token: g.share_token || null,
    url: g.share_token ? `${publicBase(req)}/s/${g.share_token}` : null,
    expiresAt: g.expires_at || null,
    expired,
    active,
  };
}

/* ---- Owner endpoints (auth) ---- */
export const shareOwner = Router();

shareOwner.get('/galleries/:id/share', (req: Authed, res: Response) => {
  const g: any = db.prepare('SELECT * FROM galleries WHERE id = ? AND org_id = ?').get(req.params.id, req.orgId);
  if (!g) return res.status(404).json({ error: 'not found' });
  res.json(shareInfo(req, g));
});

// Create a link (if none) OR renew the 30-day window. Reactivates an expired gallery record.
function openShare(req: Authed, res: Response) {
  const g: any = db.prepare('SELECT * FROM galleries WHERE id = ? AND org_id = ?').get(req.params.id, req.orgId);
  if (!g) return res.status(404).json({ error: 'not found' });
  const token = g.share_token || ('g' + uid().replace(/-/g, '').slice(0, 18));
  db.prepare("UPDATE galleries SET share_token = ?, expires_at = ?, status = CASE WHEN status = 'expired' THEN 'ready' ELSE status END WHERE id = ?")
    .run(token, plusDays(SHARE_DAYS), g.id);
  const g2: any = db.prepare('SELECT * FROM galleries WHERE id = ?').get(g.id);
  res.json(shareInfo(req, g2));
}
shareOwner.post('/galleries/:id/share', openShare);
shareOwner.post('/galleries/:id/share/renew', openShare);

shareOwner.post('/galleries/:id/share/revoke', (req: Authed, res: Response) => {
  db.prepare('UPDATE galleries SET share_token = NULL, expires_at = NULL WHERE id = ? AND org_id = ?').run(req.params.id, req.orgId);
  res.json({ ok: true });
});

/* ---- Public endpoints (no auth) ---- */
export const sharePublic = Router();

sharePublic.get('/s/:token', (req: Request, res: Response) => {
  const g: any = db.prepare('SELECT * FROM galleries WHERE share_token = ?').get(req.params.token);
  if (!g || isExpired(g)) return res.status(410).send(expiredPage());
  const org: any = db.prepare('SELECT name FROM organizations WHERE id = ?').get(g.org_id);
  const photos: any[] = db.prepare("SELECT * FROM photos WHERE gallery_id = ? AND status != 'expired'").all(g.id);
  const pkgs: any[] = db.prepare('SELECT name, price FROM packages WHERE org_id = ?').all(g.org_id);
  res.send(publicPage(publicBase(req), g, org?.name || 'Photography', photos, pkgs));
});

sharePublic.post('/s/:token/order', (req: Request, res: Response) => {
  const g: any = db.prepare('SELECT * FROM galleries WHERE share_token = ?').get(req.params.token);
  if (!g || isExpired(g)) return res.status(410).json({ error: 'link expired' });
  const { athleteName, email, pkg } = req.body || {};
  const p: any = db.prepare('SELECT price FROM packages WHERE org_id = ? AND name = ?').get(g.org_id, pkg);
  const id = uid();
  db.prepare(`INSERT INTO orders (id, org_id, client_id, athlete_name, package, amount, paid, date, source)
              VALUES (?,?,?,?,?,?,0,?, 'parent_store')`)
    .run(id, g.org_id, g.client_id, athleteName || email || 'Guest', pkg || '', p?.price || 0, nowISO().slice(0, 10));
  res.json({ ok: true });
});

/* ---- Auto-purge expired galleries' files (saves storage) ---- */
export function purgeExpired(): number {
  const rows: any[] = db.prepare("SELECT * FROM galleries WHERE expires_at IS NOT NULL AND expires_at < ? AND status != 'expired'").all(nowISO());
  let files = 0;
  for (const g of rows) {
    const dir = path.join(config.uploadDir, g.id);
    if (fs.existsSync(dir)) {
      try { for (const f of fs.readdirSync(dir)) { fs.unlinkSync(path.join(dir, f)); files++; } fs.rmdirSync(dir); } catch { /* ignore */ }
    }
    db.prepare('DELETE FROM photos WHERE gallery_id = ?').run(g.id);
    db.prepare("UPDATE galleries SET status = 'expired' WHERE id = ?").run(g.id);
  }
  if (rows.length) console.log(`  Purged ${rows.length} expired gallery file set(s) (${files} files freed).`);
  return rows.length;
}

/* ---- Public HTML (the owner's content; minimal, self-contained) ---- */
function esc(s: any) { return (s == null ? '' : String(s)).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as any)[c]); }

function publicPage(base: string, g: any, studio: string, photos: any[], pkgs: any[]): string {
  const img = (p: any) => `${base}/uploads/${p.thumb_key || p.original_key}`;
  const full = (p: any) => `${base}/uploads/${p.original_key}`;
  const tiles = photos.length
    ? photos.map((p) => `<a class="ph" href="${full(p)}" target="_blank"><img loading="lazy" src="${img(p)}" alt=""></a>`).join('')
    : `<p class="muted">Photos are being prepared — check back soon.</p>`;
  const opts = pkgs.map((p) => `<option value="${esc(p.name)}">${esc(p.name)} — $${p.price}</option>`).join('');
  const exp = g.expires_at ? new Date(g.expires_at).toLocaleDateString() : '';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(g.name)} — ${esc(studio)}</title><style>
:root{--ink:#1C1A17;--paper:#F1F0EC;--line:#DEDBD3;--accent:#9E2B25;}
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:var(--paper);color:var(--ink)}
.hero{background:linear-gradient(150deg,#241F1A,#3a3128);color:#F1EDE4;padding:30px 18px}
.wrap{max-width:1000px;margin:0 auto;padding:18px}
.kick{font-size:11px;letter-spacing:.2em;color:#C8A86A;text-transform:uppercase}
h1{margin:6px 0 2px;font-size:26px}.muted{color:#8C867B}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin:18px 0}
.ph{display:block;border-radius:10px;overflow:hidden;border:1px solid var(--line);background:#2b2620;aspect-ratio:4/3}
.ph img{width:100%;height:100%;object-fit:cover;display:block}
.card{background:#fff;border:1px solid var(--line);border-radius:13px;padding:18px;margin-top:16px}
label{display:block;font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#6A6458;margin:10px 0 4px}
input,select{width:100%;padding:10px 12px;border:1px solid #C9C5BB;border-radius:9px;font-size:15px}
button{margin-top:16px;background:var(--accent);color:#fff;border:none;border-radius:9px;padding:12px 18px;font-weight:700;font-size:15px;cursor:pointer}
.note{font-size:12px;color:#8C867B;margin-top:14px}.ok{color:#3C5132;font-weight:700}
</style></head><body>
<div class="hero"><div class="wrap"><div class="kick">${esc(studio)} · team &amp; individual photos</div><h1>${esc(g.name)}</h1>${exp ? `<div class="muted" style="color:#C7BFB1">Available to order through ${esc(exp)}</div>` : ''}</div></div>
<div class="wrap">
  <div class="grid">${tiles}</div>
  <div class="card"><h2 style="margin-top:0">Place an order</h2>
    <label>Athlete name</label><input id="ath" placeholder="Athlete name">
    <label>Your email</label><input id="email" type="email" placeholder="you@email.com">
    <label>Package</label><select id="pkg">${opts || '<option>Standard</option>'}</select>
    <button id="go">Place order</button>
    <div id="msg" class="note"></div>
    <div class="note">After you order, ${esc(studio)} will follow up about payment and prints.</div>
  </div>
</div>
<script>
  document.getElementById('go').onclick=async()=>{
    const body={athleteName:document.getElementById('ath').value,email:document.getElementById('email').value,pkg:document.getElementById('pkg').value};
    if(!body.athleteName){document.getElementById('msg').textContent='Please enter the athlete name.';return;}
    try{const r=await fetch(location.pathname+'/order',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      if(!r.ok)throw 0;document.getElementById('msg').innerHTML='<span class="ok">Order received — thank you!</span>';
      document.getElementById('go').disabled=true;
    }catch(e){document.getElementById('msg').textContent='Something went wrong — please try again.';}
  };
</script>
</body></html>`;
}

function expiredPage(): string {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Link expired</title>
<style>body{margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#F1F0EC;color:#1C1A17;display:grid;place-items:center;height:100vh;text-align:center;padding:20px}
h1{font-size:22px}p{color:#8C867B;max-width:420px}</style></head>
<body><div><h1>This gallery link has expired</h1><p>Ordering for this gallery has closed. Please contact your photographer to have the gallery re-opened.</p></div></body></html>`;
}
