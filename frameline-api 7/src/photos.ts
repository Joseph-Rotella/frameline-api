import { Router, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { db, uid } from './db';
import { config } from './config';
import { Authed } from './auth';

const upload = multer({ dest: path.join(config.uploadDir, 'tmp'), limits: { fileSize: 50 * 1024 * 1024 } });

// Lazy-load sharp so the server runs even if the optional dependency is absent.
let sharp: any = null;
try { sharp = require('sharp'); } catch { /* thumbnails disabled */ }

export const photos = Router();

function publicUrl(req: any, key: string) {
  return `${req.protocol}://${req.get('host')}/uploads/${key}`;
}

// Upload one or more photos to a gallery
photos.post('/galleries/:gid/photos', upload.array('files', 50), async (req: Authed, res: Response) => {
  const gid = req.params.gid;
  const gallery: any = db.prepare('SELECT id FROM galleries WHERE id = ? AND org_id = ?').get(gid, req.orgId);
  if (!gallery) return res.status(404).json({ error: 'gallery not found' });

  const dir = path.join(config.uploadDir, gid);
  fs.mkdirSync(dir, { recursive: true });
  const files = (req.files as Express.Multer.File[]) || [];
  const created: any[] = [];

  for (const f of files) {
    const id = uid();
    const ext = (path.extname(f.originalname) || '.jpg').toLowerCase();
    const origName = `${id}${ext}`;
    const origPath = path.join(dir, origName);
    fs.renameSync(f.path, origPath);

    let thumbKey: string | null = null;
    let width: number | null = null, height: number | null = null;
    if (sharp) {
      try {
        const thumbName = `${id}_thumb.jpg`;
        const meta = await sharp(origPath).metadata();
        width = meta.width || null; height = meta.height || null;
        await sharp(origPath).resize(400, 400, { fit: 'inside' }).jpeg({ quality: 80 }).toFile(path.join(dir, thumbName));
        thumbKey = `${gid}/${thumbName}`;
        // Production: also make a watermarked "proof" and a ~1600px web size here.
      } catch { /* keep original only */ }
    }

    db.prepare(`INSERT INTO photos (id, org_id, gallery_id, filename, original_key, thumb_key, width, height, bytes, status)
                VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(id, req.orgId, gid, f.originalname, `${gid}/${origName}`, thumbKey, width, height, f.size, 'ready');
    created.push({ id, filename: f.originalname, url: publicUrl(req, `${gid}/${origName}`), thumb: thumbKey ? publicUrl(req, thumbKey) : null });
  }

  // Bump gallery out of "processing" once it has photos
  db.prepare("UPDATE galleries SET status = 'ready' WHERE id = ? AND status = 'processing'").run(gid);
  res.status(201).json({ uploaded: created.length, photos: created });
});

// List a gallery's photos with URLs
photos.get('/galleries/:gid/photos', (req: Authed, res: Response) => {
  const rows: any[] = db.prepare('SELECT * FROM photos WHERE gallery_id = ? AND org_id = ? ORDER BY created_at').all(req.params.gid, req.orgId);
  res.json(rows.map((p) => ({
    id: p.id, filename: p.filename, width: p.width, height: p.height, bytes: p.bytes, status: p.status,
    url: publicUrl(req, p.original_key), thumb: p.thumb_key ? publicUrl(req, p.thumb_key) : publicUrl(req, p.original_key),
  })));
});

photos.delete('/photos/:id', (req: Authed, res: Response) => {
  const p: any = db.prepare('SELECT * FROM photos WHERE id = ? AND org_id = ?').get(req.params.id, req.orgId);
  if (!p) return res.status(404).json({ error: 'not found' });
  for (const k of [p.original_key, p.thumb_key]) {
    if (!k) continue;
    const fp = path.join(config.uploadDir, k);
    if (fs.existsSync(fp)) { try { fs.unlinkSync(fp); } catch { /* ignore */ } }
  }
  db.prepare('DELETE FROM photos WHERE id = ?').run(p.id);
  res.json({ ok: true });
});

export const sharpAvailable = !!sharp;
