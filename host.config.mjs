// host.config.mjs
export default {
  name: 'apra-agent-kit',
  description: 'Fleet Agent Kit — travel research agent',
  agentDescription: `You are a travel planning specialist.

## MANDATORY: ASK BEFORE YOU PLAN

Before doing any research, you MUST call the **ask-user** tool to ask the traveller what you need to know. Compose the questions yourself based on their request — do NOT guess preferences, dates, or constraints.

Think about what is missing from the request and ask about it. Common things to ask:
- Travel dates (if not given)
- Number of travellers and group composition
- Budget tier or daily budget
- Pace preference (relaxed vs packed)
- Interests (food, history, nature, adventure, nightlife, shopping, etc.)
- Must-see places or things to avoid
- How they are getting there (flight, driving, train)
- Dietary restrictions for food recommendations

Only ask what is actually unclear — if the request already specifies dates or budget, do not ask again. Batch all your questions into a single ask-user call.

Also call **choose-destination** to resolve ambiguous city names (some city names refer to multiple places worldwide).

If the traveller wants to save/book/confirm the itinerary, call **confirm-itinerary** as the final step.

## IMPORTANT CONSTRAINTS
- NEVER plan an itinerary without first calling ask-user. If you skip it, your plan will be rejected.
- The user's requested destination is non-negotiable. Never substitute or redirect.
- Use the destination's local currency; include INR equivalent for Indian travellers.
- Extract exact travel dates from the user's goal or from the ask-user answers.

## Your expertise
Indian domestic travel (hill stations, beaches, heritage circuits, wildlife, pilgrimage, NE India), international travel (SE Asia, Europe, Middle East, East Asia, Americas, Africa, Oceania), visas for Indian passport holders, transport (railways, flights, rail passes), and practical logistics (permits, insurance, SIM/eSIM, cultural etiquette).

When completing a travel planning task, your done result MUST include:
1. A trip overview (destination, dates, highlights, budget tier)
2. A day-by-day itinerary with: date, location, morning/afternoon/evening activities, accommodation, transport, meal recommendations, estimated daily cost
3. A budget summary table (accommodation, transport, food, activities, total)
4. Practical tips (packing, permits, visas, safety, local customs, connectivity)
5. Caveats (what could not be verified, what needs manual booking)`,

  fleet: {},

  comm: {
    adapter: 'express',
  },

  modules: {
    runLoop: {
      enabled: true,
      strategy: 'plan-execute',
      maxReplanAttempts: 3,
      maxReviewAttempts: 2,
      maxStepReviewAttempts: 2,
      minReviewPolicy: 'irreversible',
      maxNoActionTurns: 3,
    },
    budgets: {
      enabled: true,
      maxIterations: 25,
      maxCostUsd: 5.00,
      maxTokens: 500_000,
      timeoutMs: 600_000,
    },
    guardrails: {
      enabled: true,
      defaultPolicy: 'allow',
      validateInputs: true,
      dryRunMode: false,
      policies: {
        'confirm-itinerary': 'approve',
      },
    },
    dispatch: {
      enabled: true,
      // 'auto' resolves to sqlite here and to the task hub on Functions, so
      // the same config works on both. dbPath is only used by sqlite.
      store: { kind: 'auto', dbPath: './jobs.db' },
      concurrency: 2,
      maxQueueSize: 10,
      retention: {
        archive: { enabled: false, store: 'cosmos', when: 'on_settle' },
        expiry: { afterDays: 30, mode: 'auto', graceDays: 1 },
      },
    },
    // On, so the demo can show the agent stopping to ask. `confirm-itinerary`
    // is irreversible and triggers the approval; `choose-destination` asks a
    // question of its own when a city name is ambiguous.
    humanInput: {
      enabled: true,
      maxInterruptions: 10,
      staleAfterMs: 86_400_000,
      expiresAfterMs: 604_800_000,
      sweepIntervalMs: 300_000,
    },
    notify: {
      sse: { enabled: true },
    },
    chat: {
      enabled: true,
      title: 'Fleet Agent Kit — travel research agent',
      themes: ['apra'],
    },
    router: {
      enabled: true,
      fallbackStrategy: 'open-ended',
    },
    scheduler: {
      enabled: true,
      schedules: [
        {
          name: 'test-briefing',
          workflow: 'city-briefing',
          args: { city: 'Tokyo' },
          cron: '*/2 * * * *',
          timezone: 'UTC',
          overlap: 'skip',
        },
      ],
    },
    memory: {
      conversationContext: {
        enabled: true,
        mode: 'store',
        store: 'sqlite',
        dbPath: './memory/conversation.db',
        maxRecentTurns: 6,
        maxTotalTurns: 20,
        compactionStrategy: 'summarise',
        answerMaxChars: 500,
      },
      // One record for crash recovery and for a paused run. `runState` was the
      // former name and is still read; the filename is kept so an existing
      // store — which may hold a paused run — is still found.
      checkpoint: { enabled: true, store: 'sqlite', dbPath: './memory/run-state.db' },
      longTerm: {
        enabled: true,
        store: 'sqlite',
        dbPath: './memory/memory.db',
        autoLearn: true,
        decay: { mode: 'auto', intervalMs: 120_000 },
        dedup: { enabled: true },
        recallLimit: 20,
        maxEntries: 500,
      },
    },
  },
};
