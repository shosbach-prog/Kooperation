'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_SETTINGS = {
  klinik_name: 'LWL-Klinik Dortmund',
  untertitel: 'Personaleinsatzplanung',
  akzentfarbe: '#1f6f8b',
  zwei_faktor_pflicht: true,
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
  qualifikationen: ['Pflegefachkraft', 'Pflegehilfskraft', 'Auszubildende/r', 'Stationsleitung', 'Arzt/Ärztin', 'Psychologe/Psychologin', 'Therapeut/in'],
  begruendung_eintragen: false,
  begruendung_austragen: true,
  urlaubstage_standard: 30,
  au_ab_tag: 4,
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
  active INTEGER NOT NULL DEFAULT 1,
  totp_secret TEXT,
  totp_pending TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  totp_last_counter INTEGER NOT NULL DEFAULT -1,
  recovery_codes TEXT NOT NULL DEFAULT '[]',
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  urlaubstage_jahr REAL NOT NULL DEFAULT 30,
  schwerbehindert INTEGER NOT NULL DEFAULT 0,
  zusatzurlaub_tage REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires INTEGER NOT NULL,
  stage TEXT NOT NULL DEFAULT 'full'
);

CREATE TABLE IF NOT EXISTS buildings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kuerzel TEXT NOT NULL DEFAULT '',
  beschreibung TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS verbuende (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  gemeinsam INTEGER NOT NULL DEFAULT 1,
  beschreibung TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1
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

CREATE TABLE IF NOT EXISTS qual_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  unit_id INTEGER REFERENCES units(id) ON DELETE CASCADE,
  shift_type_id INTEGER REFERENCES shift_types(id) ON DELETE CASCADE,
  qualification TEXT NOT NULL,
  min_count INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS absences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('urlaub','zusatzurlaub','sonderurlaub','krank')),
  from_date TEXT NOT NULL,
  to_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('beantragt','genehmigt','abgelehnt','gemeldet')),
  note TEXT DEFAULT '',
  decision_note TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER,
  decided_by INTEGER,
  decided_at TEXT
);

CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  absence_id INTEGER NOT NULL REFERENCES absences(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
  uploaded_by INTEGER
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

  const insBuilding = db.prepare('INSERT INTO buildings (name, kuerzel, sort) VALUES (?, ?, ?)');
  const hausA = insBuilding.run('Haus A', 'A', 1).lastInsertRowid;
  insBuilding.run('Haus B', 'B', 2);
  const insUnit = db.prepare('INSERT INTO units (name, building_id) VALUES (?, ?)');
  const u1 = insUnit.run('Station 1', hausA).lastInsertRowid;
  const u2 = insUnit.run('Station 2', hausA).lastInsertRowid;
  // Demo: Station 1 und 2 hängen zusammen und gleichen Personal untereinander aus
  const vb = db.prepare("INSERT INTO verbuende (name, beschreibung) VALUES ('Verbund Haus A', 'Station 1 und 2 auf einem Flur')").run().lastInsertRowid;
  db.prepare('UPDATE units SET verbund_id = ? WHERE id IN (?, ?)').run(vb, u1, u2);

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

  db.prepare('INSERT INTO qual_rules (unit_id, shift_type_id, qualification, min_count) VALUES (NULL, NULL, ?, 1)').run('Pflegefachkraft');

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

/** Ergänzt fehlende Spalten in älteren Datenbanken */
function migrate(db) {
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  const add = (table, def) => {
    const name = def.split(' ')[0];
    if (!cols(table).includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${def}`);
  };
  add('users', 'totp_secret TEXT');
  add('users', 'totp_pending TEXT');
  add('users', 'totp_enabled INTEGER NOT NULL DEFAULT 0');
  add('users', 'totp_last_counter INTEGER NOT NULL DEFAULT -1');
  add('users', "recovery_codes TEXT NOT NULL DEFAULT '[]'");
  add('users', 'failed_logins INTEGER NOT NULL DEFAULT 0');
  add('users', 'locked_until INTEGER NOT NULL DEFAULT 0');
  add('sessions', "stage TEXT NOT NULL DEFAULT 'full'");
  add('users', 'urlaubstage_jahr REAL NOT NULL DEFAULT 30');
  add('users', 'schwerbehindert INTEGER NOT NULL DEFAULT 0');
  add('users', 'zusatzurlaub_tage REAL NOT NULL DEFAULT 0');
  // Personalverwaltung und Verwaltungsrechte
  for (const col of ['personalnummer', 'email', 'telefon', 'eintritt', 'austritt', 'befristet_bis', 'entgeltgruppe', 'bemerkung', 'admin_bis']) {
    add('users', `${col} TEXT NOT NULL DEFAULT ''`);
  }
  add('users', 'stufe INTEGER');
  add('users', 'stammbereich_id INTEGER');
  add('users', "admin_rechte TEXT NOT NULL DEFAULT 'keine'");
  add('users', 'foto_version INTEGER NOT NULL DEFAULT 0');
  add('users', "ical_token TEXT NOT NULL DEFAULT ''");
  add('units', "kuerzel TEXT NOT NULL DEFAULT ''");
  add('units', "telefon TEXT NOT NULL DEFAULT ''");
  add('units', 'leitung_id INTEGER');
  add('units', 'building_id INTEGER REFERENCES buildings(id) ON DELETE SET NULL');
  add('units', 'verbund_id INTEGER REFERENCES verbuende(id) ON DELETE SET NULL');
  // Abwesenheitsarten erweitern (CHECK-Bedingung erfordert Neuaufbau der Tabelle)
  const absSql = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'absences'").get()?.sql || '';
  if (!absSql.includes('zusatzurlaub')) {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      // Vorgehen nach https://www.sqlite.org/lang_altertable.html#otheralter:
      // neue Tabelle anlegen, Daten kopieren, alte löschen, neue umbenennen
      const create = SCHEMA.match(/CREATE TABLE IF NOT EXISTS absences \([\s\S]*?\n\);/)[0]
        .replace('CREATE TABLE IF NOT EXISTS absences', 'CREATE TABLE absences_neu');
      db.exec(`${create}
        INSERT INTO absences_neu SELECT * FROM absences;
        DROP TABLE absences;
        ALTER TABLE absences_neu RENAME TO absences;`);
      if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Migration absences: Fremdschlüssel verletzt');
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; } finally { db.exec('PRAGMA foreign_keys = ON'); }
  }
  // Name der Einrichtung aus der ersten Prototyp-Version korrigieren
  db.prepare("UPDATE settings SET value = ? WHERE key = 'klinik_name' AND value = ?")
    .run(JSON.stringify('LWL-Klinik Dortmund'), JSON.stringify('KWL Klinik Dortmund'));
}

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  migrate(db);
  seed(db, process.env.SEED_DEMO !== '0');
  return db;
}

module.exports = { openDb, hashPassword, verifyPassword, DEFAULT_SETTINGS };
