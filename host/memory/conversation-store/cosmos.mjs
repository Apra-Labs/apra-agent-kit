// host/memory/conversation-store/cosmos.mjs
export function createConversationCosmosStore({ endpoint, key, database, container: containerName }) {
  if (!endpoint || !key) throw new Error('createConversationCosmosStore requires endpoint and key');
  let client = null;
  let container = null;

  function toDoc(turn) {
    return { id: turn.id, partitionKey: turn.sessionId, ...turn };
  }

  function fromDoc(doc) {
    const { _rid, _self, _etag, _attachments, _ts, partitionKey, ...turn } = doc;
    return turn;
  }

  return {
    async open() {
      const { CosmosClient } = await import('@azure/cosmos');
      client = new CosmosClient({ endpoint, key });
      const { database: db } = await client.databases.createIfNotExists({ id: database });
      const { container: cont } = await db.containers.createIfNotExists({
        id: containerName,
        partitionKey: { paths: ['/partitionKey'] },
      });
      container = cont;
    },

    async close() { client = null; container = null; },

    async append(turn) {
      await container.items.create(toDoc(turn));
    },

    async get(id) {
      const sql = 'SELECT * FROM c WHERE c.id = @id';
      const { resources } = await container.items.query({ query: sql, parameters: [{ name: '@id', value: id }] }).fetchAll();
      return resources.length ? fromDoc(resources[0]) : null;
    },

    async update(id, patch) {
      const existing = await this.get(id);
      if (!existing) throw new Error(`conversation turn ${id} not found`);
      const next = { ...existing, ...patch };
      await container.item(id, existing.sessionId).replace(toDoc(next));
      return next;
    },

    async listSession(sessionId, { states, limit } = {}) {
      const conditions = ['c.sessionId = @sid'];
      const params = [{ name: '@sid', value: sessionId }];
      if (states?.length) {
        conditions.push(`c.state IN (${states.map((_, i) => `@s${i}`).join(',')})`);
        states.forEach((s, i) => params.push({ name: `@s${i}`, value: s }));
      }
      let sql = `SELECT * FROM c WHERE ${conditions.join(' AND ')} ORDER BY c.turnIndex ASC`;
      const { resources } = await container.items.query({ query: sql, parameters: params }).fetchAll();
      let results = resources.map(fromDoc);
      if (limit) results = results.slice(0, limit);
      return results;
    },

    async purgeSessions({ olderThanDays } = {}) {
      if (!olderThanDays) return 0;
      const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
      const sql = 'SELECT * FROM c WHERE c.createdAt < @cutoff';
      const { resources } = await container.items.query({ query: sql, parameters: [{ name: '@cutoff', value: cutoff }] }).fetchAll();
      for (const doc of resources) {
        await container.item(doc.id, doc.sessionId).delete();
      }
      return resources.length;
    },
  };
}
