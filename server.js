'use strict';
const path = require('path');
const { openDb } = require('./src/db');
const { createApp } = require('./src/app');

const PORT = Number(process.env.PORT) || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'personaleinsatz.db');

const db = openDb(DB_FILE);
createApp(db, {
  uploadDir: process.env.UPLOAD_DIR || path.join(path.dirname(DB_FILE), 'uploads'),
  backupDir: process.env.BACKUP_DIR || path.join(path.dirname(DB_FILE), 'backups'),
}).listen(PORT, () => {
  console.log(`Personaleinsatzplanung läuft auf http://localhost:${PORT}`);
});
