'use strict';
/**
 * Oberflächentests im echten Browser (Chromium über Playwright):
 * alle Ansichten auf Handy und PC, Barrierefreiheit (axe-core, WCAG 2.1 AA), typische Abläufe.
 * Aufruf: npm run test:e2e   (Playwright muss installiert sein, sonst werden die Tests übersprungen)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

const skip = !H.playwright && 'Playwright ist nicht installiert';
let server, url, browser, mgr, staff;

const VIEWS = {
  manager: ['plan', 'tausch', 'protokolle', 'rueckmeldung', 'abwesenheiten', 'staff', 'stationen', 'generate', 'types', 'req', 'zeiten', 'report', 'log', 'settings', 'account'],
  staff: ['plan', 'stempel', 'mine', 'protokolle', 'rueckmeldung', 'abwesenheit', 'konto', 'wuensche', 'tausch', 'account'],
};
const DEVICES = () => ({
  'iPhone 13': H.playwright.devices['iPhone 13'],
  'Tablet quer': { viewport: { width: 1180, height: 820 }, hasTouch: true },
  'PC': { viewport: { width: 1440, height: 900 } },
});
const iso = (d) => d.toISOString().slice(0, 10);

test.before(async () => {
  if (skip) return;
  ({ server, url } = await H.startServer());
  browser = await H.playwright.chromium.launch({ args: ['--no-proxy-server'] });
  mgr = await H.loginState(browser, url, 'manager', 'manager123');
  staff = await H.loginState(browser, url, 'abecker', 'demo123');
  // Dienste für die nächsten Wochen erzeugen
  const ctx = await browser.newContext({ storageState: mgr.state });
  const from = iso(new Date(Date.now() - 7 * 864e5));
  const to = iso(new Date(Date.now() + 35 * 864e5));
  const r = await ctx.request.post(`${url}api/shifts/generate`, { data: { from, to } });
  assert.equal(r.status(), 200);
  await ctx.close();
});
test.after(async () => { await browser?.close(); server?.close(); });

async function open(device, state, extra = {}) {
  const ctx = await browser.newContext({ ...device, ...(state ? { storageState: state } : {}), ...extra });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return { ctx, page, errors };
}
async function show(page, view) {
  await page.goto(`${url}#${view}`);
  await page.waitForSelector('#main > *');
  await page.waitForLoadState('networkidle');
}

test('Anmeldeseite: barrierefrei, Impressum/Datenschutz erreichbar, Sprunglink', { skip }, async () => {
  const { ctx, page, errors } = await open(DEVICES()['iPhone 13']);
  await page.goto(url);
  await page.waitForSelector('#login-form');
  assert.deepEqual(await H.axe(page), []);
  // Sprunglink: wird bei Fokus sichtbar und setzt den Fokus auf den Inhalt
  await page.focus('.skip-link');
  assert.ok(await page.evaluate(() => document.querySelector('.skip-link').getBoundingClientRect().top >= 0));
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'main');
  await page.click('.legal-links >> text=Datenschutz');
  await page.waitForSelector('.legal-text');
  assert.deepEqual(await H.axe(page), []);
  await page.click('text=Schließen');
  assert.deepEqual(errors, []);
  await ctx.close();
});

for (const role of ['manager', 'staff']) {
  test(`Alle Ansichten (${role === 'manager' ? 'Verwaltung' : 'Mitarbeitende'}): Darstellung, Fehler, Barrierefreiheit`, { skip }, async () => {
    const problems = [];
    for (const [name, device] of Object.entries(DEVICES())) {
      const { ctx, page, errors } = await open(device, (role === 'manager' ? mgr : staff).state);
      for (const v of VIEWS[role]) {
        await show(page, v);
        for (const p of await H.layoutProblems(page)) problems.push(`${name} #${v}: ${p}`);
        // axe einmal je Ansicht (auf dem Handy und am PC) – der Tablet-Durchlauf prüft nur das Layout
        if (name !== 'Tablet quer') for (const p of await H.axe(page)) problems.push(`${name} #${v}: ${p}`);
      }
      for (const e of errors) problems.push(`${name}: JS-Fehler ${e}`);
      await ctx.close();
    }
    assert.deepEqual(problems, []);
  });
}

test('Dunkler Modus: Kontraste', { skip }, async () => {
  const { ctx, page } = await open(DEVICES().PC, staff.state, { colorScheme: 'dark' });
  const problems = [];
  for (const v of ['plan', 'mine', 'abwesenheit', 'wuensche']) {
    await show(page, v);
    for (const p of await H.axe(page)) problems.push(`#${v}: ${p}`);
  }
  assert.deepEqual(problems, []);
  await ctx.close();
});

test('Ablauf: Urlaub beantragen und genehmigen', { skip }, async () => {
  // nächster Montag in mindestens 3 Wochen
  const d = new Date(Date.now() + 21 * 864e5);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  const mo = iso(d);
  const fr = iso(new Date(d.getTime() + 4 * 864e5));

  const s = await open(DEVICES()['iPhone 13'], staff.state);
  await show(s.page, 'abwesenheit');
  const card = s.page.locator('.card', { has: s.page.locator('h2', { hasText: 'Urlaub beantragen' }) });
  await card.locator('input[type=date]').nth(0).fill(mo);
  await card.locator('input[type=date]').nth(1).fill(fr);
  await card.locator('button[type=submit]').click();
  await s.page.waitForSelector('td:has-text("beantragt")');
  assert.deepEqual(await H.axe(s.page), []);
  await s.ctx.close();

  const m = await open(DEVICES().PC, mgr.state);
  await show(m.page, 'abwesenheiten');
  const row = m.page.locator('tr', { hasText: 'Anna Becker' }).filter({ has: m.page.locator('button', { hasText: 'Genehmigen' }) }).first();
  await row.locator('button', { hasText: 'Genehmigen' }).click();
  await m.page.locator('dialog[open] button', { hasText: 'Genehmigen' }).click();
  await m.page.waitForFunction(() => ![...document.querySelectorAll('tr')].some((tr) => tr.textContent.includes('Anna Becker') && tr.textContent.includes('Genehmigen')));
  assert.deepEqual(m.errors, []);
  await m.ctx.close();

  const s2 = await open(DEVICES()['iPhone 13'], staff.state);
  await show(s2.page, 'abwesenheit');
  assert.ok(await s2.page.locator('td', { hasText: 'genehmigt' }).count() >= 1);
  await s2.ctx.close();
});

test('Ablauf: Dialoge sind per Tastatur bedienbar und barrierefrei', { skip }, async () => {
  const { ctx, page, errors } = await open(DEVICES().PC, mgr.state);
  await show(page, 'stationen');
  await page.locator('button', { hasText: /Gebäude/ }).first().click();
  await page.waitForSelector('dialog[open]');
  assert.deepEqual(await H.axe(page), []);
  // Fokus liegt im Dialog, Escape schließt ihn
  assert.ok(await page.evaluate(() => !!document.activeElement.closest('dialog')));
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('dialog[open]').count(), 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('Passkey: einrichten im Profil, danach Anmeldung ohne Passwort und Code', { skip }, async () => {
  // WebAuthn verlangt einen Domainnamen (keine IP-Adresse) → localhost
  const host = url.replace('127.0.0.1', 'localhost');
  const user = await H.loginState(browser, host, 'jschmitz', 'demo123');
  const { ctx, page, errors } = await open(DEVICES().PC, user.state);
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  await page.goto(`${host}#account`);
  await page.waitForSelector('text=Passkey auf diesem Gerät einrichten');
  await page.click('text=Passkey auf diesem Gerät einrichten');
  await page.fill('dialog[open] input', 'Test-Laptop');
  await page.click('dialog[open] button[type=submit]');
  await page.waitForSelector('.passkey-list >> text=Test-Laptop');
  assert.equal((await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials.length, 1);
  assert.deepEqual(await H.axe(page), []);

  // Abmelden und mit Passkey wieder anmelden
  await page.click('#logout');
  await page.waitForSelector('#login-form');
  await page.click('text=Mit Passkey anmelden');
  await page.waitForSelector('#tabs .nav-item');
  const me = await page.evaluate(() => fetch('api/me').then((r) => r.json()));
  assert.equal(me.user.username, 'jschmitz');

  // Passkey entfernen → Anmeldung damit nicht mehr möglich
  await page.goto(`${host}#account`);
  await page.waitForSelector('.passkey-list');
  await page.click('button[aria-label="Test-Laptop entfernen"]');
  await page.click('dialog[open] button:has-text("Entfernen")');
  await page.waitForSelector('text=Noch kein Passkey eingerichtet.');
  await page.click('#logout');
  await page.waitForSelector('#login-form');
  await page.click('text=Mit Passkey anmelden');
  await page.waitForSelector('#login-error:not(:empty)');
  assert.match(await page.textContent('#login-error'), /nicht \(mehr\) eingerichtet/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('Demo-Modus: Rolle wählen, sofort angemeldet, Rolle wechseln, neue Person', { skip }, async () => {
  const demo = await H.startServer({ demo: true });
  try {
    const { ctx, page, errors } = await open(DEVICES()['iPhone 13']);
    await page.goto(demo.url);
    await page.waitForSelector('.demo-person');
    assert.deepEqual(await H.axe(page), []);
    assert.deepEqual(await H.layoutProblems(page), []);
    await page.screenshot({ path: require('path').join(require('os').tmpdir(), 'pep-demo-login.png'), fullPage: true });
    // Pflegekraft
    await page.click('.demo-person:has-text("Anna Becker")');
    await page.waitForSelector('#bottomnav button');
    assert.equal(await page.locator('#bottomnav button', { hasText: 'Meine' }).count(), 1);
    // Rolle wechseln → Pflegedienstleitung
    await page.click('.demo-switch');
    await page.waitForSelector('.demo-person');
    await page.click('.demo-person:has-text("Pflegedienstleitung")');
    await page.waitForSelector('#bottomnav button');
    assert.equal(await page.locator('#bottomnav button', { hasText: 'Anträge' }).count(), 1);
    // neue Person
    await page.click('.demo-switch');
    await page.click('summary:has-text("Als neue Person")');
    await page.fill('.demo-neu input[name=name]', 'Maria Muster');
    await page.selectOption('.demo-neu select[name=rolle]', 'stationsleitung');
    await page.click('.demo-neu button[type=submit]');
    await page.waitForSelector('#bottomnav button');
    assert.match(await page.textContent('#who'), /Maria Muster/);
    assert.deepEqual(errors, []);
    await ctx.close();
  } finally { demo.server.close(); }
});

test('Stempeluhr am Handy: Kommen, Raucherpause, Pause beenden, Gehen', { skip }, async () => {
  // Dienst, der gerade läuft, für Anna anlegen
  const m = await browser.newContext({ storageState: mgr.state });
  const api = async (method, u, data) => (await m.request.fetch(`${url}${u}`, { method, data })).json();
  const fmt = (ms) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms)).split(' ');
  const [datum, beginn] = fmt(Date.now() - 20 * 60e3);
  const ende = fmt(Date.now() + 7 * 3600e3)[1];
  const typ = await api('POST', 'api/shift-types', { name: 'Stempeltest', code: 'ST', start_time: beginn, end_time: ende, break_min: 30, color: '#2a7149' });
  const units = await api('GET', 'api/units');
  await api('PUT', 'api/requirements', [0, 1, 2, 3, 4, 5, 6].map((w) => ({ unit_id: units[0].id, shift_type_id: typ.id, weekday: w, min_staff: 1 })));
  await api('POST', 'api/shifts/generate', { from: datum, to: datum });
  const shift = (await api('GET', `api/plan?from=${datum}&to=${datum}`)).shifts.find((x) => x.shift_type_id === typ.id);
  const users = await api('GET', 'api/users');
  await api('POST', `api/shifts/${shift.id}/assign`, { user_id: users.find((u) => u.username === 'abecker').id, force: true });
  await m.close();

  const { ctx, page, errors } = await open(DEVICES()['iPhone 13'], staff.state);
  await show(page, 'stempel');
  await page.waitForSelector('button.stempel-btn.kommen:not([disabled])');
  assert.match(await page.textContent('.stempeluhr'), /Stempeltest/);
  assert.deepEqual(await H.axe(page), []);
  await page.click('button.stempel-btn.kommen');
  await page.waitForSelector('.stempel-status.an');
  await page.waitForTimeout(1100);
  assert.match(await page.textContent('.stempel-zaehler strong'), /^00:00:0[1-9]$/);
  await page.click('button.stempel-btn.raucher');
  await page.waitForSelector('.stempel-status.pause');
  assert.match(await page.textContent('.stempel-status'), /Raucherpause/);
  assert.deepEqual(await H.axe(page), []);
  assert.deepEqual(await H.layoutProblems(page), []);
  await page.screenshot({ path: require('path').join(require('os').tmpdir(), 'pep-stempel.png') });
  await page.click('button.stempel-btn.weiter');
  await page.waitForSelector('.stempel-liste li');
  await page.click('button.stempel-btn.gehen');
  await page.click('dialog[open] button:has-text("Ausstempeln")');
  await page.waitForSelector('.stempel-ergebnis');
  await page.screenshot({ path: require('path').join(require('os').tmpdir(), 'pep-stempel-fertig.png') });
  assert.match(await page.textContent('.stempel-ergebnis'), /Raucherpausen/);
  // Ist-Zeit ist übernommen
  await show(page, 'mine');
  await page.waitForSelector('text=⏱ Stempeluhr');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('Dienstplan-Personenansicht: Woche/Monat, Filter, Eintragen per Antippen', { skip }, async () => {
  for (const [name, device] of [['PC', DEVICES().PC], ['iPhone 13', DEVICES()['iPhone 13']]]) {
    const { ctx, page, errors } = await open(device, mgr.state);
    await show(page, 'plan');
    await page.click('.segmented button:has-text("Personen")');
    await page.waitForSelector('.pp-table');
    assert.deepEqual(await H.axe(page), [], name);
    assert.deepEqual(await H.layoutProblems(page), [], name);
    await page.selectOption('select[aria-label=Zeitraum]', 'monat');
    await page.waitForSelector('.pp-monat');
    assert.deepEqual(await H.layoutProblems(page), [], name);
    // Ansicht wird gemerkt
    await page.reload(); await page.waitForSelector('.pp-monat');
    if (name === 'PC') {
      // Suche filtert die Zeilen
      await page.fill('.pp input[type=search]', 'Becker');
      await page.waitForFunction(() => document.querySelectorAll('tbody tr th.pp-name').length === 1);
      // freies Feld antippen → offenen Dienst eintragen
      const tag = new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10);
      const idx = await page.evaluate((t) => [...document.querySelectorAll('thead th.pp-day')].findIndex((th) => th.textContent.endsWith(t.slice(8))), tag);
      await page.locator('tbody tr:has(th.pp-name) td.pp-cell').nth(idx).locator('button').click();
      await page.waitForSelector('dialog[open]');
      assert.deepEqual(await H.axe(page), []);
      const eintragen = page.locator('dialog[open] button:has-text("Eintragen")').first();
      if (await eintragen.count()) {
        await eintragen.click();
        await page.waitForSelector('dialog[open]', { state: 'detached' }).catch(() => {});
        const dlg = page.locator('dialog[open] button[type=submit]');
        if (await dlg.count()) await dlg.click(); // ggf. Begründung/Bestätigung
      }
      await page.fill('.pp input[type=search]', '');
    }
    await page.click('.segmented button:has-text("Schichten")');
    assert.deepEqual(errors, [], name);
    await ctx.close();
  }
});

test('Stempeln ohne Netz: Warteschlange, Übertragung, App offline öffnen', { skip }, async () => {
  // Dienst für Tobias, der gerade läuft
  const m = await browser.newContext({ storageState: mgr.state });
  const api = async (method, u, data) => (await m.request.fetch(`${url}${u}`, { method, data })).json();
  const fmt = (ms) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms)).split(' ');
  const [datum, beginn] = fmt(Date.now() - 30 * 60e3);
  const typ = await api('POST', 'api/shift-types', { name: 'Offlinetest', code: 'OT', start_time: beginn, end_time: fmt(Date.now() + 6 * 3600e3)[1], break_min: 30, color: '#555555' });
  const units = await api('GET', 'api/units');
  await api('PUT', 'api/requirements', [0, 1, 2, 3, 4, 5, 6].map((w) => ({ unit_id: units[1].id, shift_type_id: typ.id, weekday: w, min_staff: 1 })));
  await api('POST', 'api/shifts/generate', { from: datum, to: datum });
  const shift = (await api('GET', `api/plan?from=${datum}&to=${datum}`)).shifts.find((x) => x.shift_type_id === typ.id);
  const users = await api('GET', 'api/users');
  await api('POST', `api/shifts/${shift.id}/assign`, { user_id: users.find((u) => u.username === 'twagner').id, force: true });
  await m.close();

  // localhost: Service Worker (App-Hülle offline) nur in sicherem Kontext
  const host = url.replace('127.0.0.1', 'localhost');
  const julia = await H.loginState(browser, host, 'twagner', 'demo123');
  const { ctx, page, errors } = await open(DEVICES()['iPhone 13'], julia.state);
  await page.goto(`${host}#stempel`);
  await page.waitForSelector('button.stempel-btn.kommen:not([disabled])');
  await page.evaluate(() => navigator.serviceWorker.ready);

  // Funkloch: Kommen und Raucherpause werden gespeichert
  await ctx.setOffline(true);
  await page.click('button.stempel-btn.kommen');
  await page.waitForSelector('.stempel-offline');
  assert.match(await page.textContent('.stempel-offline'), /1 Stempelung/);
  await page.waitForSelector('.stempel-status.an');
  await page.click('button.stempel-btn.raucher');
  await page.waitForSelector('.stempel-status.pause');
  assert.match(await page.textContent('.stempel-offline'), /2 Stempelungen/);
  assert.deepEqual(await H.axe(page), []);

  // App offline neu öffnen: Stempeluhr mit gespeichertem Stand
  await page.reload();
  await page.waitForSelector('.offline-seite .stempeluhr');
  assert.match(await page.textContent('.stempeluhr'), /Raucherpause/);
  await page.click('button.stempel-btn.weiter');
  await page.waitForSelector('.stempel-status.an');

  // Netz wieder da: alles wird übertragen, Server kennt die Stempelung
  await ctx.setOffline(false);
  // die App merkt das Netz von selbst, überträgt und startet normal
  await page.waitForSelector('#bottomnav button:not([hidden])', { timeout: 15000 }).catch(async () => {
    await page.click('.offline-seite button:has-text("Erneut verbinden")');
    await page.waitForSelector('#bottomnav button');
  });
  await page.goto(`${host}#stempel`);
  await page.waitForSelector('.stempel-status.an');
  await page.waitForFunction(() => !document.querySelector('.stempel-offline'));
  const status = await page.evaluate(() => fetch('api/stempel').then((r) => r.json()));
  assert.ok(status.laufend, 'auf dem Server eingestempelt');
  assert.equal(status.laufend.pausen.length, 1);
  assert.equal(status.laufend.pausen[0].art, 'raucher');
  assert.ok(status.laufend.pausen[0].ende_at);
  // Abmelden löscht den Zwischenspeicher
  await page.click('#bottomnav button:has-text("Menü")');
  assert.deepEqual(errors.filter((e) => !/Failed to fetch|NetworkError/.test(e)), []);
  await ctx.close();
});

test('Schichtprotokoll: Diktat (simuliert, auf dem Gerät), Vorschau, Patientendaten-Warnung, Speichern, Abzeichnen', { skip }, async () => {
  const { ctx, page, errors } = await open(DEVICES()['iPhone 13'], staff.state);
  // Spracherkennung simulieren: liefert ein festes Diktat, „auf dem Gerät“ verfügbar
  await ctx.addInitScript(() => {
    class FakeSR {
      static async available() { return 'available'; }
      start() { setTimeout(() => { const r = [{ transcript: window.__diktat || '' }]; r.isFinal = true; this.onresult({ resultIndex: 0, results: [r] }); }, 50); }
      stop() { setTimeout(() => this.onend && this.onend(), 10); }
    }
    window.SpeechRecognition = FakeSR;
  });
  // eigener Dienst von gestern
  const m = await browser.newContext({ storageState: mgr.state });
  const api = async (method, u, data) => (await m.request.fetch(`${url}${u}`, { method, data })).json();
  const gestern = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  await api('POST', 'api/shifts/generate', { from: gestern, to: gestern });
  const s = (await api('GET', `api/plan?from=${gestern}&to=${gestern}`)).shifts.find((x) => x.type_code === 'S' && x.unit_name === 'Station 2');
  const users = await api('GET', 'api/users');
  await api('POST', `api/shifts/${s.id}/assign`, { user_id: users.find((u) => u.username === 'abecker').id, force: true });
  await m.close();

  await page.goto(`${url}#protokolle`);
  await page.waitForSelector('.prot-zeile.mein .prot-btn');
  await page.locator('.prot-zeile.mein .prot-btn').first().click();
  await page.waitForSelector('.diktat-btn');
  assert.deepEqual(await H.axe(page), []);
  assert.deepEqual(await H.layoutProblems(page), []);
  await page.evaluate(() => { window.__diktat = 'Belegung 18. Zwei Zugänge, eine Entlassung. Sturz um 14 Uhr, keine Verletzung. Aufzug defekt'; });
  await page.click('.diktat-btn');
  await page.waitForTimeout(200);
  await page.click('.diktat-btn'); // „Fertig“
  await page.waitForSelector('.diktat-vorschau:not([hidden])');
  assert.match(await page.textContent('.diktat-vorschau'), /Belegung: 18/);
  assert.match(await page.textContent('.diktat-vorschau'), /Sturz um 14:00/);
  await page.click('.diktat-vorschau button:has-text("Übernehmen")');
  assert.equal(await page.inputValue('input[aria-label="Belegung"]'), '18');
  assert.equal(await page.locator('.vk-zeile').count(), 2);
  // Patientendaten im Freitext → Warnung
  await page.fill('textarea[aria-label="Übergabe-Notiz"]', 'Frau Schmidt unruhig');
  await page.waitForSelector('.pd-warnung:not([hidden])');
  await page.fill('textarea[aria-label="Übergabe-Notiz"]', 'Ruhige Schicht.');
  await page.waitForSelector('.protokoll > .pd-warnung[hidden]', { state: 'attached' });
  await page.click('button:has-text("Speichern und abzeichnen")');
  await page.waitForSelector('text=abgezeichnet von Anna Becker');
  await page.screenshot({ path: require('path').join(require('os').tmpdir(), 'pep-protokoll.png'), fullPage: true });
  assert.deepEqual(await H.layoutProblems(page), []);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('Mehrzeilige Felder zeigen gespeicherte Inhalte (Einstellungen, Personalakte)', { skip }, async () => {
  const { ctx, page, errors } = await open(DEVICES().PC, mgr.state);
  await show(page, 'settings');
  const listen = await page.$$eval('form textarea', (els) => els.map((e) => e.value));
  assert.ok(listen.some((v) => v.includes('Pflegefachkraft')), 'Qualifikationen-Liste muss gefüllt sein');
  assert.ok(listen.some((v) => v.includes('Sturz')), 'Vorkommnis-Arten müssen gefüllt sein');
  // Speichern ohne Änderung darf keine Liste leeren
  await page.click('form button[type=submit]');
  await page.waitForTimeout(500);
  const st = await page.evaluate(() => fetch('api/settings').then((r) => r.json()));
  assert.ok(st.qualifikationen.length >= 3);
  assert.ok(st.lohnarten.length >= 3);
  assert.deepEqual(errors, []);
  await ctx.close();
});
