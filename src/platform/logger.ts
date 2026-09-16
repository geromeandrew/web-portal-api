export type Logger = {
  info(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
};

function write(
  level: "info" | "error",
  event: string,
  fields: Record<string, unknown> = {},
) {
  const entry = JSON.stringify({
    level,
    event,
    timestamp: new Date().toISOString(),
    ...fields,
  });
  if (level === "error") console.error(entry);
  else console.log(entry);
}

export function createLogger(): Logger {
  return {
    info: (event, fields) => write("info", event, fields),
    error: (event, fields) => write("error", event, fields),
  };
}
