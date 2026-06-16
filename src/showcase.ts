import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { db, uid } from './db';
import { config } from './config';
import { Authed } from './auth';

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
  if (!Array.isArray(c.items)) c.items = [];
  return c;
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
  return {
    headline: String(i.headline || '').slice(0, 200),
    intro: String(i.intro || '').slice(0, 2500),
    contactOn: !!i.contactOn,
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

function workPage(orgId: string, name: string, c: any, profile: any): string {
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
    return `<figure class="cell"><img loading="lazy" src="${esc(it.src)}" alt="${esc(it.caption || '')}" oncontextmenu="return false"><div class="zoom" data-full="${esc(it.src)}"></div>${cap}</figure>`;
  }).join('');

  let contact = '';
  if (c.contactOn) {
    let p: any = {}; try { p = JSON.parse(profile || '{}'); } catch { p = {}; }
    const bits: string[] = [];
    if (p.email) bits.push(`<a href="mailto:${esc(p.email)}">${esc(p.email)}</a>`);
    if (p.phone) bits.push(`<a href="tel:${esc(String(p.phone).replace(/[^0-9+]/g, ''))}">${esc(p.phone)}</a>`);
    if (bits.length) contact = `<div class="contact"><div class="ct-l">Get in touch</div><div class="ct-b">${bits.join('<span class="dot">&middot;</span>')}</div></div>`;
  }

  const body = items.length
    ? `<div class="grid">${cells}</div>`
    : `<div class="empty">This showcase is being put together. Check back soon.</div>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(c.headline || name)} — Our Work</title>
<meta name="robots" content="noindex">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Space+Mono&display=swap" rel="stylesheet">
<style>
:root{--ink:#1C1A17;--soft:#4A453E;--paper:#F1F0EC;--card:#fff;--line:#DEDBD3;--muted:#8C867B;--red:#9E2B25}
*{box-sizing:border-box}html,body{margin:0}
body{background:var(--paper);color:var(--ink);font-family:'Space Grotesk',system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:1100px;margin:0 auto;padding:0 20px}
header{padding:54px 0 26px;border-bottom:1px solid var(--line)}
.kicker{font-family:'Space Mono',monospace;font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:var(--red)}
h1{font-size:clamp(28px,5vw,46px);line-height:1.04;margin:10px 0 0;font-weight:700;letter-spacing:-.01em}
.intro{font-size:16px;color:var(--soft);max-width:660px;margin:16px 0 0;line-height:1.55;white-space:pre-wrap}
.grid{column-count:3;column-gap:16px;padding:28px 0}
@media(max-width:860px){.grid{column-count:2}}
@media(max-width:540px){.grid{column-count:1}}
.cell{margin:0 0 16px;break-inside:avoid;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden;display:inline-block;width:100%}
.cell img{width:100%;display:block;cursor:zoom-in}
.cell.wide{column-span:all}
@media(max-width:540px){.cell.wide{column-span:none}}
.vid{position:relative;width:100%;aspect-ratio:16/9;background:#000}
.vid iframe,.vid video{position:absolute;inset:0;width:100%;height:100%;border:0;display:block}
figcaption{font-size:13px;color:var(--soft);padding:10px 12px;border-top:1px solid var(--line)}
.ext{display:block;padding:18px;font-family:'Space Mono',monospace;font-size:13px;color:var(--ink);text-decoration:none}
.contact{padding:30px 0 44px;border-top:1px solid var(--line);text-align:center}
.ct-l{font-family:'Space Mono',monospace;font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:var(--muted)}
.ct-b{margin-top:8px;font-size:18px}.ct-b a{color:var(--ink);text-decoration:none;border-bottom:2px solid var(--red);padding-bottom:1px}
.ct-b .dot{margin:0 12px;color:var(--muted)}
.empty{padding:80px 0;text-align:center;color:var(--muted)}
footer{padding:22px 0 40px;text-align:center;color:var(--muted);font-family:'Space Mono',monospace;font-size:11px;letter-spacing:.1em}
.lb{position:fixed;inset:0;background:rgba(15,14,12,.94);display:none;align-items:center;justify-content:center;z-index:50;cursor:zoom-out}
.lb.on{display:flex}.lb img{max-width:94vw;max-height:92vh;border-radius:8px}
</style></head><body>
<div class="wrap">
<header><div class="kicker">${esc(name)}</div><h1>${esc(c.headline || name + ' — Our Work')}</h1>${c.intro ? `<p class="intro">${esc(c.intro)}</p>` : ''}</header>
${body}
${contact}
<footer>${esc(name)} &middot; Made with Frameline</footer>
</div>
<div class="lb" id="lb"><img id="lbimg" alt=""></div>
<script>
(function(){var lb=document.getElementById('lb'),im=document.getElementById('lbimg');
document.querySelectorAll('.cell img').forEach(function(g){g.addEventListener('click',function(){im.src=g.getAttribute('src');lb.classList.add('on');});});
lb.addEventListener('click',function(){lb.classList.remove('on');im.src='';});})();
</script>
</body></html>`;
}

showcase.get('/work/:org', (req: Request, res: Response) => {
  const orgId = req.params.org;
  const o = orgRow(orgId);
  res.set('Cache-Control', 'no-store');
  res.send(workPage(orgId, o.name || 'Photography', readConfig(orgId), o.profile));
});
