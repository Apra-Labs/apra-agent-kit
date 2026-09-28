// host/memory/conversation-store/interface.mjs
export const CONVERSATION_STORE_METHODS = [
  'open',
  'close',
  'append',
  'get',
  'update',
  'listSession',
  'purgeSessions',
];

export function assertConversationStore(store) {
  const missing = CONVERSATION_STORE_METHODS.filter(m => typeof store?.[m] !== 'function');
  if (missing.length) throw new Error(`conversation store missing: ${missing.join(', ')}`);
  return store;
}
