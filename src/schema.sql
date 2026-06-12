-- Frameline starter schema (SQLite). Mirrors the production spec; see README
-- for the Postgres migration notes. All tenant tables carry org_id.

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  profile TEXT NOT NULL DEFAULT '{}',          -- json { email, phone, address }
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS memberships (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'owner',
  UNIQUE (org_id, user_id)
);

CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  district TEXT,
  contact_name TEXT, contact_email TEXT, contact_phone TEXT,
  contract_status TEXT DEFAULT 'prospect',
  contract_value REAL DEFAULT 0,
  start_date TEXT, renewal_date TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  client_id TEXT,
  sport TEXT, season TEXT, year INTEGER, coach TEXT, notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS athletes (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  team_id TEXT,
  name TEXT NOT NULL, jersey TEXT, grade TEXT,
  parent_name TEXT, parent_email TEXT, parent_phone TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS picture_days (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  client_id TEXT,
  date TEXT, time TEXT, location TEXT, status TEXT DEFAULT 'scheduled',
  team_ids TEXT DEFAULT '[]',                  -- json array
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS packages (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL, price REAL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS galleries (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  client_id TEXT, team_id TEXT,
  name TEXT NOT NULL,
  status TEXT DEFAULT 'processing',
  ai_organized INTEGER DEFAULT 0,
  tags TEXT DEFAULT '[]',                       -- json array
  notes TEXT,
  delivery TEXT,                                -- json { recipient, at }
  share_token TEXT UNIQUE,
  expires_at TEXT,                              -- public client link expiry (ISO)
  downloads_open INTEGER DEFAULT 0,            -- 0 = watermarked proofs only, 1 = full-res downloads unlocked
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS photos (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  gallery_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  original_key TEXT NOT NULL,                   -- relative path under uploads/
  thumb_key TEXT,
  width INTEGER, height INTEGER, bytes INTEGER,
  status TEXT DEFAULT 'ready',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  client_id TEXT,
  athlete_name TEXT,
  package TEXT, amount REAL DEFAULT 0,
  paid INTEGER DEFAULT 0, paid_at TEXT,
  date TEXT, source TEXT DEFAULT 'manual',
  selections TEXT DEFAULT '[]',
  stripe_payment_intent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS appointments (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  client_id TEXT,
  title TEXT NOT NULL, type TEXT DEFAULT 'meeting',
  date TEXT, time TEXT, duration_min INTEGER DEFAULT 30,
  notes TEXT, done INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  client_id TEXT,
  title TEXT NOT NULL, due TEXT, priority TEXT DEFAULT 'med', done INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  client_id TEXT,
  name TEXT NOT NULL, type TEXT DEFAULT 'Contract', status TEXT DEFAULT 'draft',
  date TEXT, body TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL, audience TEXT, subject TEXT, body TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS emails (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  client_id TEXT,
  contact_email TEXT, direction TEXT, subject TEXT, body TEXT,
  gmail_message_id TEXT, gmail_thread_id TEXT,
  attachments TEXT DEFAULT '[]',                -- json array
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS integration_credentials (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  account_email TEXT,
  data_encrypted TEXT NOT NULL,                 -- starter: JSON; production: encrypt at rest
  scopes TEXT,
  connected_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (org_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_clients_org ON clients(org_id);
CREATE INDEX IF NOT EXISTS idx_teams_client ON teams(client_id);
CREATE INDEX IF NOT EXISTS idx_athletes_team ON athletes(team_id);
CREATE INDEX IF NOT EXISTS idx_photos_gallery ON photos(gallery_id);
CREATE INDEX IF NOT EXISTS idx_orders_client ON orders(client_id);
CREATE INDEX IF NOT EXISTS idx_emails_client ON emails(client_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_pd_org_date ON picture_days(org_id, date);
CREATE INDEX IF NOT EXISTS idx_appts_org_date ON appointments(org_id, date);
