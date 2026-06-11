# Deploying Frameline

Two halves, two hosts. ~30 minutes, mostly clicking.

## 1. Backend → Render (or Railway / Fly.io)

1. Put this `frameline-api` folder in a GitHub repo (GitHub Desktop is the no-terminal way).
2. On render.com: **New → Blueprint**, pick the repo. It reads `render.yaml`, provisions the
   service + a 1 GB persistent disk (so your database and photos survive restarts), and sets a
   random `JWT_SECRET`.
   - Or **New → Web Service** manually: Build `npm install`, Start `npm start`, then add a disk
     mounted at `/data` and set `DATA_DIR=/data`, `UPLOAD_DIR=/data/uploads`.
3. After deploy you get a URL like `https://frameline-api.onrender.com`. Open `…/health` to confirm.
4. Set `CORS_ORIGIN` to your Netlify URL (from step 2 below), then redeploy.

Notes:
- Use the **Starter** plan, not Free — Free sleeps and has no persistent disk (you'd lose data).
- `ANTHROPIC_API_KEY` is optional here. Each client can paste **their own** AI key in the app
  (Settings → AI provider), and Gmail is connected per-client too.

## 2. Front end → Netlify

1. On app.netlify.com: **Add new site → Deploy manually**, and drag in
   `sports-photography-platform.html` (rename it `index.html` first so it loads at the root).
2. You get a URL like `https://your-studio.netlify.app`.
3. Open it, go to **Settings → Backend connection**, set the Backend URL to your Render URL,
   and sign in. Done — it's live.

## 3. What each client does after you share the Netlify link

1. Open the site, click the connection chip, **Create a new studio account** (their own login).
2. Settings → AI provider: paste their **own** Anthropic API key → AI turns on for them.
3. Settings → Gmail: **Connect Gmail** → approve in Google → sends go through their Gmail.

## Honest lead-time items (not code — start early)
- **Gmail for many users:** `gmail.send`/`gmail.readonly` are restricted scopes. Up to ~100 test
  users work immediately; a public launch needs Google's OAuth verification + security assessment
  (weeks). Until then, the in-app mailto hand-off sends from the user's address with no setup.
- **Secrets:** before real customers, encrypt stored tokens/keys at rest and move to managed
  Postgres if you outgrow the single-disk SQLite (see frameline-backend-spec.md).
