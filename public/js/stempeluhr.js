'use strict';
/* Stempeluhr: Kommen, Pause, Raucherpause, Gehen – mit laufender Uhr */

const zwei = (n) => String(n).padStart(2, '0');
const dauer = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${zwei(Math.floor(s / 3600))}:${zwei(Math.floor((s % 3600) / 60))}:${zwei(s % 60)}`; };
const minText = (m) => (m >= 60 ? `${Math.floor(m / 60)} Std. ${m % 60 ? `${m % 60} Min.` : ''}`.trim() : `${m} Min.`);
const uhr = (ms) => new Date(ms).toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin' });

function dienstText(d) {
  if (!d) return null;
  return h('div', { class: 'stempel-dienst' }, h('span', { class: 'chip', style: { background: d.type_color } }, d.type_code),
    h('span', {}, `${d.type_name} ${d.start_time}–${d.end_time}`, h('span', { class: 'small muted' }, ` · ${d.unit_name}${d.date !== todayIso() ? ` · ${fmtDate(d.date)}` : ''}`)));
}

async function stempeln(url, body, rerender) {
  try {
    const r = await api('POST', url, body);
    if (navigator.vibrate) navigator.vibrate(40);
    if (r.ergebnis) {
      const e = r.ergebnis;
      toast(`Ausgestempelt: ${minText(e.netto_min)} Arbeitszeit${e.ergaenzt_min ? ` (Mindestpause um ${e.ergaenzt_min} Min. ergänzt)` : ''}.`);
    }
    rerender(r);
  } catch (e) { toast(e.message, true); }
}

/** Die Stempeluhr als Karte; rerender lädt neu */
async function stempelCard() {
  const card = h('div', { class: 'card stempeluhr', 'aria-live': 'polite' });
  let timer = null;
  const render = (d) => {
    clearInterval(timer);
    const offset = d.server_now - Date.now();
    const jetzt = () => Date.now() + offset;
    const L = d.laufend;
    const uhrEl = h('div', { class: 'stempel-uhr', 'aria-hidden': 'true' });
    const zaehler = h('div', { class: 'stempel-zaehler' });
    const tick = () => {
      if (!card.isConnected) { clearInterval(timer); return; }
      uhrEl.textContent = uhr(jetzt());
      if (L) {
        const t = jetzt();
        const p = L.pause_offen;
        const pausen = L.pausen.reduce((a, x) => a + ((x.ende_at ?? t) - x.start_at) * (x.art === 'raucher' && !d.einstellungen.raucherpause_abziehen ? 0 : 1), 0);
        zaehler.replaceChildren(
          p ? h('span', { class: 'small' }, p.art === 'raucher' ? 'Raucherpause läuft' : 'Pause läuft') : h('span', { class: 'small' }, 'Arbeitszeit'),
          h('strong', {}, p ? dauer(t - p.start_at) : dauer(t - L.kommen_at - pausen)));
      }
    };
    const btn = (label, cls, onclick, extra = {}) => h('button', { type: 'button', class: `stempel-btn ${cls}`, onclick, ...extra }, label);
    const re = (r) => render(r);
    let inhalt;
    if (!L) {
      inhalt = [
        h('p', { class: 'stempel-status' }, 'Nicht eingestempelt'),
        d.vorschlag ? dienstText(d.vorschlag) : h('p', { class: 'small muted' }, 'Für jetzt ist kein Dienst für Sie geplant. Beim Einspringen tragen Sie sich bitte zuerst im Dienstplan ein.'),
        btn('Kommen', 'kommen', () => stempeln('api/stempel/kommen', { shift_id: d.vorschlag?.shift_id }, re), { disabled: !d.vorschlag }),
      ];
    } else if (L.pause_offen) {
      inhalt = [
        h('p', { class: 'stempel-status pause' }, L.pause_offen.art === 'raucher' ? '🚬 Raucherpause' : '☕ Pause', h('span', { class: 'small' }, ` seit ${uhr(L.pause_offen.start_at)}`)),
        zaehler,
        btn('Pause beenden', 'weiter', () => stempeln('api/stempel/weiter', undefined, re)),
      ];
    } else {
      const lange = jetzt() - L.kommen_at > 12 * 3600e3;
      const zeitInput = h('input', { type: 'time', 'aria-label': 'Tatsächliche Uhrzeit des Gehens' });
      inhalt = [
        h('p', { class: 'stempel-status an' }, 'Eingestempelt', h('span', { class: 'small' }, ` seit ${uhr(L.kommen_at)}`)),
        dienstText(L.dienst),
        zaehler,
        lange ? h('div', { class: 'stempel-vergessen' },
          h('p', {}, h('span', { class: 'badge warn' }, 'Ausstempeln vergessen?'), ' Sie sind seit über 12 Stunden eingestempelt. Bitte die tatsächliche Uhrzeit des Gehens eintragen:'),
          h('div', { class: 'toolbar' }, zeitInput, h('button', { type: 'button', onclick: () => {
            if (!zeitInput.value) { toast('Bitte Uhrzeit eingeben.', true); return; }
            stempeln('api/stempel/gehen', { zeit: zeitInput.value, note: 'Ausstempeln vergessen' }, re);
          } }, 'Gehen nachtragen'))) : null,
        h('div', { class: 'stempel-pausen-btns' },
          btn('☕ Pause', 'pause ghost', () => stempeln('api/stempel/pause', { art: 'pause' }, re)),
          btn('🚬 Raucherpause', 'raucher ghost', () => stempeln('api/stempel/pause', { art: 'raucher' }, re))),
        btn('Gehen', 'gehen', async () => {
          if (!await uiConfirm(`Jetzt ausstempeln (${uhr(jetzt())})?`, { title: 'Gehen', okText: 'Ausstempeln' })) return;
          stempeln('api/stempel/gehen', {}, re);
        }),
        jetzt() - L.kommen_at < 10 * 60e3 && !L.pausen.length ? h('button', { type: 'button', class: 'linkish small', onclick: async () => {
          try { render(await api('DELETE', 'api/stempel/offen')); toast('Einstempeln zurückgenommen.'); } catch (e) { toast(e.message, true); }
        } }, 'Versehentlich eingestempelt? Zurücknehmen') : null,
      ];
    }
    const pausenListe = L && L.pausen.length ? h('ul', { class: 'stempel-liste' }, L.pausen.map((p) => h('li', {},
      h('span', {}, p.art === 'raucher' ? '🚬 Raucherpause' : '☕ Pause'),
      h('span', {}, `${uhr(p.start_at)} – ${p.ende_at ? uhr(p.ende_at) : 'läuft'}`, p.ende_at ? h('span', { class: 'muted' }, ` (${minText(Math.round((p.ende_at - p.start_at) / 60000))})`) : null)))) : null;
    const erledigt = d.erledigt.length ? h('div', { class: 'stempel-erledigt' }, h('h3', {}, 'Zuletzt gestempelt'), d.erledigt.map((e) => h('div', { class: 'stempel-ergebnis' },
      dienstText(e.dienst),
      h('dl', {},
        h('dt', {}, 'Kommen – Gehen'), h('dd', {}, `${uhr(e.kommen_at)} – ${uhr(e.gehen_at)}`),
        h('dt', {}, 'Pausen'), h('dd', {}, minText(e.pause_min)),
        h('dt', {}, 'Raucherpausen'), h('dd', {}, minText(e.raucher_min), !d.einstellungen.raucherpause_abziehen ? h('span', { class: 'muted small' }, ' (zählen als Arbeitszeit)') : null),
        e.ergaenzt_min ? [h('dt', {}, 'Mindestpause ergänzt'), h('dd', {}, `${e.ergaenzt_min} Min. (§ 4 ArbZG)`)] : null,
        h('dt', {}, 'Arbeitszeit'), h('dd', {}, h('strong', {}, minText(e.netto_min))))))) : null;
    card.replaceChildren(...[h('div', { class: 'stempel-kopf' }, h('h2', {}, 'Stempeluhr'), uhrEl), ...inhalt.flat(), pausenListe, erledigt,
      h('p', { class: 'small muted' }, 'Die Zeiten werden sekundengenau gespeichert und beim Gehen automatisch als Ist-Zeit übernommen. ',
        d.einstellungen.raucherpause_abziehen ? 'Raucherpausen sind keine Arbeitszeit und werden abgezogen. ' : '',
        d.einstellungen.mindestpause_ergaenzen ? 'Fehlt die gesetzliche Mindestpause (über 6 Std.: 30 Min., über 9 Std.: 45 Min., nur Pausen ab 15 Min. zählen), wird sie ergänzt.' : '')].filter(Boolean));
    tick();
    timer = setInterval(tick, 1000);
  };
  try { render(await api('GET', 'api/stempel')); } catch (e) { card.replaceChildren(h('p', { class: 'error' }, e.message)); }
  return card;
}

async function renderStempeluhr() {
  setMain(await stempelCard());
}
