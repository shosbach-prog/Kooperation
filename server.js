'use strict';
const path = require('path');
const { openDb } = require('./src/db');
const { createApp } = require('./src/app');

const PORT = Number(process.env.PORT) || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'personaleinsatz.db');

const db = openDb(DB_FILE);
createApp(db).listen(PORT, () => {
  console.log(`Personaleinsatzplanung läuft auf http://localhost:${PORT}`);
});
