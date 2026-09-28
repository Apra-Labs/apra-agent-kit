// host/memory/index.mjs
import { assertMemoryStore } from './store/interface.mjs';
import { createFilesystemStore } from './store/filesystem.mjs';
import { createSqliteStore } from './store/sqlite.mjs';
import { assertConversationStore } from './conversation-store/interface.mjs';
import { createConversationSqliteStore } from './conversation-store/sqlite.mjs';
import { createConversationContext } from './conversation-context.mjs';
import { createRunState } from './run-state.mjs';
import { createLongTermMemory } from './long-term.mjs';
import { createFsrs6Engine } from './decay/fsrs6.mjs';
import { createLearner } from './learner.mjs';
import { createMemoryEvents } from './events.mjs';
import { buildMemoryRoutes } from './routes.mjs';
import { preloadKnowledge } from './preloader.mjs';

async function resolveStore(config) {
  if (typeof config.store === 'function') {
    return assertMemoryStore(config.store(config));
  }
  switch (config.store) {
    case 'filesystem': return createFilesystemStore({ dir: config.dir ?? './memory' });
    case 'sqlite': return createSqliteStore({ dbPath: config.dbPath ?? `${config.dir ?? './memory'}/memory.db` });
    case 'cosmos': {
      const { createCosmosStore } = await import('./store/cosmos.mjs');
      return createCosmosStore(config.cosmos ?? {});
    }
    default: return createFilesystemStore({ dir: config.dir ?? './memory' });
  }
}

async function resolveConversationStore(config) {
  if (typeof config.store === 'function') {
    return assertConversationStore(config.store(config));
  }
  switch (config.store) {
    case 'sqlite': return createConversationSqliteStore({ dbPath: config.dbPath ?? './memory/conversation.db' });
    case 'cosmos': {
      const { createConversationCosmosStore } = await import('./conversation-store/cosmos.mjs');
      return createConversationCosmosStore(config.cosmos ?? {});
    }
    default: return createConversationSqliteStore({ dbPath: config.dbPath ?? './memory/conversation.db' });
  }
}

function interpolateEnv(value, env = process.env) {
  if (typeof value !== 'string') return value;
  return value.replace(/\$\{(\w+)\}/g, (_, key) => env[key] ?? '');
}

function interpolateConfigStrings(obj, env) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = typeof v === 'string' ? interpolateEnv(v, env) : typeof v === 'object' ? interpolateConfigStrings(v, env) : v;
  }
  return out;
}

export async function createMemoryModule(memoryConfig, { notifier, fleetApi, logger = console } = {}) {
  const events = createMemoryEvents({
    notifier,
    level: memoryConfig?.events?.level ?? 'notifications',
  });

  const ltConfig = memoryConfig?.longTerm
    ? interpolateConfigStrings(memoryConfig.longTerm, process.env)
    : null;

  // Shared FSRS-6 engine so long-term memory and conversation context decay
  // turns/entries using the same thresholds and math.
  const engine = createFsrs6Engine({
    thresholds: ltConfig?.decay?.thresholds,
  });

  let rsStore = null;
  const rs = memoryConfig?.runState?.enabled
    ? await (async () => {
        rsStore = await resolveStore(memoryConfig.runState);
        return createRunState({ ...memoryConfig.runState, store: rsStore, logger });
      })()
    : null;

  let ltmStore = null;
  const ltm = ltConfig?.enabled
    ? await (async () => {
        ltmStore = await resolveStore(ltConfig);
        return createLongTermMemory({
          store: ltmStore,
          decayConfig: ltConfig.decay ?? {},
          dedupConfig: ltConfig.dedup ?? {},
          recallLimit: ltConfig.recallLimit,
          maxEntries: ltConfig.maxEntries,
          recallFailurePolicy: ltConfig.recallFailurePolicy,
          events,
          logger,
          engine,
        });
      })()
    : null;

  const learner = ltm && ltConfig?.autoLearn
    ? createLearner({ longTermMemory: ltm, fleetApi, events, logger })
    : null;

  const routes = ltm ? buildMemoryRoutes(ltm) : null;

  const ccConfig = memoryConfig?.conversationContext
    ? interpolateConfigStrings(memoryConfig.conversationContext, process.env)
    : null;
  let cc = null;
  if (ccConfig?.enabled) {
    const ccMode = ccConfig.mode ?? 'store';
    if (ccMode === 'store') {
      const ccStore = await resolveConversationStore(ccConfig);
      cc = createConversationContext({
        store: ccStore,
        engine,
        fleetApi,
        maxRecentTurns: ccConfig.maxRecentTurns ?? 6,
        maxTotalTurns: ccConfig.maxTotalTurns ?? 20,
        compactionStrategy: ccConfig.compactionStrategy ?? 'summarise',
        answerMaxChars: ccConfig.answerMaxChars ?? 500,
        events,
        logger,
      });
    } else {
      // Passthrough mode — no store, no decay, just expose mode + config
      cc = {
        mode: 'passthrough',
        maxRecentTurns: ccConfig.maxRecentTurns ?? 10,
        async open() {},
        async close() {},
      };
    }
  }

  return {
    runState: rs,
    longTerm: ltm,
    learner,
    events,
    routes,
    conversationContext: cc,

    async open() {
      if (rsStore) await rsStore.open();
      if (ltm) {
        await ltm.open();
        if (ltConfig?.preloadDir) {
          try {
            await preloadKnowledge(ltm, { dir: ltConfig.preloadDir, logger });
          } catch (err) {
            logger.warn?.(`[memory/preloader] preload failed: ${err?.message ?? err}`);
          }
        }
      }
      if (cc) await cc.open();
    },

    async close() {
      if (ltm) {
        try {
          await ltm.close();
        } catch (err) {
          logger.warn?.(`[memory] failed to close long-term memory: ${err?.message ?? err}`);
        }
      }
      if (rsStore) {
        try {
          await rsStore.close();
        } catch (err) {
          logger.warn?.(`[memory] failed to close run-state store: ${err?.message ?? err}`);
        }
      }
      if (cc) {
        try {
          await cc.close();
        } catch (err) {
          logger.warn?.(`[memory] failed to close conversation context: ${err?.message ?? err}`);
        }
      }
    },
  };
}
