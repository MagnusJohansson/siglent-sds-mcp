/** Size limits for logged content (docs/audit-log-design.md, "Content limits"). */

/**
 * Strings logged from arguments, commands, replies and errors; the wire limit
 * is 512 too. Names and ids from the client (tool, method, request id) are
 * bounded at 128, the protocol version at 64, human-readable lines at 4096.
 */
export const MAX_STRING = 512;
/** Tool arguments, as one JSON string. */
export const MAX_ARGUMENTS = 4096;
/** One serialised event. */
export const MAX_LINE_BYTES = 16 * 1024;

export function bound(value: string, max: number = MAX_STRING): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…[truncated, ${value.length} chars]`;
}

/**
 * Tool arguments as JSON, each string bounded, the whole bounded too.
 * Arguments that can't be serialised (nested too deep for the stack, for
 * instance) are logged as a placeholder rather than failing the call.
 */
export function boundArguments(args: unknown): string {
  try {
    const json = JSON.stringify(args ?? {}, (_key, v: unknown) => (typeof v === "string" ? bound(v) : v));
    return bound(json, MAX_ARGUMENTS);
  } catch (err) {
    return `[arguments not logged: ${err instanceof Error ? err.message : String(err)}]`;
  }
}

/** A tool result's content as types and sizes, never the content itself. */
export function summariseContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((item: { type?: string; text?: string; data?: string }) => {
      const size = typeof item.text === "string" ? item.text.length : typeof item.data === "string" ? item.data.length : 0;
      return `${item.type ?? "unknown"}:${size}`;
    })
    .join(",");
}

/** The first text item of a tool result, bounded: the error message of a failed call. */
export function firstText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const text = content.find((c: { type?: string; text?: unknown }) => c.type === "text" && typeof c.text === "string");
  return text ? bound(text.text as string) : undefined;
}

/** Serialise an event to one line, cutting the longest strings until it fits. */
export function serialise(record: Record<string, string | number | boolean>): string {
  let line = JSON.stringify(record);
  if (Buffer.byteLength(line) <= MAX_LINE_BYTES) return line;
  const r: Record<string, string | number | boolean> = { ...record, "audit.truncated": true };
  for (;;) {
    let longest: string | undefined;
    for (const [k, v] of Object.entries(r)) {
      if (typeof v === "string" && (longest === undefined || v.length > (r[longest] as string).length)) longest = k;
    }
    if (longest === undefined || (r[longest] as string).length < 64) return JSON.stringify(r);
    const v = r[longest] as string;
    r[longest] = `${v.slice(0, Math.floor(v.length / 2))}…[truncated]`;
    line = JSON.stringify(r);
    if (Buffer.byteLength(line) <= MAX_LINE_BYTES) return line;
  }
}
