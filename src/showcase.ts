import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { db, uid } from './db';
import { config } from './config';
import { Authed } from './auth';
import { sendViaGmail } from './email';

// Up to 200MB per file — fine for short phone clips; longer videos should use a YouTube/Vimeo link.
const upload = multer({ dest: path.join(config.uploadDir, 'tmp'), limits: { fileSize: 200 * 1024 * 1024 } });

const base = (req: Request) => `${req.protocol}://${req.get('host')}`;
const pub = (req: Request, key: string) => `${base(req)}/uploads/${key}`;

export const showcase = Router(); // public, no auth
export const showcaseOwner = Router(); // studio auth

function readConfig(orgId: string): any {
  const row: any = db.prepare('SELECT showcase_json FROM organizations WHERE id = ?').get(orgId);
  let c: any = {};
  try { c = JSON.parse(row?.showcase_json || '{}'); } catch { c = {}; }
  return cleanConfig(c);
}
function orgRow(orgId: string): any {
  return db.prepare('SELECT name, profile FROM organizations WHERE id = ?').get(orgId) || {};
}

function cleanConfig(incoming: any): any {
  const i = incoming && typeof incoming === 'object' ? incoming : {};
  const items = Array.isArray(i.items) ? i.items.slice(0, 300).map((it: any) => ({
    id: String(it.id || uid()),
    kind: ['photo', 'video', 'embed'].includes(it.kind) ? it.kind : 'photo',
    src: String(it.src || '').slice(0, 1200),
    caption: String(it.caption || '').slice(0, 300),
  })).filter((it: any) => it.src) : [];
  const d = i.design && typeof i.design === 'object' ? i.design : {};
  const design = {
    theme: ['paper', 'dark', 'bold'].includes(d.theme) ? d.theme : 'paper',
    accent: /^#[0-9a-fA-F]{3,8}$/.test(String(d.accent || '')) ? String(d.accent) : '#9E2B25',
    layout: ['masonry', 'grid', 'feature'].includes(d.layout) ? d.layout : 'masonry',
    font: ['grotesk', 'serif', 'mono'].includes(d.font) ? d.font : 'grotesk',
    cover: String(d.cover || '').slice(0, 1200),
    rounded: d.rounded !== false,
    coverPosX: ['left', 'center', 'right'].includes(d.coverPosX) ? d.coverPosX : 'center',
    coverPosY: ['top', 'center', 'bottom'].includes(d.coverPosY) ? d.coverPosY : 'center',
    coverHeight: ['short', 'medium', 'tall'].includes(d.coverHeight) ? d.coverHeight : 'medium',
    coverShade: ['light', 'medium', 'dark'].includes(d.coverShade) ? d.coverShade : 'medium',
  };
  return {
    headline: String(i.headline || '').slice(0, 200),
    intro: String(i.intro || '').slice(0, 2500),
    contactOn: !!i.contactOn,
    formOn: i.formOn === undefined ? true : !!i.formOn,
    design,
    items,
  };
}

// ---------- Owner (authed) ----------
showcaseOwner.get('/showcase', (req: Authed, res: Response) => {
  res.json({ url: `${base(req)}/work/${req.orgId}`, config: readConfig(req.orgId!) });
});

showcaseOwner.put('/showcase', (req: Authed, res: Response) => {
  const clean = cleanConfig(req.body);
  db.prepare('UPDATE organizations SET showcase_json = ? WHERE id = ?').run(JSON.stringify(clean), req.orgId);
  res.json({ ok: true, url: `${base(req)}/work/${req.orgId}`, config: clean });
});

// Upload photos/short videos straight from a device
showcaseOwner.post('/showcase/media', upload.array('files', 20), (req: Authed, res: Response) => {
  const dir = path.join(config.uploadDir, 'showcase', req.orgId!);
  fs.mkdirSync(dir, { recursive: true });
  const files = (req.files as Express.Multer.File[]) || [];
  const out: any[] = [];
  for (const f of files) {
    const id = uid();
    const ext = (path.extname(f.originalname) || '').toLowerCase();
    const isVideo = /^video\//.test(f.mimetype || '') || ['.mov', '.mp4', '.m4v', '.webm', '.ogg', '.avi'].includes(ext);
    const name = `${id}${ext || (isVideo ? '.mp4' : '.jpg')}`;
    fs.renameSync(f.path, path.join(dir, name));
    out.push({ id, kind: isVideo ? 'video' : 'photo', src: pub(req, `showcase/${req.orgId}/${name}`), filename: f.originalname });
  }
  res.status(201).json({ uploaded: out.length, items: out });
});

// ---------- Public page ----------
function esc(s: any): string {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as any)[m]);
}

function embedSrc(u: string): string | null {
  try {
    const url = new URL(u);
    const h = url.hostname.replace(/^www\./, '');
    if (h === 'youtu.be') { const id = url.pathname.slice(1).split('/')[0]; return id ? `https://www.youtube.com/embed/${id}` : null; }
    if (h.endsWith('youtube.com')) {
      if (url.pathname === '/watch') { const id = url.searchParams.get('v'); return id ? `https://www.youtube.com/embed/${id}` : null; }
      const m = url.pathname.match(/\/(embed|shorts)\/([^/?]+)/); if (m) return `https://www.youtube.com/embed/${m[2]}`;
    }
    if (h.endsWith('vimeo.com')) { const id = url.pathname.split('/').filter(Boolean)[0]; return /^\d+$/.test(id) ? `https://player.vimeo.com/video/${id}` : null; }
  } catch { /* ignore */ }
  return null;
}

function themeVars(design){
  const a = design.accent || '#9E2B25';
  if (design.theme === 'dark') return `--ink:#F2EFE9;--soft:#C9C2B5;--paper:#15130F;--card:#1E1B16;--line:#2E2A23;--muted:#8C867B;--accent:${a}`;
  if (design.theme === 'bold') return `--ink:#0B0B0C;--soft:#3A3A3D;--paper:#FFFFFF;--card:#FFFFFF;--line:#E6E6E6;--muted:#9A9A9D;--accent:${a}`;
  return `--ink:#1C1A17;--soft:#4A453E;--paper:#F1F0EC;--card:#FFFFFF;--line:#DEDBD3;--muted:#8C867B;--accent:${a}`;
}
function headFont(font){ if (font === 'serif') return "Georgia,'Times New Roman',serif"; if (font === 'mono') return "'Space Mono',monospace"; return "'Space Grotesk',system-ui,sans-serif"; }

function workPage(orgId: string, name: string, c: any, profile: any): string {
  const design = c.design || { theme: 'paper', accent: '#9E2B25', layout: 'masonry', font: 'grotesk', cover: '', rounded: true };
  const rad = design.rounded === false ? 0 : 12;
  const layout = design.layout || 'masonry';
  const items: any[] = c.items || [];

  const cells = items.map((it) => {
    const cap = it.caption ? `<figcaption>${esc(it.caption)}</figcaption>` : '';
    if (it.kind === 'embed') {
      const src = embedSrc(it.src);
      const inner = src
        ? `<div class="vid"><iframe src="${esc(src)}" title="${esc(it.caption || 'Video')}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe></div>`
        : `<a class="ext" href="${esc(it.src)}" target="_blank" rel="noopener">Watch video &rarr;</a>`;
      return `<figure class="cell wide">${inner}${cap}</figure>`;
    }
    if (it.kind === 'video') {
      return `<figure class="cell wide"><div class="vid"><video src="${esc(it.src)}" controls preload="metadata" playsinline></video></div>${cap}</figure>`;
    }
    return `<figure class="cell"><img loading="lazy" src="${esc(it.src)}" alt="${esc(it.caption || '')}" oncontextmenu="return false">${cap}</figure>`;
  }).join('');

  let gridCss = '';
  if (layout === 'grid') {
    gridCss = `.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px;padding:28px 0}
.cell{background:var(--card);border:1px solid var(--line);border-radius:${rad}px;overflow:hidden}
.cell img{width:100%;aspect-ratio:4/3;object-fit:cover;display:block;cursor:zoom-in}
.cell.wide{grid-column:1/-1}`;
  } else if (layout === 'feature') {
    gridCss = `.grid{max-width:820px;margin:0 auto;padding:24px 0}
.cell{background:var(--card);border:1px solid var(--line);border-radius:${rad}px;overflow:hidden;margin:0 0 18px}
.cell img{width:100%;display:block;cursor:zoom-in}`;
  } else {
    gridCss = `.grid{column-count:3;column-gap:16px;padding:28px 0}
@media(max-width:860px){.grid{column-count:2}}@media(max-width:540px){.grid{column-count:1}}
.cell{margin:0 0 16px;break-inside:avoid;background:var(--card);border:1px solid var(--line);border-radius:${rad}px;overflow:hidden;display:inline-block;width:100%}
.cell img{width:100%;display:block;cursor:zoom-in}
.cell.wide{column-span:all}@media(max-width:540px){.cell.wide{column-span:none}}`;
  }

  let contact = '';
  if (c.contactOn) {
    let p: any = {}; try { p = JSON.parse(profile || '{}'); } catch { p = {}; }
    const bits: string[] = [];
    if (p.email) bits.push(`<a href="mailto:${esc(p.email)}">${esc(p.email)}</a>`);
    if (p.phone) bits.push(`<a href="tel:${esc(String(p.phone).replace(/[^0-9+]/g, ''))}">${esc(p.phone)}</a>`);
    if (bits.length) contact = `<div class="contact"><div class="ct-l">Get in touch</div><div class="ct-b">${bits.join('<span class="dot">&middot;</span>')}</div></div>`;
  }

  const form = c.formOn ? `<section class="reqform" id="reqform">
<div class="rf-l">Request photos / video</div>
<h2 class="rf-h">Tell us what you need</h2>
<p class="rf-p">Send a request and it goes straight to ${esc(name)}.</p>
<div id="rf-box-wrap"><div class="rf-box">
<div class="rf-row"><input id="rf-name" placeholder="Your name"><input id="rf-email" type="email" placeholder="Email"></div>
<input id="rf-phone" placeholder="Phone (optional)">
<textarea id="rf-msg" placeholder="What are you looking for? Team or event, dates, prints or digital&hellip;"></textarea>
<button id="rf-send" type="button">Send request</button>
<div id="rf-note" class="rf-note"></div>
</div></div>
</section>` : '';

  const headerInner = `<div class="kicker">${esc(name)}</div><h1>${esc(c.headline || name + ' \u2014 Our Work')}</h1>${c.intro ? `<p class="intro">${esc(c.intro)}</p>` : ''}`;
  const shadeMap: any = { light: 'rgba(0,0,0,.16),rgba(0,0,0,.30)', medium: 'rgba(0,0,0,.34),rgba(0,0,0,.58)', dark: 'rgba(0,0,0,.5),rgba(0,0,0,.72)' };
  const heightMap: any = { short: 240, medium: 380, tall: 560 };
  const coverShade = shadeMap[design.coverShade] || shadeMap.medium;
  const coverMinH = heightMap[design.coverHeight] || heightMap.medium;
  const coverPos = `${design.coverPosX || 'center'} ${design.coverPosY || 'center'}`;
  const hero = design.cover
    ? `<header class="hero" style="min-height:${coverMinH}px;background-image:linear-gradient(${coverShade}),url('${esc(design.cover)}');background-position:${coverPos}"><div class="hero-in">${headerInner}</div></header>`
    : '';

  const body = items.length ? `<div class="grid">${cells}</div>` : `<div class="empty">This showcase is being put together. Check back soon.</div>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(c.headline || name)} \u2014 Our Work</title>
<meta name="robots" content="noindex">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Space+Mono&display=swap" rel="stylesheet">
<style>
:root{${themeVars(design)}}
*{box-sizing:border-box}html,body{margin:0}
body{background:var(--paper);color:var(--ink);font-family:'Space Grotesk',system-ui,sans-serif;-webkit-font-smoothing:antialiased}
h1,h2,.kicker{font-family:${headFont(design.font)}}
.wrap{max-width:1100px;margin:0 auto;padding:0 20px}
header{padding:54px 0 26px;border-bottom:1px solid var(--line)}
.hero{background-size:cover;background-repeat:no-repeat;border-bottom:1px solid var(--line);display:flex;align-items:center}
.hero-in{max-width:1100px;margin:0 auto;padding:30px 20px;width:100%}
.kicker{font-family:'Space Mono',monospace;font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:var(--accent)}
h1{font-size:clamp(28px,5vw,46px);line-height:1.05;margin:10px 0 0;font-weight:700;letter-spacing:-.01em}
.intro{font-size:16px;color:var(--soft);max-width:660px;margin:16px 0 0;line-height:1.55;white-space:pre-wrap}
${gridCss}
.vid{position:relative;width:100%;aspect-ratio:16/9;background:#000}
.vid iframe,.vid video{position:absolute;inset:0;width:100%;height:100%;border:0;display:block}
figcaption{font-size:13px;color:var(--soft);padding:10px 12px;border-top:1px solid var(--line)}
.ext{display:block;padding:18px;font-family:'Space Mono',monospace;font-size:13px;color:var(--ink);text-decoration:none}
.reqform{padding:40px 0 12px;border-top:1px solid var(--line);text-align:center}
.rf-l{font-family:'Space Mono',monospace;font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:var(--accent)}
.rf-h{font-size:clamp(22px,3.6vw,32px);margin:8px 0 0}
.rf-p{color:var(--soft);margin:10px 0 18px}
.rf-box{max-width:540px;margin:0 auto;text-align:left}
.rf-row{display:flex;gap:10px}@media(max-width:480px){.rf-row{flex-direction:column}}
.rf-box input,.rf-box textarea{width:100%;margin:0 0 10px;padding:12px 13px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--ink);font:inherit;font-size:15px}
.rf-box textarea{min-height:120px;resize:vertical}
.rf-box input:focus,.rf-box textarea:focus{outline:none;border-color:var(--accent)}
#rf-send{width:100%;background:var(--accent);color:#fff;border:none;border-radius:10px;padding:13px;font-weight:600;font-size:15px;cursor:pointer}
#rf-send:disabled{opacity:.6;cursor:default}
.rf-note{font-size:13px;margin-top:10px;color:var(--soft)}.rf-note.err{color:#c0392b}
.rf-thanks{max-width:540px;margin:0 auto;padding:26px;border:1px solid var(--line);border-radius:12px;background:var(--card);font-size:16px}
.contact{padding:34px 0 44px;border-top:1px solid var(--line);text-align:center}
.ct-l{font-family:'Space Mono',monospace;font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:var(--muted)}
.ct-b{margin-top:8px;font-size:18px}.ct-b a{color:var(--ink);text-decoration:none;border-bottom:2px solid var(--accent);padding-bottom:1px}
.ct-b .dot{margin:0 12px;color:var(--muted)}
.empty{padding:80px 0;text-align:center;color:var(--muted)}
footer{padding:22px 0 40px;text-align:center;color:var(--muted);font-family:'Space Mono',monospace;font-size:11px;letter-spacing:.1em}
.lb{position:fixed;inset:0;background:rgba(10,9,8,.94);display:none;align-items:center;justify-content:center;z-index:50;cursor:zoom-out}
.lb.on{display:flex}.lb img{max-width:94vw;max-height:92vh;border-radius:8px}
</style></head><body>
${hero}
<div class="wrap">
${design.cover ? '' : `<header>${headerInner}</header>`}
${body}
${form}
${contact}
<footer>${esc(name)} &middot; Made with Frameline</footer>
</div>
<div class="lb" id="lb"><img id="lbimg" alt=""></div>
<script>
(function(){var lb=document.getElementById('lb'),im=document.getElementById('lbimg');
document.querySelectorAll('.cell img').forEach(function(g){g.addEventListener('click',function(){im.src=g.getAttribute('src');lb.classList.add('on');});});
lb.addEventListener('click',function(){lb.classList.remove('on');im.src='';});
var b=document.getElementById('rf-send');
if(b){b.addEventListener('click',function(){
var name=v('rf-name'),email=v('rf-email'),phone=v('rf-phone'),msg=v('rf-msg'),note=document.getElementById('rf-note');
if(!name||!email||!msg){note.textContent='Please add your name, email, and a message.';note.className='rf-note err';return;}
b.disabled=true;note.textContent='Sending...';note.className='rf-note';
fetch('/work/${orgId}/inquiry',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name,email:email,phone:phone,message:msg})})
.then(function(r){return r.json().catch(function(){return {};}).then(function(d){return {ok:r.ok,d:d};});})
.then(function(x){if(x.ok){document.getElementById('rf-box-wrap').innerHTML='<div class="rf-thanks">Thanks \u2014 your request was sent. We will be in touch soon.</div>';}else{note.textContent=(x.d&&x.d.error)||'Something went wrong. Please try again.';note.className='rf-note err';b.disabled=false;}})
.catch(function(){note.textContent='Network error. Please try again.';note.className='rf-note err';b.disabled=false;});
});}
function v(id){var e=document.getElementById(id);return e?e.value.trim():'';}
})();
</script>
</body></html>`;
}

showcase.get('/work/:org', (req: Request, res: Response) => {
  const orgId = req.params.org;
  const o = orgRow(orgId);
  res.set('Cache-Control', 'no-store');
  res.send(workPage(orgId, o.name || 'Photography', readConfig(orgId), o.profile));
});

// Public: a visitor requests photos/video. Stores the lead + emails the studio.
showcase.post('/work/:org/inquiry', async (req: Request, res: Response) => {
  const orgId = req.params.org;
  const o = orgRow(orgId);
  if (!o || !o.name) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 120);
  const email = String(b.email || '').trim().slice(0, 160);
  const phone = String(b.phone || '').trim().slice(0, 40);
  const message = String(b.message || '').trim().slice(0, 3000);
  if (!name || !email || !message) return res.status(400).json({ error: 'Please add your name, email, and a message.' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Please enter a valid email.' });

  const id = uid();
  db.prepare('INSERT INTO inquiries (id, org_id, name, email, phone, message, status) VALUES (?,?,?,?,?,?,?)')
    .run(id, orgId, name, email, phone, message, 'new');

  let prof: any = {}; try { prof = JSON.parse(o.profile || '{}'); } catch { prof = {}; }
  if (prof.email) {
    const body = `You have a new request from your Our Work page.\n\nName: ${name}\nEmail: ${email}\nPhone: ${phone || '-'}\n\nMessage:\n${message}\n\nReply directly to ${email} to respond.\n\n- Frameline`;
    sendViaGmail(orgId, { to: prof.email, subject: `New request from ${name}`, body }).catch(() => { /* lead still saved */ });
  }
  res.json({ ok: true });
});
