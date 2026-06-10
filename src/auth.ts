import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { db, uid } from './db';
import { config } from './config';

export interface Authed extends Request {
  userId?: string;
  orgId?: string;
}

export const auth = Router();

auth.post('/register', (req: Request, res: Response) => {
  const { email, password, name, studio } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(String(email).toLowerCase());
  if (exists) return res.status(409).json({ error: 'email already registered' });

  const userId = uid();
  const orgId = uid();
  const hash = bcrypt.hashSync(String(password), 10);
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO organizations (id, name, profile) VALUES (?,?,?)')
      .run(orgId, studio || 'My Studio', JSON.stringify({ email, phone: '', address: '' }));
    db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)')
      .run(userId, String(email).toLowerCase(), name || '', hash);
    db.prepare('INSERT INTO memberships (id, org_id, user_id, role) VALUES (?,?,?,?)')
      .run(uid(), orgId, userId, 'owner');
  });
  tx();
  const token = sign(userId, orgId);
  res.json({ token, user: { id: userId, email, name: name || '' }, orgId });
});

auth.post('/login', (req: Request, res: Response) => {
  const { email, password } = req.body || {};
  const user: any = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').toLowerCase());
  if (!user || !bcrypt.compareSync(String(password || ''), user.password_hash)) {
    return res.status(401).json({ error: 'invalid credentials' });
  }
  const m: any = db.prepare('SELECT org_id FROM memberships WHERE user_id = ? LIMIT 1').get(user.id);
  const token = sign(user.id, m?.org_id);
  res.json({ token, user: { id: user.id, email: user.email, name: user.name }, orgId: m?.org_id });
});

function sign(userId: string, orgId: string): string {
  return jwt.sign({ uid: userId, org: orgId }, config.jwtSecret, { expiresIn: '30d' });
}

export function requireAuth(req: Authed, res: Response, next: NextFunction) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'missing token' });
  try {
    const payload: any = jwt.verify(token, config.jwtSecret);
    req.userId = payload.uid;
    req.orgId = payload.org;
    next();
  } catch {
    res.status(401).json({ error: 'invalid token' });
  }
}
