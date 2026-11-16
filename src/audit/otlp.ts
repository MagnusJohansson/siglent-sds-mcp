/**
 * The OpenTelemetry sink: audit events as OTLP log records over HTTP (JSON),
 * to a collector (docs/audit-log-design.md, "OpenTelemetry mapping").
 *
 * The SDK is loaded with a dynamic import() only when an endpoint is
 * configured, so a server without OTLP never runs that code. The exporter
 * reads the standard OTEL_EXPORTER_OTLP_* variables itself (endpoint,
 * headers, timeout); nothing here duplicates them.
 *
 * Losses are counted here, not inside the SDK:
 * - the sink refuses records once as many are waiting as the batch processor
 *   can hold, so the processor never drops one silently;
 * - a wrapper around the exporter counts every record of a failed export;
 * - records a collector rejects in a "partial success" answer (which the SDK
 *   treats as success) are counted from the SDK's diagnostic warning;
 * - records still unexported at shutdown are reported by the caller
 *   (unexported), on the sinks that still work.
 *
 * Nothing the SDK reports reaches stderr unfiltered: its error handler and
 * diagnostic logger are replaced, messages are redacted (URL credentials,
 * every configured header value and each part of it) and rate-limited, and
 * error stacks and HTTP response bodies are never logged.
 */
import type { AuditLevel, AuditRecord, AuditSink } from "./audit.js";

/** The batch processor's queue; the sink refuses records beyond it. */
const MAX_QUEUE = 2048;
const SCHEDULED_DELAY_MS = 1000;
/** At most one diagnostic line per kind per interval; the rest are counted. */
const DIAG_INTERVAL_MS = 60_000;

const RESOURCE_KEYS = new Set(["service.name", "service.version", "service.instance.id"]);
const PARTIAL_SUCCESS = "Received Partial Success response:";

/** Records whose outcome means something didn't go as asked. */
function isWarning(r: AuditRecord): boolean {
  const name = r["event.name"];
  const outcome = r["outcome"];
  if (name === "guard.refused" || name === "audit.loss" || name === "mcp.malformed") return true;
  if (name === "mcp.response") return outcome === "tool_error" || outcome === "jsonrpc_error";
  if (name === "scpi.result") return outcome !== "written" && outcome !== "replied";
  if (name === "instrument.connect") return outcome !== "connected";
  if (name === "instrument.disconnect") return r["reason"] === "socket_error" || r["reason"] === "socket_closed";
  return false;
}

/** A one-line body, so a log viewer shows something useful without opening attributes. */
function summary(r: AuditRecord): string {
  const name = String(r["event.name"]);
  const detail =
    r["rule"] ?? r["gen_ai.tool.name"] ?? r["scpi.command"] ?? r["mcp.method.name"] ?? r["reason"] ?? r["outcome"];
  return detail !== undefined ? `${name}: ${String(detail)}` : name;
}

export interface OtlpSinkStatus {
  exportsOk: number;
  exportsFailed: number;
  /** Records in exports that succeeded, rejected ones included. */
  exportedRecords: number;
  /** Records rejected in partial-success answers. */
  rejected: number;
  /** Records in exports that failed. */
  failedRecords: number;
  /** Records the sink refused because its queue was full. */
  refused: number;
  lastError?: string;
}

/** The parts of the SDK the sink uses, loaded on demand. */
interface Sdk {
  logger: { emit(record: Record<string, unknown>): void };
  forceFlush(): Promise<void>;
  severity: { INFO: number; WARN: number };
}

export class OtlpSink implements AuditSink {
  readonly name = "otlp";
  readonly level: AuditLevel = "full";
  private accepted = 0;
  private settled = 0;
  private lostLater = 0;
  private flushChain: Promise<void> = Promise.resolve();
  readonly status: OtlpSinkStatus = {
    exportsOk: 0,
    exportsFailed: 0,
    exportedRecords: 0,
    rejected: 0,
    failedRecords: 0,
    refused: 0,
  };
  /** Loss counts carried by audit.loss records that were themselves lost. */
  private carriedLost = 0;

  /**
   * Records the collector actually kept. Computed when read: the SDK reports
   * a partial-success rejection before it reports the export's success, so a
   * running total would depend on that order.
   */
  get delivered(): number {
    return Math.max(0, this.status.exportedRecords - this.status.rejected);
  }
  private sdk?: Sdk;

  /**
   * Called by the exporter wrapper when an export finishes (exactly once per
   * export). `carried` is the sum of the losses that audit.loss records in a
   * failed export were reporting: those must be reported again.
   */
  onExported(count: number, ok: boolean, error?: string, carried = 0): void {
    this.settled += count;
    if (ok) {
      this.status.exportsOk++;
      this.status.exportedRecords += count;
    } else {
      this.status.exportsFailed++;
      this.status.failedRecords += count;
      this.status.lastError = error;
      this.lostLater += count;
      this.carriedLost += carried;
    }
  }

  /** Records a collector rejected in a partial-success answer: lost, though the export "succeeded". */
  onRejected(count: number): void {
    if (!(count > 0)) return;
    this.status.rejected += count;
    this.lostLater += count;
  }

  attach(sdk: Sdk): void {
    this.sdk = sdk;
  }

  write(record: AuditRecord): boolean {
    if (!this.sdk || this.accepted - this.settled >= MAX_QUEUE) {
      this.status.refused++;
      return false;
    }
    this.accepted++;
    const attributes: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(record)) {
      if (k !== "time" && k !== "event.name" && !RESOURCE_KEYS.has(k)) attributes[k] = v;
    }
    const warn = isWarning(record);
    this.sdk.logger.emit({
      eventName: `siglent.audit.${String(record["event.name"])}`,
      timestamp: new Date(String(record["time"])),
      severityNumber: warn ? this.sdk.severity.WARN : this.sdk.severity.INFO,
      severityText: warn ? "WARN" : "INFO",
      body: summary(record),
      attributes,
    });
    return true;
  }

  takeLost(): number {
    const n = this.lostLater;
    this.lostLater = 0;
    return n;
  }

  takeUnreported(): number {
    const n = this.carriedLost;
    this.carriedLost = 0;
    return n;
  }

  /**
   * Every record that didn't reach the collector so far: refused, in a failed
   * export, or rejected. (A rejected audit.loss record's carried count can't
   * be re-reported: a partial-success answer doesn't say which records it
   * rejected.)
   */
  get lostTotal(): number {
    return this.status.refused + this.status.failedRecords + this.status.rejected;
  }

  /** Records accepted but not yet exported (or failed): at shutdown, the ones that won't arrive. */
  get unexported(): number {
    return this.accepted - this.settled;
  }

  /**
   * True once everything accepted has been exported (or has failed to be).
   * Flushes queue behind each other: the SDK returns at once from a flush
   * started while another is running, which would let shutdown skip the
   * export of server.stop while the startup check's flush is still waiting.
   */
  async flush(timeoutMs: number): Promise<boolean> {
    const sdk = this.sdk;
    if (!sdk) return true;
    const run = this.flushChain.then(() => sdk.forceFlush()).catch(() => {});
    this.flushChain = run;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs)));
    await Promise.race([run, timeout]);
    clearTimeout(timer);
    return this.settled === this.accepted;
  }

  /**
   * An HTTP export doesn't hold a thread-pool write, so the OTLP sink never
   * makes shutdown kill the process. (A host-name endpoint does use the pool
   * for DNS: a hung resolver can delay exit until getaddrinfo gives up, which
   * is bounded by the resolver's timeouts.)
   */
  writeInFlight(): boolean {
    return false;
  }
}

/** An endpoint as it may be logged: no userinfo, no query string, no fragment. */
export function redactUrl(value: string): string {
  try {
    const u = new URL(value);
    u.username = "";
    u.password = "";
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return "[invalid URL]";
  }
}

/**
 * Remove credentials from free text (the SDK's messages): URL userinfo and
 * query strings, and every value configured in OTEL_EXPORTER_OTLP_HEADERS /
 * OTEL_EXPORTER_OTLP_LOGS_HEADERS, raw and URL-decoded, whole and each
 * whitespace-separated part of it ("Bearer <token>" covers the bare token).
 */
export function redactText(text: string, env: NodeJS.ProcessEnv): string {
  let out = text
    .replace(/(https?:\/\/)[^\s/@]+@/gi, "$1***@")
    .replace(/(https?:\/\/[^\s?#"]+)\?[^\s#"]*/gi, "$1?***");
  const secrets = new Set<string>();
  for (const name of ["OTEL_EXPORTER_OTLP_HEADERS", "OTEL_EXPORTER_OTLP_LOGS_HEADERS"]) {
    for (const pair of (env[name] ?? "").split(",")) {
      const i = pair.indexOf("=");
      if (i < 0) continue;
      const raw = pair.slice(i + 1).trim();
      let decoded = raw;
      try {
        decoded = decodeURIComponent(raw);
      } catch {
        // keep the raw value
      }
      for (const v of [raw, decoded]) {
        secrets.add(v);
        for (const part of v.split(/\s+/)) secrets.add(part);
      }
    }
  }
  // Longest first, so a whole value is replaced before its parts.
  for (const secret of [...secrets].filter((s) => s.length >= 4).sort((a, b) => b.length - a.length)) {
    out = out.split(secret).join("***");
  }
  return out;
}

/** One line per kind per interval; the next one says how many were suppressed. */
function rateLimited(log: (message: string) => void) {
  const last = new Map<string, { at: number; suppressed: number }>();
  return (kind: string, message: string) => {
    const now = Date.now();
    const s = last.get(kind);
    if (s && now - s.at < DIAG_INTERVAL_MS) {
      s.suppressed++;
      return;
    }
    const note = s?.suppressed ? ` (${s.suppressed} similar messages suppressed)` : "";
    last.set(kind, { at: now, suppressed: 0 });
    log(message + note);
  };
}

/**
 * Load the SDK and start the sink. Everything the SDK reports goes to `log`,
 * redacted and rate-limited, never to the console.
 */
export async function startOtlpSink(options: {
  service: { name: string; version: string; instanceId: string };
  log: (message: string) => void;
  env?: NodeJS.ProcessEnv;
}): Promise<OtlpSink> {
  const env = options.env ?? process.env;
  const [api, apiLogs, core, sdkLogs, exporterHttp, resources] = await Promise.all([
    import("@opentelemetry/api"),
    import("@opentelemetry/api-logs"),
    import("@opentelemetry/core"),
    import("@opentelemetry/sdk-logs"),
    import("@opentelemetry/exporter-logs-otlp-http"),
    import("@opentelemetry/resources"),
  ]);

  const sink = new OtlpSink();
  const emit = rateLimited((message) => options.log(redactText(message, env)));
  const text = (a: unknown) => (a instanceof Error ? a.message : typeof a === "string" ? a : "");

  // Export failures: the default handler JSON-serialises the whole error,
  // including its stack and the collector's response body, which can echo
  // the key. Only the message and HTTP status are logged.
  core.setGlobalErrorHandler((ex: unknown) => {
    const e = ex as { message?: unknown; code?: unknown } | string;
    const message = typeof e === "string" ? e : String(e?.message ?? "unknown error");
    const code = typeof e === "object" && e?.code !== undefined ? ` (status ${String(e.code)})` : "";
    emit("export-error", `otlp: export failed: ${message.split("\n")[0]}${code}`);
  });

  const warn = (message: string, ...args: unknown[]) => {
    if (message === PARTIAL_SUCCESS) {
      // The SDK calls the export a success; the collector rejected records.
      let rejected = 0;
      try {
        const p = JSON.parse(String(args[0])) as { rejectedLogRecords?: unknown };
        rejected = Number(p.rejectedLogRecords ?? 0);
      } catch {
        // not parseable: nothing to count
      }
      sink.onRejected(rejected);
      emit("partial-success", `otlp: the collector rejected ${rejected} records (partial success)`);
      return;
    }
    emit("warn", `otlp warn: ${[message, ...args.map(text)].filter(Boolean).join(" ")}`);
  };
  api.diag.setLogger(
    {
      error: (message: string, ...args: unknown[]) =>
        emit("error", `otlp error: ${[message, ...args.map(text)].filter(Boolean).join(" ")}`),
      warn,
      info: () => {},
      debug: () => {},
      verbose: () => {},
    },
    { logLevel: api.DiagLogLevel.WARN, suppressOverrideMessage: true }
  );

  const inner = new exporterHttp.OTLPLogExporter();
  type Records = Parameters<typeof inner.export>[0];
  type Callback = Parameters<typeof inner.export>[1];
  const exporter = {
    export(records: Records, done: Callback): void {
      inner.export(records, (result) => {
        const ok = result.code === 0;
        // A failed audit.loss record takes its report with it: count what it carried.
        const carried = ok
          ? 0
          : records
              .filter((r) => r.eventName === "siglent.audit.audit.loss")
              .reduce((n, r) => n + Number(r.attributes["audit.lost"] ?? 0), 0);
        sink.onExported(
          records.length,
          ok,
          result.error ? redactText(result.error.message.split("\n")[0], env) : undefined,
          carried
        );
        done(result);
      });
    },
    shutdown: () => inner.shutdown(),
    forceFlush: () => inner.forceFlush(),
  };

  // OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES may override the name and
  // version, but not the instance id: it joins the OTLP records to the
  // stderr and file records of the same process.
  const resource = resources
    .resourceFromAttributes({ "service.name": options.service.name, "service.version": options.service.version })
    .merge(resources.detectResources({ detectors: [resources.envDetector] }))
    .merge(resources.resourceFromAttributes({ "service.instance.id": options.service.instanceId }));

  const provider = new sdkLogs.LoggerProvider({
    resource,
    processors: [
      new sdkLogs.BatchLogRecordProcessor({
        exporter,
        maxQueueSize: MAX_QUEUE,
        scheduledDelayMillis: SCHEDULED_DELAY_MS,
      }),
    ],
  });
  sink.attach({
    logger: provider.getLogger(options.service.name, options.service.version),
    forceFlush: () => provider.forceFlush(),
    severity: { INFO: apiLogs.SeverityNumber.INFO, WARN: apiLogs.SeverityNumber.WARN },
  });
  return sink;
}
