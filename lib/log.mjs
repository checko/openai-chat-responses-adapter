const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger({ level = "info" } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  function emit(lvl, fields) {
    if ((LEVELS[lvl] ?? 20) < threshold) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), level: lvl, ...fields });
    if (lvl === "error" || lvl === "warn") process.stderr.write(line + "\n");
    else process.stdout.write(line + "\n");
  }
  return {
    debug: (f) => emit("debug", f),
    info: (f) => emit("info", f),
    warn: (f) => emit("warn", f),
    error: (f) => emit("error", f),
    level,
  };
}
