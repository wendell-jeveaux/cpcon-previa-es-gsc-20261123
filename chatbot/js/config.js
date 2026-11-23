// ============================================================
//  CPCON CHATBOT — Configurações
//  Edite aqui para personalizar sem mexer na lógica
// ============================================================

const CPCON_CONFIG = {

  // ── Identidade del atendente ─────────────────────────────
  agentName:    'Lucía',
  agentInitials:'LU',
  companyName:  'CPCON',

  // ── WhatsApp DESHABILITADO en España (instrucción Wendell) ──
  // Mantener vacío para que cualquier referencia legada quede inoperativa.
  whatsappNumber: '',

  // ── Enlaces ──────────────────────────────────────────────
  privacyUrl: 'https://cpcongroup.es/politica-de-privacidad/',
  siteUrl:    'https://cpcongroup.es',

  // ── Contacto (España) ────────────────────────────────────
  // Teléfono ES mostrado en los mensajes de fallback del chat. Debe coincidir
  // con el del sitio (Footer / Contacto). NO usar el número de Brasil.
  contactPhone: '+34 620 35 87 38',

  // ── Comportamiento ───────────────────────────────────────
  wppOpenDelay: 1000,
  agentJoinDelay: 4000,

  // ── Palabras clave que disparan contacto inmediato ───────
  contactKeywords: /atend|hablar con|humano|persona|comercial|vendedor|llamar|llame|telef|contacto|quiero hablar|llámame|llámeme|urgente|ahora mismo|inmediato|soporte/i,

  // ── API LLM ──────────────────────────────────────────────
  // Modelo e key são gerenciados pelo backend (/api/chat). Nunca expor key no frontend.
  aiMaxTokens: 200,
};

// Los scripts del chat se cargan como <script src> clásicos e independientes:
// un `const` de nivel superior NO se expone como propiedad de window. chatbot.js
// lee `window.CPCON_CONFIG`, así que hay que publicarlo explícitamente aquí.
if (typeof window !== 'undefined') { window.CPCON_CONFIG = CPCON_CONFIG; }
