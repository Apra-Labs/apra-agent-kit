// evals/graders/llm-judge.mjs

function extractText(response) {
  if (!response) return '';
  if (typeof response === 'string') return response;
  if (typeof response.text === 'string') return response.text;
  return (response.content ?? []).map(p => p.text ?? '').join('\n');
}

export default async function llmJudge(expected, actual) {
  const fleetApi = expected._fleetApi;
  if (!fleetApi) return { pass: false, score: 0, reason: 'llm-judge requires _fleetApi on expected' };

  const task = expected._task ?? {};
  const prompt = `You are an eval judge. Grade the agent's output against the rubric.

Task goal: ${task.goal ?? 'unknown'}
Rubric: ${expected.rubric ?? 'no rubric provided'}
Agent output: ${JSON.stringify(actual.result)}
Agent status: ${actual.status}

Think step by step, then respond with ONLY a JSON object on a single line:
{"pass": true, "score": 0.85, "reason": "your reasoning here"}

Your final line MUST be the JSON verdict. Do not wrap it in markdown code fences.`;

  try {
    const response = await fleetApi.executePrompt({ member_name: 'doer', prompt });
    let text = extractText(response);
    if (!text) {
      return { pass: false, score: 0, reason: 'llm-judge received empty response' };
    }
    // Detect fleet errors (untrusted workspace, permissions, etc.)
    if (/^\[FAIL\]|^\[ERROR\]|Workspace not trusted/m.test(text)) {
      return { pass: false, score: 0, reason: `llm-judge fleet error: ${text.split('\n')[0].slice(0, 120)}` };
    }
    // Strip markdown code fences the LLM may wrap around JSON
    text = text.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '');

    let parsed = null;
    // Strategy 1: scan lines bottom-up for a JSON object with "pass"
    const lines = text.split('\n').reverse();
    for (const line of lines) {
      const match = line.match(/\{[^{}]*"pass"\s*:\s*(true|false)[^{}]*\}/);
      if (match) {
        try { parsed = JSON.parse(match[0]); break; } catch { /* try next line */ }
      }
    }
    // Strategy 2: multi-line JSON with pass + reason
    if (!parsed) {
      const broad = text.match(/\{[\s\S]*?"pass"\s*:\s*(true|false)[\s\S]*?\}/);
      if (broad) {
        try { parsed = JSON.parse(broad[0]); } catch { /* fall through */ }
      }
    }
    // Strategy 3: infer from text when no JSON found
    if (!parsed) {
      const passHint = /\bpass\b/i.test(text) && !/\bfail\b/i.test(text);
      const scoreMatch = text.match(/\b(?:score|rating)\s*[:=]\s*(\d+(?:\.\d+)?)/i);
      if (passHint || scoreMatch) {
        const score = scoreMatch ? parseFloat(scoreMatch[1]) : (passHint ? 1 : 0);
        parsed = { pass: passHint, score, reason: 'inferred from unstructured judge text' };
      }
    }
    if (!parsed) {
      const preview = text.length > 200 ? text.slice(0, 200) + '...' : text;
      return { pass: false, score: 0, reason: `could not parse judge response: ${preview}` };
    }
    let score = typeof parsed.score === 'number' ? parsed.score : (parsed.pass ? 1 : 0);
    if (expected.scoreScale && typeof expected.scoreScale === 'number') {
      score = score / expected.scoreScale;
    }
    score = Math.round(Math.min(1, Math.max(0, score)) * 100) / 100;
    const pass = parsed.pass ?? (score >= 0.6);
    return { pass, score, reason: parsed.reason ?? 'no reason given' };
  } catch (err) {
    return { pass: false, score: 0, reason: `llm-judge error: ${err.message}` };
  }
}
