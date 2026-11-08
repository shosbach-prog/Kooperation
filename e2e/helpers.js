'use strict';
/** Gemeinsame Hilfen für die Oberflächentests (Playwright + axe-core) */
const os = require('os');
const fs = require('fs');
const path = require('path');
const TOTP = require('../src/totp');

let playwright = null;
try { playwright = require('playwright'); } catch { /* optional */ }

async function startServer(extra = {}) {
  const { openDb } = require('../src/db');
  const { createApp } = require('../src/app');
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pep-e2e-'));
  const server = createApp(openDb(':memory:'), { uploadDir, basePath: '/lwl', timers: false, ...extra }).listen(0);
  await new Promise((r) => server.once('listening', r));
  return { server, url: `http://127.0.0.1:${server.address().port}/lwl/` };
}

/** Anmeldung über die Oberfläche inkl. 2FA-Einrichtung; liefert den gespeicherten Zustand (Cookie) */
async function loginState(browser, url, username, password) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  await p.goto(url);
  await p.fill('input[name=username]', username);
  await p.fill('input[name=password]', password);
  await p.click('button[type=submit]');
  await p.waitForSelector('a[href^="otpauth"]');
  const secret = new URL((await p.getAttribute('a[href^="otpauth"]', 'href')).replace('otpauth://', 'http://')).searchParams.get('secret');
  await p.fill('.code-input', TOTP.totp(secret));
  await p.click('button:has-text("Aktivieren")');
  await p.waitForSelector('pre.codes');
  await p.check('label.check input');
  await p.click('button:has-text("Weiter")');
  await p.waitForSelector('#tabs .nav-item');
  const state = await ctx.storageState();
  await ctx.close();
  return { state, secret };
}

const AXE = path.join(path.dirname(require.resolve('axe-core')), 'axe.min.js');
/** axe-core ausführen; liefert Verstöße der Stufen „serious“ und „critical“ (WCAG 2.1 A/AA) */
async function axe(page) {
  await page.addScriptTag({ path: AXE });
  const r = await page.evaluate(() => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } }));
  return r.violations.filter((v) => ['serious', 'critical'].includes(v.impact))
    .map((v) => `${v.id}: ${v.help} → ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
}

/** Seitenbreite und Tippflächen prüfen */
async function layoutProblems(page) {
  return page.evaluate(() => {
    const W = window.innerWidth;
    const out = [];
    if (document.documentElement.scrollWidth - W > 0) out.push(`horizontaler Überlauf ${document.documentElement.scrollWidth - W}px`);
    // versehentlich ausgegebene leere Werte
    const t = document.body.innerText;
    const m = t.match(/(^|[\s(])(null|undefined|NaN)([\s).,]|$)/);
    if (m) out.push(`Text „${m[2]}“ sichtbar: …${t.slice(Math.max(0, m.index - 30), m.index + 30).replace(/\s+/g, ' ')}…`);
    if (matchMedia('(pointer: coarse)').matches) {
      for (const el of document.querySelectorAll('button, a.button, select, input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=color])')) {
        const r = el.getBoundingClientRect();
        if (r.width && r.height && r.height < 32 && getComputedStyle(el).visibility !== 'hidden' && !el.closest('.chip, table.plan')) out.push(`kleine Tippfläche ${el.tagName} „${(el.textContent || el.name || '').trim().slice(0, 20)}“ ${Math.round(r.height)}px`);
      }
    }
    return out.slice(0, 5);
  });
}

module.exports = { playwright, startServer, loginState, axe, layoutProblems, TOTP };
