// ============================================================
//  CPCON CHATBOT — Prompt LEGACY (sustituido por el backend)
//
//  El system prompt actual reside en /api/chat (server-side) en
//  src/lib/lucia.ts → HANDOFF_RULES_BLOCK + SYSTEM_PROMPT_CORE.
//  Mantenemos esta función para retrocompatibilidad con widgets
//  antiguos en caché — devuelve un placeholder mínimo.
//
//  El flujo real:
//    1. Frontend (cpconSubmitForm) recoge nombre + correo + empresa
//       + teléfono (4 campos obligatorios) y POST /api/leads/chatbot.
//    2. Frontend abre conversación llamando cpconCallChat con userContext.
//    3. /api/chat aplica HANDOFF_RULES_BLOCK + SYSTEM_PROMPT_CORE en
//       gpt-4o-mini con políticas RGPD/LOPDGDD + sanitizer DNI/NIE/CIF.
// ============================================================

function cpconGetSystemPrompt(userName) {
  // No-op: ver descripción arriba. El prompt real está en el backend.
  return 'Lúcia, consultora comercial del CPCON Group. Cliente: ' + (userName || 'cliente') + '.';
}
