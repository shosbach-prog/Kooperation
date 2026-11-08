'use strict';
/* Profilfotos und Zuschnitt */

// ---------- Profilfotos ----------
/** Rundes Foto oder Initialen */
function avatar(u, size = 32) {
  const initials = String(u?.name || '?').split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  const id = u?.id ?? u?.user_id;
  const style = { width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.4)}px` };
  if (u && u.foto_version) {
    return h('img', { class: 'avatar', src: `api/users/${id}/foto?v=${u.foto_version}`, alt: '', loading: 'lazy', style });
  }
  return h('span', { class: 'avatar avatar-initials', 'aria-hidden': 'true', style }, initials);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error('Das Bild konnte nicht gelesen werden. Bitte JPG oder PNG verwenden.'));
    i.src = src;
  });
}

/**
 * Zuschnitt-Dialog: Bild verschieben und vergrößern, bis nur der Kopf im Kreis ist.
 * Bedienung: ziehen (Finger/Maus), zwei Finger oder Mausrad zum Zoomen, Regler, Pfeiltasten.
 * Ergebnis: quadratisches JPEG (max. 512 px) ohne Metadaten, oder null bei Abbruch.
 */
async function cropImage(src, { out = 512 } = {}) {
  const img = await loadImage(src);
  const W = img.naturalWidth, H = img.naturalHeight;
  return openDialog((close) => {
    const S = Math.round(Math.min(320, window.innerWidth - 56)); // Größe der Bühne in CSS-Pixeln
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const canvas = h('canvas', { width: Math.round(S * dpr), height: Math.round(S * dpr), style: { width: `${S}px`, height: `${S}px` } });
    const ctx = canvas.getContext('2d');
    const base = Math.max(S / W, S / H); // Bild füllt die Bühne mindestens aus
    let zoom = 1;
    let x = 0, y = 0; // Verschiebung der Bildmitte gegenüber der Bühnenmitte (CSS-Pixel)
    const MAX = 5;

    const clamp = () => {
      const sc = base * zoom;
      const mx = Math.max(0, (W * sc - S) / 2), my = Math.max(0, (H * sc - S) / 2);
      x = Math.min(mx, Math.max(-mx, x));
      y = Math.min(my, Math.max(-my, y));
    };
    const draw = () => {
      clamp();
      const sc = base * zoom * dpr;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, (S * dpr) / 2 + x * dpr - (W * sc) / 2, (S * dpr) / 2 + y * dpr - (H * sc) / 2, W * sc, H * sc);
      slider.value = String(zoom);
    };
    /** Zoomen um einen Punkt (px, py relativ zur Bühnenmitte), damit dieser Punkt stehen bleibt */
    const zoomTo = (z, px = 0, py = 0) => {
      const nz = Math.min(MAX, Math.max(1, z));
      const f = nz / zoom;
      x = px - (px - x) * f;
      y = py - (py - y) * f;
      zoom = nz;
      draw();
    };

    const slider = h('input', { type: 'range', min: 1, max: MAX, step: 0.01, value: 1, 'aria-label': 'Vergrößerung', class: 'crop-zoom',
      oninput: (e) => zoomTo(Number(e.target.value)) });
    const stage = h('div', { class: 'crop-stage', tabindex: 0, 'aria-label': 'Bildausschnitt – mit Pfeiltasten verschieben, + und − zum Zoomen',
      style: { width: `${S}px`, height: `${S}px` } }, canvas, h('div', { class: 'crop-mask' }), h('div', { class: 'crop-guide' }));

    // Ziehen und Zwei-Finger-Zoom
    const pointers = new Map();
    let pinch = null;
    const rel = (e) => { const r = stage.getBoundingClientRect(); return [e.clientX - r.left - S / 2, e.clientY - r.top - S / 2]; };
    stage.addEventListener('pointerdown', (e) => {
      stage.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, rel(e));
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), z: zoom };
      }
    });
    stage.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId)) return;
      const prev = pointers.get(e.pointerId);
      const cur = rel(e);
      pointers.set(e.pointerId, cur);
      if (pointers.size === 1) {
        x += cur[0] - prev[0];
        y += cur[1] - prev[1];
        draw();
      } else if (pointers.size === 2 && pinch) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        zoomTo(pinch.z * (d / pinch.d), (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      }
    });
    const end = (e) => { pointers.delete(e.pointerId); if (pointers.size < 2) pinch = null; };
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', end);
    stage.addEventListener('wheel', (e) => { e.preventDefault(); const [px, py] = rel(e); zoomTo(zoom * Math.exp(-e.deltaY / 400), px, py); }, { passive: false });
    stage.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 20 : 6;
      if (e.key === 'ArrowLeft') x -= step; else if (e.key === 'ArrowRight') x += step;
      else if (e.key === 'ArrowUp') y -= step; else if (e.key === 'ArrowDown') y += step;
      else if (e.key === '+' || e.key === '=') return zoomTo(zoom * 1.1);
      else if (e.key === '-') return zoomTo(zoom / 1.1);
      else return;
      e.preventDefault();
      draw();
    });

    const save = () => {
      // so viele Original-Pixel liegen im Ausschnitt; nicht künstlich hochrechnen
      const n = Math.max(128, Math.min(out, Math.round(S / (base * zoom))));
      const o = document.createElement('canvas');
      o.width = n; o.height = n;
      const c = o.getContext('2d');
      const k = n / S; // Bühne → Ausgabe
      const sc = base * zoom * k;
      c.imageSmoothingQuality = 'high';
      c.drawImage(img, n / 2 + x * k - (W * sc) / 2, n / 2 + y * k - (H * sc) / 2, W * sc, H * sc);
      o.toBlob((b) => close(b), 'image/jpeg', 0.88);
    };

    draw();
    setTimeout(() => stage.focus(), 60);
    return h('div', { class: 'ui-dialog-body crop-dialog' },
      h('h2', {}, 'Ausschnitt wählen'),
      h('p', { class: 'ui-dialog-msg' }, 'Bild verschieben und vergrößern, bis Ihr Kopf im Kreis ist.'),
      stage,
      h('div', { class: 'crop-controls' },
        h('button', { type: 'button', class: 'ghost', 'aria-label': 'Verkleinern', onclick: () => zoomTo(zoom / 1.2) }, '−'),
        slider,
        h('button', { type: 'button', class: 'ghost', 'aria-label': 'Vergrößern', onclick: () => zoomTo(zoom * 1.2) }, '+')),
      h('div', { class: 'ui-dialog-actions' },
        h('button', { type: 'button', class: 'ghost', onclick: () => close(null) }, 'Abbrechen'),
        h('button', { type: 'button', class: 'ghost', onclick: () => { zoom = 1; x = 0; y = 0; draw(); } }, 'Zurücksetzen'),
        h('button', { type: 'button', onclick: save }, 'Übernehmen')));
  });
}

async function uploadFoto(url, blob, onDone) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: blob });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  toast('Foto gespeichert.');
  onDone(data);
}

/** Foto-Bereich mit Hochladen, Zuschneiden, Entfernen; url = 'api/me/foto' oder 'api/users/<id>/foto' */
function fotoControl(u, url, onDone) {
  const input = h('input', { type: 'file', accept: 'image/*', hidden: true });
  input.addEventListener('change', async () => {
    const file = input.files[0];
    input.value = '';
    if (!file) return;
    const src = URL.createObjectURL(file);
    try {
      const blob = await cropImage(src);
      if (blob) await uploadFoto(url, blob, onDone);
    } catch (e) { toast(e.message, true); } finally { URL.revokeObjectURL(src); }
  });
  const fotoSrc = u.foto_version ? `api/users/${u.id}/foto?v=${u.foto_version}` : null;
  return h('div', { class: 'foto-control' }, avatar(u, 96),
    h('div', {}, input,
      h('button', { type: 'button', onclick: () => input.click() }, u.foto_version ? 'Neues Foto' : 'Foto hochladen'),
      fotoSrc ? h('button', { type: 'button', class: 'ghost', onclick: async () => {
        try {
          const blob = await cropImage(fotoSrc);
          if (blob) await uploadFoto(url, blob, onDone);
        } catch (e) { toast(e.message, true); }
      } }, 'Ausschnitt ändern') : null,
      u.foto_version ? h('button', { type: 'button', class: 'ghost', onclick: async () => {
        if (!await uiConfirm('Das Foto wird gelöscht.', { title: 'Foto entfernen?', okText: 'Entfernen', danger: true })) return;
        try { onDone(await api('DELETE', url)); toast('Foto entfernt.'); } catch (e) { toast(e.message, true); }
      } }, 'Entfernen') : null,
      h('p', { class: 'small muted' }, 'Freiwillig. Das Foto sehen nur angemeldete Kolleginnen und Kollegen, z. B. im Dienstplan. ',
        'Auf dem Handy können Sie direkt die Kamera nutzen.')));
}
