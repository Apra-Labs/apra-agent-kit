import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createConversationSqliteStore } from '../host/memory/conversation-store/sqlite.mjs';
import { conversationStoreContractTests } from './helpers/conversation-store-contract.mjs';

conversationStoreContractTests(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-store-'));
  const dbPath = path.join(dir, 'conversation.db');
  const store = createConversationSqliteStore({ dbPath });
  await store.open();
  return store;
});
