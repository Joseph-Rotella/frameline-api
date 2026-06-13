import { Router, Response } from 'express';
import { db, uid } from './db';
import { Authed } from './auth';

export interface ResourceDef {
  table: string;
  cols: string[];          // writable columns (besides id/org_id/created_at)
  json?: string[];         // columns stored as JSON text
  bool?: string[];         // columns stored as 0/1 integers
  filters?: string[];      // query-string filters allowed (must be in cols)
}

function encode(def: ResourceDef, body: any): Record<string, any> {
  const out: Record<string, any> = {};
  for (const c of def.cols) {
    if (!(c in body)) continue;
    let v = body[c];
    if (def.json?.includes(c)) v = JSON.stringify(v ?? null);
    else if (def.bool?.includes(c)) v = v ? 1 : 0;
    out[c] = v;
  }
  return out;
}

function decode(def: ResourceDef, row: any): any {
  if (!row) return row;
  const out = { ...row };
  for (const c of def.json || []) {
    try { out[c] = out[c] != null ? JSON.parse(out[c]) : out[c]; } catch { /* leave as-is */ }
  }
  for (const c of def.bool || []) out[c] = !!out[c];
  return out;
}

export function crudRouter(def: ResourceDef): Router {
  const r = Router();
  const { table } = def;

  // LIST (org-scoped, optional simple filters)
  r.get('/', (req: Authed, res: Response) => {
    const where = ['org_id = ?'];
    const params: any[] = [req.orgId];
    for (const f of def.filters || []) {
      if (req.query[f] != null) { where.push(`${f} = ?`); params.push(req.query[f]); }
    }
    const rows = db.prepare(`SELECT * FROM ${table} WHERE ${where.join(' AND ')} ORDER BY created_at DESC`).all(...params);
    res.json(rows.map((row: any) => decode(def, row)));
  });

  // READ
  r.get('/:id', (req: Authed, res: Response) => {
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND org_id = ?`).get(req.params.id, req.orgId);
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(decode(def, row));
  });

  // CREATE
  r.post('/', (req: Authed, res: Response) => {
    const data = encode(def, req.body || {});
    const id = (req.body && typeof req.body.id === 'string' && req.body.id) ? req.body.id : uid();
    const keys = ['id', 'org_id', ...Object.keys(data)];
    const vals = [id, req.orgId, ...Object.values(data)];
    const placeholders = keys.map(() => '?').join(',');
    db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${placeholders})`).run(...vals);
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
    res.status(201).json(decode(def, row));
  });

  // UPDATE (partial)
  r.patch('/:id', (req: Authed, res: Response) => {
    const existing = db.prepare(`SELECT id FROM ${table} WHERE id = ? AND org_id = ?`).get(req.params.id, req.orgId);
    if (!existing) return res.status(404).json({ error: 'not found' });
    const data = encode(def, req.body || {});
    const keys = Object.keys(data);
    if (keys.length) {
      const set = keys.map((k) => `${k} = ?`).join(', ');
      db.prepare(`UPDATE ${table} SET ${set} WHERE id = ? AND org_id = ?`).run(...Object.values(data), req.params.id, req.orgId);
    }
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id);
    res.json(decode(def, row));
  });

  // DELETE
  r.delete('/:id', (req: Authed, res: Response) => {
    const info = db.prepare(`DELETE FROM ${table} WHERE id = ? AND org_id = ?`).run(req.params.id, req.orgId);
    if (!info.changes) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  });

  return r;
}

// Resource definitions (mirror the prototype's data model)
export const RESOURCES: Record<string, ResourceDef> = {
  clients: { table: 'clients', cols: ['name', 'district', 'contact_name', 'contact_email', 'contact_phone', 'contract_status', 'contract_value', 'start_date', 'renewal_date', 'notes'] },
  teams: { table: 'teams', cols: ['client_id', 'sport', 'season', 'year', 'coach', 'notes'], filters: ['client_id'] },
  athletes: { table: 'athletes', cols: ['team_id', 'name', 'jersey', 'grade', 'parent_name', 'parent_email', 'parent_phone'], filters: ['team_id'] },
  'picture-days': { table: 'picture_days', cols: ['client_id', 'date', 'time', 'location', 'status', 'team_ids', 'notes'], json: ['team_ids'], filters: ['client_id'] },
  packages: { table: 'packages', cols: ['name', 'price'] },
  galleries: { table: 'galleries', cols: ['client_id', 'team_id', 'name', 'status', 'ai_organized', 'tags', 'notes', 'delivery', 'share_token'], json: ['tags', 'delivery'], bool: ['ai_organized'], filters: ['client_id'] },
  orders: { table: 'orders', cols: ['client_id', 'athlete_name', 'package', 'amount', 'paid', 'paid_at', 'date', 'source', 'selections', 'email', 'phone'], json: ['selections'], bool: ['paid'], filters: ['client_id'] },
  appointments: { table: 'appointments', cols: ['client_id', 'title', 'type', 'date', 'time', 'duration_min', 'notes', 'done'], bool: ['done'], filters: ['client_id'] },
  tasks: { table: 'tasks', cols: ['client_id', 'title', 'due', 'priority', 'done'], bool: ['done'], filters: ['client_id'] },
  documents: { table: 'documents', cols: ['client_id', 'name', 'type', 'status', 'date', 'body'], filters: ['client_id'] },
  templates: { table: 'templates', cols: ['name', 'audience', 'subject', 'body'] },
};
