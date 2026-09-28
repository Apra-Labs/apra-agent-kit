// tests/host-conversation-pipeline.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt } from '../host/prompts/system.mjs';

test('buildSystemPrompt includes conversation history when provided', () => {
  const conversation = [
    { role: 'turn', goal: 'Find flights to Tokyo', answer: 'Found 3 flights...' },
    { role: 'turn', goal: 'Book the cheapest one', answer: 'Booked flight JAL123...' },
  ];
  const prompt = buildSystemPrompt({ agentName: 'test', conversation });
  assert.ok(prompt.includes('Conversation History'));
  assert.ok(prompt.includes('Find flights to Tokyo'));
  assert.ok(prompt.includes('Found 3 flights'));
  assert.ok(prompt.includes('Book the cheapest one'));
});

test('buildSystemPrompt includes summary when present', () => {
  const conversation = [
    { role: 'summary', text: 'User asked about Tokyo flights.' },
    { role: 'turn', goal: 'Book the cheapest one', answer: 'Booked.' },
  ];
  const prompt = buildSystemPrompt({ agentName: 'test', conversation });
  assert.ok(prompt.includes('User asked about Tokyo flights.'));
  assert.ok(prompt.includes('Book the cheapest one'));
});

test('buildSystemPrompt omits conversation section when empty or missing', () => {
  const prompt1 = buildSystemPrompt({ agentName: 'test' });
  assert.ok(!prompt1.includes('Conversation History'));
  const prompt2 = buildSystemPrompt({ agentName: 'test', conversation: [] });
  assert.ok(!prompt2.includes('Conversation History'));
});

test('buildSystemPrompt places conversation after memory, before response format', () => {
  const memories = [{ kind: 'domain', text: 'fact1' }];
  const conversation = [{ role: 'turn', goal: 'q', answer: 'a' }];
  const prompt = buildSystemPrompt({ agentName: 'test', memories, conversation });
  const memIdx = prompt.indexOf('Your Memory');
  const convIdx = prompt.indexOf('Conversation History');
  const fmtIdx = prompt.indexOf('Response format');
  assert.ok(memIdx < convIdx, 'memory should come before conversation');
  assert.ok(convIdx < fmtIdx, 'conversation should come before response format');
});

test('buildSystemPrompt handles passthrough-style raw entries', () => {
  const conversation = [
    { role: 'turn', goal: 'What is X?', answer: 'X is ...' },
  ];
  const prompt = buildSystemPrompt({ agentName: 'test', conversation });
  assert.ok(prompt.includes('What is X?'));
  assert.ok(prompt.includes('X is ...'));
});
