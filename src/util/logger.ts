/**
 * 軽量ロガー。標準出力に構造化されたプレフィックス付きで出す。
 * GitHub Actionsのログにそのまま流れることを想定。
 */

type Level = "info" | "warn" | "error" | "debug";

function ts(): string {
  // ISO文字列（UTC）。GitHub Actionsのログ上でJSTに読み替える運用。
  return new Date().toISOString();
}

function emit(level: Level, msg: string, meta?: unknown): void {
  const line = `[${ts()}] [${level.toUpperCase()}] ${msg}`;
  const out = level === "error" || level === "warn" ? console.error : console.log;
  if (meta !== undefined) {
    out(line, typeof meta === "string" ? meta : JSON.stringify(meta));
  } else {
    out(line);
  }
}

export const log = {
  info: (msg: string, meta?: unknown) => emit("info", msg, meta),
  warn: (msg: string, meta?: unknown) => emit("warn", msg, meta),
  error: (msg: string, meta?: unknown) => emit("error", msg, meta),
  debug: (msg: string, meta?: unknown) => {
    if (process.env.DEBUG) emit("debug", msg, meta);
  },
};
