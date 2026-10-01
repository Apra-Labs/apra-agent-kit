import { Cron } from 'croner';

function isValidTimezone(tz) {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function isValidCron(expr) {
  try {
    new Cron(expr, { timezone: 'UTC' });
    return true;
  } catch {
    return false;
  }
}

export function validateSchedules(schedules, toolRegistry, { logger } = {}) {
  const names = new Set();
  const routableWorkflows = new Set(
    toolRegistry.filter(t => t.routing).map(t => t.name),
  );

  const valid = [];

  for (const s of schedules) {
    if (!s.name || typeof s.name !== 'string') {
      throw new Error('schedule name is required (non-empty string)');
    }
    if (names.has(s.name)) {
      throw new Error(`duplicate schedule name "${s.name}"`);
    }
    names.add(s.name);

    if (!s.workflow || typeof s.workflow !== 'string') {
      throw new Error(`schedule "${s.name}": workflow is required`);
    }
    if (!toolRegistry.some(t => t.name === s.workflow)) {
      throw new Error(`schedule "${s.name}" references unknown workflow "${s.workflow}"`);
    }
    if (!routableWorkflows.has(s.workflow)) {
      logger?.warn?.(`[scheduler] skipping schedule "${s.name}": workflow "${s.workflow}" is not routable (missing routing config)`);
      continue;
    }

    if (!s.cron || typeof s.cron !== 'string') {
      throw new Error(`schedule "${s.name}": cron is required (non-empty string)`);
    }
    if (!isValidCron(s.cron)) {
      throw new Error(`schedule "${s.name}" has invalid cron expression "${s.cron}"`);
    }

    if (!s.timezone || typeof s.timezone !== 'string') {
      throw new Error(`schedule "${s.name}": timezone is required (non-empty string)`);
    }
    if (!isValidTimezone(s.timezone)) {
      throw new Error(`schedule "${s.name}" has invalid timezone "${s.timezone}"`);
    }

    valid.push(s);
  }

  return valid;
}
