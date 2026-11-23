// ============================================================
//  CPCON CHATBOT — UI / Renderização de Mensagens
//  Dependências: config.js
// ============================================================

// ── Chat principal ───────────────────────────────────────────

// Adiciona mensagem do bot com animação de digitação
function cpconSay(txt, cb) {
  const tid = 'cpcon-typ-' + Date.now();
  const container = document.getElementById('cpcon-msgs');

  const typingRow = document.createElement('div');
  typingRow.className = 'cpcon-row';
  typingRow.id = tid;
  typingRow.innerHTML = `
    <div class="cpcon-av"><img src="/cpcon-previa-es-gsc-20261123/chatbot/images/lucia.webp" alt="Lúcia" width="26" height="26"/></div>
    <div class="cpcon-bbl">
      <div class="cpcon-typing"><span></span><span></span><span></span></div>
    </div>`;
  container.appendChild(typingRow);
  cpconScrollDown();

  // Delay proporcional ao tamanho do texto (mín 600ms, máx 1800ms)
  const delay = Math.min(Math.max(txt.length * 20, 600), 1800);
  setTimeout(() => {
    document.getElementById(tid)?.remove();
    cpconAddBot(txt);
    if (cb) cb();
  }, delay);
}

// Mensagem do bot (sem animação de digitação)
function cpconAddBot(txt) {
  const container = document.getElementById('cpcon-msgs');
  const row = document.createElement('div');
  row.className = 'cpcon-row';
  row.innerHTML = `
    <div class="cpcon-av"><img src="/cpcon-previa-es-gsc-20261123/chatbot/images/lucia.webp" alt="Lúcia" width="26" height="26"/></div>
    <div class="cpcon-bbl">${cpconNl2br(cpconEsc(txt))}</div>`;
  container.appendChild(row);
  cpconScrollDown();
}

// Mensagem do cliente
function cpconMeMsg(txt) {
  const container = document.getElementById('cpcon-msgs');
  const row = document.createElement('div');
  row.className = 'cpcon-row me';
  row.innerHTML = `
    <div class="cpcon-av me"></div>
    <div class="cpcon-bbl">${cpconEsc(txt)}</div>`;
  container.appendChild(row);
  cpconScrollDown();
}

// Typing indicator para IA
function cpconShowTyping(id) {
  const container = document.getElementById('cpcon-msgs');
  const t = document.createElement('div');
  t.className = 'cpcon-row';
  t.id = id;
  t.innerHTML = `
    <div class="cpcon-av"><img src="/cpcon-previa-es-gsc-20261123/chatbot/images/lucia.webp" alt="Lúcia" width="26" height="26"/></div>
    <div class="cpcon-bbl">
      <div class="cpcon-typing"><span></span><span></span><span></span></div>
    </div>`;
  container.appendChild(t);
  cpconScrollDown();
}
function cpconRemoveTyping(id) { document.getElementById(id)?.remove(); }

// ── Painel ao vivo ───────────────────────────────────────────

// Mensagem do bot no live
function cpconAddLiveBot(txt) {
  const container = document.getElementById('cpcon-lp-msgs');
  const row = document.createElement('div');
  row.className = 'cpcon-row';
  row.innerHTML = `
    <div class="cpcon-av"><img src="/cpcon-previa-es-gsc-20261123/chatbot/images/lucia.webp" alt="Lúcia" width="26" height="26"/></div>
    <div class="cpcon-bbl">${cpconNl2br(cpconEsc(txt))}</div>`;
  container.appendChild(row);
  container.scrollTop = container.scrollHeight;
}

// Mensagem do cliente no live
function cpconAddLiveMe(txt) {
  const container = document.getElementById('cpcon-lp-msgs');
  const row = document.createElement('div');
  row.className = 'cpcon-row me';
  row.innerHTML = `
    <div class="cpcon-av me"></div>
    <div class="cpcon-bbl">${cpconEsc(txt)}</div>`;
  container.appendChild(row);
  container.scrollTop = container.scrollHeight;
}

// Typing indicator no live
function cpconShowLiveTyping() {
  const container = document.getElementById('cpcon-lp-msgs');
  const t = document.createElement('div');
  t.className = 'cpcon-row';
  t.id = 'cpcon-ltyp';
  t.innerHTML = `
    <div class="cpcon-av"><img src="/cpcon-previa-es-gsc-20261123/chatbot/images/lucia.webp" alt="Lúcia" width="26" height="26"/></div>
    <div class="cpcon-bbl">
      <div class="cpcon-typing"><span></span><span></span><span></span></div>
    </div>`;
  container.appendChild(t);
  container.scrollTop = container.scrollHeight;
}
function cpconRemoveLiveTyping() { document.getElementById('cpcon-ltyp')?.remove(); }
