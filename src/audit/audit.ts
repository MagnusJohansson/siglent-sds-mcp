/**
 * The audit log (docs/audit-log-design.md).
 *
 * Events come from the MCP transport (src/audit/transport.ts) and from the
 * connection to the instrument (src/connection.ts). Every event carries the
 * JSON-RPC request id of the call that caused it, taken from an explicit
 * AuditContext. All event and field names are defined in this file.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { bound, serialise } from "./bounds.js";
import type { FdWriter } from "./writer.js";

// ---------------------------------------------------------------------------
// Context

export type AuditCause =
  | "tool-call"
  | "auto-connect"
  | "reconnect"
  | "idle-close"
  | "reset"
  | "socket"
  | "shutdown"
  | "internal";

export interface AuditContext {
  /** The JSON-RPC request id, as a string. Absent when no request caused the event. */
  requestId?: string;
  cause: AuditCause;
}

const storage = new AsyncLocalStorage<AuditContext>();

/** Run fn with ctx as the ambient audit context. */
export function withAuditContext<T>(ctx: AuditContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/**
 * The ambient context. Only valid at the synchronous start of a call made by
 * a tool (or another caller that set one). Code that runs later from socket
 * or timer callbacks must use a context captured earlier, never this.
 */
export function auditContext(): AuditContext {
  return storage.getStore() ?? { cause: "internal" };
}

// ---------------------------------------------------------------------------
// Levels and sinks

/** "security": the low-volume default. "full": everything. */
export type AuditLevel = "security" | "full";

export type AuditValue = string | number | boolean;
export type AuditRecord = Record<string, AuditValue>;

export interface AuditSink {
  readonly name: string;
  readonly level: AuditLevel;
  /** Accept a record. Returns false if it was dropped. */
  write(record: AuditRecord): boolean;
  /** Records lost after they were accepted, since the last call. */
  takeLost?(): number;
  /**
   * Losses already counted and reported, whose report (an audit.loss record)
   * was itself lost: to be reported again, without counting them twice.
   */
  takeUnreported?(): number;
  /** Wait until accepted records are written, or the timeout passes. */
  flush?(timeoutMs: number): Promise<boolean>;
  /** A write is stuck in the thread pool right now (see FdWriter.writeInFlight). */
  writeInFlight?(): boolean;
}

/** A sink that writes JSON lines through an FdWriter (stderr or a file). */
export class JsonlSink implements AuditSink {
  private lostLater = 0;
  constructor(
    readonly name: string,
    readonly level: AuditLevel,
    private readonly writer: FdWriter
  ) {}
  write(record: AuditRecord): boolean {
    return this.writer.write(`${serialise(record)}\n`, () => this.lostLater++);
  }
  takeLost(): number {
    const n = this.lostLater;
    this.lostLater = 0;
    return n;
  }
  flush(timeoutMs: number): Promise<boolean> {
    return this.writer.flush(timeoutMs);
  }
  writeInFlight(): boolean {
    return this.writer.writeInFlight;
  }
}

interface SinkState {
  sink: AuditSink;
  seq: number;
  /** Losses not yet reported with an audit.loss event. */
  unreported: number;
  lostTotal: number;
}

// ---------------------------------------------------------------------------
// Event field types

export type ScpiKind = "command" | "query" | "binary-query" | "opc";
export type ScpiOutcome =
  | "written"
  | "replied"
  | "timeout"
  | "write_failed"
  | "out_of_step"
  | "connection_closed"
  | "not_written";
export type ConnectOutcome = "connected" | "refused_by_policy" | "failed" | "superseded";
export type DisconnectReason =
  | "requested"
  | "replaced"
  | "init_failed"
  | "idle"
  | "reset_after_timeout"
  | "reset_out_of_step"
  | "socket_error"
  | "socket_closed"
  | "shutdown";
export type Guard = "wire" | "query" | "command" | "binary" | "host" | "raw-scpi" | "schema";

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
}

const LOSS_WARNING_INTERVAL_MS = 60_000;

// ---------------------------------------------------------------------------

export class Audit {
  readonly instanceId = randomUUID();
  private service = { name: "unknown", version: "0.0.0" };
  private sinks: SinkState[] = [];
  private stderr?: FdWriter;
  private writeIds = 0;
  private lastLossWarning = 0;
  private humanLost = 0;
  private readonly tools = new Map<string, ToolAnnotations>();

  configure(options: { service?: { name: string; version: string }; sinks?: AuditSink[]; stderr?: FdWriter }): void {
    if (options.service) this.service = options.service;
    if (options.sinks) this.sinks = options.sinks.map((sink) => ({ sink, seq: 0, unreported: 0, lostTotal: 0 }));
    if (options.stderr) this.stderr = options.stderr;
  }

  /** Add a sink, keeping the other sinks' numbering. */
  addSink(sink: AuditSink): void {
    this.sinks.push({ sink, seq: 0, unreported: 0, lostTotal: 0 });
  }

  /** Remove all sinks (tests). */
  reset(): void {
    this.sinks = [];
    this.stderr = undefined;
  }

  // --- Tools ----------------------------------------------------------------

  registerTool(name: string, annotations: ToolAnnotations | undefined): void {
    this.tools.set(name, annotations ?? {});
  }

  /** The annotations every registered tool declared (for tests). */
  get registeredTools(): ReadonlyMap<string, ToolAnnotations> {
    return this.tools;
  }

  /** State-changing tools are recorded at the security level. Unknown tools aren't. */
  isStateChanging(tool: string): boolean {
    const a = this.tools.get(tool);
    return a !== undefined && a.readOnlyHint === false;
  }

  // --- Human-readable stderr lines ------------------------------------------

  /**
   * A human-readable line on stderr, through the same non-blocking queue as
   * the audit events. Dropped (and counted) when the queue is full.
   */
  log(text: string): void {
    // Stack traces and instrument errors can be long; keep a line bounded.
    const message = bound(text, 4096);
    if (!this.stderr) {
      // Not configured yet (startup, tests): nothing else writes to stderr.
      logSync(message);
      return;
    }
    if (!this.stderr.write(`${message}\n`, () => this.humanLost++)) this.humanLost++;
  }

  // --- Events -----------------------------------------------------------------

  nextWriteId(): number {
    return ++this.writeIds;
  }

  serverStart(fields: { rawScpiEnabled: boolean; allowedHosts: string[]; allowedPorts: number[]; audit: string }): void {
    this.emit("security", "server.start", {
      raw_scpi_enabled: fields.rawScpiEnabled,
      allowed_hosts: fields.allowedHosts.join(","),
      allowed_ports: fields.allowedPorts.join(","),
      "audit.config": fields.audit,
    }, { cause: "internal" });
  }

  /** server.stop, to every sink or only to those whose name passes `only`. */
  serverStop(
    reason: "stdin_closed" | "signal",
    extra: Record<string, AuditValue> = {},
    only?: (sinkName: string) => boolean
  ): void {
    this.emit(
      "security",
      "server.stop",
      { reason, ...extra },
      { cause: "shutdown" },
      (s) => ({ "audit.lost": s.lostTotal }),
      only
    );
  }

  mcpRequest(
    level: AuditLevel,
    fields: {
      method: string;
      tool?: string;
      arguments?: string;
      annotations?: ToolAnnotations;
      client?: { name?: string; version?: string; protocolVersion?: string };
    },
    ctx: AuditContext
  ): void {
    this.emit(level, "mcp.request", {
      "mcp.method.name": fields.method,
      "gen_ai.tool.name": fields.tool,
      "gen_ai.tool.call.arguments": fields.arguments,
      read_only_hint: fields.annotations?.readOnlyHint,
      destructive_hint: fields.annotations?.destructiveHint,
      "client.name": fields.client?.name !== undefined ? bound(fields.client.name, 128) : undefined,
      "client.version": fields.client?.version !== undefined ? bound(fields.client.version, 64) : undefined,
      "client.self_reported": fields.client?.name !== undefined ? true : undefined,
      "mcp.protocol.version": fields.client?.protocolVersion !== undefined ? bound(fields.client.protocolVersion, 64) : undefined,
    }, ctx);
  }

  mcpResponse(
    level: AuditLevel,
    fields: {
      method: string;
      tool?: string;
      outcome: "ok" | "tool_error" | "jsonrpc_error" | "cancelled";
      errorType?: string;
      statusCode?: string;
      errorMessage?: string;
      content?: string;
      durationMs: number;
    },
    ctx: AuditContext
  ): void {
    this.emit(level, "mcp.response", {
      "mcp.method.name": fields.method,
      "gen_ai.tool.name": fields.tool,
      outcome: fields.outcome,
      "error.type": fields.errorType,
      "rpc.status_code": fields.statusCode,
      "error.message": fields.errorMessage,
      "content.summary": fields.content,
      duration_ms: fields.durationMs,
    }, ctx);
  }

  mcpMalformed(error: unknown): void {
    this.emit("full", "mcp.malformed", {
      "error.message": bound(error instanceof Error ? error.message : String(error)),
    }, { cause: "internal" });
  }

  guardRefused(
    fields: { guard: Guard; rule: string; message: string; command?: string; host?: string; port?: number },
    ctx: AuditContext
  ): void {
    this.emit("security", "guard.refused", {
      guard: fields.guard,
      rule: fields.rule,
      "scpi.command": fields.command !== undefined ? bound(fields.command) : undefined,
      "server.address": fields.host !== undefined ? bound(fields.host, 253) : undefined,
      "server.port": fields.port,
      "error.message": bound(fields.message),
    }, ctx);
  }

  scpiWrite(
    fields: { writeId: number; command: string; kind: ScpiKind; host: string; port: number },
    ctx: AuditContext
  ): void {
    this.emit("full", "scpi.write", {
      "scpi.write_id": fields.writeId,
      "scpi.command": bound(fields.command),
      "scpi.kind": fields.kind,
      "server.address": fields.host,
      "server.port": fields.port,
    }, ctx);
  }

  scpiResult(
    fields: { writeId: number; outcome: ScpiOutcome; startedAt?: number; reply?: Buffer; binary?: boolean },
    ctx: AuditContext
  ): void {
    const reply = fields.reply;
    this.emit("full", "scpi.result", {
      "scpi.write_id": fields.writeId,
      outcome: fields.outcome,
      "reply.bytes": reply?.length,
      "reply.text": reply && !fields.binary ? bound(reply.toString("utf8").trim()) : undefined,
      duration_ms: fields.startedAt ? Date.now() - fields.startedAt : undefined,
    }, ctx);
  }

  instrumentConnect(
    fields: { host: string; port: number; outcome: ConnectOutcome; idn?: string; message?: string },
    ctx: AuditContext
  ): void {
    this.emit("security", "instrument.connect", {
      "server.address": bound(fields.host, 253),
      "server.port": fields.port,
      outcome: fields.outcome,
      "instrument.idn": fields.idn !== undefined ? bound(fields.idn, 256) : undefined,
      "error.message": fields.message !== undefined ? bound(fields.message) : undefined,
    }, ctx);
  }

  instrumentDisconnect(fields: { host: string; port: number; reason: DisconnectReason }, ctx: AuditContext): void {
    this.emit("security", "instrument.disconnect", {
      "server.address": fields.host,
      "server.port": fields.port,
      reason: fields.reason,
    }, ctx);
  }

  /** Total records lost across all sinks, and human-readable lines lost. */
  get lost(): { events: number; lines: number } {
    return { events: this.sinks.reduce((n, s) => n + s.lostTotal, 0), lines: this.humanLost };
  }

  /** Some sink, or stderr, has a write stuck in the thread pool. */
  get writeInFlight(): boolean {
    return (this.stderr?.writeInFlight ?? false) || this.sinks.some((s) => s.sink.writeInFlight?.() ?? false);
  }

  /** Wait for the human-readable stderr lines to drain, or the timeout to pass. */
  flushStderr(timeoutMs: number): Promise<boolean> {
    return this.stderr?.flush(timeoutMs) ?? Promise.resolve(true);
  }

  /** Wait for every sink and stderr to drain, or the timeout to pass. */
  async flush(timeoutMs: number): Promise<boolean> {
    const results = await Promise.all([
      ...this.sinks.map((s) => s.sink.flush?.(timeoutMs) ?? Promise.resolve(true)),
      this.stderr?.flush(timeoutMs) ?? Promise.resolve(true),
    ]);
    return results.every(Boolean);
  }

  // --- Internals ----------------------------------------------------------------

  private emit(
    level: AuditLevel,
    name: string,
    fields: Record<string, AuditValue | undefined>,
    ctx: AuditContext,
    perSink?: (s: SinkState) => Record<string, AuditValue>,
    only?: (sinkName: string) => boolean
  ): void {
    if (this.sinks.length === 0) return;
    const base: AuditRecord = {
      time: new Date().toISOString(),
      "event.name": name,
      "service.name": this.service.name,
      "service.version": this.service.version,
      "service.instance.id": this.instanceId,
      cause: ctx.cause,
    };
    if (ctx.requestId !== undefined) base["jsonrpc.request.id"] = ctx.requestId;
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) base[k] = v;
    }
    for (const s of this.sinks) {
      if (level === "full" && s.sink.level === "security") continue;
      if (only && !only(s.sink.name)) continue;
      this.reportLoss(s, base);
      this.deliver(s, { ...base, ...perSink?.(s) });
    }
  }

  /** Each sink numbers the records it accepts; a dropped record leaves a gap. */
  private deliver(s: SinkState, record: AuditRecord): boolean {
    s.seq++;
    const ok = s.sink.write({ ...record, "audit.sink": s.sink.name, "audit.seq": s.seq });
    if (!ok) {
      s.unreported++;
      s.lostTotal++;
    }
    return ok;
  }

  /** Report losses as soon as the sink accepts records again. */
  private reportLoss(s: SinkState, base: AuditRecord): void {
    const later = s.sink.takeLost?.() ?? 0;
    if (later > 0) {
      s.unreported += later;
      s.lostTotal += later;
    }
    // Already in lostTotal: their earlier report didn't arrive.
    s.unreported += s.sink.takeUnreported?.() ?? 0;
    if (s.unreported === 0) return;
    const lost = s.unreported;
    const record: AuditRecord = {
      time: base.time,
      "event.name": "audit.loss",
      "service.name": this.service.name,
      "service.version": this.service.version,
      "service.instance.id": this.instanceId,
      cause: "internal",
      "audit.lost": lost,
    };
    if (this.deliver(s, record)) {
      s.unreported -= lost;
      this.warnLoss(s.sink.name, lost);
    }
  }

  /**
   * A human-readable warning, given when a loss is reported: at that point
   * the sink works again, so a warning about a stuck stderr isn't itself
   * dropped. Rate-limited, and only ever enqueued.
   */
  private warnLoss(sink: string, lost: number): void {
    const now = Date.now();
    if (now - this.lastLossWarning < LOSS_WARNING_INTERVAL_MS) return;
    this.lastLossWarning = now;
    this.log(`audit: ${lost} events were lost on the ${sink} sink (${this.lost.events} in total); see the audit.loss events`);
  }
}

/** The process-wide audit log. */
export const audit = new Audit();

/**
 * A synchronous stderr line, only for startup errors before the queue exists
 * (the process exits right after). Everything else goes through audit.log().
 */
export function logSync(message: string): void {
  try {
    fs.writeSync(2, `${message}\n`);
  } catch {
    // Nothing more can be done if stderr itself is gone.
  }
}
