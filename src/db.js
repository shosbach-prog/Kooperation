'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_SETTINGS = {
  klinik_name: 'KWL Klinik Dortmund',
  wochenstunden_standard: 38.5,
  austrag_frist_std: 72,
  austrag_unter_minimum: false,
  ruhezeit_std: 11,
  nacht_von: '21:00',
  nacht_bis: '06:00',
  zuschlag_nacht: 20,
  zuschlag_sonntag: 25,
  zuschlag_feiertag: 35,
  zuschlag_vorfest: 35,
  zuschlag_samstag: 20,
  samstag_bei_schichtarbeit: false,
};

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(pw, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(String(pw), salt, 64);
  const ref = Buffer.from(hash, 'hex');
  return ref.length === test.length && crypto.timingSafeEqual(ref, test);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('manager','staff')),
  qualification TEXT DEFAULT '',
  weekly_hours REAL DEFAULT 38.5,
  min_hours_month REAL DEFAULT 0,
  stundenentgelt REAL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS units (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS shift_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  break_min INTEGER NOT NULL DEFAULT 30,
  color TEXT NOT NULL DEFAULT '#4f7cac',
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS requirements (
  unit_id INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  shift_type_id INTEGER NOT NULL REFERENCES shift_types(id) ON DELETE CASCADE,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  min_staff INTEGER NOT NULL DEFAULT 0,
  max_staff INTEGER,
  PRIMARY KEY (unit_id, shift_type_id, weekday)
);

CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  unit_id INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  shift_type_id INTEGER NOT NULL REFERENCES shift_types(id) ON DELETE CASCADE,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  break_min INTEGER NOT NULL,
  min_staff INTEGER NOT NULL DEFAULT 0,
  max_staff INTEGER,
  note TEXT DEFAULT '',
  UNIQUE (date, unit_id, shift_type_id)
);

CREATE TABLE IF NOT EXISTS assignments (
  shift_id INTEGER NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER,
  PRIMARY KEY (shift_id, user_id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  actor_id INTEGER,
  action TEXT NOT NULL,
  details TEXT
);
`;

function seed(db, withDemo) {
  const insSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insSetting.run(k, JSON.stringify(v));

  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count > 0) return;

  const insUser = db.prepare(`INSERT INTO users (name, username, password_hash, role, qualification, weekly_hours, min_hours_month, stundenentgelt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  insUser.run('Pflegedienstleitung', 'manager', hashPassword(process.env.MANAGER_PASSWORD || 'manager123'), 'manager', 'Leitung', 38.5, 0, 0);

  if (!withDemo) return;

  const insUnit = db.prepare('INSERT INTO units (name) VALUES (?)');
  const u1 = insUnit.run('Station 1').lastInsertRowid;
  const u2 = insUnit.run('Station 2').lastInsertRowid;

  const insType = db.prepare('INSERT INTO shift_types (name, code, start_time, end_time, break_min, color) VALUES (?, ?, ?, ?, ?, ?)');
  const f = insType.run('Frühdienst', 'F', '06:00', '14:30', 30, '#e9a23b').lastInsertRowid;
  const s = insType.run('Spätdienst', 'S', '13:30', '22:00', 30, '#4f7cac').lastInsertRowid;
  const n = insType.run('Nachtdienst', 'N', '21:30', '06:30', 60, '#5b4a8a').lastInsertRowid;

  const insReq = db.prepare('INSERT INTO requirements (unit_id, shift_type_id, weekday, min_staff, max_staff) VALUES (?, ?, ?, ?, ?)');
  for (const unit of [u1, u2]) {
    for (let wd = 0; wd < 7; wd++) {
      const weekend = wd === 0 || wd === 6;
      insReq.run(unit, f, wd, weekend ? 2 : 3, weekend ? 3 : 4);
      insReq.run(unit, s, wd, weekend ? 2 : 3, weekend ? 3 : 4);
      insReq.run(unit, n, wd, 1, 2);
    }
  }

  const demo = [
    ['Anna Becker', 'abecker', 'Pflegefachkraft', 38.5, 120],
    ['Murat Yilmaz', 'myilmaz', 'Pflegefachkraft', 38.5, 120],
    ['Julia Schmitz', 'jschmitz', 'Pflegefachkraft', 30, 90],
    ['Tobias Wagner', 'twagner', 'Pflegefachkraft', 38.5, 120],
    ['Lena Hoffmann', 'lhoffmann', 'Pflegehilfskraft', 19.25, 60],
    ['Kevin Schulz', 'kschulz', 'Pflegehilfskraft', 38.5, 120],
  ];
  for (const [name, user, qual, wh, minH] of demo) {
    insUser.run(name, user, hashPassword('demo123'), 'staff', qual, wh, minH, 22.5);
  }
}

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  seed(db, process.env.SEED_DEMO !== '0');
  return db;
}

module.exports = { openDb, hashPassword, verifyPassword, DEFAULT_SETTINGS };
