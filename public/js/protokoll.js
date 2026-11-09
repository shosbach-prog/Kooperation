'use strict';
/* Schichtprotokoll (ohne Patientenbezug) mit Spracheingabe */

// ---------- Spracheingabe ----------
// Bevorzugt Erkennung AUF DEM GERÄT (Chrome: processLocally). Cloud-Erkennung (Audio geht an Google/Apple)
// nur, wenn die Verwaltung sie in den Einstellungen ausdrücklich erlaubt hat.
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
async function sprachModus(cloudErlaubt) {
  if (!SR) return { modus: 'keine' };
  if (typeof SR.available === 'function') {
    try {
      const st = await SR.available({ langs: ['de-DE'], processLocally: true });
      if (st === 'available') return { modus: 'lokal' };
      if (st === 'downloadable' || st === 'downloading') return { modus: 'herunterladbar' };
    } catch { /* ältere Version */ }
  }
  return { modus: cloudErlaubt ? 'cloud' : 'gesperrt' };
}

/** Startet ein Diktat; onText(endgueltig, vorlaeufig); liefert stop() */
function diktatStarten({ lokal, onText, onEnde, onFehler }) {
  const rec = new SR();
  rec.lang = 'de-DE';
  rec.continuous = true;
  rec.interimResults = true;
  if (lokal) rec.processLocally = true;
  let aktiv = true, fertig = '';
  rec.onresult = (e) => {
    let vorl = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) fertig += (fertig && !/\s$/.test(fertig) ? ' ' : '') + t.trim();
      else vorl += t;
    }
    onText(fertig, vorl);
  };
  rec.onerror = (e) => {
    if (e.error === 'no-speech' || e.error === 'aborted') return;
    aktiv = false;
    onFehler(e.error === 'not-allowed' || e.error === 'service-not-allowed' ? 'Kein Zugriff aufs Mikrofon – bitte in den Browser-Einstellungen erlauben.'
      : e.error === 'network' ? 'Für die Spracherkennung wird eine Internetverbindung benötigt.'
        : e.error === 'language-not-supported' ? 'Deutsch ist für die Spracherkennung auf diesem Gerät nicht verfügbar.' : `Spracherkennung: ${e.error}`);
  };
  rec.onend = () => { if (aktiv) { try { rec.start(); } catch { aktiv = false; onEnde(fertig); } } else onEnde(fertig); };
  rec.start();
  return { stop: () => { aktiv = false; try { rec.stop(); } catch { onEnde(fertig); } } };
}

// ---------- Spracherkennung auf dem eigenen Server (funktioniert in jedem Browser) ----------
let serverSpracheStatus = null;
async function serverSpracheVerfuegbar() {
  if (serverSpracheStatus === null || (!serverSpracheStatus.verfuegbar && Date.now() - serverSpracheStatus.at > 60000)) {
    try { serverSpracheStatus = { ...(await api('GET', 'api/sprache/status')), at: Date.now() }; } catch { serverSpracheStatus = { verfuegbar: false, at: Date.now() }; }
  }
  return serverSpracheStatus.verfuegbar;
}

/** Nimmt auf, bis stop() aufgerufen wird (höchstens 2 Min.); liefert 16-kHz-Mono als Int16-PCM */
async function serverAufnahme({ onPegel, onZeit, onAutoStop }) {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error('Dieser Browser kann keine Tonaufnahme machen.');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch (e) {
    throw new Error(e.name === 'NotAllowedError' ? 'Kein Zugriff aufs Mikrofon – bitte im Browser erlauben (Schloss-Symbol neben der Adresse → Mikrofon).' : 'Mikrofon nicht verfügbar.');
  }
  const rec = new MediaRecorder(stream);
  const teile = [];
  rec.ondataavailable = (e) => { if (e.data.size) teile.push(e.data); };
  const ac = new (window.AudioContext || window.webkitAudioContext)();
  const an = ac.createAnalyser(); an.fftSize = 512;
  ac.createMediaStreamSource(stream).connect(an);
  const werte = new Uint8Array(an.fftSize);
  const t0 = Date.now();
  const timer = setInterval(() => {
    an.getByteTimeDomainData(werte);
    let max = 0; for (const v of werte) max = Math.max(max, Math.abs(v - 128));
    onPegel(Math.min(1, max / 64));
    onZeit(Math.floor((Date.now() - t0) / 1000));
    if (Date.now() - t0 > 120000) onAutoStop();
  }, 100);
  rec.start(250);
  return {
    stop: () => new Promise((resolve, reject) => {
      rec.onstop = async () => {
        clearInterval(timer);
        stream.getTracks().forEach((t) => t.stop());
        try {
          const blob = new Blob(teile, { type: rec.mimeType || 'audio/webm' });
          const roh = await ac.decodeAudioData(await blob.arrayBuffer());
          const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(roh.duration * 16000)), 16000);
          const src = off.createBufferSource(); src.buffer = roh; src.connect(off.destination); src.start();
          const f32 = (await off.startRendering()).getChannelData(0);
          const i16 = new Int16Array(f32.length);
          for (let i = 0; i < f32.length; i++) i16[i] = Math.max(-1, Math.min(1, f32[i])) * 32767;
          ac.close();
          resolve(i16);
        } catch (e) { ac.close(); reject(new Error('Die Aufnahme konnte nicht verarbeitet werden.')); }
      };
      rec.stop();
    }),
  };
}

async function serverErkennen(i16) {
  const res = await fetch('api/sprache/erkennen', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: i16.buffer });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Spracherkennung fehlgeschlagen.'), { code: data.code });
  return data.text || '';
}

/** Knopf „Diktieren“ inkl. Statusanzeige; ruft onFertig(text) */
function diktierKnopf(cloudErlaubt, onFertig, { label = '🎤 Diktieren', klein = false } = {}) {
  const box = h('div', { class: `diktat${klein ? ' klein' : ''}` });
  const anzeige = h('div', { class: 'diktat-text', 'aria-live': 'polite' });
  let lauf = null;
  const btn = h('button', { type: 'button', class: klein ? 'tiny ghost' : 'diktat-btn' }, label);
  const fertig = () => { lauf = null; btn.disabled = false; btn.classList.remove('aktiv'); btn.textContent = label; box.classList.remove('laeuft'); };
  btn.addEventListener('click', async () => {
    if (lauf) { lauf.stop(); return; }
    // 1. Wahl: Erkennung auf dem eigenen Server – geht in jedem Browser, Aufnahme verlässt den Server nicht
    if (await serverSpracheVerfuegbar()) {
      let aufnahme;
      const pegel = h('span', { class: 'pegel' }, h('span', {}));
      const zeit = h('span', { class: 'muted' }, '0:00');
      try {
        aufnahme = await serverAufnahme({
          onPegel: (p) => { pegel.firstChild.style.width = `${Math.round(p * 100)}%`; },
          onZeit: (sek) => { zeit.textContent = `${Math.floor(sek / 60)}:${String(sek % 60).padStart(2, '0')}`; },
          onAutoStop: () => lauf?.stop(),
        });
      } catch (e) { toast(e.message, true); return; }
      btn.classList.add('aktiv'); btn.textContent = '⏹ Fertig'; box.classList.add('laeuft');
      anzeige.replaceChildren(h('span', { class: 'aufnahme-punkt', 'aria-hidden': 'true' }), ' Aufnahme läuft ', zeit, pegel,
        h('div', { class: 'small' }, 'Tipp: Handy ca. 20 cm vor den Mund, ruhig und deutlich sprechen, kurze Sätze („Belegung 18. Zwei Zugänge.“).'),
        h('div', { class: 'small muted' }, 'Erkennung auf dem Klinik-Server – die Aufnahme verlässt den Server nicht und wird nicht gespeichert.'));
      lauf = {
        stop: async () => {
          lauf = { stop: () => {} };
          btn.disabled = true; btn.textContent = '… wird erkannt';
          anzeige.replaceChildren(h('span', { class: 'muted' }, 'Wird erkannt …'));
          try {
            const text = await serverErkennen(await aufnahme.stop());
            anzeige.replaceChildren();
            if (text.trim()) onFertig(text.trim()); else toast('Es wurde nichts verstanden – bitte noch einmal deutlich sprechen.', true);
          } catch (e) {
            anzeige.replaceChildren();
            toast(e.code === 'ZU_KURZ' ? 'Die Aufnahme war zu kurz.' : e.message, true);
          }
          fertig();
        },
      };
      return;
    }
    const m = await sprachModus(cloudErlaubt);
    if (m.modus === 'keine') { uiAlert('Dieser Browser unterstützt keine Spracheingabe. Bitte Chrome (Android) oder Safari (iPhone) verwenden.', { title: 'Spracheingabe' }); return; }
    if (m.modus === 'gesperrt') {
      uiAlert('Auf diesem Gerät ist keine Spracherkennung direkt auf dem Gerät verfügbar. Die Erkennung über das Internet (Audio wird an Google bzw. Apple übertragen) '
        + 'ist in dieser Einrichtung nicht freigegeben. Bitte Chrome aktualisieren oder die Verwaltung fragen.', { title: 'Spracheingabe nicht verfügbar' });
      return;
    }
    if (m.modus === 'herunterladbar') {
      if (!await uiConfirm('Für die Spracherkennung direkt auf dem Gerät muss einmalig das deutsche Sprachpaket geladen werden (ohne Übertragung Ihrer Aufnahmen).', { title: 'Sprachpaket laden', okText: 'Laden' })) return;
      try { await SR.install({ langs: ['de-DE'], processLocally: true }); } catch { toast('Sprachpaket konnte nicht geladen werden.', true); return; }
    }
    const lokal = m.modus === 'lokal' || m.modus === 'herunterladbar';
    btn.classList.add('aktiv');
    btn.textContent = '⏹ Fertig';
    box.classList.add('laeuft');
    anzeige.replaceChildren(h('span', { class: 'muted' }, lokal ? 'Hört zu … (Erkennung auf dem Gerät)' : 'Hört zu … (Erkennung über das Internet)'));
    lauf = diktatStarten({
      lokal,
      onText: (f, v) => anzeige.replaceChildren(...[h('span', {}, f), v ? h('span', { class: 'muted' }, ` ${v}`) : null].filter(Boolean)),
      onFehler: (msg) => toast(msg, true),
      onEnde: (text) => {
        lauf = null; btn.classList.remove('aktiv'); btn.textContent = label; box.classList.remove('laeuft'); anzeige.replaceChildren();
        if (text.trim()) onFertig(text.trim());
      },
    });
  });
  box.append(btn, anzeige);
  return box;
}

// ---------- Übersicht ----------
const PROT_STATUS = { fehlt: ['fehlt', 'bad'], entwurf: ['Entwurf', 'warn'], abgezeichnet: ['abgezeichnet', 'ok'] };

async function renderProtokolle() {
  if (state.protokollShift) return renderProtokoll(state.protokollShift);
  state.protVon ||= addDays(todayIso(), -6);
  state.protBis ||= todayIso();
  const [r, units] = await Promise.all([api('GET', `api/schichtprotokolle?from=${state.protVon}&to=${state.protBis}`), api('GET', 'api/units')]);
  const lf = listenFilter('protokolle', units, renderProtokolle);
  const nurOffen = !!state.protNurOffen;
  const list = r.dienste.filter((x) => lf.passt('', x.unit_id) && (!nurOffen || x.status !== 'abgezeichnet'));
  const meine = list.filter((x) => x.mein);
  const zeile = (x) => h('li', { class: `prot-zeile${x.mein ? ' mein' : ''}` },
    h('button', { type: 'button', class: 'prot-btn', onclick: () => { state.protokollShift = x.shift_id; renderProtokoll(x.shift_id); } },
      h('span', { class: 'chip', style: { background: x.type_color } }, x.type_code),
      h('span', { class: 'prot-info' }, h('strong', {}, `${WD[weekday(x.date)]} ${fmtDate(x.date)} · ${x.type_name}`),
        h('span', { class: 'small muted' }, `${x.unit_name} · ${x.start_time}–${x.end_time} · ${x.besetzt}/${x.min_staff} besetzt${x.mein ? ' · mein Dienst' : ''}`)),
      h('span', { class: 'prot-status' }, h('span', { class: `badge ${PROT_STATUS[x.status][1]}` }, PROT_STATUS[x.status][0]),
        x.vorkommnisse ? h('span', { class: 'small' }, `⚑ ${x.vorkommnisse}`) : null, x.gesperrt ? h('span', { title: 'Monat abgeschlossen' }, '🔒') : null)));
  setMain(
    isMgr() ? await protokollAuswertungCard() : null,
    h('div', { class: 'card' }, h('h2', {}, 'Schichtprotokolle'),
      h('p', { class: 'small muted' }, 'Stationsbetrieb je Dienst: Belegung, Zu- und Abgänge, besondere Vorkommnisse und Übergabe – per Sprache oder Tippen. ',
        h('strong', {}, 'Keine Patientendaten'), ' (Namen, Geburtsdaten, Fallnummern) – diese gehören in die Patientenakte.'),
      h('div', { class: 'toolbar' },
        h('label', {}, 'von', h('input', { type: 'date', value: state.protVon, onchange: (e) => { state.protVon = e.target.value; renderProtokolle(); } })),
        h('label', {}, 'bis', h('input', { type: 'date', value: state.protBis, onchange: (e) => { state.protBis = e.target.value; renderProtokolle(); } })),
        lf.leiste[0],
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: nurOffen, onchange: (e) => { state.protNurOffen = e.target.checked; renderProtokolle(); } }), 'nur offene')),
      meine.length ? [h('h3', {}, 'Meine Dienste'), h('ul', { class: 'prot-liste' }, meine.map(zeile))] : null,
      h('h3', {}, meine.length ? 'Alle Dienste' : 'Dienste'),
      list.length ? h('ul', { class: 'prot-liste' }, list.filter((x) => !x.mein).map(zeile)) : h('p', { class: 'muted' }, 'Keine Dienste im Zeitraum.')));
}

// ---------- Protokoll eines Dienstes ----------
function stepper(label, wert, onChange) {
  const input = h('input', { type: 'number', min: 0, max: 999, inputmode: 'numeric', value: wert ?? '', 'aria-label': label, placeholder: 'leer' });
  input.addEventListener('input', () => onChange(input.value === '' ? null : Number(input.value)));
  const plus = (d) => () => { const v = Math.max(0, (Number(input.value) || 0) + d); input.value = v; onChange(v); };
  return h('div', { class: 'stepper' }, h('span', { class: 'stepper-label' }, label),
    h('div', { class: 'stepper-reihe' }, h('button', { type: 'button', class: 'ghost', 'aria-label': `${label} verringern`, onclick: plus(-1) }, '−'), input,
      h('button', { type: 'button', class: 'ghost', 'aria-label': `${label} erhöhen`, onclick: plus(1) }, '+')));
}

async function renderProtokoll(shiftId) {
  let d;
  try { d = await api('GET', `api/schichtprotokolle/${shiftId}`); } catch (e) { state.protokollShift = null; toast(e.message, true); return renderProtokolle(); }
  const p = d.protokoll;
  const daten = {
    belegung: p?.belegung ?? null, betten: p?.betten ?? null, zugaenge: p?.zugaenge ?? null, entlassungen: p?.entlassungen ?? null, verlegungen: p?.verlegungen ?? null,
    notiz: p?.notiz || '', vorkommnisse: (p?.vorkommnisse || []).map((v) => ({ ...v })), per_sprache: false,
  };
  let geaendert = false;
  const ro = !d.darf_schreiben;
  const zurueck = () => { state.protokollShift = null; renderProtokolle(); };
  const t = d.dienst;

  const warnung = h('div', { class: 'pd-warnung', role: 'alert', hidden: true });
  const pruefe = () => {
    const funde = [daten.notiz, ...daten.vorkommnisse.map((v) => v.notiz)].flatMap((x) => Sprachparser.patientendaten(x));
    warnung.hidden = !funde.length;
    warnung.replaceChildren(h('strong', {}, '⚠ Möglicherweise Patientendaten: '), funde.map((f) => `„${f.text}“ (${f.art})`).join(', '),
      h('div', { class: 'small' }, 'Bitte entfernen – Patientendaten gehören in die Patientenakte.'));
  };

  const zahlen = h('div', { class: 'prot-zahlen' });
  const zeichneZahlen = () => zahlen.replaceChildren(
    stepper('Belegung', daten.belegung, (v) => { daten.belegung = v; geaendert = true; }),
    stepper('Zugänge', daten.zugaenge, (v) => { daten.zugaenge = v; geaendert = true; }),
    stepper('Entlassungen', daten.entlassungen, (v) => { daten.entlassungen = v; geaendert = true; }),
    stepper('Verlegungen', daten.verlegungen, (v) => { daten.verlegungen = v; geaendert = true; }));

  const vkListe = h('div', { class: 'vk-liste' });
  const zeichneVk = () => {
    vkListe.replaceChildren(...daten.vorkommnisse.map((v, i) => {
      const art = h('select', { 'aria-label': 'Art', onchange: (e) => { v.art = e.target.value; geaendert = true; } },
        [...new Set([...d.arten, v.art])].map((a) => h('option', { value: a, selected: a === v.art }, a)));
      const zeit = h('input', { type: 'time', value: v.uhrzeit || '', 'aria-label': 'Uhrzeit', onchange: (e) => { v.uhrzeit = e.target.value; geaendert = true; } });
      const anz = h('input', { type: 'number', min: 1, max: 99, value: v.anzahl || 1, inputmode: 'numeric', 'aria-label': 'Anzahl', class: 'vk-anzahl', onchange: (e) => { v.anzahl = Number(e.target.value) || 1; geaendert = true; } });
      const notiz = h('input', { value: v.notiz || '', maxlength: 300, placeholder: 'kurze Beschreibung (ohne Namen)', 'aria-label': 'Beschreibung' });
      notiz.addEventListener('input', () => { v.notiz = notiz.value; geaendert = true; pruefe(); });
      return h('div', { class: 'vk-zeile' }, art, anz, zeit, notiz,
        h('button', { type: 'button', class: 'tiny danger', 'aria-label': `Vorkommnis ${v.art} entfernen`, onclick: () => { daten.vorkommnisse.splice(i, 1); geaendert = true; zeichneVk(); pruefe(); } }, '×'));
    }), h('button', { type: 'button', class: 'ghost', onclick: () => { daten.vorkommnisse.push({ art: d.arten[0], anzahl: 1, uhrzeit: new Date().toTimeString().slice(0, 5), notiz: '' }); geaendert = true; zeichneVk(); } }, '+ Vorkommnis'));
  };

  const notiz = h('textarea', { rows: 5, maxlength: 4000, placeholder: 'Übergabe, organisatorische Besonderheiten … (keine Patientennamen)', value: daten.notiz, 'aria-label': 'Übergabe-Notiz' });
  notiz.addEventListener('input', () => { daten.notiz = notiz.value; geaendert = true; pruefe(); });

  // Diktat: in Felder zerlegen, Vorschau, übernehmen
  const vorschau = h('div', { class: 'diktat-vorschau', hidden: true });
  const diktatAuswerten = (text) => {
    const r = Sprachparser.parse(text, d.arten);
    const punkte = [];
    for (const [k, l] of [['belegung', 'Belegung'], ['zugaenge', 'Zugänge'], ['entlassungen', 'Entlassungen'], ['verlegungen', 'Verlegungen']]) {
      if (r[k] !== null) punkte.push({ text: `${l}: ${r[k]}`, apply: () => { daten[k] = r[k]; } });
    }
    for (const v of r.vorkommnisse) punkte.push({ text: `Vorkommnis: ${v.anzahl > 1 ? `${v.anzahl}× ` : ''}${v.art}${v.uhrzeit ? ` um ${v.uhrzeit}` : ''}${v.notiz ? ` – ${v.notiz}` : ''}`, apply: () => daten.vorkommnisse.push(v) });
    if (r.notiz) punkte.push({ text: `Übergabe: ${r.notiz}`, apply: () => { daten.notiz = daten.notiz ? `${daten.notiz.trim()}\n${r.notiz}` : r.notiz; } });
    if (!punkte.length) { toast('Nichts erkannt – bitte noch einmal sprechen.', true); return; }
    const checks = punkte.map((pt) => ({ ...pt, el: h('input', { type: 'checkbox', checked: true }) }));
    const funde = Sprachparser.patientendaten(text);
    vorschau.hidden = false;
    vorschau.replaceChildren(...[h('h3', {}, 'Erkannt – bitte prüfen'),
      h('p', { class: 'small muted' }, `„${text}“`),
      funde.length ? h('p', { class: 'pd-warnung' }, '⚠ Das Diktat enthält möglicherweise Patientendaten: ', funde.map((f) => `„${f.text}“`).join(', ')) : null,
      h('ul', { class: 'diktat-punkte' }, checks.map((c) => h('li', {}, h('label', { class: 'check' }, c.el, c.text)))),
      h('div', { class: 'toolbar' },
        h('button', { type: 'button', onclick: () => {
          checks.filter((c) => c.el.checked).forEach((c) => c.apply());
          daten.per_sprache = true; geaendert = true;
          vorschau.hidden = true; zeichneZahlen(); zeichneVk(); notiz.value = daten.notiz; pruefe();
          toast('Übernommen – bitte noch speichern.');
        } }, 'Übernehmen'),
        h('button', { type: 'button', class: 'ghost', onclick: () => { vorschau.hidden = true; } }, 'Verwerfen'))].filter(Boolean));
    vorschau.scrollIntoView({ block: 'center' });
  };

  const speichern = async (abzeichnen) => {
    const body = { ...daten, notiz: notiz.value };
    const senden = async (extra = {}) => api('PUT', `api/schichtprotokolle/${shiftId}`, { ...body, ...extra });
    try {
      let extra = {};
      if (p?.abgezeichnet_am && geaendert) {
        const grund = await uiPrompt({ title: 'Änderung nach Abzeichnung', label: 'Grund der Änderung (wird protokolliert)', required: true, minLength: 5 });
        if (!grund) return;
        extra.aenderungsgrund = grund;
      }
      try { await senden(extra); } catch (e) {
        if (e.code !== 'PATIENTENDATEN') throw e;
        const ok = await uiConfirm(`${e.message}\n\nGefunden: ${(e.funde || []).map((f) => `„${f.text}“`).join(', ')}\n\nNur speichern, wenn es sich sicher NICHT um Patientendaten handelt.`,
          { title: 'Patientendaten?', okText: 'Kein Patientenbezug – speichern', cancelText: 'Text korrigieren' });
        if (!ok) return;
        await senden({ ...extra, patientendaten_bestaetigt: true });
      }
      if (abzeichnen) await api('POST', `api/schichtprotokolle/${shiftId}/abzeichnen`);
      toast(abzeichnen ? 'Gespeichert und abgezeichnet.' : 'Gespeichert.');
      renderProtokoll(shiftId);
    } catch (e) { toast(e.message, true); }
  };

  zeichneZahlen(); zeichneVk(); pruefe();
  const besetzung = h('div', { class: 'prot-besetzung' }, h('h3', {}, `Besetzung ${d.besetzung.length}/${t.min_staff}`, t.unterbesetzt ? h('span', { class: 'badge bad', style: { marginLeft: '.4rem' } }, 'unterbesetzt') : null),
    h('ul', {}, d.besetzung.map((b) => h('li', {}, b.name, beschTag(b), b.qualification ? h('span', { class: 'small muted' }, ` · ${b.qualification}`) : null,
      b.ist_start ? h('span', { class: 'small muted' }, ` · ${b.ist_start}–${b.ist_end}${b.ist_quelle === 'stempel' ? ' ⏱' : ''}`) : null))));
  const status = p ? h('p', { class: 'small' },
    p.abgezeichnet_am ? h('span', { class: 'badge ok' }, `abgezeichnet von ${p.abgezeichnet_von_name} · ${fmtDate(p.abgezeichnet_am.slice(0, 10))} ${p.abgezeichnet_am.slice(11, 16)}`)
      : h('span', { class: 'badge warn' }, 'Entwurf – noch nicht abgezeichnet'),
    h('span', { class: 'muted' }, ` · angelegt von ${p.erstellt_von_name || '–'}${p.geaendert_von_name ? `, zuletzt geändert von ${p.geaendert_von_name}` : ''}${p.per_sprache ? ' · per Sprache erfasst' : ''}`)) : null;

  setMain(h('div', { class: 'card protokoll' + (ro ? ' ro' : '') },
    h('div', { class: 'toolbar' }, h('button', { type: 'button', class: 'ghost', onclick: zurueck }, '‹ Übersicht'),
      h('h2', { style: { margin: 0 } }, h('span', { class: 'chip', style: { background: t.type_color } }, t.type_code), ` ${t.type_name} · ${WD[weekday(t.date)]} ${fmtDate(t.date)}`),
      h('span', { class: 'muted' }, `${t.unit_name}${t.building_name ? ` · ${t.building_name}` : ''} · ${t.start_time}–${t.end_time}`)),
    status,
    ro ? h('p', {}, h('span', { class: 'badge' }, '🔒'), t.gesperrt ? ' Der Monat ist abgeschlossen – nur Ansicht.' : ' Das Protokoll kann erst ab dem Diensttag geschrieben werden.') : null,
    h('div', { class: 'pd-hinweis' }, h('strong', {}, 'Ohne Patientendaten: '), 'keine Namen, Geburtsdaten oder Fallnummern. Vorkommnisse nur als Art, Anzahl und Uhrzeit.'),
    !ro ? h('div', { class: 'diktat-bereich' }, diktierKnopf(d.sprache_cloud_erlaubt, diktatAuswerten),
      h('p', { class: 'small muted' }, 'Zum Beispiel: „Belegung 18. Zwei Zugänge, eine Entlassung. Sturz um 14 Uhr, keine Verletzung. Aufzug defekt.“ – die Angaben werden automatisch den Feldern zugeordnet.')) : null,
    vorschau,
    h('h3', {}, 'Belegung und Bewegungen'), zahlen,
    h('h3', {}, 'Besondere Vorkommnisse'), vkListe,
    h('h3', {}, 'Übergabe / Besonderheiten'), notiz,
    !ro ? diktierKnopf(d.sprache_cloud_erlaubt, (text) => { notiz.value = notiz.value ? `${notiz.value.trim()}\n${text}` : text; daten.notiz = notiz.value; daten.per_sprache = true; geaendert = true; pruefe(); },
      { label: '🎤 In die Notiz diktieren', klein: true }) : null,
    warnung,
    besetzung,
    !ro ? h('div', { class: 'toolbar prot-aktionen' },
      h('button', { type: 'button', onclick: () => speichern(false) }, 'Speichern'),
      !p?.abgezeichnet_am ? h('button', { type: 'button', class: 'ghost', onclick: () => speichern(true) }, 'Speichern und abzeichnen') : null) : null));
  if (ro) for (const el of main().querySelectorAll('.protokoll input, .protokoll select, .protokoll textarea, .protokoll .stepper button, .protokoll .vk-liste button')) el.disabled = true;
}

// ---------- Auswertung (Verwaltung) ----------
async function protokollAuswertungCard() {
  state.protMonat ||= todayIso().slice(0, 7);
  let a;
  try { a = await api('GET', `api/schichtprotokolle-auswertung?month=${state.protMonat}`); } catch { return null; }
  const arten = a.arten.filter((art) => a.stationen.some((s) => s.vorkommnisse[art]));
  return h('div', { class: 'card' }, h('div', { class: 'toolbar' }, h('h2', { style: { margin: 0 } }, 'Auswertung Schichtprotokolle'), h('span', { class: 'spacer' }),
    h('label', {}, 'Monat', h('input', { type: 'month', value: state.protMonat, onchange: (e) => { state.protMonat = e.target.value; renderProtokolle(); } })),
    h('a', { href: `api/schichtprotokolle.csv?month=${state.protMonat}` }, h('button', { class: 'ghost' }, 'CSV-Export'))),
    a.stationen.length ? h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Station', 'Protokolle', 'Ø Belegung', 'Zugänge', 'Entlassungen', 'Verlegungen', ...arten, 'Vorkommnisse in unterbesetzten Diensten'].map((x, i) => h('th', { class: i ? 'num' : '' }, x)))),
      h('tbody', {}, a.stationen.map((s) => h('tr', {}, h('td', {}, s.unit_name),
        h('td', { class: 'num' }, `${s.protokolle}/${s.dienste}`, s.protokolle < s.dienste ? h('div', { class: 'small muted' }, `${s.abgezeichnet} abgezeichnet`) : null),
        h('td', { class: 'num' }, s.belegung_schnitt ?? '–'), h('td', { class: 'num' }, s.zugaenge), h('td', { class: 'num' }, s.entlassungen), h('td', { class: 'num' }, s.verlegungen),
        ...arten.map((art) => h('td', { class: 'num' }, s.vorkommnisse[art] || '')),
        h('td', { class: 'num' }, s.vk_gesamt ? `${s.vk_unterbesetzt} von ${s.vk_gesamt}` : '–', s.dienste_unterbesetzt ? h('div', { class: 'small muted' }, `${s.dienste_unterbesetzt} Dienste unterbesetzt`) : null)))))) : h('p', { class: 'muted' }, 'Keine Dienste im Monat.'));
}
