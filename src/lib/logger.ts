const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;

const currentLevel: Level = (process.env.LOG_LEVEL as string) in LEVELS
  ? (process.env.LOG_LEVEL as Level)
  : 'debug';

function ts(): string {
  return new Date().toISOString();
}

function fmt(level: string, tag: string, msg: string): string {
  return `${ts()} [${level.toUpperCase().padEnd(5)}] [${tag}] ${msg}`;
}

export const log = {
  debug: (msg: string, ...args: unknown[]) => {
    if (LEVELS[currentLevel] <= LEVELS.debug) console.debug(fmt('debug', 'SYS', msg), ...args);
  },
  info: (msg: string, ...args: unknown[]) => {
    if (LEVELS[currentLevel] <= LEVELS.info) console.log(fmt('info', 'SYS', msg), ...args);
  },
  warn: (msg: string, ...args: unknown[]) => {
    if (LEVELS[currentLevel] <= LEVELS.warn) console.warn(fmt('warn', 'SYS', msg), ...args);
  },
  error: (msg: string, ...args: unknown[]) => {
    console.error(fmt('error', 'SYS', msg), ...args);
  },
};

/** Create a tagged logger for a specific module */
export function createLogger(tag: string) {
  return {
    debug: (msg: string, ...args: unknown[]) => {
      if (LEVELS[currentLevel] <= LEVELS.debug) console.debug(fmt('debug', tag, msg), ...args);
    },
    info: (msg: string, ...args: unknown[]) => {
      if (LEVELS[currentLevel] <= LEVELS.info) console.log(fmt('info', tag, msg), ...args);
    },
    warn: (msg: string, ...args: unknown[]) => {
      if (LEVELS[currentLevel] <= LEVELS.warn) console.warn(fmt('warn', tag, msg), ...args);
    },
    error: (msg: string, ...args: unknown[]) => {
      console.error(fmt('error', tag, msg), ...args);
    },
  };
}
