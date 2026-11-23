// ============================================================
//  CPCON CHATBOT — Lúcia v2 (ES) — flujo controlado por el backend
//  Conforme RGPD (Reglamento UE 2016/679) + LOPDGDD (Ley Orgánica 3/2018).
//  Dependencias: config.js, ui.js, api.js (ya cargados antes)
// ============================================================

// ── Turnstile REMOVIDO 2026-05-02 ──
// Widget Turnstile carregava 130KB de JS Cloudflare + Web Workers pesados,
// quebrava em mobile/Safari ITP e zerava leads silenciosamente. Substituído
// por: signed form token (GET /api/leads/form-token) + rate limit per-IP
// + honeypot (cpcon_hp) + validação Zod + pre-filtros LLM.
// Origin allowlist sozinho NÃO autentica — o POST de lead exige o token HMAC.
//
// Stubs mantidos pra compat de chamadas existentes:

// 17/10/2026 (form infalível): quem mexeu num formulário da página nos últimos
// 60 s não perde o foco para a Camile.
var cpconPageFormAt = 0;
document.addEventListener('focusin', function (e) {
  var t = e.target;
  if (t && t.form && !(t.closest && t.closest('#cpcon-inline-form'))) cpconPageFormAt = Date.now();
}, true);
function cpconPageFormBusy() {
  var a = document.activeElement;
  var inPage = a && a.form && !(a.closest && a.closest('#cpcon-inline-form'));
  return !!inPage || Date.now() - cpconPageFormAt < 60000;
}

function cpconRenderTurnstileInForm(_containerEl) { /* noop */ }
function cpconGetTurnstileToken() {
  return Promise.resolve('');
}

// ── Estado ─────────────────────────────────────────────────
const CRM_PROXY_URL = '/api/leads';
const CHAT_URL = '/api/chat';

async function cpconFetchFormToken() {
  const res = await fetch('/api/leads/form-token', { credentials: 'same-origin' });
  if (!res.ok) throw new Error('form-token HTTP ' + res.status);
  const data = await res.json().catch(function () { return null; });
  if (!data || !data.form_token) throw new Error('form-token missing');
  return data.form_token;
}

const cpconState = {
  isOpen: false,
  started: false,
  sessionId: null,
  // sessionToken: HMAC emitido pelo /api/leads/chatbot após captura do
  // formulário inicial. Próximas chamadas (/api/chat,
  // /api/atendimento/iniciar) enviam isso como prova de autorização.
  sessionToken: '',
  stage: 'idle',
  transferred: false,
  history: [],            // [{role, content}]
  busy: false,
  userName: '',
  userEmail: '',
  userPhone: '',
  userPhoneCountry: 'ES',
  honeypot: '',
  userEmpresa: '',
  leadId: null,
  lastActivityAt: 0,
  reengageTimer: null,
  // Legacy fields (compat com api.js antigo). Não usados pela UI nova.
  handoffReady: false,
  luciaLocked: false,
  responsesAfterHandoffReady: 0,
  // PR camile-ux-perf-2026-05-03 — fluxo novo
  handoffOffered: false,
  conversationEnded: false,
  lastSegment: null,
  lastTema: null,
  turns: 0,
};

// ── Validações do form inicial (iguais à versão antiga) ─────
const BLOCKED_NAMES = /^(oi|ola|olá|hey|hi|hello|hola|buenos|buenas|buenos\s*días|buenas\s*tardes|buenas\s*noches|boa|bom|bom\s*dia|boa\s*tarde|boa\s*noite|e|ee|eh|blz|beleza|opa|salve|ok|si|sí|sim|no|nao|não|teste|test|prueba|asdf|aaa|xxx|jaja|kkk|haha|hehe)$/i;
const VOWEL_RE = /[aeiouáéíóúâêîôûãõ]/i;
function validarNome(n) {
  const t = (n || '').trim();
  if (t.length < 3 || !VOWEL_RE.test(t) || BLOCKED_NAMES.test(t)) return null;
  // Nome COMPLETO — split(' ')[0] cortava o sobrenome de todo lead do chat.
  return t.replace(/\s+/g, ' ');
}
const EMAIL_RE = /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/;
const DISPOSABLE = /^(tempmail|mailinator|guerrillamail|10minutemail|throwaway|yopmail|fakeinbox|trashmail|sharklasers)\./i;
function validarEmail(e) {
  const t = (e || '').trim().toLowerCase();
  if (!EMAIL_RE.test(t)) return null;
  if (DISPOSABLE.test(t.split('@')[1])) return null;
  return t;
}
function validarTelefone(p, country) {
  var api = window.cpconPhone;
  if (!api || typeof api.normalize !== 'function') return '';
  var r = api.normalize(country || cpconState.userPhoneCountry || 'ES', p || '');
  return r && r.ok ? r.e164 : '';
}
function validarEmpresa(e) {
  const t = (e || '').trim();
  if (t.length < 2) return null;
  return t;
}

// Captura contato digitado em TEXTO LIVRE no chat (email/telefone/nome) para
// não perder lead quando o cliente escreve os dados em prosa em vez do fluxo
// estruturado. Só preenche o que falta; email/telefone passam pela validação
// existente; nome só quando já há email (exige inicial maiúscula, evita pegar
// cargo/verbo como nome). Paridade com o fix do widget BR.
function cpconExtractContact(text) {
  var s = String(text || '');
  if (!s) return;
  if (!cpconState.userEmail) {
    var em = (s.match(/[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/i) || [])[0];
    var ev = em ? validarEmail(em) : null;
    if (ev) cpconState.userEmail = ev;
  }
  if (!cpconState.userPhone && window.cpconPhone && typeof window.cpconPhone.extract === 'function') {
    var found = window.cpconPhone.extract(s);
    if (found && found.e164) {
      cpconState.userPhone = found.e164;
      cpconState.userPhoneCountry = found.country || 'ES';
    }
  }
  if (!cpconState.userName && cpconState.userEmail) {
    var nm = '';
    var mn = s.match(/(?:[Mm]i nombre es|[Mm]e llamo|[Ss]oy|[Nn]ombre[:\-])\s+([A-ZÀ-Ý][A-Za-zÀ-ÿ'\-]+(?:\s+[A-ZÀ-Ý][A-Za-zÀ-ÿ'\-]+){0,2})/);
    if (mn && mn[1]) nm = mn[1].trim();
    if (nm.length < 2) {
      var head = s.split(/[a-z0-9._%+\-]+@/i)[0];
      var cap = (head.match(/[A-ZÀ-Ý][a-zà-ÿ'\-]{1,}(?:\s+[A-ZÀ-Ý][a-zà-ÿ'\-]{1,}){0,2}/) || [''])[0]
        .replace(/^(Hola|Buenos|Buenas|Estimad[oa]s?|Hey|Soy|Mi|Me)\s+/i, '').trim();
      if (cap.length >= 2) nm = cap;
    }
    if (nm.length < 2) nm = cpconState.userEmail.split('@')[0].replace(/[._\-]+/g, ' ').trim();
    if (nm.length >= 2) cpconState.userName = nm.slice(0, 120);
  }
}


// ── Helpers UI (reutiliza os existentes: cpconSay, cpconMeMsg, etc) ─

function cpconScheduleReengage() {
  if (cpconState.reengageTimer) clearTimeout(cpconState.reengageTimer);
  if (cpconState.transferred) return;
  if (cpconState.stage !== 'chat' && cpconState.stage !== 'greeting') return;
  cpconState.reengageTimer = setTimeout(function () {
    if (Date.now() - cpconState.lastActivityAt < 60000) return;
    if (cpconState.transferred) return;
    cpconSay('¿Sigue por aquí?', function () { cpconEnableInput(); });
  }, 60000);
}

// ── Toggle + greeting ──────────────────────────────────────

function cpconToggle() {
  const chat = document.getElementById('cpcon-chat');
  const isCurrentlyOpen = chat.classList.contains('open');
  const willOpen = !isCurrentlyOpen;

  // PR camile-ux-perf-2026-05-03 — telemetria abertura do widget.
  if (willOpen) {
    try {
      (window.dataLayer = window.dataLayer || []).push({
        event: 'lucia_widget_opened',
        source: window.__cpconStickyClicked ? 'sticky_button' : 'fab',
        page_path: window.location.pathname,
      });
    } catch (e) { /* analytics opcional */ }
    window.__cpconStickyClicked = false;
    // Esconde o botão sticky enquanto janela aberta (volta no fechar).
    const sticky = document.getElementById('cpcon-sticky');
    if (sticky) sticky.style.display = 'none';
  } else {
    const sticky = document.getElementById('cpcon-sticky');
    if (sticky) sticky.style.display = '';
  }

  if (isCurrentlyOpen && !cpconState.started) {
    document.getElementById('cpcon-msgs').innerHTML = '';
    cpconState.isOpen = true;
    cpconState.started = true;
    setTimeout(cpconFlowGreeting, 300);
    return;
  }
  cpconState.isOpen = willOpen;
  chat.classList.toggle('open', cpconState.isOpen);
  // 02/11/2026: hora de abertura (proteção contra clique-fantasma, ver cpconCaptureGuard).
  if (cpconState.isOpen) cpconState.openedAt = Date.now();
  const badge = document.getElementById('cpcon-badge');
  if (badge) badge.style.display = 'none';
  if (cpconState.isOpen && !cpconState.started) {
    cpconState.started = true;
    setTimeout(cpconFlowGreeting, 500);
  }
}

function cpconFlowGreeting() {
  // Aviso RGPD/LOPDGDD: conforme al Reglamento UE 2016/679 + LO 3/2018,
  // informamos al usuario antes de recoger PII en el formulario inicial.
  cpconAppendNotice('No comparta contraseñas, DNI, NIE, CIF, IBAN ni datos de tarjeta aquí.');
  cpconSay(
    'Buenos días. Soy ' + (window.CPCON_CONFIG && window.CPCON_CONFIG.agentName ? window.CPCON_CONFIG.agentName : 'Lúcia') + ', consultora comercial del CPCON Group. Para poder ayudarle, indíqueme sus datos de contacto a continuación:',
    function () {
      cpconState.stage = 'form';
      cpconDisableInput();
      cpconShowInlineForm();
    }
  );
}

function cpconAppendNotice(text) {
  const container = document.getElementById('cpcon-msgs');
  if (!container) return;
  const n = document.createElement('div');
  n.className = 'cpcon-notice';
  n.style.cssText = 'font-size:11px;color:#475569;padding:6px 12px;text-align:center;background:#f1f5f9;border-radius:6px;margin:4px 12px;';
  n.textContent = text;
  container.appendChild(n);
  cpconScrollDown();
}

// ── Telemetria da captura (16/10/2026) ─────────────────────
// Funil da captura da Camile: capture_shown → capture_submitted, ou
// capture_rejected{reason: robot_box|phone|country|other}. Vai para o mesmo
// /api/form-telemetry dos formulários. Só códigos e nomes de campo: nada do
// que a pessoa digitou (sem nome, e-mail, empresa ou telefone).
var CPCON_TELEMETRY_URL = '/api/form-telemetry';
function cpconCaptureTelemetry(event, extra) {
  try {
    var body = { event: event, page: window.location.pathname.slice(0, 200), form: 'camile' };
    if (extra && extra.reason) body.reason = extra.reason;
    if (extra && extra.fields && extra.fields.length) body.fields = extra.fields.slice(0, 12);
    if (extra && extra.errors && extra.errors.length) body.errors = extra.errors.slice(0, 12);
    if (extra && /^[A-Z]{2}$/.test(extra.phone_country || '')) body.phone_country = extra.phone_country;
    var json = JSON.stringify(body);
    if (navigator.sendBeacon && navigator.sendBeacon(CPCON_TELEMETRY_URL, new Blob([json], { type: 'application/json' }))) return;
    fetch(CPCON_TELEMETRY_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json, keepalive: true, credentials: 'same-origin' }).catch(function () {});
  } catch (e) { /* telemetria nunca quebra o chat */ }
}

function cpconSetFieldError(input, errEl, msg) {
  if (errEl) errEl.textContent = msg || '';
  if (input) {
    if (msg) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
    if (errEl && errEl.id) input.setAttribute('aria-describedby', errEl.id);
  }
}

function cpconShowInlineForm() {
  const container = document.getElementById('cpcon-msgs');
  const formRow = document.createElement('div');
  formRow.className = 'cpcon-row';
  formRow.id = 'cpcon-inline-form';
  formRow.innerHTML =
    '<div class="cpcon-av"><img src="/cpcon-previa-es-gsc-20261123/chatbot/images/lucia.webp" alt="Lúcia" width="26" height="26"/></div>' +
    '<div class="cpcon-bbl cpcon-form-bbl">' +
    '  <div class="cpcon-form-group"><input type="text" id="cpcon-form-nome" placeholder="Nombre y apellidos *" maxlength="100" autocomplete="name"/><div id="cpcon-form-nome-err" class="cpcon-form-err"></div></div>' +
    '  <div class="cpcon-form-group"><input type="email" id="cpcon-form-email" placeholder="Correo electrónico corporativo *" maxlength="200" autocomplete="email"/><div id="cpcon-form-email-err" class="cpcon-form-err"></div></div>' +
    '  <div class="cpcon-form-group"><input type="text" id="cpcon-form-empresa" placeholder="Empresa *" maxlength="120" autocomplete="organization"/><div id="cpcon-form-empresa-err" class="cpcon-form-err"></div></div>' +
    '  <div class="cpcon-form-group" id="cpcon-form-phone">' +
    '    <div class="cpcon-phone-row">' +
    '      <button type="button" id="cpcon-form-cc" aria-haspopup="listbox" aria-expanded="false" aria-label="País del teléfono, España +34">🇪🇸 +34</button>' +
    '      <input type="tel" id="cpcon-form-tel" name="telefono" placeholder="Teléfono *" maxlength="24" autocomplete="tel-national" inputmode="tel"/>' +
    '    </div>' +
    '    <div id="cpcon-form-cc-pop" class="cpcon-phone-pop" hidden>' +
    '      <input type="search" id="cpcon-form-cc-q" name="cpcon_pais_q" autocomplete="off" placeholder="Buscar país" aria-label="Buscar país" data-1p-ignore="true" data-lpignore="true" data-form-type="other"/>' +
    '      <div id="cpcon-form-cc-list" role="listbox" aria-label="Países"></div>' +
    '    </div>' +
    '    <div id="cpcon-form-tel-err" class="cpcon-form-err" role="alert"></div>' +
    '  </div>' +
    '  <div class="cpcon-form-privacy" style="font-size:11px;color:#64748b;margin:8px 0 6px;line-height:1.45;">Al continuar acepta el tratamiento de sus datos por CPCON Group conforme al <a href="https://cpcongroup.es/politica-de-privacidad/" target="_blank" rel="noopener noreferrer">RGPD (UE 2016/679) y la LOPDGDD (Ley Orgánica 3/2018)</a>. Finalidad: gestión de su consulta comercial. Derechos ARCO ante la AEPD.</div>' +
    '  <div class="cpcon-form-actions">' +
    '    <label class="cpcon-robot" for="cpcon-form-robot"><input type="checkbox" id="cpcon-form-robot" name="no_soy_un_robot" aria-describedby="cpcon-form-robot-err"/> No soy un robot</label>' +
    '    <button id="cpcon-form-btn" onclick="cpconSubmitForm()">Continuar</button>' +
    '  </div>' +
    '  <div id="cpcon-form-robot-err" class="cpcon-form-err" role="alert"></div>' +
    '  <input type="text" id="cpcon-hp-note" name="cpcon_hp_note" tabindex="-1" autocomplete="off" autocapitalize="none" spellcheck="false" aria-hidden="true" value="" data-1p-ignore="true" data-lpignore="true" data-bwignore="true" data-form-type="other" style="position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;"/>' +
    '</div>';
  container.appendChild(formRow);
  cpconScrollDown();
  cpconCaptureTelemetry('capture_shown');
  cpconState.formShownAt = Date.now();
  document.getElementById('cpcon-form-robot').addEventListener('change', function (e) {
    if (e.target.checked) cpconSetFieldError(e.target, document.getElementById('cpcon-form-robot-err'), '');
  });
  const nome = document.getElementById('cpcon-form-nome');
  const email = document.getElementById('cpcon-form-email');
  const empresa = document.getElementById('cpcon-form-empresa');
  const tel = document.getElementById('cpcon-form-tel');
  nome.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); email.focus(); } });
  email.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); empresa.focus(); } });
  empresa.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); tel.focus(); } });
  tel.addEventListener('keydown', cpconPhoneEnter);
  tel.addEventListener('input', cpconMaskPhoneInput);
  // 16/11/2026: teclado que compõe (Samsung etc.): máscara só quando a composição termina.
  tel.addEventListener('compositionend', function (e) { cpconMaskPhoneInput({ target: e.target }); });
  cpconInitPhoneSelector();
  // 17/10/2026 (form infalível): a Camile não rouba o foco de quem está
  // preenchendo um formulário da página (abertura automática).
  if (!cpconPageFormBusy()) nome.focus();
}

function cpconPhoneApi() {
  return window.cpconPhone && typeof window.cpconPhone.format === 'function' ? window.cpconPhone : null;
}

function cpconInitPhoneSelector() {
  var api = cpconPhoneApi();
  var telErr = document.getElementById('cpcon-form-tel-err');
  if (!api) {
    if (telErr) telErr.textContent = 'No se pudo validar el teléfono. Recargue la página.';
    return;
  }
  cpconState.userPhoneCountry = api.defaultCountry || 'ES';
  var btn = document.getElementById('cpcon-form-cc');
  var pop = document.getElementById('cpcon-form-cc-pop');
  var q = document.getElementById('cpcon-form-cc-q');
  var list = document.getElementById('cpcon-form-cc-list');
  var countries = api.countries();
  function paint(filter) {
    var f = (filter || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/^\+/, '');
    list.innerHTML = '';
    countries.forEach(function (c) {
      var name = c.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      if (f && name.indexOf(f) === -1 && c.dial.replace('+', '').indexOf(f) !== 0 && c.iso.toLowerCase().indexOf(f) === -1) return;
      var opt = document.createElement('button');
      opt.type = 'button';
      opt.className = 'cpcon-phone-opt';
      opt.setAttribute('role', 'option');
      opt.setAttribute('aria-selected', c.iso === cpconState.userPhoneCountry ? 'true' : 'false');
      opt.textContent = c.flag + ' ' + c.name + ' ' + c.dial;
      opt.addEventListener('click', function () {
        cpconState.userPhoneCountry = c.iso;
        btn.textContent = c.flag + ' ' + c.dial;
        btn.setAttribute('aria-label', 'País del teléfono, ' + c.name + ' ' + c.dial);
        var tel = document.getElementById('cpcon-form-tel');
        if (tel) tel.value = api.format(c.iso, tel.value);
        pop.hidden = true;
        btn.setAttribute('aria-expanded', 'false');
      });
      list.appendChild(opt);
    });
  }
  paint('');
  btn.addEventListener('click', function () {
    pop.hidden = !pop.hidden;
    btn.setAttribute('aria-expanded', pop.hidden ? 'false' : 'true');
    if (!pop.hidden) q.focus();
  });
  q.addEventListener('input', function () { paint(q.value); });
  q.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); }
    if (e.key === 'Enter') e.preventDefault();
  });
}

// 16/11/2026 — causa raiz das recusas telefono:phone_invalid em Android (ES 16/11,
// Samsung Galaxy no navegador do TikTok): teclados que digitam por "composição"
// (teclado Samsung com texto preditivo e outros IME) mandam cada dígito como
// texto em composição. Reescrever o campo (máscara) no meio da composição faz o
// teclado reinserir a "palavra" inteira: 612345678 virava 612 36 12 34 (número
// errado) ou um número inválido. Padrão CPCON (igual nos 6 sites): durante a
// composição o campo fica como a pessoa digitou; a máscara entra no fim da
// composição (compositionend). A validação do envio continua igual.
function cpconImeComposing(e) {
  return !!(e && (e.isComposing || e.inputType === 'insertCompositionText'));
}

// 16/11/2026: Enter/"Ir" do teclado no telefone com a caixa "No soy un robot"
// desmarcada não envia às cegas (com o teclado aberto a caixa e o botão ficam
// fora da tela): fecha o teclado, leva a pessoa até a caixa e mostra o aviso.
function cpconPhoneEnter(e) {
  if (e.key !== 'Enter' || cpconImeComposing(e)) return;
  e.preventDefault();
  var robot = document.getElementById('cpcon-form-robot');
  if (robot && !robot.checked) {
    cpconSetFieldError(robot, document.getElementById('cpcon-form-robot-err'), 'Marca la casilla «No soy un robot» junto al botón para enviar.');
    cpconCaptureTelemetry('capture_rejected', { reason: 'robot_box', fields: ['no_soy_un_robot'], errors: ['no_soy_un_robot:robot_box'], phone_country: cpconState.userPhoneCountry });
    try { e.target.blur(); robot.focus(); robot.scrollIntoView({ block: 'center' }); } catch (err) { /* ok */ }
    return;
  }
  cpconSubmitForm();
}

function cpconMaskPhoneInput(e) {
  if (cpconImeComposing(e)) return;
  var api = cpconPhoneApi();
  if (!api) {
    e.target.value = '';
    var telErr = document.getElementById('cpcon-form-tel-err');
    if (telErr) telErr.textContent = 'No se pudo validar el teléfono. Recargue la página.';
    return;
  }
  if (typeof api.type !== 'function') { e.target.value = api.format(cpconState.userPhoneCountry || 'ES', e.target.value); return; }
  // 16/10/2026: "+351…" troca a bandeira sozinho; o "+" não some enquanto digita.
  var t = api.type(cpconState.userPhoneCountry || 'ES', e.target.value);
  e.target.value = t.display;
  if (t.detected && t.country !== cpconState.userPhoneCountry) cpconSetPhoneFlag(t.country);
}

function cpconSetPhoneFlag(iso) {
  var api = cpconPhoneApi();
  var btn = document.getElementById('cpcon-form-cc');
  if (!api || !btn) return;
  var c = api.countries().filter(function (x) { return x.iso === iso; })[0];
  if (!c) return;
  cpconState.userPhoneCountry = iso;
  btn.textContent = c.flag + ' ' + c.dial;
  btn.setAttribute('aria-label', 'País del teléfono, ' + c.name + ' ' + c.dial);
}

// 02/11/2026 — causa raiz das recusas "todos os campos inválidos" (MX 01-02/11):
// o painel abre sozinho (ou é aberto) e o toque/clique que a pessoa ia dar na
// página cai no botão de envio 0-4 s depois, com o formulário VAZIO. Nada ia
// ao servidor, mas a pessoa via 4-5 erros vermelhos e ia embora.
// Padrão CPCON (igual nos 6 sites):
//  - clique < CPCON_GHOST_MS após abrir o painel/mostrar o formulário = clique-fantasma:
//    não valida nem pinta erro; só registra form:ghost_click.
//  - formulário todo vazio = uma mensagem clara no 1º campo + foco; registra form:empty.
// Nunca envia ao servidor nesses casos. Validação normal segue igual.
var CPCON_GHOST_MS = 800;
var CPCON_EMPTY_MSG = 'Complete nombre, email, empresa y teléfono para empezar la conversación.';
function cpconCaptureGuard() {
  var since = Date.now() - Math.max(cpconState.openedAt || 0, cpconState.formShownAt || 0);
  if (since < CPCON_GHOST_MS) {
    cpconCaptureTelemetry('capture_rejected', { reason: 'other', fields: ['form'], errors: ['form:ghost_click'] });
    return false;
  }
  var ids = ['cpcon-form-nome', 'cpcon-form-email', 'cpcon-form-empresa', 'cpcon-form-tel'];
  var empty = ids.every(function (id) { var el = document.getElementById(id); return !el || !String(el.value || '').trim(); });
  if (empty) {
    var n = document.getElementById('cpcon-form-nome');
    cpconSetFieldError(n, document.getElementById('cpcon-form-nome-err'), CPCON_EMPTY_MSG);
    cpconCaptureTelemetry('capture_rejected', { reason: 'other', fields: ['form'], errors: ['form:empty'] });
    if (n && n.focus) { try { n.focus(); n.scrollIntoView({ block: 'center' }); } catch (e) { /* ok */ } }
    return false;
  }
  return true;
}

async function cpconSubmitForm() {
  if (!cpconCaptureGuard()) return;
  const nomeInp = document.getElementById('cpcon-form-nome');
  const emailInp = document.getElementById('cpcon-form-email');
  const empresaInp = document.getElementById('cpcon-form-empresa');
  const telInp = document.getElementById('cpcon-form-tel');
  const nomeErr = document.getElementById('cpcon-form-nome-err');
  const emailErr = document.getElementById('cpcon-form-email-err');
  const empresaErr = document.getElementById('cpcon-form-empresa-err');
  const telErr = document.getElementById('cpcon-form-tel-err');
  const robotInp = document.getElementById('cpcon-form-robot');
  const robotErr = document.getElementById('cpcon-form-robot-err');
  cpconSetFieldError(nomeInp, nomeErr, ''); cpconSetFieldError(emailInp, emailErr, '');
  cpconSetFieldError(empresaInp, empresaErr, ''); cpconSetFieldError(telInp, telErr, '');
  cpconSetFieldError(robotInp, robotErr, '');
  const nome = validarNome(nomeInp.value);
  const email = validarEmail(emailInp.value);
  const empresa = validarEmpresa(empresaInp.value);
  const api = cpconPhoneApi();
  // 16/10/2026: país pelo prefijo (+351…); sin prefijo = bandera; sin país = ES.
  const phone = !api ? { ok: false, reason: 'other' }
    : (typeof api.resolve === 'function' ? api.resolve(cpconState.userPhoneCountry || 'ES', telInp.value)
      : (function () { var e = validarTelefone(telInp.value, cpconState.userPhoneCountry); return e ? { ok: true, e164: e, country: cpconState.userPhoneCountry || 'ES' } : { ok: false, reason: 'phone' }; })());
  const tel = phone.ok ? phone.e164 : '';
  const failed = []; // [campo, clave, elemento] en el orden de la pantalla
  if (!nome) { cpconSetFieldError(nomeInp, nomeErr, 'Nombre válido (mín. 3 letras)'); failed.push(['nome', 'name_invalid', nomeInp]); }
  if (!email) { cpconSetFieldError(emailInp, emailErr, 'Correo corporativo válido'); failed.push(['email', 'email_invalid', emailInp]); }
  if (!empresa) { cpconSetFieldError(empresaInp, empresaErr, 'Empresa válida (mín. 2 letras)'); failed.push(['empresa', 'company_invalid', empresaInp]); }
  if (!api) { cpconSetFieldError(telInp, telErr, 'No se pudo validar el teléfono. Recargue la página.'); failed.push(['telefono', 'phone_api_missing', telInp]); }
  // 17/10/2026: campo vazio = obrigatório (não "inválido").
  else if (!String(telInp.value || '').replace(/[^0-9\u0660-\u0669\u06F0-\u06F9]/g, '')) { cpconSetFieldError(telInp, telErr, 'El teléfono es obligatorio.'); failed.push(['telefono', 'phone_invalid', telInp]); }
  else if (!phone.ok && phone.reason === 'country') { cpconSetFieldError(telInp, telErr, 'Prefijo internacional no reconocido. Revise el número o elija el país en la lista.'); failed.push(['telefono', 'phone_country', telInp]); }
  else if (!phone.ok) { cpconSetFieldError(telInp, telErr, 'Introduce un teléfono válido. ¿De otro país? Escríbalo con + y el prefijo, p. ej. +351…'); failed.push(['telefono', 'phone_invalid', telInp]); }
  if (!robotInp || !robotInp.checked) {
    cpconSetFieldError(robotInp, robotErr, 'Marca la casilla «No soy un robot» junto al botón para enviar.');
    failed.push(['no_soy_un_robot', 'robot_box', robotInp]);
  }
  const err = failed.length > 0;
  const honeypot = (document.getElementById('cpcon-hp-note') || {}).value || '';
  cpconState.honeypot = honeypot;
  if (String(honeypot).trim()) {
    if (robotErr) robotErr.textContent = 'No fue posible procesar su solicitud. Revise los datos e inténtelo de nuevo. Si necesita ayuda, escríbanos a ventas-es@cpcongroup.com o llame al +34 620 35 87 38.';
    cpconFetchFormToken().then(function (form_token) {
      fetch(CRM_PROXY_URL + '/cpcon-previa-es-gsc-20261123/chatbot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          nome: nomeInp.value,
          email: emailInp.value,
          telefone: telInp.value,
          telefono_pais: cpconState.userPhoneCountry || 'ES',
          empresa: empresaInp.value,
          no_soy_un_robot: !!(robotInp && robotInp.checked),
          cpcon_hp: honeypot,
          origem: 'chatbot_lucia',
          pagina: window.location.pathname,
          form_token: form_token,
        }),
      }).catch(function () {});
    }).catch(function () {});
    return;
  }
  if (err) {
    const keys = failed.map(function (f) { return f[1]; });
    const reason = keys.indexOf('robot_box') !== -1 ? 'robot_box'
      : keys.indexOf('phone_country') !== -1 ? 'country'
      : (keys.indexOf('phone_invalid') !== -1 || keys.indexOf('phone_api_missing') !== -1) ? 'phone' : 'other';
    cpconCaptureTelemetry('capture_rejected', {
      reason: reason,
      fields: failed.map(function (f) { return f[0]; }),
      errors: failed.map(function (f) { return f[0] + ':' + f[1]; }),
      phone_country: cpconState.userPhoneCountry,
    });
    const first = failed[0][2];
    if (first && first.focus) { try { first.focus(); first.scrollIntoView({ block: 'center' }); } catch (e) { /* ok */ } }
    return;
  }

  cpconState.userName = nome;
  cpconState.userEmail = email;
  cpconState.userEmpresa = empresa;
  cpconState.userPhone = tel;
  cpconState.userPhoneCountry = phone.country || cpconState.userPhoneCountry || 'ES';
  cpconCaptureTelemetry('capture_submitted', { phone_country: cpconState.userPhoneCountry });

  document.getElementById('cpcon-inline-form')?.remove();
  cpconMeMsg(nome + ' — ' + email + ' — ' + empresa + ' — ' + tel);

  // Cria lead inicial no CRM (fire-and-forget — não bloqueia o chat).
  // Token HMAC (GET /api/leads/form-token) + rate limit + honeypot + Zod.
  try {
    {
      const leadFields = {
          nome: nome,
          email: email,
          telefone: tel,
          telefono_pais: cpconState.userPhoneCountry || 'ES',
          no_soy_un_robot: true,
          empresa: empresa,
          origem: 'chatbot_lucia',
          pagina: window.location.pathname,
          cpcon_hp: cpconState.honeypot || '',
          country: 'ES',
          _render_elapsed_ms: 5000,
        };
      const postLead = async function () {
        const form_token = await cpconFetchFormToken();
        return fetch(CRM_PROXY_URL + '/cpcon-previa-es-gsc-20261123/chatbot', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(Object.assign({}, leadFields, { form_token: form_token })),
        }).then(function (r) { return r.json(); }).catch(function () { return null; });
      };
      // O lead é criado AQUI, antes de qualquer conversa — se a conversa
      // cair depois, o contato já está no CRM. Uma retentativa cobre
      // oscilação de rede no momento do submit.
      let resp = await postLead();
      if (!resp) {
        await new Promise(function (r) { setTimeout(r, 1500); });
        resp = await postLead();
      }
      if (!resp || resp.ok === false) {
        cpconCaptureTelemetry('capture_rejected', { reason: 'other', errors: [resp ? 'server:rejected' : 'server:network'] });
      }
      if (resp && resp.ok === false) {
        cpconSay(resp.error || 'No fue posible procesar su solicitud. Si necesita ayuda, escríbanos a ventas-es@cpcongroup.com o llame al +34 620 35 87 38.');
        return;
      }
      if (resp && resp.lead_id) {
        cpconState.leadId = resp.lead_id;
        // Só conta conversão quando o servidor devolveu um id real.
        try {
          (window.dataLayer = window.dataLayer || []).push({
            event: 'generate_lead',
            form_name: 'chatbot_lucia',
            lead_source: 'chatbot_lucia',
            page_path: window.location.pathname,
          });
        } catch (e) { /* analytics opcional */ }
      }
      if (resp && resp.session_token) cpconState.sessionToken = resp.session_token;
      if (resp && resp.session_id) cpconState.sessionId = resp.session_id;
    }
  } catch (e) {}

  cpconState.stage = 'greeting';
  // Abre a conversa chamando /api/chat com msg vazia (backend responde E1)
  cpconState.stage = 'chat';
  cpconCallChat('');
}

// ── Chamada ao /api/chat ───────────────────────────────────

async function cpconCallChat(userText, extra) {
  if (cpconState.busy) return;
  if (cpconState.transferred) {
    cpconSay('Sus datos ya han sido registrados conforme al RGPD/LOPDGDD. Un especialista de CPCON se pondrá en contacto a través del correo electrónico o del teléfono facilitados en breve.');
    return;
  }
  cpconState.busy = true;
  cpconDisableInput();
  cpconShowTyping();

  // Sem Turnstile desde 2026-05-02 — rate limit + honeypot + Zod
  // protegem o endpoint sem CAPTCHA.
  // Adiciona mensagem do cliente ao histórico local (se não for turn 0 com userText vazio)
  if (userText) cpconState.history.push({ role: 'user', content: userText });
  if (userText) cpconExtractContact(userText);

  // Se é primeira chamada (sem session_id e sem histórico), forçar um placeholder
  let messages = cpconState.history.slice(-10);
  if (messages.length === 0) {
    messages = [{ role: 'user', content: '[início]' }];
  }

  const payload = {
    messages: messages,
    userContext: {
      nome: cpconState.userName,
      email: cpconState.userEmail,
      telefone: cpconState.userPhone,
      empresa: cpconState.userEmpresa || undefined,
    },
    max_tokens: 200,
    cpcon_hp: cpconState.honeypot || '',
  };
  if (cpconState.sessionId) payload.session_id = cpconState.sessionId;
  if (cpconState.sessionToken) payload.session_token = cpconState.sessionToken;
  if (extra && extra.segment_choice) payload.segment_choice = extra.segment_choice;
  if (extra && extra.handoff_response) payload.handoff_response = extra.handoff_response;

  let data = null;
  try {
    const res = await fetch(CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    data = await res.json().catch(function () { return null; });
    if (!res.ok) {
      cpconHideTyping();
      cpconSay('Hemos tenido una incidencia momentánea. Le derivo al equipo para que pueda atenderle correctamente.');
      cpconState.busy = false;
      cpconFireTransfer('error-backend');
      return;
    }
  } catch (e) {
    cpconHideTyping();
    cpconSay('Hemos tenido una incidencia de red. Le derivo al equipo.');
    cpconState.busy = false;
    cpconFireTransfer('error-red');
    return;
  }

  cpconHideTyping();
  cpconState.busy = false;
  cpconState.sessionId = data.session_id || cpconState.sessionId;
  cpconState.stage = data.stage || cpconState.stage;
  cpconState.lastActivityAt = Date.now();

  if (data.reply) {
    // chat-guard: guarda a assinatura do servidor; sem ela o servidor não
    // devolve essa fala ao modelo.
    var turn = { role: 'assistant', content: data.reply };
    if (typeof data.reply_sig === 'string' && data.reply_sig) turn.sig = data.reply_sig;
    cpconState.history.push(turn);
    // PR AT-Nuclear PROVA #4 — log DEBUG identificável via grep no asset.
    // userContext?.nome usado como string-marker pra grep validation.
    try {
      console.log('[FRONTEND_RESPONSE]', JSON.stringify({
        handoffReady: data.handoffReady,
        responsesRemaining: data.handoffResponsesRemaining,
        luciaLocked: data.luciaLocked,
        hasUserContext: !!cpconState.userContext?.nome,
      }));
    } catch (e) { /* defensivo */ }
    // PR camile-ux-perf-2026-05-03 — espelho de campos novos do backend
    if (typeof data.turn_count === 'number') cpconState.turns = data.turn_count;
    if (typeof data.handoff_offered === 'boolean') cpconState.handoffOffered = data.handoff_offered;
    if (typeof data.conversation_ended === 'boolean') cpconState.conversationEnded = data.conversation_ended;
    // PR camile-no-promise-2026-05-03 — telemetria de violation de regras
    if (data.pre_handoff_violation_caught === true) {
      try {
        (window.dataLayer = window.dataLayer || []).push({
          event: 'lucia_forbidden_pattern_caught',
          turn_count: data.turn_count || cpconState.turns || 0,
          fallback_used: !!data.pre_handoff_fallback_used,
          session_id: cpconHashSession(cpconState.sessionId),
          page_path: window.location.pathname,
        });
      } catch (e) { /* analytics opcional */ }
    }
    // Compat legado (api.js antigo ainda lê esses campos)
    if (typeof data.handoffReady === 'boolean') cpconState.handoffReady = data.handoffReady;
    if (typeof data.luciaLocked === 'boolean') cpconState.luciaLocked = data.luciaLocked;
    if (data.tags) {
      cpconState.lastSegment = (data.tags.find && data.tags.find(function (t) { return /^segmento:/.test(t); }) || '').replace('segmento:', '') || cpconState.lastSegment || null;
      cpconState.lastTema = (data.tags.find && data.tags.find(function (t) { return /^tema:/.test(t); }) || '').replace('tema:', '') || cpconState.lastTema || null;
    }

    cpconSay(data.reply, function () {
      // PR camile-ux-perf-2026-05-03 — fluxo NOVO (substitui handoffReady
      // imediato + luciaLocked após 4 respostas). Ordem de prioridade:
      // 1. conversation_ended (recusa registrada no backend)
      // 2. handoff_immediate (trigger T1-T5 ou fallback LLM)
      // 3. transferred legado (off-topic 3 strikes, reuniao, preço…)
      // 4. showSegmentButtons (E2.5)
      // 5. offer_handoff_button (chegou na 6ª troca, oferece Sim/Não)
      // 6. default — input liberado pra próximo turno
      if (data.conversation_ended) {
        cpconShowConversationEnded(data);
      } else if (data.handoff_immediate) {
        cpconHandleImmediateHandoff(data);
      } else if (data.transferred) {
        cpconState.transferred = true;
        cpconFireTransfer(data.tags || []);
      } else if (data.showSegmentButtons) {
        cpconShowSegmentButtons();
      } else if (data.offer_handoff_button) {
        cpconShowHandoffOffer(data);
      } else {
        cpconEnableInput();
        cpconScheduleReengage();
      }
    });
  } else {
    cpconEnableInput();
  }
}

function cpconShowSegmentButtons() {
  const container = document.getElementById('cpcon-msgs');
  if (!container) return;
  const row = document.createElement('div');
  row.className = 'cpcon-seg-btns';
  row.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;padding:4px 12px 12px;';
  const buttons = [
    { label: 'PYME', value: 'pyme' },
    { label: 'Gran Empresa', value: 'gran-empresa' },
    { label: 'Sector Público', value: 'sector-publico' },
    { label: 'Tercer Sector', value: 'tercer-sector' },
  ];
  buttons.forEach(function (b) {
    const btn = document.createElement('button');
    btn.textContent = b.label;
    btn.className = 'cpcon-seg-btn';
    btn.style.cssText = 'background:#0f766e;color:#fff;border:0;padding:8px 12px;border-radius:16px;font-size:12px;cursor:pointer;';
    btn.onclick = function () {
      row.remove();
      cpconMeMsg(b.label);
      cpconCallChat(b.label, { segment_choice: b.value });
    };
    row.appendChild(btn);
  });
  container.appendChild(row);
  cpconScrollDown();
  cpconDisableInput();
}

// ── Handoff WhatsApp 24/7 ──────────────────────────────────
// Atención Lúcia disponible en cualquier horario. En España NO se usa WhatsApp:
// Função mantida pra compatibilidade de callers existentes; sempre retorna true.

function cpconIsBusinessHours() {
  return true;
}

function cpconBuildWppUrl() {
  // WhatsApp deshabilitado en España (instrucción Wendell 2026-05-19).
  return '';
}

// PR handoff WhatsApp — botão persistente que aparece após segmento+demanda
// detectados (mode='persistent') e ganha pulse após luciaLocked
// (mode='highlighted'). Modo 'fallback' mantém comportamento legado de
// fallback de popup bloqueado.
function cpconAppendWppButton(_url, _mode) {
  // WhatsApp deshabilitado en España — no-op (instrucción Wendell 2026-05-19).
  return;
}

// ── PR camile-ux-perf-2026-05-03 — bloco de handoff novo ───────────
// Pergunta + botões Sim/Não exibidos quando backend devolve
// `offer_handoff_button: true` (turn_count >= 6 sem trigger).

function cpconShowHandoffOffer(data) {
  const container = document.getElementById('cpcon-msgs');
  if (!container) return;
  cpconState.handoffOffered = true;

  // Idempotência — se já está renderizado (turn duplicado), ignora.
  if (document.getElementById('cpcon-handoff-offer')) {
    cpconEnableInput();
    return;
  }

  const wrap = document.createElement('div');
  wrap.id = 'cpcon-handoff-offer';
  wrap.className = 'cpcon-handoff-offer';
  wrap.innerHTML =
    '<div class="cpcon-handoff-question">¿Desea que un especialista de CPCON le contacte para profundizar en su necesidad? Le contactaremos por correo o teléfono.</div>' +
    '<div class="cpcon-handoff-actions">' +
    '<button type="button" class="cpcon-handoff-yes-btn" id="cpcon-handoff-yes">Sí, contactar conmigo</button>' +
    '<button type="button" class="cpcon-handoff-no-btn" id="cpcon-handoff-no">No, gracias</button>' +
    '</div>';
  container.appendChild(wrap);
  cpconScrollDown();
  cpconDisableInput();

  document.getElementById('cpcon-handoff-yes').onclick = function () {
    cpconAcceptHandoffButton();
  };
  document.getElementById('cpcon-handoff-no').onclick = function () {
    cpconDeclineHandoffButton();
  };
}

async function cpconAcceptHandoffButton() {
  const offer = document.getElementById('cpcon-handoff-offer');
  const yesBtn = document.getElementById('cpcon-handoff-yes');
  const noBtn = document.getElementById('cpcon-handoff-no');
  if (yesBtn) yesBtn.disabled = true;
  if (noBtn) noBtn.disabled = true;

  try {
    await cpconPostLeadBeforeRedirect({ accepted_handoff: true });
  } catch (err) {
    cpconShowSystemMessage(
      'Estamos con una inestabilidad momentánea. Por favor, contacte directamente ' +
      ((window.CPCON_CONFIG && window.CPCON_CONFIG.contactPhone) || '+34 620 35 87 38') + '.'
    );
    if (yesBtn) yesBtn.disabled = false;
    if (noBtn) noBtn.disabled = false;
    return;
  }

  // dataLayer: lucia_handoff via botão da 6ª troca. Sem PII.
  try {
    (window.dataLayer = window.dataLayer || []).push({
      event: 'lucia_handoff',
      trigger_type: 'button_6th_turn_yes',
      turn_count_at_handoff: cpconState.turns || cpconState.history.length || 0,
      session_id: cpconHashSession(cpconState.sessionId),
      page_path: window.location.pathname,
    });
  } catch (e) { /* analytics opcional */ }

  if (offer) offer.remove();
  cpconSay('¡Gracias! Sus datos han sido enviados a nuestro equipo. Un especialista de CPCON entrará en contacto por el correo o teléfono indicado en breve. 🚀');
  cpconState.transferred = true;
  cpconDisableInput();
}

async function cpconDeclineHandoffButton() {
  const offer = document.getElementById('cpcon-handoff-offer');
  const yesBtn = document.getElementById('cpcon-handoff-yes');
  const noBtn = document.getElementById('cpcon-handoff-no');
  if (yesBtn) yesBtn.disabled = true;
  if (noBtn) noBtn.disabled = true;

  try {
    await cpconPostLeadBeforeRedirect({
      chat_completed_no_handoff: true,
      recusal_method: 'button_no',
    });
  } catch (err) {
    // Mesmo se POST falhar, encerramos a conversa visualmente.
    console.error('[Lucia] decline POST failed', err);
  }

  // dataLayer: lucia_chat_ended_no_handoff via botão "Não". Sem PII.
  try {
    (window.dataLayer = window.dataLayer || []).push({
      event: 'lucia_chat_ended_no_handoff',
      turn_count_at_end: cpconState.turns || cpconState.history.length || 0,
      session_id: cpconHashSession(cpconState.sessionId),
      recusal_method: 'button_no',
      page_path: window.location.pathname,
    });
  } catch (e) { /* analytics opcional */ }

  if (offer) offer.remove();
  // Envia "no" pro backend pra ele marcar conversation_ended e logar tag.
  // Resposta vem com a frase fixa de encerramento — vai ser renderizada
  // pelo handler de cpconCallChat normalmente (conversation_ended=true).
  cpconCallChat('No, gracias', { handoff_response: 'no' });
}

// Trigger T1-T5 ou fallback LLM — backend já marcou transferred=true.
// WhatsApp deshabilitado en España: solo mensaje de confirmación + dataLayer.
function cpconHandleImmediateHandoff(data) {
  cpconState.transferred = true;
  cpconDisableInput();

  // dataLayer com trigger_type vindo do backend
  try {
    (window.dataLayer = window.dataLayer || []).push({
      event: 'lucia_handoff',
      trigger_type: data.trigger_type || 'unknown',
      trigger_reason: data.trigger_reason || '',
      turn_count_at_handoff:
        data.turn_count_at_handoff || cpconState.turns || cpconState.history.length || 0,
      session_id: cpconHashSession(cpconState.sessionId),
      page_path: window.location.pathname,
    });
  } catch (e) { /* analytics opcional */ }

  // Pequeno delay pra UI renderizar a mensagem antes do popup
  // Resposta honesta: só confirma depois que o resumo foi aceito pelo servidor.
  // Em caso de falha, cpconPostLeadBeforeRedirect já mostra a mensagem com o
  // telefone de contato — não dizemos "¡Gracias!" por cima dela.
  setTimeout(function () {
    cpconPostLeadBeforeRedirect({
      handoff_trigger_type: data.trigger_type || 'unknown',
    }).then(function () {
      // WhatsApp deshabilitado — sem redirect, sólo mensaje de confirmación.
      setTimeout(function () {
        cpconSay('¡Gracias! Sus datos y el resumen de la conversación han sido enviados a nuestro equipo. Un especialista de CPCON entrará en contacto en breve. 🚀');
      }, 600);
    }).catch(function (err) {
      console.error('[Lucia] immediate handoff POST failed', err);
    });
  }, 400);
}

// Conversación finalizada por el rechazo del cliente. Backend ya marcó
// conversationEnded=true y devolvió la frase fija en data.reply.
function cpconShowConversationEnded(_data) {
  cpconState.transferred = true;
  cpconState.conversationEnded = true;
  cpconDisableInput();

  const inp = document.getElementById('cpcon-inp');
  if (inp) inp.placeholder = 'Conversación finalizada';

  // Badge persistente "Conversación finalizada" — visible y accesible.
  if (!document.getElementById('cpcon-ended-badge')) {
    const container = document.getElementById('cpcon-msgs');
    if (container) {
      const badge = document.createElement('div');
      badge.id = 'cpcon-ended-badge';
      badge.className = 'cpcon-ended-badge';
      badge.setAttribute('role', 'status');
      badge.setAttribute('aria-live', 'polite');
      badge.textContent = 'Conversación finalizada';
      container.appendChild(badge);
      cpconScrollDown();
    }
  }
}

// Hash leve de session_id pra telemetria (não-PII). 8 hex.
function cpconHashSession(sid) {
  if (!sid) return '';
  let h = 0;
  for (let i = 0; i < sid.length; i += 1) {
    h = ((h << 5) - h + sid.charCodeAt(i)) | 0;
  }
  return ('00000000' + (h >>> 0).toString(16)).slice(-8);
}

// Mensaje del sistema (estilo neutro, sin avatar Lúcia) — usado cuando
// luciaLocked para avisar que la atención por chat ha finalizado.
function cpconShowSystemMessage(text) {
  const container = document.getElementById('cpcon-msgs');
  if (!container) return;
  const row = document.createElement('div');
  row.className = 'cpcon-system-msg';
  row.textContent = text;
  container.appendChild(row);
  cpconScrollDown();
}

// Resumen breve de la conversación para incluir en el mensaje del lead.
function cpconBuildResumoConversa() {
  const lines = ['Resumen de la conversación vía Lúcia:'];
  if (cpconState.userName) lines.push('- Contacto: ' + cpconState.userName);
  if (cpconState.userEmpresa) lines.push('- Empresa: ' + cpconState.userEmpresa);
  if (cpconState.lastSegment) lines.push('- Segmento: ' + cpconState.lastSegment);
  if (cpconState.lastTema) lines.push('- Demanda: ' + cpconState.lastTema);
  lines.push('- Total de turnos: ' + (cpconState.turns || cpconState.history.length));
  const ultimaMsg = (cpconState.history.filter(function (m) { return m.role === 'user'; }).slice(-1)[0] || {}).content;
  if (ultimaMsg) lines.push('- Último mensaje: ' + String(ultimaMsg).slice(0, 200));
  return lines.join('\n');
}

// POST /api/leads/chatbot ANTES do redirect WhatsApp. Espera 200 OK; em caso
// de erro, lança pra que o caller (botão onclick) bloqueie window.open.
//
// PR camile-ux-perf-2026-05-03 — opts pode conter:
//   - chat_completed_no_handoff: true  (cliente recusou WhatsApp)
//   - accepted_handoff: true           (cliente aceitou via botão Sim)
//   - handoff_trigger_type: 'T1'|'T2'|… (handoff via trigger detectado)
//   - recusal_method: 'button_no'|'text_refusal'
async function cpconPostLeadBeforeRedirect(opts) {
  opts = opts || {};
  const refusal = !!opts.chat_completed_no_handoff;
  const tail = refusal
    ? '\n\nEl cliente rechazó continuar tras la oferta del 6º intercambio. Lead archivado.'
    : '\n\nEl cliente solicitó contacto con un especialista.';
  const payload = {
    nome: cpconState.userName,
    email: cpconState.userEmail,
    empresa: cpconState.userEmpresa || '',
    telefone: cpconState.userPhone,
    telefono_pais: cpconState.userPhoneCountry || 'ES',
    no_soy_un_robot: true,
    mensagem: cpconBuildResumoConversa() + tail,
    origem: 'chatbot_lucia',
    pagina_origem: window.location.href,
    metadata: {
      segmento: cpconState.lastSegment || null,
      demanda: cpconState.lastTema || null,
      handoff_via: opts.handoff_trigger_type
        ? 'trigger_' + String(opts.handoff_trigger_type)
        : refusal
          ? 'refused'
          : 'whatsapp_button_yes',
      handoff_trigger_type: opts.handoff_trigger_type || null,
      recusal_method: opts.recusal_method || null,
      turn_count: cpconState.turns || cpconState.history.length || 0,
      session_id: cpconState.sessionId,
    },
  };
  if (refusal) payload.chat_completed_no_handoff = true;
  // chat-guard: o servidor monta o resumo do CRM a partir das falas (as do
  // bot conferidas pela assinatura). Teto ~6 KB (limite do endpoint 10 KB).
  if (cpconState.sessionId) payload.session_id = cpconState.sessionId;
  var turns = cpconState.history.slice(-40).map(function (m) {
    var t = { role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '').slice(0, 2000) };
    if (m.role === 'assistant' && m.sig) t.sig = m.sig;
    return t;
  }).filter(function (t) { return t.content; });
  while (turns.length > 1 && JSON.stringify(turns).length > 5500) turns.shift();
  if (turns.length) payload.conversation_turns = turns;
  payload.form_token = await cpconFetchFormToken();

  let leadId = null;
  try {
    const res = await fetch('/api/leads/chatbot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new Error('POST /api/leads/chatbot HTTP ' + res.status);
    }
    const data = await res.json().catch(function () { return null; });
    leadId = (data && data.lead_id) || null;
  } catch (err) {
    if (!refusal) {
      cpconShowSystemMessage(
        'Estamos con una inestabilidad momentánea. Por favor, contacte directamente ' +
        ((window.CPCON_CONFIG && window.CPCON_CONFIG.contactPhone) || '+34 620 35 87 38') +
        ' o aguarde unos instantes para volver a intentarlo.'
      );
    }
    throw err;
  }

  // Mantém o evento legacy `click_whatsapp` (GTM pre-existing trigger),
  // agora com trigger_type + turn_count_at_handoff. Para refusal NÃO
  // dispara (esse caso usa lucia_chat_ended_no_handoff em outro caller).
  if (!refusal) {
    try {
      (window.dataLayer = window.dataLayer || []).push({
        event: 'click_whatsapp',
        source: 'lucia_handoff',
        trigger_type:
          opts.handoff_trigger_type || (opts.accepted_handoff ? 'button_6th_turn_yes' : 'manual'),
        turn_count_at_handoff: cpconState.turns || cpconState.history.length || 0,
        session_id: cpconHashSession(cpconState.sessionId),
        leadId: leadId,
      });
    } catch (e) { /* analytics opcional */ }
  }
}

function cpconOpenWpp() {
  // WhatsApp deshabilitado en España — sustituye por mensaje de confirmación.
  cpconSay('¡Gracias! Sus datos han sido registrados. Un especialista de CPCON entrará en contacto por el correo o teléfono indicado en breve. 🚀');
  cpconState.transferred = true;
}

function cpconShowAfterHoursMessage() {
  // Mantida pra compatibilidade de callers; usada hoje só em fallback de erro técnico.
  const msg = 'Hemos tenido una inestabilidad en el servicio de IA. Sus datos ya están registrados y nuestro equipo le contactará en breve.';
  cpconSay(msg);
}

// ── Transferência pra humano ───────────────────────────────

async function cpconFireTransfer(tagsOrReason) {
  if (cpconState._transferFired) return;
  cpconState._transferFired = true;
  cpconState.transferred = true;

  const tags = Array.isArray(tagsOrReason) ? tagsOrReason : [String(tagsOrReason || 'transferido')];
  // Sem Turnstile desde 2026-05-02. Se temos session_token (HMAC do
  // /api/leads/chatbot), usa pra validação de sessão. Caso contrário,
  // segue sem token — backend tem rate limit + honeypot.
  const useToken = cpconState.sessionToken;
  const msgInicial = cpconState.history.filter(function (m) { return m.role === 'user'; }).map(function (m) { return m.content; }).join(' | ').slice(0, 1500);
  const segment = tags.find(function (t) { return t && t.indexOf('segmento-') === 0; });
  const tema = tags.find(function (t) { return t && t.indexOf('tema-') === 0; });

  try {
    const reqBody = {
      nome: cpconState.userName || 'Visitante',
      email: cpconState.userEmail || '',
      telefone: cpconState.userPhone || '',
      empresa: cpconState.userEmpresa || '',
      origem: 'chatbot_lucia',
      lead_id: cpconState.leadId || null,
      mensagem_inicial: msgInicial,
      session_id: cpconState.sessionId,
      tags: tags,
      segment: segment ? segment.replace('segmento-', '') : undefined,
      tema: tema ? tema.replace('tema-', '') : undefined,
      cpcon_hp: cpconState.honeypot || '',
    };
    if (useToken) reqBody.session_token = useToken;

    const res = await fetch('/api/atendimento/iniciar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reqBody),
    });
    const data = await res.json().catch(function () { return null; });
    if (!res.ok) {
      cpconState.transferred = false;
      cpconState._transferFired = false;
      cpconSay('No hemos podido registrar el contacto. Inténtelo de nuevo en unos minutos.');
      return;
    }
    if (data && data.session_id) {
      cpconState.liveSessionId = data.session_id;
    }
  } catch (e) {
    cpconState.transferred = false;
    cpconState._transferFired = false;
    cpconSay('No hemos podido registrar el contacto. Inténtelo de nuevo en unos minutos.');
    return;
  }

  // Sin WhatsApp en España — solo confirma registro + cierre.
  cpconDisableInput();
  setTimeout(function () {
    cpconAppendNotice('Equipo notificado. Su contacto ha sido registrado.');
    setTimeout(function () {
      cpconSay('¡Gracias! Sus datos han sido enviados a nuestro equipo. Un especialista de CPCON entrará en contacto por el correo o teléfono indicado. 🚀');
      cpconState.transferred = true;
    }, 1200);
  }, 400);
}

// ── Handler central ─────────────────────────────────────────

function cpconOnSend() {
  const inp = document.getElementById('cpcon-inp');
  if (!inp) return;
  const v = inp.value.trim();
  if (!v) return;
  if (v.length > 500) {
    cpconSay('El mensaje es demasiado extenso. ¿Podría resumirlo en hasta 500 caracteres?');
    return;
  }
  inp.value = '';
  inp.style.height = 'auto';
  cpconMeMsg(v);
  cpconState.lastActivityAt = Date.now();
  if (cpconState.transferred) {
    cpconSay('Sus datos ya han sido registrados. Un especialista de CPCON entrará en contacto por correo o teléfono en breve.');
    return;
  }
  cpconCallChat(v);
}

function cpconOnKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); cpconOnSend(); }
}

// ── Utilitários compartilhados com UI antiga ─────────────────

function cpconShowTyping() {
  const container = document.getElementById('cpcon-msgs');
  if (!container) return;
  const row = document.createElement('div');
  row.id = 'cpcon-typing';
  row.className = 'cpcon-row';
  row.innerHTML = '<div class="cpcon-av"><img src="/cpcon-previa-es-gsc-20261123/chatbot/images/lucia.webp" alt="Lúcia" width="26" height="26"/></div><div class="cpcon-bbl"><em>escribiendo…</em></div>';
  container.appendChild(row);
  cpconScrollDown();
}
function cpconHideTyping() {
  const n = document.getElementById('cpcon-typing');
  if (n) n.remove();
}
function cpconShowTypingSlowHint() {
  const row = document.getElementById('cpcon-typing');
  if (!row) return;
  const bubble = row.querySelector('.cpcon-bbl');
  if (!bubble || row.querySelector('.cpcon-slow-hint')) return;
  const hint = document.createElement('span');
  hint.className = 'cpcon-slow-hint';
  hint.style.cssText = 'font-style:italic;color:#9ca3af;font-size:12px;margin-left:6px;';
  hint.textContent = 'só um segundo…';
  bubble.appendChild(hint);
}
function cpconClearTypingSlowHint() {
  const h = document.querySelector('#cpcon-typing .cpcon-slow-hint');
  if (h) h.remove();
}

function cpconEnableInput() {
  const inp = document.getElementById('cpcon-inp');
  const btn = document.getElementById('cpcon-send-btn');
  if (btn) btn.disabled = false;
  if (inp) {
    inp.disabled = false;
    inp.placeholder = 'Escribe tu mensaje';
    inp.removeAttribute('inputmode');
    inp.focus();
  }
}

function cpconDisableInput() {
  const inp = document.getElementById('cpcon-inp');
  const btn = document.getElementById('cpcon-send-btn');
  if (btn) btn.disabled = true;
  if (inp) inp.disabled = true;
}

function cpconScrollDown() {
  const m = document.getElementById('cpcon-msgs');
  if (m) m.scrollTop = m.scrollHeight;
}

function cpconResizeTextarea(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 80) + 'px';
}

function cpconEsc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function cpconNl2br(s) { return s.replace(/\n/g, '<br>'); }

// Final: ao fechar a página, encerra sessão no backend
window.addEventListener('beforeunload', function () {
  if (cpconState.sessionId) {
    try {
      navigator.sendBeacon('/api/chat?session_id=' + encodeURIComponent(cpconState.sessionId));
    } catch (e) {}
  }
});

// Liga handler do enter no live panel se existir (compat com UI antiga)
function cpconOnLiveKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); /* ignore */ }
}
function cpconSendLive() {}
function cpconCloseLive() {
  const p = document.getElementById('cpcon-live-panel');
  if (p) p.classList.remove('show');
}
