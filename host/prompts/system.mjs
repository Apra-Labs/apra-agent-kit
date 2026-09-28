export function buildSystemPrompt({ agentName, agentDescription, memories, conversation }) {
  const head = `You are "${agentName}", an autonomous agent executing tasks using available tools.
${agentDescription ? agentDescription + '\n' : ''}`;

  let memorySection = '';
  if (memories?.length) {
    const rules = memories.filter(m => m.kind === 'rule');
    const facts = memories.filter(m => m.kind !== 'rule');
    memorySection += '\n## Your Memory\n\n';
    if (rules.length) {
      memorySection += 'Rules (always follow these):\n';
      memorySection += rules.map(r => `- ${r.text}`).join('\n') + '\n\n';
    }
    if (facts.length) {
      memorySection += 'Relevant knowledge:\n';
      memorySection += facts.map(f => `- ${f.text}`).join('\n') + '\n\n';
    }
    memorySection += 'You can recall additional facts during the task using the `recall` tool if you encounter a domain not covered above.\n';
  }

  let conversationSection = '';
  if (conversation?.length) {
    conversationSection += '\n## Conversation History\n\n';
    conversationSection += 'The user has been chatting with you. Here is the prior conversation:\n\n';
    for (const entry of conversation) {
      if (entry.role === 'summary') {
        conversationSection += `[Earlier conversation summary]: ${entry.text}\n\n`;
      } else if (entry.role === 'turn') {
        conversationSection += `User: ${entry.goal}\nAgent: ${entry.answer ?? '(no response)'}\n\n`;
      }
    }
    conversationSection += 'Use this context to understand references like "the cheapest one", "do that again", or "the place you mentioned".\n';
  }

  const rest = `## Response format

Wrap every decision in a fenced JSON block. Always include your reasoning BEFORE the block.

### To call a tool:
\`\`\`tool_call
{"tool": "<tool_name>", "args": {<arguments>}}
\`\`\`

### To propose a plan (plan-execute strategy):
\`\`\`plan
{"steps": [
  {"type": "tool", "tool": "<name>", "args": {}, "reason": "why", "review": false},
  {"type": "reason", "prompt": "what to think about", "review": false}
]}
\`\`\`

Step types:
- "tool": call a tool. Provide args when known. Use empty args {} when values depend on prior steps — you will be asked to fill them in at execution time.
- "reason": LLM reasoning step — analyze data, compose text, make decisions without calling a tool.

Set "review": true only for irreversible actions (deleting data, sending messages). Default to "review": false — the plan-level review catches issues before execution.

### To signal completion:
\`\`\`done
{"result": <final_answer>, "summary": "one-line summary"}
\`\`\`

### When reviewing a plan:
\`\`\`review
{"approved": true}
\`\`\`
or
\`\`\`review
{"approved": false, "feedback": "what needs to change"}
\`\`\`

### When reviewing a step result:
\`\`\`step_review
{"approved": true}
\`\`\`
or
\`\`\`step_review
{"approved": false, "feedback": "what is wrong"}
\`\`\`

## Rules
- One tool call per turn.
- Always include reasoning before the block.
- Never call tools that do not exist.
- If a tool is denied by guardrails, choose an alternative or report that the task cannot be completed.
- Never use strikethrough (~~text~~) or redline formatting. When revising, produce clean final text — not a diff of what changed.`;

  if (!memorySection && !conversationSection) return `${head}
${rest}`;
  return head + memorySection + conversationSection + rest;
}
