import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import path from 'path';
import { config } from './config';
import { db } from './db';
import { seedIfEmpty } from './seed';
import { auth, requireAuth, Authed } from './auth';
import { crudRouter, RESOURCES } from './crud';
import { photos, sharpAvailable } from './photos';
import { email, emailPublic } from './email';
import { ai, aiEnabled } from './ai';
import { payments, stripeWebhook, stripeEnabled } from './payments';
import { shareOwner, sharePublic, purgeExpired } from './share';
import { portal, portalOwner } from './portal';
import { showcase, showcaseOwner } from './showcase';

seedIfEmpty();
purgeExpired();
setInterval(purgeExpired, 24 * 60 * 60 * 1000);

const app = express();
app.set('trust proxy', 1); // host (Render/Railway) terminates TLS; makes photo URLs use https
app.use(cors({ origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(',').map((s) => s.trim()) }));

// Stripe webhook needs the raw body, so mount it BEFORE express.json().
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), stripeWebhook);

app.use(express.json({ limit: '2mb' }));

// Static: smoke-test console + uploaded photos
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/uploads', express.static(config.uploadDir));

app.get('/health', (_req, res) => res.json({
  ok: true,
  version: 'showcase-3',
  features: { gmailInbox: true, tokenRefresh: true },
  integrations: { ai: aiEnabled ? 'live' : 'stub', gmail: config.google.clientId ? 'configured' : 'mailto-fallback', stripe: stripeEnabled ? 'live' : 'stub', thumbnails: sharpAvailable ? 'on' : 'off' },
}));

// Public auth
app.use('/auth', auth);
// Public client gallery links (no auth)
app.use(sharePublic);
app.use(portal);
app.use(showcase);
// Public Gmail OAuth callback (Google redirects here without auth)
app.use(emailPublic);

// Everything below requires a token
app.get('/me', requireAuth, (req: Authed, res: Response) => {
  const user = db.prepare('SELECT id, email, name FROM users WHERE id = ?').get(req.userId);
  const org = db.prepare('SELECT id, name, profile FROM organizations WHERE id = ?').get(req.orgId) as any;
  if (org) { try { org.profile = JSON.parse(org.profile); } catch { /* keep */ } }
  res.json({ user, org });
});

// Generic CRUD resources
for (const [name, def] of Object.entries(RESOURCES)) {
  app.use(`/${name}`, requireAuth, crudRouter(def));
}

// Feature routers
app.use(requireAuth, photos);
app.use(requireAuth, email);
app.use(requireAuth, ai);
app.use(requireAuth, payments);
app.use(requireAuth, shareOwner);
app.use(requireAuth, portalOwner);
app.use(requireAuth, showcaseOwner);
app.post('/admin/purge', requireAuth, (_req, res) => res.json({ purged: purgeExpired() }));

// 404 + error handler
app.use((_req, res) => res.status(404).json({ error: 'not found' }));
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: err?.message || 'server error' });
});

app.listen(config.port, () => {
  console.log(`\n  Frameline API → http://localhost:${config.port}`);
  console.log(`  Smoke-test console → http://localhost:${config.port}/`);
  console.log(`  Health → http://localhost:${config.port}/health\n`);
});
