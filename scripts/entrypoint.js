'use strict';
/**
 * Startpunkt im Container: Wird als root gestartet, korrigiert die Besitzrechte des
 * Datenordners (z. B. frisch angelegter Ordner auf dem Server) und läuft danach
 * mit den eingeschränkten Rechten des Benutzers "node" weiter.
 */
const fs = require('fs');
const path = require('path');

const DATA = path.dirname(process.env.DB_FILE || '/data/personaleinsatz.db');
const UID = 1000;
const GID = 1000;

function chownRecursive(p) {
  const st = fs.lstatSync(p);
  if (st.uid !== UID || st.gid !== GID) fs.lchownSync(p, UID, GID);
  if (st.isDirectory()) for (const name of fs.readdirSync(p)) chownRecursive(path.join(p, name));
}

if (typeof process.getuid === 'function' && process.getuid() === 0) {
  fs.mkdirSync(DATA, { recursive: true });
  chownRecursive(DATA);
  fs.chmodSync(DATA, 0o700);
  process.setgroups([]);
  process.setgid(GID);
  process.setuid(UID);
}

require('../server.js');
