import bcrypt from 'bcryptjs';
import { db, uid } from './db';

const DEMO_EMAIL = 'demo@frameline.test';
const DEMO_PASSWORD = 'frameline';

export function seedIfEmpty() {
  const count = (db.prepare('SELECT COUNT(*) c FROM organizations').get() as any).c;
  if (count > 0) return;

  const orgId = uid(), userId = uid();
  const today = new Date();
  const d = (offset: number) => { const t = new Date(today); t.setDate(t.getDate() + offset); return t.toISOString().slice(0, 10); };
  const yr = today.getFullYear();

  db.prepare('INSERT INTO organizations (id, name, profile) VALUES (?,?,?)')
    .run(orgId, 'Frameline Studio', JSON.stringify({ email: 'studio@frameline.photo', phone: '(305) 555-0100', address: '1200 Aperture Ave, Miami, FL' }));
  db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)')
    .run(userId, DEMO_EMAIL, 'Demo User', bcrypt.hashSync(DEMO_PASSWORD, 10));
  db.prepare('INSERT INTO memberships (id, org_id, user_id, role) VALUES (?,?,?,?)').run(uid(), orgId, userId, 'owner');

  const ins = (table: string, row: Record<string, any>) => {
    const keys = ['id', 'org_id', ...Object.keys(row)];
    const vals = [uid(), orgId, ...Object.values(row)];
    db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...vals);
    return vals[0] as string;
  };

  const c1 = ins('clients', { name: 'Lincoln High School', district: 'Riverside USD', contact_name: 'Coach Tara Mills', contact_email: 'tmills@lincoln.edu', contact_phone: '(305) 555-0142', contract_status: 'active', contract_value: 18000, renewal_date: d(60), notes: 'Multi-sport annual agreement.' });
  const c2 = ins('clients', { name: 'St. Agnes Academy', district: 'Diocese League', contact_name: 'Mr. Devon Park', contact_email: 'dpark@stagnes.org', contact_phone: '(786) 555-0188', contract_status: 'renewal', contract_value: 11500, renewal_date: d(20), notes: 'Renewal conversation needed.' });

  const t1 = ins('teams', { client_id: c1, sport: 'Football', season: 'Fall', year: yr, coach: 'Coach Reyes', notes: '' });
  ins('teams', { client_id: c2, sport: 'Soccer', season: 'Fall', year: yr, coach: 'Coach Alvarez', notes: '' });

  ins('athletes', { team_id: t1, name: 'Marcus Bell', jersey: '12', grade: '11', parent_name: 'Andre Bell', parent_email: 'andre.bell@email.com', parent_phone: '(305) 555-2201' });
  ins('athletes', { team_id: t1, name: 'Eli Vance', jersey: '22', grade: '12', parent_name: 'Dana Vance', parent_email: 'dvance@email.com', parent_phone: '(305) 555-2203' });

  ins('picture_days', { client_id: c1, date: d(6), time: '08:30', location: 'Lincoln Field House', status: 'confirmed', team_ids: JSON.stringify([t1]), notes: 'Two backdrops.' });

  for (const [name, price] of [['Team + Individual', 65], ['Digital Bundle', 45], ['Senior Banner', 120], ['Pose Pack A', 35]] as [string, number][]) {
    ins('packages', { name, price });
  }

  ins('galleries', { client_id: c1, team_id: t1, name: 'Lincoln Football — Fall Picture Day', status: 'ready', ai_organized: 1, tags: JSON.stringify(['individuals', 'team-pano', 'seniors']), notes: '' });

  ins('orders', { client_id: c1, athlete_name: 'Marcus Bell', package: 'Team + Individual', amount: 65, paid: 1, paid_at: d(-18), date: d(-18), source: 'manual' });
  ins('orders', { client_id: c1, athlete_name: 'Eli Vance', package: 'Senior Banner', amount: 120, paid: 0, date: d(-2), source: 'parent_store' });

  ins('appointments', { client_id: c2, title: 'Renewal call — St. Agnes', type: 'call', date: d(2), time: '11:00', duration_min: 30, notes: 'Discuss next-season coverage.', done: 0 });
  ins('tasks', { client_id: c2, title: 'Send St. Agnes renewal agreement', due: d(1), priority: 'high', done: 0 });
  ins('tasks', { client_id: c1, title: 'Edit Lincoln football gallery', due: d(3), priority: 'med', done: 0 });

  ins('documents', { client_id: c1, name: 'Lincoln HS — Annual Photography Agreement', type: 'Contract', status: 'signed', date: d(-120), body: '' });
  ins('templates', { name: 'Gallery is ready', audience: 'Parents', subject: 'Your photos are ready — {school}', body: 'Hi {parent},\n\nYour photos from {school} are ready: {link}\n\nThanks,\n{studio}' });
  ins('emails', { client_id: c1, contact_email: 'tmills@lincoln.edu', direction: 'received', subject: 'Re: Fall picture day logistics', body: 'Field house is reserved for 8:30am. Rosters attached.', sent_at: new Date(Date.now() - 5 * 864e5).toISOString() });

  console.log(`\n  Seeded demo studio. Log in with:\n    email:    ${DEMO_EMAIL}\n    password: ${DEMO_PASSWORD}\n`);
}
