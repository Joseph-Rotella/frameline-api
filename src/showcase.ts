import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { db, uid } from './db';
import { config } from './config';
import { Authed } from './auth';
import { sendViaGmail } from './email';
import { execFile } from 'child_process';

// Bundled ffmpeg (optional dep); falls back to a system ffmpeg on PATH.
let FFMPEG = 'ffmpeg';
try { const p = require('ffmpeg-static'); if (p) FFMPEG = p; } catch { /* use PATH ffmpeg */ }

// Convert any uploaded clip to a web-friendly MP4 (H.264) + a poster frame.
// Browsers (esp. Chrome) often refuse to play .mov/QuickTime even when H.264 — MP4 always plays.
function transcodeToMp4(input: string, outMp4: string, outPoster: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ['-y', '-i', input, '-vf', "scale='min(1280,iw)':-2", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', outMp4];
    execFile(FFMPEG, args, { timeout: 180000 }, (err) => {
      if (err) return reject(err);
      execFile(FFMPEG, ['-y', '-ss', '0.3', '-i', outMp4, '-frames:v', '1', '-vf', "scale='min(1280,iw)':-2", outPoster], { timeout: 30000 }, () => resolve());
    });
  });
}

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

function clampPct(v: any, def: number): number {
  if (typeof v === 'number' && isFinite(v)) return Math.max(0, Math.min(100, v));
  const map: any = { left: 0, top: 0, center: 50, right: 100, bottom: 100 };
  if (typeof v === 'string' && v in map) return map[v];
  const n = parseFloat(v);
  return isFinite(n) ? Math.max(0, Math.min(100, n)) : def;
}

function cleanConfig(incoming: any): any {
  const i = incoming && typeof incoming === 'object' ? incoming : {};
  const items = Array.isArray(i.items) ? i.items.slice(0, 300).map((it: any) => ({
    id: String(it.id || uid()),
    kind: ['photo', 'video', 'embed'].includes(it.kind) ? it.kind : 'photo',
    src: String(it.src || '').slice(0, 1200),
    caption: String(it.caption || '').slice(0, 300),
    poster: String(it.poster || '').slice(0, 1200),
  })).filter((it: any) => it.src) : [];
  const d = i.design && typeof i.design === 'object' ? i.design : {};
  const design = {
    theme: ['paper', 'dark', 'bold'].includes(d.theme) ? d.theme : 'paper',
    accent: /^#[0-9a-fA-F]{3,8}$/.test(String(d.accent || '')) ? String(d.accent) : '#9E2B25',
    layout: ['masonry', 'grid', 'feature'].includes(d.layout) ? d.layout : 'masonry',
    font: ['grotesk', 'serif', 'mono'].includes(d.font) ? d.font : 'grotesk',
    cover: String(d.cover || '').slice(0, 1200),
    rounded: d.rounded !== false,
    coverPosX: clampPct(d.coverPosX, 50),
    coverPosY: clampPct(d.coverPosY, 50),
    coverHeight: ['short', 'medium', 'tall'].includes(d.coverHeight) ? d.coverHeight : 'medium',
    coverShade: ['light', 'medium', 'dark'].includes(d.coverShade) ? d.coverShade : 'medium',
    intro: d.intro !== false,
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
showcaseOwner.post('/showcase/media', upload.array('files', 20), async (req: Authed, res: Response) => {
  const dir = path.join(config.uploadDir, 'showcase', req.orgId!);
  fs.mkdirSync(dir, { recursive: true });
  const files = (req.files as Express.Multer.File[]) || [];
  const out: any[] = [];
  for (const f of files) {
    const id = uid();
    const ext = (path.extname(f.originalname) || '').toLowerCase();
    const isVideo = /^video\//.test(f.mimetype || '') || ['.mov', '.mp4', '.m4v', '.webm', '.ogg', '.avi', '.mkv', '.hevc'].includes(ext);
    if (isVideo) {
      const mp4 = path.join(dir, `${id}.mp4`);
      const jpg = path.join(dir, `${id}.jpg`);
      try {
        await transcodeToMp4(f.path, mp4, jpg);
        try { fs.unlinkSync(f.path); } catch { /* ignore */ }
        const hasPoster = fs.existsSync(jpg);
        out.push({ id, kind: 'video', src: pub(req, `showcase/${req.orgId}/${id}.mp4`), poster: hasPoster ? pub(req, `showcase/${req.orgId}/${id}.jpg`) : '', filename: f.originalname });
      } catch (e) {
        // Converter unavailable/failed — keep the original so nothing is lost.
        const name = `${id}${ext || '.mp4'}`;
        try { fs.renameSync(f.path, path.join(dir, name)); } catch { /* ignore */ }
        out.push({ id, kind: 'video', src: pub(req, `showcase/${req.orgId}/${name}`), poster: '', filename: f.originalname });
      }
    } else {
      const name = `${id}${ext || '.jpg'}`;
      fs.renameSync(f.path, path.join(dir, name));
      out.push({ id, kind: 'photo', src: pub(req, `showcase/${req.orgId}/${name}`), filename: f.originalname });
    }
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
    const yt = (id: string) => `https://www.youtube.com/embed/${id}?autoplay=1&mute=1&loop=1&playlist=${id}&rel=0&playsinline=1`;
    const vm = (id: string) => `https://player.vimeo.com/video/${id}?autoplay=1&muted=1&loop=1`;
    if (h === 'youtu.be') { const id = url.pathname.slice(1).split('/')[0]; return id ? yt(id) : null; }
    if (h.endsWith('youtube.com')) {
      if (url.pathname === '/watch') { const id = url.searchParams.get('v'); return id ? yt(id) : null; }
      const m = url.pathname.match(/\/(embed|shorts)\/([^/?]+)/); if (m) return yt(m[2]);
    }
    if (h.endsWith('vimeo.com')) { const id = url.pathname.split('/').filter(Boolean)[0]; return /^\d+$/.test(id) ? vm(id) : null; }
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


function cameraSvgMarkup(): string {
  const tex = [90,105,120,135,150,165,180,195,210].map(y=>`<line x1="22" y1="${y}" x2="338" y2="${y}" stroke="rgba(255,255,255,0.015)" stroke-width="1"/>`).join('');
  const shoe = [162,170,178,186,194].map(x=>`<line x1="${x}" y1="16" x2="${x}" y2="24" stroke="#1e1e22" stroke-width="1"/>`).join('');
  const mode = [0,45,90,135,180,225,270,315].map(a=>{const r=a*Math.PI/180;return `<line x1="${(66+Math.cos(r)*11).toFixed(2)}" y1="${(82+Math.sin(r)*11).toFixed(2)}" x2="${(66+Math.cos(r)*16).toFixed(2)}" y2="${(82+Math.sin(r)*16).toFixed(2)}" stroke="#3a3a3e" stroke-width="1.5"/>`;}).join('');
  const cmd = [0,1,2,3,4,5,6].map(i=>`<line x1="${215+i*6}" y1="54" x2="${215+i*6}" y2="72" stroke="#2e2e32" stroke-width="1"/>`).join('');
  const focus = Array.from({length:36}).map((_,i)=>{const a=i/36*Math.PI*2;return `<line x1="${(180+Math.cos(a)*62).toFixed(2)}" y1="${(155+Math.sin(a)*62).toFixed(2)}" x2="${(180+Math.cos(a)*68).toFixed(2)}" y2="${(155+Math.sin(a)*68).toFixed(2)}" stroke="#2a2a2e" stroke-width="1.2"/>`;}).join('');
  const ap = ([[-80,'2.8'],[-40,'4'],[0,'5.6'],[40,'8'],[80,'11']] as [number,string][]).map(([a,l])=>{const r=a*Math.PI/180;return `<text x="${(180+Math.cos(r)*52).toFixed(2)}" y="${(155+Math.sin(r)*52+2).toFixed(2)}" fill="#2a2a2e" font-size="5" font-family="monospace" text-anchor="middle">${l}</text>`;}).join('');
  const iris = [0,60,120,180,240,300].map(angle=>{const r=angle*Math.PI/180;const bx=180+Math.cos(r)*24;const by=155+Math.sin(r)*24;return `<ellipse cx="${bx.toFixed(2)}" cy="${by.toFixed(2)}" rx="26" ry="13" fill="#0A0A0B" transform="rotate(${angle+90}, ${bx.toFixed(2)}, ${by.toFixed(2)})"/>`;}).join('');
  const fl = [0,30,60,90,120,150,180,210,240,270,300,330].map(a=>{const r=a*Math.PI/180;return `<line x1="${(180+Math.cos(r)*50).toFixed(2)}" y1="${(155+Math.sin(r)*50).toFixed(2)}" x2="${(180+Math.cos(r)*80).toFixed(2)}" y2="${(155+Math.sin(r)*80).toFixed(2)}" stroke="rgba(255,255,255,0.12)" stroke-width="1.5"/>`;}).join('');
  const back = [115,130,145,160].map(cy=>`<circle cx="320" cy="${cy}" r="5" fill="#181819" stroke="#2a2a2e" stroke-width="1"/>`).join('');
  return `<svg viewBox="0 0 360 250" width="340" height="240" fill="none" xmlns="http://www.w3.org/2000/svg">
<ellipse cx="180" cy="242" rx="110" ry="6" fill="rgba(0,0,0,0.6)"/>
<rect x="18" y="72" width="324" height="162" rx="16" fill="#1c1c1e"/><rect x="18" y="72" width="324" height="162" rx="16" stroke="#3a3a3e" stroke-width="1.5"/>
${tex}
<rect x="90" y="48" width="180" height="28" rx="6" fill="#161618"/><rect x="90" y="48" width="180" height="28" rx="6" stroke="#2e2e32" stroke-width="1"/>
<path d="M130 48 L150 22 L210 22 L230 48 Z" fill="#121214" stroke="#2a2a2e" stroke-width="1"/>
<rect x="155" y="16" width="50" height="8" rx="2" fill="#0e0e10" stroke="#222226" stroke-width="1"/>${shoe}
<g class="btn"><circle cx="296" cy="82" r="11" fill="#202022" stroke="#3c3c40" stroke-width="1.2"/><circle cx="296" cy="82" r="6" fill="#181819"/><circle cx="296" cy="82" r="2.5" fill="#cc3333"/></g>
<circle cx="66" cy="82" r="18" fill="#161618" stroke="#2e2e32" stroke-width="1.2"/>${mode}<circle cx="66" cy="82" r="5" fill="#0e0e10"/>
<text x="59" y="79" fill="#666" font-size="5" font-family="monospace" font-weight="bold">A</text>
<rect x="210" y="52" width="46" height="22" rx="5" fill="#181819" stroke="#2a2a2e" stroke-width="1"/>${cmd}
<rect x="96" y="52" width="106" height="20" rx="3" fill="#0a1a0a" stroke="#1e2e1e" stroke-width="1"/>
<text x="101" y="63" fill="#33aa33" font-size="6" font-family="monospace" letter-spacing="1.5">1/250  F2.8</text>
<text x="101" y="70" fill="#33aa33" font-size="5" font-family="monospace" letter-spacing="1">ISO 400</text>
<circle cx="180" cy="155" r="76" fill="#141416" stroke="#2e2e32" stroke-width="2"/>
<circle cx="180" cy="155" r="70" fill="#111113" stroke="#3a3a3e" stroke-width="1.5"/>${focus}
<circle cx="180" cy="155" r="58" fill="#0d0d0f" stroke="#252528" stroke-width="1"/>${ap}
<circle cx="180" cy="155" r="48" fill="#080809"/>
<circle cx="180" cy="155" r="42" fill="#050506" stroke="#1a1a1e" stroke-width="0.5"/>
<g class="iris">${iris}</g>
<circle class="flare" cx="180" cy="155" r="42" fill="none" stroke="#ffffff" stroke-width="1.5"/>
<ellipse cx="165" cy="142" rx="12" ry="8" fill="rgba(255,255,255,0.035)"/>
<ellipse cx="192" cy="165" rx="6" ry="3.5" fill="rgba(255,255,255,0.02)"/>
<circle cx="175" cy="148" r="2" fill="rgba(255,255,255,0.05)"/>
<text x="230" y="148" fill="#2a2a2e" font-size="5.5" font-family="monospace" letter-spacing="1">AF/MF</text>
<text x="232" y="158" fill="#252528" font-size="5" font-family="monospace">67mm</text>
<text x="32" y="106" fill="#2a2a2e" font-size="6" font-family="monospace" letter-spacing="1">ISO</text>
<text x="32" y="116" fill="#303035" font-size="7" font-family="monospace" letter-spacing="0.5">400</text>
<rect x="22" y="208" width="22" height="10" rx="3" fill="#141416" stroke="#252528" stroke-width="1"/>
<rect x="316" y="208" width="22" height="10" rx="3" fill="#141416" stroke="#252528" stroke-width="1"/>
${back}
<g class="flines">${fl}<circle cx="180" cy="155" r="50" fill="rgba(255,255,255,0.06)"/></g>
</svg>`;
}

function introBlock(name: string): { style: string; markup: string; script: string } {
  const style = `<style>
.intro{position:fixed;inset:0;z-index:200;display:flex;align-items:center;justify-content:center;overflow:hidden;background:#0A0A0B}
.intro .cam{display:flex;flex-direction:column;align-items:center;animation:camIn .7s cubic-bezier(.22,1,.36,1) both}
.intro .brand{margin-top:22px;font-family:'Space Mono',monospace;font-size:11px;letter-spacing:.55em;text-transform:uppercase;color:rgba(255,255,255,.22);animation:introFade .6s ease .6s both}
.intro .flash-layer{position:absolute;inset:0;background:#fff;opacity:0;pointer-events:none}
.intro .iris,.intro .flare,.intro .flines{opacity:0}
.intro .flare{transform-box:fill-box;transform-origin:center}
.intro.wiggle .cam-inner{animation:introWig 1.2s ease-in-out}
.intro.shutter .cam-inner{animation:introShk .25s ease-in-out}
.intro.shutter .btn{animation:introPrs .2s ease-in-out}
.intro.shutter .iris{animation:introIrs .3s ease both}
.intro.shutter .flare{animation:introFlr .3s ease both}
.intro.shutter .flines{animation:introFls .25s ease .05s both}
.intro.flash .flash-layer,.intro.fadeout .flash-layer{opacity:1;transition:opacity .12s ease}
.intro.flash .cam,.intro.fadeout .cam{opacity:0;transform:scale(1.12);filter:blur(6px);transition:.3s ease}
.intro.fadeout{opacity:0;transition:opacity .8s ease-out}
@keyframes camIn{from{opacity:0;transform:translateY(40px) scale(.8)}to{opacity:1;transform:none}}
@keyframes introFade{from{opacity:0}to{opacity:1}}
@keyframes introWig{0%{transform:translateY(0) rotate(0)}25%{transform:translateY(-4px) rotate(-.5deg)}50%{transform:translateY(0) rotate(0)}75%{transform:translateY(-3px) rotate(.5deg)}100%{transform:translateY(0) rotate(0)}}
@keyframes introShk{0%{transform:scale(1) translateY(0)}30%{transform:scale(.97) translateY(3px)}60%{transform:scale(1.02) translateY(-1px)}100%{transform:scale(1) translateY(0)}}
@keyframes introPrs{0%{transform:translateY(0)}50%{transform:translateY(3px)}100%{transform:translateY(0)}}
@keyframes introIrs{0%{opacity:0}15%{opacity:1}50%{opacity:.8}100%{opacity:0}}
@keyframes introFlr{0%{opacity:0;transform:scale(1)}50%{opacity:.5;transform:scale(1.24)}100%{opacity:0;transform:scale(1.55)}}
@keyframes introFls{0%{opacity:0}40%{opacity:1}100%{opacity:0}}
@media (prefers-reduced-motion: reduce){.intro{display:none}}
</style>`;
  const markup = `<div id="intro" class="intro idle"><div class="cam"><div class="cam-inner">${cameraSvgMarkup()}</div><p class="brand">${esc(name)}</p></div><div class="flash-layer"></div></div>`;
  const script = `<script>(function(){var o=document.getElementById('intro');if(!o)return;if(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches){if(o.parentNode)o.parentNode.removeChild(o);return;}document.body.style.overflow='hidden';function go(p){o.className='intro '+p;}var t=[];t.push(setTimeout(function(){go('wiggle');},800));t.push(setTimeout(function(){go('shutter');},1600));t.push(setTimeout(function(){go('flash');},1900));t.push(setTimeout(function(){go('fadeout');},2200));t.push(setTimeout(done,3000));function done(){for(var i=0;i<t.length;i++)clearTimeout(t[i]);if(o.parentNode)o.parentNode.removeChild(o);document.body.style.overflow='';}o.addEventListener('click',done);})();</script>`;
  return { style, markup, script };
}

function workPage(orgId: string, name: string, c: any, profile: any): string {
  const design = c.design || { theme: 'paper', accent: '#9E2B25', layout: 'masonry', font: 'grotesk', cover: '', rounded: true };
  const rad = design.rounded === false ? 0 : 12;
  const layout = design.layout || 'masonry';
  const introOn = design.intro !== false;
  const ib = introOn ? introBlock(name) : { style: '', markup: '', script: '' };
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
      let posterUrl = it.poster || '';
      if (!posterUrl) {
        const m = String(it.src).match(/\/uploads\/(.+)$/);
        if (m) { const jpgRel = m[1].replace(/\.[^.]+$/, '.jpg'); try { if (fs.existsSync(path.join(config.uploadDir, jpgRel))) posterUrl = String(it.src).replace(/\.[^.]+$/, '.jpg'); } catch { /* ignore */ } }
      }
      const posterAttr = posterUrl ? ` poster="${esc(posterUrl)}"` : '';
      return `<figure class="cell"><div class="vid videofile"><video src="${esc(it.src)}"${posterAttr} autoplay muted loop playsinline controls preload="auto"></video><span class="playbtn" aria-hidden="true"></span></div>${cap}</figure>`;
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

  const headerInner = `<div class="kicker">${esc(name)}</div><h1>${esc(c.headline || name + ' \u2014 Our Work')}</h1>${c.intro ? `<p class="lede">${esc(c.intro)}</p>` : ''}`;
  const shadeMap: any = { light: 'rgba(0,0,0,.16),rgba(0,0,0,.30)', medium: 'rgba(0,0,0,.34),rgba(0,0,0,.58)', dark: 'rgba(0,0,0,.5),rgba(0,0,0,.72)' };
  const heightMap: any = { short: 240, medium: 380, tall: 560 };
  const coverShade = shadeMap[design.coverShade] || shadeMap.medium;
  const coverMinH = heightMap[design.coverHeight] || heightMap.medium;
  const coverPos = `${design.coverPosX}% ${design.coverPosY}%`;
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
.lede{font-size:16px;color:var(--soft);max-width:660px;margin:16px 0 0;line-height:1.55;white-space:pre-wrap}
${gridCss}
.vid{position:relative;width:100%;aspect-ratio:16/9;background:#0d0d0f;overflow:hidden}
.vid iframe,.vid video{position:absolute;inset:0;width:100%;height:100%;border:0;display:block}
.vid.videofile video{object-fit:contain;background:#0d0d0f}
.vid .playbtn{position:absolute;left:50%;top:50%;width:52px;height:52px;margin:-26px 0 0 -26px;border-radius:50%;background:rgba(0,0,0,.5);box-shadow:0 0 0 1px rgba(255,255,255,.28);pointer-events:none}
.vid .playbtn:after{content:"";position:absolute;left:20px;top:15px;border-style:solid;border-width:11px 0 11px 18px;border-color:transparent transparent transparent #fff}
.vid video:hover + .playbtn{opacity:0;transition:opacity .2s}
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
</style>${ib.style}</head><body>
${ib.markup}
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
document.querySelectorAll('.vid.videofile video').forEach(function(vd){vd.addEventListener('play',function(){var b=vd.parentNode.querySelector('.playbtn');if(b)b.style.display='none';});});
})();
</script>
${ib.script}
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
