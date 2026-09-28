// host/logger.mjs
// Unified logger that works in both Express and Azure Functions.
// Azure Functions swallows console.log/warn from the Node worker,
// so we write to stderr directly which func start captures.
import fs from 'node:fs';

function timestamp() {
  return new Date().toISOString();
}

function formatMessage(level, prefix, args) {
  const parts = args.map(a => typeof a === 'string' ? a : JSON.stringify(a));
  return `[${timestamp()}] [${level}] ${prefix ? `[${prefix}] ` : ''}${parts.join(' ')}`;
}

export function createLogger({ prefix = 'host', target = 'stderr', filePath } = {}) {
  const writers = {
    console: (msg) => console.warn(msg),
    stderr: (msg) => process.stderr.write(msg + '\n'),
    file: (msg) => {
      try { fs.appendFileSync(filePath, msg + '\n'); } catch {}
    },
    both: (msg) => {
      process.stderr.write(msg + '\n');
      if (filePath) try { fs.appendFileSync(filePath, msg + '\n'); } catch {}
    },
  };

  const write = writers[target] ?? writers.stderr;

  return {
    info: (...args) => write(formatMessage('INFO', prefix, args)),
    warn: (...args) => write(formatMessage('WARN', prefix, args)),
    error: (...args) => write(formatMessage('ERROR', prefix, args)),
    child(childPrefix) {
      return createLogger({ prefix: `${prefix}/${childPrefix}`, target, filePath });
    },
  };
}
