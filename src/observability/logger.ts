export type LogFields = Record<string, string | number | boolean | undefined>;

export interface StructuredLogger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

function write(level: string, message: string, fields: LogFields = {}): void {
  const safeFields = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), level, message, ...safeFields }));
}

export const consoleLogger: StructuredLogger = {
  info: (message, fields) => write("info", message, fields),
  warn: (message, fields) => write("warn", message, fields),
  error: (message, fields) => write("error", message, fields),
};
