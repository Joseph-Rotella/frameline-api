# Frameline API — starter backend

A runnable backend for the Frameline sports-photography platform. It starts with **zero external services** (no Postgres, Redis, or accounts required) and lights up each integration as you add credentials. Built to migrate cleanly to the production stack in `frameline-backend-spec.md`.

---

## Quick start

```bash
# 1. install (Node 18+; Node 20 or 22 recommended)
npm install

# 2. (optional) configure — nothing here is required to start
cp .env.example .env        # then edit if you want AI / Gmail / Stripe

# 3. run
npm run dev                 # auto-reload, or: npm start
```

Then open **http://localhost:4000/** — a built-in smoke-test console. Log in with the seeded demo account:

```
email:    demo@frameline.test
password: frameline
```

You'll see seeded clients, galleries, orders, and appointments, and you can create/read records right in the browser. `GET /health` shows which integrations are live.

> **Database:** uses `better-sqlite3` (a fast native module installed via a prebuilt binary — no compiler needed on a normal machine). If that module can't load, it automatically falls back to Node's built-in `node:sqlite` (Node 22.5+). The SQLite file lives in `./data/`. Uploaded photos live in `./uploads/`. Both are git-ignored.

---

## What works out of the box

- **Auth** — register (creates a studio/org + owner) and login, JWT sessions (`/auth/register`, `/auth/login`, `/me`).
- **Multi-tenant CRUD** — every record is scoped to your org. Resources: `clients`, `teams`, `athletes`, `picture-days`, `packages`, `galleries`, `orders`, `appointments`, `tasks`, `documents`, `templates`. Standard REST: `GET /clients`, `POST /clients`, `GET/PATCH/DELETE /clients/:id`, plus simple filters like `GET /teams?client_id=...`.
- **Photo upload** — `POST /galleries/:id/photos` (multipart) stores files and (if `sharp` is installed) generates thumbnails; served from `/uploads`.
- **Email** — `POST /emails/send` records to the client thread; delivers via Gmail if connected (see below). `GET /emails?direction=sent`.
- **AI proxy** — `/ai/draft-email`, `/ai/generate-contract`, `/ai/assistant`, `/ai/summarize`. Returns helpful stubs until you add a key; the key stays server-side.
- **Payments** — `POST /orders/:id/checkout` and `POST /webhooks/stripe` (stubbed until you add a Stripe key).

---

## Lighting up the integrations

Add keys to `.env` and restart. Each is independent.

**AI (Anthropic).** Set `ANTHROPIC_API_KEY`. The `/ai/*` endpoints then call the model server-side with an org-scoped data snapshot — the key never reaches the browser. Swap providers by editing `complete()` in `src/ai.ts`.

**Gmail (real send + sync).** Create a Google Cloud project, enable the Gmail API, build an OAuth consent screen, and create Web OAuth credentials. Set `GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI`. Then `GET /integrations/gmail/connect` returns the consent URL; the callback stores tokens and `/emails/send` delivers through the user's Gmail. **Heads-up:** `gmail.send`/`gmail.readonly` are restricted scopes — fine for up to ~100 testers, but a public launch needs Google's verification + security assessment (start early). Until then, the front end's `mailto:` hand-off delivers from the user's address with zero setup.

**Stripe (parent payments).** Set `STRIPE_SECRET_KEY`. `POST /orders/:id/checkout` creates a Checkout Session; configure the webhook to `POST /webhooks/stripe` and set `STRIPE_WEBHOOK_SECRET`. Production must verify the webhook signature (see the note in `src/payments.ts`).

---

## Connecting your front end

The prototype (`sports-photography-platform.html`) persists through a `Store` layer. To go live, point it at this API using `api-client.js` (included). It wraps auth, CRUD, photo upload, email, and AI, and contains a commented sketch of the swap. The one gotcha: the API uses `snake_case` + `client_id` while the prototype uses `camelCase` + `schoolId`, so add a thin field-mapping layer (less invasive than renaming everything in the prototype).

Set `CORS_ORIGIN` in `.env` to your front end's origin (defaults to `*` for local dev).

---

## Project structure

```
src/
  index.ts      Express bootstrap — mounts auth, CRUD, photos, email, ai, payments
  config.ts     env loading + data/upload dirs
  db.ts         SQLite (native, with built-in fallback) + helpers
  schema.sql    table definitions (mirrors the spec)
  seed.ts       demo studio + sample data on first run
  auth.ts       register/login, JWT, requireAuth middleware
  crud.ts       generic org-scoped CRUD factory + resource definitions
  photos.ts     multipart upload, thumbnails, listing
  email.ts      send (record + Gmail), Gmail OAuth routes
  ai.ts         provider proxy with org-scoped context
  payments.ts   Stripe checkout + webhook
public/index.html   browser smoke-test console
api-client.js       drop-in client for the front end
```

---

## Migrating to the production stack

This starter intentionally simplifies three things for zero-config running. The spec (`frameline-backend-spec.md`) is the target; here's the path:

1. **SQLite → PostgreSQL.** Stand up Postgres and either keep raw SQL (swap the driver in `db.ts` for `pg`) or adopt **Prisma** (recommended in the spec) by translating `schema.sql` into `schema.prisma` and replacing the query calls. The column names already match the spec's schema.
2. **Local disk → S3/R2.** Replace the filesystem writes in `photos.ts` with presigned direct-to-storage uploads, and add the worker that generates web/proof/watermarked sizes (the spec's photo pipeline).
3. **App-layer tenancy → Postgres RLS.** Keep the `org_id` filtering and add Row-Level Security policies as the safety net.
4. **Harden:** encrypt the tokens in `integration_credentials` at rest, verify the Stripe webhook signature, add refresh-token handling for Gmail, move sessions to your auth provider (Clerk/Supabase) if you'd rather not own passwords, and add a job queue (BullMQ) for image processing, sync, and reminders.

---

## Notes

- `npm run typecheck` runs the TypeScript checker; `npm run build` emits to `dist/`.
- `multer@1.x` carries advisories; upgrade to `2.x` before production (the disk-upload API used here is compatible).
- This is a starter, not a hardened production service — see the spec's security section before going live, and get legal review for handling minors' images (COPPA/FERPA).
