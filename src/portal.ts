import { Router, Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { db, uid, nowISO } from './db';
import { config } from './config';
import { sendViaGmail } from './email';

export const portal = Router();        // public, no studio auth
export const portalOwner = Router();   // studio-auth, returns the link

const esc = (s: any) => (s == null ? '' : String(s)).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as any)[c]);
const base = (req: Request) => `${req.protocol}://${req.get('host')}`;
const digits = (s: any) => String(s || '').replace(/\D/g, '');
const last10 = (s: any) => digits(s).slice(-10);
function maskEmail(e: string) {
  const [u, d] = String(e).split('@');
  if (!d) return e;
  const head = u.length <= 2 ? u[0] || '' : u.slice(0, 2);
  return `${head}${'*'.repeat(Math.max(2, u.length - 2))}@${d}`;
}
function org(id: string): any { return db.prepare('SELECT id, name FROM organizations WHERE id = ?').get(id); }

// ---- find a parent's email from an email or phone they typed ----
function resolveEmail(orgId: string, idType: string, value: string): string {
  if (idType === 'email') {
    const e = String(value || '').trim().toLowerCase();
    if (!e || e.indexOf('@') < 0) return '';
    const hit =
      db.prepare('SELECT 1 FROM orders WHERE org_id = ? AND lower(email) = ? LIMIT 1').get(orgId, e) ||
      db.prepare('SELECT 1 FROM clients WHERE org_id = ? AND lower(contact_email) = ? LIMIT 1').get(orgId, e) ||
      db.prepare('SELECT 1 FROM athletes WHERE org_id = ? AND lower(parent_email) = ? LIMIT 1').get(orgId, e);
    return hit ? e : '';
  }
  // phone -> look up the email on file for that number
  const want = last10(value);
  if (want.length < 7) return '';
  const pools: any[] = [
    ...db.prepare("SELECT email AS e, phone AS p FROM orders WHERE org_id = ? AND email IS NOT NULL AND email != ''").all(orgId),
    ...db.prepare("SELECT contact_email AS e, contact_phone AS p FROM clients WHERE org_id = ?").all(orgId),
    ...db.prepare("SELECT parent_email AS e, parent_phone AS p FROM athletes WHERE org_id = ?").all(orgId),
  ];
  const hit = pools.find((r) => r.e && last10(r.p) === want);
  return hit ? String(hit.e).trim().toLowerCase() : '';
}

// ---- parent session (JWT) ----
interface ParentReq extends Request { parentEmail?: string; parentOrg?: string; }
function requireParent(req: ParentReq, res: Response, next: NextFunction) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'sign in' });
  try {
    const p: any = jwt.verify(token, config.jwtSecret);
    if (p.kind !== 'parent' || p.org !== req.params.org) return res.status(401).json({ error: 'sign in' });
    req.parentEmail = p.email; req.parentOrg = p.org; next();
  } catch { return res.status(401).json({ error: 'sign in' }); }
}

// ===== request a one-time code =====
portal.post('/portal/:org/request-code', async (req: Request, res: Response) => {
  const o = org(req.params.org);
  if (!o) return res.status(404).json({ error: 'not found' });
  const { idType, value } = req.body || {};
  const email = resolveEmail(o.id, idType === 'phone' ? 'phone' : 'email', value);
  if (!email) return res.json({ ok: true, sent: false, message: 'We couldn\'t find photos for that info. Check with your photographer, or try the email/number you gave them.' });
  const code = String(Math.floor(100000 + Math.random() * 900000));
  db.prepare('DELETE FROM parent_codes WHERE org_id = ? AND email = ?').run(o.id, email);
  db.prepare('INSERT INTO parent_codes (id, org_id, email, code, expires_at) VALUES (?,?,?,?,?)')
    .run(uid(), o.id, email, code, new Date(Date.now() + 15 * 60 * 1000).toISOString());
  try {
    await sendViaGmail(o.id, {
      to: email,
      subject: `Your ${o.name} sign-in code: ${code}`,
      body: `Hi,\n\nYour one-time sign-in code for the ${o.name} photo portal is:\n\n    ${code}\n\nIt expires in 15 minutes. If you didn't request this, you can ignore this email.\n\n${o.name}`,
    });
  } catch (e: any) {
    return res.status(503).json({ ok: false, reason: 'studio-email', message: 'The studio\'s email isn\'t set up to send codes yet. Please contact your photographer.' });
  }
  res.json({ ok: true, sent: true, email: maskEmail(email), challenge: jwt.sign({ kind: 'parent-challenge', org: o.id, email }, config.jwtSecret, { expiresIn: '15m' }) });
});

// ===== verify code -> issue parent token =====
portal.post('/portal/:org/verify', (req: Request, res: Response) => {
  const o = org(req.params.org);
  if (!o) return res.status(404).json({ error: 'not found' });
  const { challenge, code } = req.body || {};
  let email = '';
  try {
    const p: any = jwt.verify(String(challenge || ''), config.jwtSecret);
    if (p.kind !== 'parent-challenge' || p.org !== o.id) throw 0;
    email = p.email;
  } catch { return res.json({ ok: false, message: 'Your sign-in request expired — request a new code.' }); }
  const row: any = db.prepare('SELECT * FROM parent_codes WHERE org_id = ? AND email = ?').get(o.id, email);
  if (!row || row.expires_at < nowISO()) return res.json({ ok: false, message: 'That code has expired — request a new one.' });
  if (row.attempts >= 5) { db.prepare('DELETE FROM parent_codes WHERE id = ?').run(row.id); return res.json({ ok: false, message: 'Too many tries — request a new code.' }); }
  if (row.code !== String(code || '').trim()) {
    db.prepare('UPDATE parent_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
    return res.json({ ok: false, message: 'That code didn\'t match. Try again.' });
  }
  db.prepare('DELETE FROM parent_codes WHERE id = ?').run(row.id);
  res.json({ ok: true, token: jwt.sign({ kind: 'parent', org: o.id, email }, config.jwtSecret, { expiresIn: '7d' }) });
});

// ===== parent profile =====
portal.get('/portal/:org/me', requireParent, (req: ParentReq, res: Response) => {
  const o = org(req.params.org);
  const email = req.parentEmail as string;
  const orders: any[] = db.prepare("SELECT * FROM orders WHERE org_id = ? AND lower(email) = ? ORDER BY date DESC").all(o.id, email);
  // also surface galleries for any client this parent has ordered from
  const clientIds = Array.from(new Set(orders.map((x) => x.client_id).filter(Boolean)));
  let gals: any[] = [];
  if (clientIds.length) {
    const ph = clientIds.map(() => '?').join(',');
    gals = db.prepare(`SELECT * FROM galleries WHERE org_id = ? AND client_id IN (${ph}) AND share_token IS NOT NULL`).all(o.id, ...clientIds);
  }
  const b = base(req);
  res.json({
    studio: o.name,
    email,
    orders: orders.map((x) => ({
      athlete: x.athlete_name, package: x.package, amount: x.amount, paid: !!x.paid, date: x.date,
      photos: (() => { try { return JSON.parse(x.selections || '[]'); } catch { return []; } })(),
    })),
    galleries: gals.map((g) => ({
      name: g.name,
      unlocked: !!g.downloads_open,
      viewUrl: `${b}/s/${g.share_token}`,
      downloadUrl: g.downloads_open ? `${b}/s/${g.share_token}/download` : null,
    })),
  });
});

// ===== landing + portal page =====
portal.get('/portal/:org', (req: Request, res: Response) => {
  const o = org(req.params.org);
  if (!o) return res.status(404).type('html').send('<p style="font-family:sans-serif;padding:40px">Portal not found.</p>');
  // active galleries to order from
  const gals: any[] = db.prepare("SELECT g.name AS name, g.share_token AS token, c.name AS client FROM galleries g LEFT JOIN clients c ON c.id = g.client_id WHERE g.org_id = ? AND g.share_token IS NOT NULL AND (g.expires_at IS NULL OR g.expires_at > ?) ORDER BY g.created_at DESC").all(o.id, nowISO());
  const b = base(req);
  const teamCards = gals.length
    ? gals.map((g) => `<a class="team" href="${b}/s/${esc(g.token)}"><div class="tn">${esc(g.name)}</div>${g.client ? `<div class="tc">${esc(g.client)}</div>` : ''}<div class="go">Order &rarr;</div></a>`).join('')
    : `<p class="muted">No photo galleries are open for ordering right now.</p>`;
  res.set('Cache-Control', 'no-store');
  res.type('html').send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.name)} — Photos</title><style>
:root{--ink:#1C1A17;--paper:#F1F0EC;--line:#DEDBD3;--accent:#9E2B25;}
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:var(--paper);color:var(--ink)}
.hero{background:linear-gradient(150deg,#241F1A,#3a3128);color:#F1EDE4;padding:40px 18px 34px}
.wrap{max-width:860px;margin:0 auto;padding:18px}
.kick{font-size:11px;letter-spacing:.2em;color:#C8A86A;text-transform:uppercase}
h1{margin:8px 0 4px;font-size:30px}.sub{color:#C7BFB1;margin:0}
h2{font-size:18px;margin:26px 0 12px}.muted{color:#8C867B}
.teams{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}
.team{display:block;background:#fff;border:1px solid var(--line);border-radius:13px;padding:16px;text-decoration:none;color:inherit;box-shadow:0 1px 0 rgba(0,0,0,.03)}
.team:hover{border-color:var(--accent)}
.tn{font-weight:700;font-size:15px}.tc{color:#8C867B;font-size:12.5px;margin-top:2px}.go{color:var(--accent);font-weight:700;font-size:13px;margin-top:10px}
.card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:22px;margin-top:14px}
.seg{display:flex;gap:6px;background:#EEEAE2;border-radius:10px;padding:4px;margin-bottom:14px;max-width:280px}
.seg button{flex:1;border:none;background:none;padding:8px;border-radius:7px;font-weight:600;font-size:13px;cursor:pointer;color:#6A6458}
.seg button.on{background:#fff;color:var(--ink)}
label{display:block;font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#6A6458;margin:10px 0 4px}
input{width:100%;padding:11px 12px;border:1px solid #C9C5BB;border-radius:9px;font-size:16px}
button.go-btn{margin-top:14px;background:var(--accent);color:#fff;border:none;border-radius:9px;padding:12px 20px;font-weight:700;font-size:15px;cursor:pointer}
.note{font-size:12.5px;color:#8C867B;margin-top:10px}.err{color:var(--accent);font-size:13px;margin-top:8px}
.ord{border:1px solid var(--line);border-radius:11px;padding:14px;margin-bottom:10px}
.ord .h{display:flex;justify-content:space-between;gap:10px}.ord b{font-size:15px}
.pill{display:inline-block;font-size:11px;font-weight:700;border-radius:20px;padding:3px 9px}
.pill.paid{background:#E7F0E3;color:#3C5132}.pill.due{background:#F6E7C9;color:#8a6d1e}
.glink{display:inline-block;background:var(--accent);color:#fff;text-decoration:none;border-radius:8px;padding:9px 15px;font-weight:700;font-size:13px;margin-top:8px}
.glock{font-size:12.5px;color:#8C867B;margin-top:8px}
.signout{background:none;border:1px solid var(--line);border-radius:8px;padding:7px 14px;font-size:13px;cursor:pointer;color:#6A6458}
.hidden{display:none}
</style></head><body>
<div class="hero"><div class="wrap"><div class="kick">${esc(o.name)}</div><h1>Your team photos</h1><p class="sub">Find your team to order, or sign in to see your orders and downloads.</p></div></div>
<div class="wrap">
  <h2>Find your team & order</h2>
  <div class="teams">${teamCards}</div>

  <h2>Your photos & orders</h2>
  <div class="card" id="loginCard">
    <div class="seg"><button class="on" id="tab-email" type="button">Email</button><button id="tab-phone" type="button">Phone</button></div>
    <div id="step1">
      <label id="idlabel">Email address</label>
      <input id="idval" type="email" placeholder="you@email.com">
      <button class="go-btn" id="sendCode" type="button">Send me a code</button>
      <div class="err" id="err1"></div>
      <div class="note">We'll email you a 6-digit code to sign in — no password needed. Photos and orders are private to you.</div>
    </div>
    <div id="step2" class="hidden">
      <label>Enter the 6-digit code sent to <b id="maskEmail"></b></label>
      <input id="codeval" inputmode="numeric" placeholder="123456" maxlength="6">
      <button class="go-btn" id="verify" type="button">Sign in</button>
      <div class="err" id="err2"></div>
      <div class="note"><a href="#" id="restart">Use a different email/phone</a></div>
    </div>
  </div>
  <div class="card hidden" id="profile"></div>
</div>
<script>
  var ORG=${JSON.stringify(o.id)};var API=location.pathname.replace(/\\/$/,'');var idType='email';var TOK=null;
  function $(id){return document.getElementById(id);}
  function setTab(t){idType=t;$('tab-email').classList.toggle('on',t==='email');$('tab-phone').classList.toggle('on',t==='phone');
    $('idlabel').textContent=t==='email'?'Email address':'Mobile number';$('idval').type=t==='email'?'email':'tel';$('idval').placeholder=t==='email'?'you@email.com':'(555) 123-4567';$('idval').value='';$('err1').textContent='';}
  $('tab-email').onclick=function(){setTab('email');};$('tab-phone').onclick=function(){setTab('phone');};
  $('sendCode').onclick=async function(){
    $('err1').textContent='';var v=$('idval').value.trim();if(!v){$('err1').textContent='Please enter your '+(idType==='email'?'email':'number')+'.';return;}
    $('sendCode').disabled=true;
    try{var r=await fetch(API+'/request-code',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({idType:idType,value:v})});var d=await r.json();
      if(d.sent){window.__challenge=d.challenge;$('maskEmail').textContent=d.email;$('step1').classList.add('hidden');$('step2').classList.remove('hidden');$('codeval').focus();}
      else{$('err1').textContent=d.message||'We couldn\\'t find a match.';}
    }catch(e){$('err1').textContent='Something went wrong. Please try again.';}
    $('sendCode').disabled=false;
  };
  $('restart').onclick=function(e){e.preventDefault();$('step2').classList.add('hidden');$('step1').classList.remove('hidden');$('codeval').value='';$('err2').textContent='';};
  $('verify').onclick=async function(){
    $('err2').textContent='';var code=$('codeval').value.trim();if(code.length<6){$('err2').textContent='Enter the 6-digit code.';return;}
    $('verify').disabled=true;
    try{var r=await fetch(API+'/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({challenge:window.__challenge,code:code})});var d=await r.json();
      if(d.ok&&d.token){TOK=d.token;await loadProfile();}else{$('err2').textContent=d.message||'That code didn\\'t work.';}
    }catch(e){$('err2').textContent='Something went wrong. Please try again.';}
    $('verify').disabled=false;
  };
  async function loadProfile(){
    var r=await fetch(API+'/me',{headers:{'Authorization':'Bearer '+TOK}});var d=await r.json();
    $('loginCard').classList.add('hidden');var p=$('profile');p.classList.remove('hidden');
    var oh=d.orders.map(function(o){return '<div class="ord"><div class="h"><b>'+esc(o.athlete||'Order')+'</b><span class="pill '+(o.paid?'paid':'due')+'">'+(o.paid?'Paid':'Unpaid')+'</span></div><div class="muted" style="font-size:13px;margin-top:4px">'+esc(o.package||'')+' &middot; $'+(o.amount||0)+(o.photos&&o.photos.length?(' &middot; '+o.photos.length+' photo'+(o.photos.length>1?'s':'')+' selected'):'')+'</div></div>';}).join('')||'<p class="muted">No orders on file yet.</p>';
    var gh=d.galleries.map(function(g){return '<div class="ord"><b>'+esc(g.name)+'</b>'+(g.unlocked?('<div><a class="glink" href="'+g.downloadUrl+'">Download all photos (.zip)</a> <a class="glink" style="background:#5A554B" href="'+g.viewUrl+'">View gallery</a></div>'):('<div class="glock">Your photos unlock here once your order is paid. <a href="'+g.viewUrl+'">Preview gallery</a></div>'))+'</div>';}).join('')||'<p class="muted">No galleries linked to your orders yet.</p>';
    p.innerHTML='<div class="h" style="display:flex;justify-content:space-between;align-items:center"><h2 style="margin:0">Welcome back</h2><button class="signout" id="signout" type="button">Sign out</button></div><p class="muted" style="font-size:13px">'+esc(d.email)+'</p><h2>Your galleries</h2>'+gh+'<h2>Your orders</h2>'+oh;
    document.getElementById('signout').onclick=function(){TOK=null;p.classList.add('hidden');p.innerHTML='';$('loginCard').classList.remove('hidden');$('step2').classList.add('hidden');$('step1').classList.remove('hidden');$('idval').value='';$('codeval').value='';};
  }
  function esc(s){return (s==null?'':String(s)).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
</script>
</body></html>`);
});

// ===== studio-side: get the shareable portal link =====
portalOwner.get('/portal-link', (req: any, res: Response) => {
  res.json({ url: `${base(req)}/portal/${req.orgId}` });
});
