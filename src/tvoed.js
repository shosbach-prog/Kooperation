'use strict';
/**
 * Arbeitszeit- und Zuschlagsberechnung angelehnt an TVöD (BT-K, §§ 6–8).
 *
 * Alle Zeiten werden als "lokale Wandzeit" behandelt (intern als UTC gerechnet),
 * damit Sommer-/Winterzeitumstellungen die Rechnung nicht verfälschen.
 * Die Prozentsätze sind konfigurierbar und müssen gegen den jeweils gültigen
 * Tarifstand geprüft werden.
 */

const DAY = 86400000;
const SLOT_MIN = 15; // Rechengenauigkeit in Minuten

function parseDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function isoDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + (m || 0);
}

/** Ostersonntag (Gaußsche Osterformel, gregorianisch) */
function easterSunday(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return Date.UTC(y, month - 1, day);
}

const holidayCache = new Map();

/** Gesetzliche Feiertage in Nordrhein-Westfalen */
function holidaysNRW(y) {
  if (holidayCache.has(y)) return holidayCache.get(y);
  const e = easterSunday(y);
  const map = new Map();
  const add = (ms, name) => map.set(isoDate(ms), name);
  add(Date.UTC(y, 0, 1), 'Neujahr');
  add(e - 2 * DAY, 'Karfreitag');
  add(e + 1 * DAY, 'Ostermontag');
  add(Date.UTC(y, 4, 1), 'Tag der Arbeit');
  add(e + 39 * DAY, 'Christi Himmelfahrt');
  add(e + 50 * DAY, 'Pfingstmontag');
  add(e + 60 * DAY, 'Fronleichnam');
  add(Date.UTC(y, 9, 3), 'Tag der Deutschen Einheit');
  add(Date.UTC(y, 10, 1), 'Allerheiligen');
  add(Date.UTC(y, 11, 25), '1. Weihnachtstag');
  add(Date.UTC(y, 11, 26), '2. Weihnachtstag');
  holidayCache.set(y, map);
  return map;
}

function holidayName(iso) {
  return holidaysNRW(Number(iso.slice(0, 4))).get(iso) || null;
}

/** 24.12. und 31.12. ("Vorfesttage" nach § 8 Abs. 1 Satz 2 Buchst. e TVöD) */
function isVorfest(iso) {
  const md = iso.slice(5);
  return md === '12-24' || md === '12-31';
}

/** Beginn/Ende einer Schicht in ms. Endet sie vor/zum Beginn, geht sie über Mitternacht. */
function shiftInterval(date, start, end) {
  const base = parseDate(date);
  const s = base + toMinutes(start) * 60000;
  let e = base + toMinutes(end) * 60000;
  if (e <= s) e += DAY;
  return { start: s, end: e };
}

/** Bezahlte Arbeitszeit einer Schicht in Stunden (Dauer minus Pause) */
function shiftHours(shift) {
  const { start, end } = shiftInterval(shift.date, shift.start_time, shift.end_time);
  const minutes = (end - start) / 60000 - (Number(shift.break_min) || 0);
  return Math.max(0, minutes) / 60;
}

/**
 * Zerlegt eine Schicht in zuschlagspflichtige Stunden.
 * - Nachtarbeit (Standard 21–6 Uhr) wird zusätzlich zu den Tageszuschlägen gezählt.
 * - Von Feiertag / Vorfesttag / Sonntag / Samstag wird je Zeitabschnitt nur der
 *   höchste Zuschlag gewährt (§ 8 Abs. 1 Satz 3 TVöD).
 * - Die Pause wird anteilig von allen Kategorien abgezogen.
 */
function breakdown(shift, settings) {
  const { start, end } = shiftInterval(shift.date, shift.start_time, shift.end_time);
  const totalMin = (end - start) / 60000;
  const paidMin = Math.max(0, totalMin - (Number(shift.break_min) || 0));
  const factor = totalMin > 0 ? paidMin / totalMin : 0;

  const nightFrom = toMinutes(settings.nacht_von || '21:00');
  const nightTo = toMinutes(settings.nacht_bis || '06:00');
  const rates = {
    feiertag: Number(settings.zuschlag_feiertag) || 0,
    vorfest: Number(settings.zuschlag_vorfest) || 0,
    sonntag: Number(settings.zuschlag_sonntag) || 0,
    samstag: settings.samstag_bei_schichtarbeit ? Number(settings.zuschlag_samstag) || 0 : 0,
  };

  const acc = { nacht: 0, samstag: 0, sonntag: 0, feiertag: 0, vorfest: 0 };
  for (let t = start; t < end; t += SLOT_MIN * 60000) {
    const iso = isoDate(t);
    const minOfDay = (t % DAY) / 60000;
    const weekday = new Date(t).getUTCDay();

    const isNight = nightFrom > nightTo
      ? minOfDay >= nightFrom || minOfDay < nightTo
      : minOfDay >= nightFrom && minOfDay < nightTo;
    if (isNight) acc.nacht += SLOT_MIN;

    const candidates = [];
    if (holidayName(iso)) candidates.push('feiertag');
    if (isVorfest(iso) && minOfDay >= 6 * 60) candidates.push('vorfest');
    if (weekday === 0) candidates.push('sonntag');
    if (weekday === 6 && minOfDay >= 13 * 60 && minOfDay < 21 * 60 && rates.samstag > 0) candidates.push('samstag');
    if (candidates.length) {
      candidates.sort((a, b) => rates[b] - rates[a]);
      acc[candidates[0]] += SLOT_MIN;
    }
  }

  const out = { stunden: paidMin / 60 };
  for (const k of Object.keys(acc)) out[k] = (acc[k] * factor) / 60;
  // Nachtschicht im Sinne von § 7 Abs. 1 TVöD: mindestens 2 Stunden Nachtarbeit
  out.nachtschicht = acc.nacht >= 120;
  return out;
}

/** Zuschlag in Euro für eine Zerlegung bei gegebenem Stundenentgelt */
function zuschlagEuro(b, settings, stundenentgelt) {
  const rate = Number(stundenentgelt) || 0;
  if (!rate) return 0;
  const pct = (k) => (Number(settings['zuschlag_' + k]) || 0) / 100;
  const samstag = settings.samstag_bei_schichtarbeit ? b.samstag * pct('samstag') : 0;
  return rate * (b.nacht * pct('nacht') + b.sonntag * pct('sonntag') + b.feiertag * pct('feiertag')
    + b.vorfest * pct('vorfest') + samstag);
}

/**
 * Soll-Arbeitszeit eines Monats (§ 6 Abs. 3 TVöD):
 * Wochenarbeitszeit / 5 je Werktag Mo–Fr; Feiertage sowie 24.12./31.12.
 * an Werktagen vermindern das Soll.
 */
function sollStunden(year, month, weeklyHours) {
  const perDay = (Number(weeklyHours) || 0) / 5;
  let days = 0;
  for (let t = Date.UTC(year, month - 1, 1); new Date(t).getUTCMonth() === month - 1; t += DAY) {
    const wd = new Date(t).getUTCDay();
    const iso = isoDate(t);
    if (wd === 0 || wd === 6) continue;
    if (holidayName(iso) || isVorfest(iso)) continue;
    days++;
  }
  return days * perDay;
}

module.exports = {
  DAY, parseDate, isoDate, toMinutes, easterSunday, holidaysNRW, holidayName, isVorfest,
  shiftInterval, shiftHours, breakdown, zuschlagEuro, sollStunden,
};
