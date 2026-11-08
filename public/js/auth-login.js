'use strict';
/* Erscheinungsbild der Einrichtung und Anmeldung */

// ---------- Erscheinungsbild der Einrichtung ----------
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
async function loadBranding() {
  try { state.branding = await api('GET', 'api/branding'); } catch { state.branding = state.branding || null; }
  applyBranding();
}
function logoImg(cls) {
  const b = state.branding;
  return b && b.logo ? h('img', { src: `api/branding/logo?v=${b.logo_version}`, alt: `Logo ${b.klinik_name}`, class: cls }) : null;
}
function applyBranding() {
  const b = state.branding;
  if (!b) return;
  document.title = `${b.untertitel} – ${b.klinik_name}`;
  document.getElementById('clinic-name').textContent = b.klinik_name;
  document.getElementById('brand-sub').textContent = b.untertitel;
  document.getElementById('brand-mark').replaceChildren(logoImg('brand-logo') || h('span', { class: 'logo' }, '⊕'));
  if (darkQuery.matches) document.documentElement.style.removeProperty('--primary');
  else document.documentElement.style.setProperty('--primary', b.akzentfarbe);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', b.akzentfarbe);
  const login = main().querySelector('.login-brand');
  if (login) fillLoginBrand(login);
}
darkQuery.addEventListener('change', applyBranding);
function fillLoginBrand(el) {
  const b = state.branding || { klinik_name: '', untertitel: 'Personaleinsatzplanung' };
  el.querySelector('[data-clinic]').textContent = b.klinik_name;
  el.querySelector('[data-sub]').textContent = b.untertitel;
  el.querySelector('[data-logo]').replaceChildren(logoImg('login-logo-img') || h('span', { class: 'login-logo-icon' }, '⊕'));
}

// ---------- Anmeldung ----------
function hideAppChrome() {
  document.getElementById('topbar').hidden = true;
  document.getElementById('bottomnav').hidden = true;
  document.body.classList.remove('app', 'nav-open');
}

function renderLogin() {
  hideAppChrome();
  const node = document.getElementById('login-tpl').content.cloneNode(true);
  setMain(node);
  fillLoginBrand(main().querySelector('.login-brand'));
  const pk = passkeyLoginButton();
  if (pk) main().querySelector('#login-form').after(pk);
  main().querySelector('.login').append(legalLinks());
  const form = document.getElementById('login-form');
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = new FormData(form);
    try {
      const r = await api('POST', 'api/login', { username: fd.get('username'), password: fd.get('password') });
      if (r.stage === '2fa') renderCodeStep();
      else if (r.stage === 'setup') renderSetup(false);
      else await boot();
    } catch (e) { document.getElementById('login-error').textContent = e.message; }
  });
}
