'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../src/tvoed');
const { DEFAULT_SETTINGS } = require('../src/db');

const S = { ...DEFAULT_SETTINGS };
const shift = (date, start_time, end_time, break_min) => ({ date, start_time, end_time, break_min });
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);

test('Feiertage NRW 2026', () => {
  const h = T.holidaysNRW(2026);
  assert.equal(h.get('2026-04-03'), 'Karfreitag');
  assert.equal(h.get('2026-04-06'), 'Ostermontag');
  assert.equal(h.get('2026-05-14'), 'Christi Himmelfahrt');
  assert.equal(h.get('2026-05-25'), 'Pfingstmontag');
  assert.equal(h.get('2026-06-04'), 'Fronleichnam');
  assert.equal(h.get('2026-11-01'), 'Allerheiligen');
  assert.equal(h.size, 11);
});

test('Schichtdauer inkl. Mitternacht und Pause', () => {
  near(T.shiftHours(shift('2026-11-09', '06:00', '14:30', 30)), 8);
  near(T.shiftHours(shift('2026-11-09', '21:30', '06:30', 60)), 8);
});

test('Nachtdienst werktags: Nachtstunden anteilig ohne Pause', () => {
  const b = T.breakdown(shift('2026-11-10', '21:30', '06:30', 60), S); // Di → Mi
  // 8,5 Std. Nacht (21:30–06:00) von 9 Std. Anwesenheit, Faktor 8/9
  near(b.nacht, 8.5 * 8 / 9);
  near(b.sonntag, 0);
  assert.equal(b.nachtschicht, true);
});

test('Samstag → Sonntag: Sonntagszuschlag erst ab 0 Uhr', () => {
  const b = T.breakdown(shift('2026-11-07', '21:30', '06:30', 0), S); // Sa → So
  near(b.sonntag, 6.5);
  near(b.samstag, 0); // im Schichtdienst standardmäßig kein Samstagszuschlag
  near(b.nacht, 8.5);
});

test('Samstagszuschlag nur 13–21 Uhr, wenn aktiviert', () => {
  const b = T.breakdown(shift('2026-11-07', '13:30', '22:00', 0), { ...S, samstag_bei_schichtarbeit: true });
  near(b.samstag, 7.5);
});

test('Feiertag hat Vorrang vor Sonntag', () => {
  // 01.11.2026 (Allerheiligen) ist ein Sonntag
  const b = T.breakdown(shift('2026-11-01', '06:00', '14:00', 0), S);
  near(b.feiertag, 8);
  near(b.sonntag, 0);
});

test('Heiligabend: Vorfestzuschlag erst ab 6 Uhr', () => {
  const b = T.breakdown(shift('2026-12-24', '05:00', '13:00', 0), S);
  near(b.vorfest, 7);
  near(b.nacht, 1);
});

test('Soll-Stunden: Feiertage an Werktagen mindern das Soll', () => {
  // Nov. 2026: 21 Werktage Mo–Fr, Allerheiligen fällt auf Sonntag → 21 × 7,7
  near(T.sollStunden(2026, 11, 38.5), 21 * 7.7);
  // Dez. 2026: 23 Werktage, abzüglich 24., 25., 31.12. (Do, Fr, Do) → 20
  near(T.sollStunden(2026, 12, 38.5), 20 * 7.7);
});

test('Zuschlag in Euro', () => {
  const b = { nacht: 8, samstag: 0, sonntag: 2, feiertag: 0, vorfest: 0 };
  near(T.zuschlagEuro(b, S, 20), 20 * (8 * 0.2 + 2 * 0.25));
});

test('Sprachparser: Diktat in Felder zerlegen, Patientendaten erkennen', () => {
  const P = require('../public/js/sprachparser');
  const r = P.parse('Belegung 18. Zwei Zugänge, eine Entlassung. Sturz um 14 Uhr, keine Verletzung. Aufzug ausgefallen. Kollegin hat sich krank gemeldet. Polizeieinsatz gegen 22:30 wegen Bedrohung. Medikamentenlieferung kommt erst morgen');
  assert.equal(r.belegung, 18); assert.equal(r.zugaenge, 2); assert.equal(r.entlassungen, 1);
  assert.deepEqual(r.vorkommnisse.map((v) => [v.art, v.uhrzeit]), [['Sturz', '14:00'], ['Technische Störung', null], ['Personalausfall', null], ['Polizeieinsatz', '22:30']]);
  assert.equal(r.vorkommnisse[0].notiz, 'keine Verletzung');
  assert.equal(r.notiz, 'Medikamentenlieferung kommt erst morgen.');
  assert.equal(P.parse('Drei Aufnahmen und keine Entlassung').entlassungen, 0);
  assert.equal(P.parse('Aggressives Verhalten um 9 Uhr 15').vorkommnisse[0].uhrzeit, '09:15');
  assert.equal(P.patientendaten('Aufzug defekt, Station ruhig').length, 0);
  assert.ok(P.patientendaten('Frau Schmidt Zimmer 3').length);
  assert.ok(P.patientendaten('Pat.-Nr. 1234567').length);
});
