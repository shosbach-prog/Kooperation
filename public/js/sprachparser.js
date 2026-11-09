'use strict';
/**
 * Diktat → Felder des Schichtprotokolls (ohne Patientenbezug) und Warnung vor Patientendaten.
 * Läuft im Browser (window.Sprachparser) und auf dem Server (require), damit beide dieselben Regeln nutzen.
 *
 * Beispiel: „Belegung 18. Zwei Zugänge, eine Entlassung. Sturz um 14 Uhr, keine Verletzung. Aufzug defekt.“
 *   → belegung 18, zugaenge 2, entlassungen 1, Vorkommnisse [Sturz 1× 14:00 „keine Verletzung“, Technische Störung „Aufzug defekt“]
 */
(function (root) {
  const ZAHLEN = {
    kein: 0, keine: 0, keinen: 0, null: 0, ein: 1, eine: 1, einen: 1, einem: 1, einer: 1, eins: 1, zwei: 2, zwo: 2, drei: 3, vier: 4, fünf: 5, fuenf: 5,
    sechs: 6, sieben: 7, acht: 8, neun: 9, zehn: 10, elf: 11, zwölf: 12, zwoelf: 12, dreizehn: 13, vierzehn: 14, fünfzehn: 15, sechzehn: 16,
    siebzehn: 17, achtzehn: 18, neunzehn: 19, zwanzig: 20, einundzwanzig: 21, zweiundzwanzig: 22, dreiundzwanzig: 23, vierundzwanzig: 24,
    fünfundzwanzig: 25, dreißig: 30, dreissig: 30,
  };
  const ZAHL = `(\\d{1,3}|${Object.keys(ZAHLEN).sort((a, b) => b.length - a.length).join('|')})`;
  const zahl = (w) => (w === undefined ? null : /^\d+$/.test(w) ? Number(w) : ZAHLEN[w.toLowerCase()] ?? null);

  /** Stichwörter je Vorkommnis-Art (Standardarten; weitere Arten werden über ihren Namen erkannt) */
  const SYNONYME = {
    'Notfall/Reanimation': ['notfall', 'reanimation', 'reanimiert', 'rea ', 'herzstillstand', 'notarzt'],
    Sturz: ['sturz', 'gestürzt', 'hingefallen', 'gefallen'],
    Aggressionsereignis: ['aggression', 'aggressiv', 'übergriff', 'angriff', 'angegriffen', 'bedroht', 'bedrohung', 'tätlich'],
    Polizeieinsatz: ['polizei'],
    Entweichung: ['entweichung', 'entwichen', 'abgängig', 'weggelaufen'],
    Selbstverletzung: ['selbstverletzung', 'selbstverletzend', 'selbst verletzt'],
    'Technische Störung': ['störung', 'defekt', 'kaputt', 'ausgefallen', 'funktioniert nicht', 'stromausfall', 'netzwerk', 'edv'],
    Personalausfall: ['personalausfall', 'krankgemeldet', 'krank gemeldet', 'ausgefallen ist', 'nicht zum dienst', 'fehlt heute'],
  };

  const uhrzeit = (t) => {
    let m = t.match(/\b(?:um|gegen|ca\.?)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(?:uhr)?(?:\s*(\d{1,2}))?/i) || t.match(/\b(\d{1,2})[:.](\d{2})\s*(?:uhr)?\b/i);
    if (!m) { m = t.match(/\b(\d{1,2})\s*uhr(?:\s*(\d{1,2}))?/i); if (m) m = [m[0], m[1], m[2]]; }
    if (!m) return null;
    const hh = Number(m[1]), mm = Number(m[2] ?? m[3] ?? 0);
    if (hh > 23 || mm > 59) return null;
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  };

  /** Anzahl unmittelbar vor einem Stichwort („zwei Zugänge“) oder danach („Zugänge: 2“) */
  const anzahlZu = (satz, woerter) => {
    const w = woerter.join('|');
    let m = satz.match(new RegExp(`${ZAHL}\\s+(?:neue[nr]?\\s+)?(?:${w})`, 'i'));
    if (m) return zahl(m[1]);
    m = satz.match(new RegExp(`(?:${w})\\s*(?::|=|waren|gab es|gibt es|sind|ist|von)?\\s*${ZAHL}\\b`, 'i'));
    if (m) return zahl(m[1]);
    return null;
  };

  /**
   * @param {string} text  Diktat
   * @param {string[]} arten  Vorkommnis-Arten (aus den Einstellungen)
   * @returns {{ belegung, zugaenge, entlassungen, verlegungen, vorkommnisse: {art, anzahl, uhrzeit, notiz}[], notiz }}
   */
  function parse(text, arten = Object.keys(SYNONYME)) {
    const out = { belegung: null, zugaenge: null, entlassungen: null, verlegungen: null, vorkommnisse: [], notiz: '' };
    const rest = [];
    const saetze = String(text || '').replace(/[ \t]+/g, ' ').split(/(?<=[.!?;])\s+|\s*\n+\s*|,\s+(?=(?:und\s+)?(?:\d+|ein|eine|zwei|drei|vier|fünf)\s)/i).map((s) => s.trim()).filter(Boolean);
    for (const roh of saetze) {
      const satz = roh.replace(/[.!?;]+$/, '');
      const s = ` ${satz.toLowerCase()} `;
      let erkannt = false;
      const set = (feld, woerter) => { const n = anzahlZu(satz, woerter); if (n !== null) { out[feld] = n; erkannt = true; } };
      if (/belegung|belegt|betten|patienten|auf station/.test(s)) set('belegung', ['belegung', 'belegt', 'betten belegt', 'betten', 'patienten', 'patientinnen', 'patienten auf station']);
      if (/zugang|zugänge|aufnahme|aufgenommen/.test(s)) set('zugaenge', ['zugänge', 'zugang', 'aufnahmen', 'aufnahme', 'neuaufnahmen', 'neuaufnahme', 'aufgenommen']);
      if (/entlass/.test(s)) set('entlassungen', ['entlassungen', 'entlassung', 'entlassen']);
      if (/verleg/.test(s)) set('verlegungen', ['verlegungen', 'verlegung', 'verlegt']);
      // Vorkommnisse
      // passende Art: Stichwort am Wortanfang, bei mehreren gewinnt das längste Stichwort („ausgefallen ist“ vor „ausgefallen“)
      let beste = null;
      for (const art of arten) {
        const keys = SYNONYME[art] || [art.toLowerCase().split(/[\s/]+/)[0]];
        for (const k of keys) {
          const kk = k.trim();
          const m = new RegExp(`(?:^|[\\s,.(\\-])${kk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').exec(s);
          // zuerst genanntes Stichwort entscheidet, bei gleicher Stelle das längere
          if (m && (!beste || m.index < beste.pos || (m.index === beste.pos && kk.length > beste.len))) beste = { art, keys, len: kk.length, pos: m.index };
        }
      }
      for (const { art, keys } of beste ? [beste] : []) {
        const n = anzahlZu(satz, keys.map((k) => k.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        const notiz = satz.replace(new RegExp(`^.*?(?:${keys.map((k) => k.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})[a-zäöüß]*`, 'i'), '')
          .replace(/\b(?:um|gegen)\s*\d{1,2}(?:[:.]\d{2})?\s*(?:uhr)?(?:\s*\d{1,2})?/i, '').replace(/^[\s,:–-]+|[\s,:–-]+$/g, '');
        const sauber = notiz.replace(/\s+,/g, ',').replace(/^[\s,]+/, '');
        // Rest nach dem Stichwort als Notiz; steht das Wichtige davor („Aufzug ausgefallen“), den ganzen Satz (ohne Uhrzeit) nehmen
        const vorher = (s.slice(0, beste.pos + 1).trim());
        const ohneZeit = satz.replace(/\s*\b(?:um|gegen)\s*\d{1,2}(?:[:.]\d{2})?\s*(?:uhr)?(?:\s*\d{1,2})?/i, '').trim();
        out.vorkommnisse.push({ art, anzahl: n && n > 0 ? n : 1, uhrzeit: uhrzeit(satz), notiz: (sauber.length > 2 ? sauber : vorher.length >= 3 ? ohneZeit : '').slice(0, 200) });
        erkannt = true;
        break; // ein Satz = ein Vorkommnis
      }
      if (!erkannt) rest.push(satz);
    }
    out.notiz = rest.join('. ').replace(/\s+/g, ' ').trim();
    if (out.notiz && !/[.!?]$/.test(out.notiz)) out.notiz += '.';
    return out;
  }

  /** Hinweise auf Patientendaten (Namen mit Anrede, Geburtsdaten, Fall-/Patientennummern) */
  function patientendaten(text) {
    const t = String(text || '');
    const funde = [];
    const add = (re, label) => { const m = t.match(re); if (m) funde.push({ art: label, text: m[0].trim() }); };
    add(/\b(?:Herr|Herrn|Frau|Hr\.|Fr\.)\s+(?:Dr\.\s+)?[A-ZÄÖÜ][a-zäöüß]+/, 'Name mit Anrede');
    add(/\b(?:Patient(?:in)?|Pat\.|Bewohner(?:in)?)\s+[A-ZÄÖÜ][a-zäöüß]{2,}(?:\s+[A-ZÄÖÜ][a-zäöüß]{2,})?/, 'Name nach „Patient“');
    add(/\b(?:geb\.|geboren|Geburtsdatum)\b/i, 'Geburtsangabe');
    add(/\b\d{1,2}\.\s?\d{1,2}\.\s?(?:19|20)\d{2}\b/, 'Datum mit Jahr (Geburtsdatum?)');
    add(/\b(?:Fall|Fallnr\.?|Fallnummer|PID|Patienten-?nr\.?|Pat\.-?Nr\.?)\s*:?\s*\d{4,}\b/i, 'Fall- oder Patientennummer');
    add(/\b\d{7,}\b/, 'lange Nummer');
    return funde;
  }

  const api = { parse, patientendaten, SYNONYME };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Sprachparser = api;
}(typeof window !== 'undefined' ? window : globalThis));
