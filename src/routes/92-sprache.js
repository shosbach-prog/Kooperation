'use strict';
/**
 * Spracherkennung auf dem EIGENEN Server (Whisper, Open Source, über @huggingface/transformers + ONNX).
 * Die App nimmt im Browser auf, wandelt in 16-kHz-Mono um und schickt die Rohdaten hierher.
 * Audio wird nur im Arbeitsspeicher verarbeitet, nie gespeichert und verlässt den Server nicht.
 * Funktioniert damit in jedem Browser (Brave, Firefox, Safari, Chrome) und in der Android-App.
 *
 * .env:  SPRACHE=0               ausschalten
 *        SPRACHE_MODELL=…         Standard nach Arbeitsspeicher: ab 8 GB whisper-large-v3-turbo (sehr genau, ~1,1 GB Download),
 *                                 ab 3 GB whisper-small (~250 MB), darunter whisper-base
 * Das Modell wird beim ersten Start einmalig geladen und im Datenordner zwischengespeichert.
 */
const os = require('os');
const path = require('path');

// Ein Modell für alle App-Instanzen im Prozess (Echtbetrieb und Demo-Bereich teilen es)
const geteilt = globalThis.__pepSprache ||= { asr: null, laden: null, fehler: null, warteschlange: Promise.resolve(), modell: null };

module.exports = (app, ctx) => {
  const { HttpError, auth, wrap, audit, getSettings, express } = ctx;
  const ein = process.env.SPRACHE !== '0';
  // bestes Modell, das der Arbeitsspeicher erlaubt (gemessen: small ~1,4 GB, large-v3-turbo ~3,3 GB während der Erkennung)
  const gb = os.totalmem() / 1024 ** 3;
  const modell = process.env.SPRACHE_MODELL
    || (gb >= 7.5 ? 'onnx-community/whisper-large-v3-turbo' : gb >= 3 ? 'onnx-community/whisper-small' : 'onnx-community/whisper-base');
  const cacheDir = process.env.SPRACHE_CACHE || path.join(path.dirname(ctx.uploadDir), 'sprachmodelle');

  /** Erkenner: in Tests einsetzbar (opts.sprache), sonst Whisper */
  const laden = async () => {
    if (ctx.spracheTest) return ctx.spracheTest;
    if (geteilt.asr) return geteilt.asr;
    if (!geteilt.laden) {
      geteilt.modell = modell;
      geteilt.laden = (async () => {
        const { pipeline, env } = await import('@huggingface/transformers');
        env.cacheDir = cacheDir;
        const asr = await pipeline('automatic-speech-recognition', modell, { dtype: 'q8' });
        geteilt.asr = (pcm) => asr(pcm, { language: 'german', task: 'transcribe', chunk_length_s: 30, stride_length_s: 5 }).then((r) => String(r.text || '').trim());
        console.log(`Spracherkennung bereit (${modell}).`);
        return geteilt.asr;
      })().catch((e) => { geteilt.fehler = e.message; geteilt.laden = null; console.error('Spracherkennung nicht verfügbar:', e.message); throw e; });
    }
    return geteilt.laden;
  };
  ctx.spracheVorladen = () => { if (ein && !ctx.spracheTest) laden().catch(() => {}); };

  app.get('/api/sprache/status', auth, wrap(() => ({
    verfuegbar: ein && getSettings().sprache_server !== false && (!!ctx.spracheTest || !geteilt.fehler || !!geteilt.asr),
    geladen: !!(ctx.spracheTest || geteilt.asr),
    modell: ctx.spracheTest ? 'test' : (geteilt.modell || modell),
  })));

  // Begrenzung je Person: 60 Aufnahmen pro Stunde
  const zaehler = new Map();
  app.post('/api/sprache/erkennen', auth, express.raw({ type: () => true, limit: 16000 * 2 * 125 }), wrap(async (req) => {
    if (!ein || getSettings().sprache_server === false) throw new HttpError(403, 'Die Spracherkennung auf dem Server ist ausgeschaltet.', 'AUS');
    const jetzt = Date.now();
    const z = (zaehler.get(req.user.id) || []).filter((t) => t > jetzt - 3600e3);
    if (z.length >= 60) throw new HttpError(429, 'Zu viele Spracheingaben in kurzer Zeit – bitte kurz warten.');
    z.push(jetzt); zaehler.set(req.user.id, z);
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (buf.length < 16000 * 2 * 0.3 || buf.length % 2) throw new HttpError(400, 'Die Aufnahme ist zu kurz.', 'ZU_KURZ');
    // 16-Bit-PCM (little endian, 16 kHz, mono) → Float32
    const pcm = new Float32Array(buf.length / 2);
    for (let i = 0; i < pcm.length; i++) pcm[i] = buf.readInt16LE(i * 2) / 32768;
    let asr;
    try { asr = await laden(); } catch {
      throw new HttpError(503, 'Die Spracherkennung wird gerade vorbereitet oder ist nicht verfügbar. Bitte in einer Minute erneut versuchen.', 'NICHT_BEREIT');
    }
    const t0 = Date.now();
    // nacheinander abarbeiten (schont Prozessor und Arbeitsspeicher)
    const lauf = geteilt.warteschlange.then(() => asr(pcm));
    geteilt.warteschlange = lauf.catch(() => {});
    const text = await lauf;
    audit(req.user.id, 'sprache.erkannt', { sekunden: Math.round(pcm.length / 1600) / 10, ms: Date.now() - t0 });
    return { text, ms: Date.now() - t0 };
  }));
};
