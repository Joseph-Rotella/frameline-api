import path from 'path';
import fs from 'fs';
import { config } from './config';

/*
 * Data layer. Prefers the fast native `better-sqlite3` (installed on a normal
 * machine via a prebuilt binary). If that native module isn't present, it falls
 * back to Node's built-in `node:sqlite` (Node 22.5+) so the server still runs.
 * Both expose the same tiny interface used across the app.
 */
let db: any;

(function initDb() {
  let Better: any = null;
  try { Better = require('better-sqlite3'); } catch { /* fall back to node:sqlite */ }

  if (Better) {
    db = new Better(config.dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    return;
  }

  // Built-in fallback (experimental but stable enough for a starter).
  const { DatabaseSync } = require('node:sqlite');
  const raw = new DatabaseSync(config.dbPath);
  raw.exec('PRAGMA journal_mode = WAL;');
  raw.exec('PRAGMA foreign_keys = ON;');
  db = {
    exec: (sql: string) => raw.exec(sql),
    pragma: () => {},
    prepare: (sql: string) => {
      const st = raw.prepare(sql);
      return {
        run: (...args: any[]) => st.run(...args),
        get: (...args: any[]) => st.get(...args),
        all: (...args: any[]) => st.all(...args),
      };
    },
    transaction: (fn: (...a: any[]) => any) => (...args: any[]) => {
      raw.exec('BEGIN');
      try { const r = fn(...args); raw.exec('COMMIT'); return r; }
      catch (e) { raw.exec('ROLLBACK'); throw e; }
    },
  };
})();

// Apply schema (idempotent — uses IF NOT EXISTS).
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);
// Lightweight migrations for DBs created before a column existed.
try { db.exec('ALTER TABLE galleries ADD COLUMN expires_at TEXT'); } catch { /* already present */ }
try { db.exec('ALTER TABLE galleries ADD COLUMN downloads_open INTEGER DEFAULT 0'); } catch { /* already present */ }
try { db.exec("ALTER TABLE orders ADD COLUMN selections TEXT DEFAULT '[]'"); } catch { /* already present */ }
try { db.exec('ALTER TABLE orders ADD COLUMN email TEXT'); } catch { /* already present */ }
try { db.exec('ALTER TABLE orders ADD COLUMN phone TEXT'); } catch { /* already present */ }
try { db.exec("ALTER TABLE organizations ADD COLUMN showcase_json TEXT NOT NULL DEFAULT '{}'"); } catch { /* already present */ }

export { db };

export function uid(): string {
  try { return (globalThis as any).crypto.randomUUID(); }
  catch { return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36); }
}
export function nowISO(): string { return new Date().toISOString(); }
