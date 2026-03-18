import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import path from 'path';

const DB_PATH = path.join(process.env.DATA_DIR || '/data', 'oko.db');

export const db: BetterSqlite3.Database = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Create tables immediately — before any prepared statements
db.exec(`
  CREATE TABLE IF NOT EXISTS cameras (
    id TEXT PRIMARY KEY,
    label TEXT DEFAULT '',
    "group" TEXT DEFAULT '',
    sort_order INTEGER DEFAULT 0,
    main_codec TEXT DEFAULT '',
    main_audio TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT DEFAULT ''
  );
`);

// Migrations — safe to run multiple times
try { db.exec('ALTER TABLE cameras ADD COLUMN main_codec TEXT DEFAULT ""'); } catch {}
try { db.exec('ALTER TABLE cameras ADD COLUMN main_audio TEXT DEFAULT ""'); } catch {}

export function initDb() {
  // No-op — tables created at module load.
  // Codec cache is NOT cleared on restart anymore — probed data persists.
}

/** Ensure all camera IDs have a row in DB with group set. */
export function ensureCameraRows(cameras: { id: string; group: string }[]) {
  const upsertGroup = db.prepare(`
    INSERT INTO cameras (id, "group", sort_order) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET "group"=excluded."group"
  `);
  const txn = db.transaction((cams: { id: string; group: string }[]) => {
    cams.forEach((cam, i) => upsertGroup.run(cam.id, cam.group, i));
  });
  txn(cameras);
}

// Prepared statements — tables guaranteed to exist
export const stmts = {
  getAll:       db.prepare('SELECT id, label, "group", sort_order, main_codec, main_audio FROM cameras ORDER BY sort_order, id'),
  get:          db.prepare('SELECT id, label, "group", sort_order FROM cameras WHERE id = ?'),
  upsert:       db.prepare(`
    INSERT INTO cameras (id, label, "group", sort_order) VALUES (@id, @label, @group, @sort_order)
    ON CONFLICT(id) DO UPDATE SET label=@label, "group"=@group, sort_order=@sort_order
  `),
  updateMeta:   db.prepare(`
    INSERT INTO cameras (id, label, "group") VALUES (@id, @label, @group)
    ON CONFLICT(id) DO UPDATE SET label=@label, "group"=@group
  `),
  updateOrder:  db.prepare('UPDATE cameras SET sort_order = ? WHERE id = ?'),
  insertIgnore: db.prepare('INSERT OR IGNORE INTO cameras (id, sort_order) VALUES (?, ?)'),
  getCodecs:    db.prepare('SELECT main_codec, main_audio FROM cameras WHERE id = ?'),
  setCodecs:    db.prepare(`
    INSERT INTO cameras (id, main_codec, main_audio) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET main_codec=excluded.main_codec, main_audio=excluded.main_audio
  `),
};
