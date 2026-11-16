import * as net from "node:net";
import {
  audit,
  auditContext,
  type AuditContext,
  type DisconnectReason,
  type Guard,
  type ScpiKind,
  type ScpiOutcome,
} from "./audit/audit.js";
import {
  assertBinaryQuery,
  assertIsCommand,
  assertIsQuery,
  ScpiPolicyError,
} from "./security/scpi-guard.js";
import { assertConnectAllowed, type HostPolicy } from "./security/host-policy.js";

const DEFAULT_PORT = 5025;
const DEFAULT_TIMEOUT = 5000;
const BINARY_TIMEOUT = 30000;
// Gap between a command and its *OPC? so they reach the scope as separate
// reads; a write callback alone doesn't stop the receiver coalescing them.
const OPC_GAP_MS = 20;

export interface ConnectionOptions {
  /** Where connect() may go. Enforced here, so every connect path is covered. */
  hostPolicy: HostPolicy;
  /** Host used when reconnecting before any explicit connect (SIGLENT_IP). */
  defaultHost?: string;
  defaultPort: number;
  /** Release the connection after this many ms without traffic (0 = never). */
  idleTimeoutMs: number;
  /** How long a command may take before its *OPC? is considered lost. */
  commandTimeoutMs: number;
}

export const DEFAULT_OPTIONS: ConnectionOptions = {
  // Until configured: private-LAN IP addresses on the standard port only.
  hostPolicy: { allowedHosts: [], allowedPorts: [DEFAULT_PORT] },
  defaultPort: DEFAULT_PORT,
  idleTimeoutMs: 0,
  commandTimeoutMs: DEFAULT_TIMEOUT,
};

/** Channel count from the model name, e.g. SDS1202X-E -> 2, SDS1104X-E -> 4 */
export function channelCountFromModel(model: string): number | undefined {
  const m = /SDS\d{3}(\d)/i.exec(model);
  return m ? parseInt(m[1], 10) : undefined;
}

/**
 * *OPC? answers "1" (or "*OPC 1" while command headers are still on).
 * Anything else means another reply arrived first, e.g. from a command that
 * produced output; the real "1" is still on its way and would answer the
 * next query.
 */
function opcProblem(cmd: string, reply: Buffer): string | undefined {
  const text = reply.toString("utf-8").trim();
  if (/^(\*OPC\s+)?1$/i.test(text)) return undefined;
  return (
    `Unexpected reply to "${cmd}": ${JSON.stringify(text.slice(0, 80))}. ` +
    "Commands must not produce output (use scpi_query for queries). The connection was reset."
  );
}

interface QueuedQuery {
  cmd: string;
  /** Command written (and flushed) before `cmd`, e.g. a setter paced by *OPC? */
  pre?: string;
  binary: boolean;
  timeout: number;
  /** Captured at enqueue: the drain runs later, often from another call's socket callback. */
  ctx: AuditContext;
  /** Write ids, allocated at enqueue: each gets exactly one scpi.result. */
  preId?: number;
  cmdId: number;
  /** `pre`'s result is recorded (written, or write_failed). */
  preDone: boolean;
  cmdWritten: boolean;
  startedAt?: number;
  /**
   * Checks the reply before anything else is sent. Returns an error message
   * if the reply is out of step; the connection is then reset and queued
   * work is rejected without reaching the scope.
   */
  validate?: (reply: Buffer) => string | undefined;
  resolve: (value: Buffer) => void;
  reject: (reason: Error) => void;
}

/** An error that carries the scpi.result outcome it stands for. */
function outcomeError(message: string, outcome: ScpiOutcome): Error {
  return Object.assign(new Error(message), { auditOutcome: outcome });
}

function guardOf(rule: string): Guard {
  const prefix = rule.split(".")[0];
  return prefix === "wire" || prefix === "host" || prefix === "command" || prefix === "binary" ? prefix : "query";
}

/**
 * Audit contexts: the ambient context (auditContext()) is read only at the
 * synchronous start of the public methods tools call (connect, disconnect,
 * sendCommand, query, queryBinary, checkChannel). Everything that runs later
 * (the queue drain, timers, socket and write callbacks, reconnects) uses a
 * context captured earlier or a synthetic one (docs/audit-log-design.md).
 */
export class SiglentConnection {
  private options: ConnectionOptions;
  private socket: net.Socket | null = null;
  private host = "";
  private port = DEFAULT_PORT;
  private dataBuffer = Buffer.alloc(0);
  private responseResolve: ((value: Buffer) => void) | null = null;
  private responseReject: ((reason: Error) => void) | null = null;
  private responseTimer: ReturnType<typeof setTimeout> | null = null;
  private expectedBinaryLength: number | null = null;
  private binaryDataStart: number = 0;
  private headerParsed = false;
  private queryQueue: QueuedQuery[] = [];
  private queryRunning = false;
  private model = "";
  private connecting: Promise<string> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  // Set by an explicit disconnect() so we don't silently reconnect afterwards
  private autoConnectSuppressed = false;
  /**
   * Incremented on every connect attempt. An attempt superseded by a newer one
   * (e.g. the startup auto-connect still initializing when the `connect` tool
   * is called) must not install its socket or tear down the newer one.
   */
  private connectGeneration = 0;
  /** The last socket error, for the reason recorded when the socket closes. */
  private lastSocketError: string | null = null;

  constructor(options: Partial<ConnectionOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /** Apply the server configuration (host policy, defaults, timeouts). */
  configure(options: Partial<ConnectionOptions>): void {
    this.options = { ...this.options, ...options };
  }

  async connect(host: string, port: number = this.options.defaultPort): Promise<string> {
    return this.connectIn(host, port, auditContext());
  }

  private async connectIn(host: string, port: number, ctx: AuditContext): Promise<string> {
    // Every connect path (tool, auto-connect, reconnect) passes through here.
    try {
      assertConnectAllowed(host, port, this.options.hostPolicy);
    } catch (err) {
      if (err instanceof ScpiPolicyError) {
        audit.guardRefused({ guard: "host", rule: err.rule, message: err.message, host, port }, ctx);
        audit.instrumentConnect({ host, port, outcome: "refused_by_policy", message: err.message }, ctx);
      }
      throw err;
    }

    // Track the attempt so tool calls made meanwhile wait for it (and get its
    // error) instead of queueing on a socket that may not initialize.
    const generation = this.connectGeneration + 1;
    const attempt = this.openConnection(host, port, ctx).then(
      (idn) => {
        audit.instrumentConnect({ host, port, outcome: "connected", idn }, ctx);
        return idn;
      },
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        const outcome = generation !== this.connectGeneration ? "superseded" : "failed";
        audit.instrumentConnect({ host, port, outcome, message }, ctx);
        throw err;
      }
    );
    this.connecting = attempt;
    try {
      return await attempt;
    } finally {
      if (this.connecting === attempt) {
        this.connecting = null;
        // The idle timer is held off during the handshake (see
        // scheduleIdleClose); arm it now that the connection is up.
        this.scheduleIdleClose();
      }
    }
  }

  private async openConnection(host: string, port: number, ctx: AuditContext): Promise<string> {
    const generation = ++this.connectGeneration;
    const superseded = () => generation !== this.connectGeneration;

    if (this.socket) {
      this.close("Connection closed", "replaced", ctx);
    }

    this.host = host;
    this.port = port;
    this.autoConnectSuppressed = false;

    return new Promise((resolve, reject) => {
      const socket = new net.Socket();

      const connectTimeout = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Connection timeout to ${host}:${port}`));
      }, 5000);

      socket.on("connect", async () => {
        clearTimeout(connectTimeout);
        if (superseded()) {
          // The scope serves one client at a time: don't hold it open.
          socket.destroy();
          reject(new Error("Connection attempt superseded by a newer connect."));
          return;
        }
        // Remove the connect-phase error handler before installing runtime handlers
        socket.removeAllListeners("error");
        this.socket = socket;
        this.setupSocketListeners();

        try {
          // Drain the welcome banner the scope sends on TCP connect
          await this.delay(200);
          if (superseded()) throw new Error("superseded by a newer connect");
          this.dataBuffer = Buffer.alloc(0);

          // Set CHDR OFF for clean numeric responses
          await this.enqueueQuery("*OPC?", false, DEFAULT_TIMEOUT, ctx, "CHDR OFF", (r) =>
            opcProblem("CHDR OFF", r)
          );
          await this.delay(100);
          if (superseded()) throw new Error("superseded by a newer connect");

          // Query identification
          const idn = (await this.enqueueQuery("*IDN?", false, DEFAULT_TIMEOUT, ctx))
            .toString("utf-8")
            .trim();
          if (superseded()) throw new Error("superseded by a newer connect");
          this.model = idn.split(",")[1]?.trim() ?? "";
          resolve(idn);
        } catch (err) {
          // Only the current attempt may tear down the shared connection;
          // a superseded one would otherwise kill the newer socket.
          if (!superseded()) this.close("Connection closed", "init_failed", ctx);
          const msg = err instanceof Error ? err.message : String(err);
          reject(
            new Error(
              /timeout/i.test(msg)
                ? `${host}:${port} accepted the connection but did not respond. ` +
                  `The scope serves one client at a time, so it is probably in ` +
                  `use by another program (another MCP server, EasyScopeX, ...). ` +
                  `Close that connection and try again.`
                : `Connected but failed to initialize: ${msg}`
            )
          );
        }
      });

      socket.on("error", (err) => {
        clearTimeout(connectTimeout);
        reject(new Error(`Connection failed: ${err.message}`));
      });

      socket.connect(port, host);
    });
  }

  /** Close the connection and don't auto-reconnect until connect() is called */
  disconnect(why: DisconnectReason = "requested", ctx: AuditContext = auditContext()): void {
    this.autoConnectSuppressed = true;
    this.close("Connection closed", why, ctx);
  }

  /** Close the connection: `reason` for queued work, `why` and `ctx` for the audit log. */
  private close(reason: string, why: DisconnectReason, ctx: AuditContext): void {
    if (this.socket) {
      audit.instrumentDisconnect({ host: this.host, port: this.port, reason: why }, ctx);
    }
    this.clearIdleTimer();
    const pending = this.queryQueue.splice(0);
    this.queryRunning = false;
    if (this.responseReject) {
      this.responseReject(new Error(reason));
    }
    this.clearPending();
    for (const q of pending) {
      q.reject(new Error(reason));
    }
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
    this.dataBuffer = Buffer.alloc(0);
  }

  isConnected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  /** Model name from *IDN?, e.g. "SDS1202X-E" (empty until connected) */
  getModel(): string {
    return this.model;
  }

  /**
   * Throw if `channel` (e.g. "C3") doesn't exist on the connected model.
   * A 2-channel scope answers C3/C4 queries with placeholder values rather
   * than an error, so without this check tools return plausible junk.
   */
  async checkChannel(channel: string): Promise<void> {
    await this.ensureReady(auditContext());
    const count = channelCountFromModel(this.model);
    const n = /^C(\d)$/.exec(channel);
    if (count !== undefined && n && parseInt(n[1], 10) > count) {
      throw new Error(
        `${channel} does not exist on the ${this.model} (${count} channels: C1-C${count})`
      );
    }
  }

  getConnectionInfo(): string {
    if (!this.isConnected()) return "Not connected";
    return `${this.host}:${this.port}`;
  }

  async sendCommand(cmd: string): Promise<void> {
    const ctx = auditContext();
    // The connection is the single choke point to the instrument, so this
    // check applies regardless of which tool built the command.
    this.guard(() => assertIsCommand(cmd), cmd, ctx);
    await this.ensureReady(ctx);
    // The scope silently drops commands that arrive while it is still applying
    // the previous one (e.g. a VDIV change takes ~250ms on SDS1202X-E fw 1.3.27).
    // Follow each command with *OPC? and wait for its reply so commands are
    // paced by the scope itself. Going through the query queue also keeps the
    // pair from interleaving with concurrent queries.
    // The two must be separate writes: if "*OPC?" arrives in the same packet
    // the scope mis-parses the command's numeric argument and clamps it
    // (e.g. "TDIV 50US" becomes 1ns).
    await this.enqueueQuery("*OPC?", false, this.options.commandTimeoutMs, ctx, cmd, (r) =>
      opcProblem(cmd, r)
    );
  }

  async query(cmd: string, timeout: number = DEFAULT_TIMEOUT): Promise<string> {
    // A query must be structurally a query; otherwise "C1:VDIV 5V" sent via a
    // read-only tool would change state and simply time out waiting for a reply.
    const ctx = auditContext();
    this.guard(() => assertIsQuery(cmd), cmd, ctx);
    await this.ensureReady(ctx);
    const buf = await this.enqueueQuery(cmd, false, timeout, ctx);
    return buf.toString("utf-8").trim();
  }

  async queryBinary(cmd: string, timeout: number = BINARY_TIMEOUT): Promise<Buffer> {
    const ctx = auditContext();
    this.guard(() => assertBinaryQuery(cmd), cmd, ctx);
    await this.ensureReady(ctx);
    return this.enqueueQuery(cmd, true, timeout, ctx);
  }

  /** Run a guard check, recording a refusal before it propagates. */
  private guard(check: () => void, cmd: string, ctx: AuditContext): void {
    try {
      check();
    } catch (err) {
      if (err instanceof ScpiPolicyError) {
        audit.guardRefused({ guard: guardOf(err.rule), rule: err.rule, message: err.message, command: cmd }, ctx);
      }
      throw err;
    }
  }

  private enqueueQuery(
    cmd: string,
    binary: boolean,
    timeout: number,
    ctx: AuditContext,
    pre?: string,
    validate?: (reply: Buffer) => string | undefined
  ): Promise<Buffer> {
    this.clearIdleTimer();
    const preId = pre !== undefined ? audit.nextWriteId() : undefined;
    const cmdId = audit.nextWriteId();
    const result = new Promise<Buffer>((resolve, reject) => {
      // A query settles once: a late callback must not record a second result.
      let settled = false;
      const finishPre = () => {
        if (q.preId !== undefined && !q.preDone) {
          q.preDone = true;
          audit.scpiResult({ writeId: q.preId, outcome: "not_written" }, ctx);
        }
      };
      const q: QueuedQuery = {
        cmd,
        pre,
        binary,
        timeout,
        validate,
        ctx,
        preId,
        cmdId,
        preDone: false,
        cmdWritten: false,
        resolve: (buf) => {
          if (settled) return;
          settled = true;
          finishPre();
          audit.scpiResult({ writeId: cmdId, outcome: "replied", startedAt: q.startedAt, reply: buf, binary }, ctx);
          resolve(buf);
        },
        reject: (err) => {
          if (settled) return;
          settled = true;
          finishPre();
          const tagged = (err as { auditOutcome?: ScpiOutcome }).auditOutcome;
          // A timeout during a setter's *OPC? gap: the *OPC? was never written.
          const outcome =
            tagged === "timeout" && !q.cmdWritten
              ? "not_written"
              : (tagged ?? (q.cmdWritten ? "connection_closed" : "not_written"));
          audit.scpiResult({ writeId: cmdId, outcome, startedAt: q.startedAt }, ctx);
          reject(err);
        },
      };
      this.queryQueue.push(q);
      this.drainQueue();
    });
    result.then(
      () => this.scheduleIdleClose(),
      () => this.scheduleIdleClose()
    );
    return result;
  }

  private drainQueue(): void {
    if (this.queryRunning || this.queryQueue.length === 0) return;
    if (!this.socket) {
      const pending = this.queryQueue.splice(0);
      for (const q of pending) q.reject(new Error("Connection closed"));
      return;
    }
    this.queryRunning = true;

    const q = this.queryQueue.shift()!;
    const { cmd, pre, binary, timeout, validate, resolve, reject } = q;

    this.expectedBinaryLength = null;
    this.binaryDataStart = 0;
    this.headerParsed = false;
    this.dataBuffer = Buffer.alloc(0);

    this.responseResolve = (buf) => {
      this.queryRunning = false;
      // Validate before starting the next queued operation: if this reply is
      // out of step, nothing else may reach the scope on this connection.
      const problem = validate?.(buf);
      if (problem) {
        reject(outcomeError(problem, "out_of_step"));
        this.close("Connection reset: an earlier reply was out of step", "reset_out_of_step", {
          requestId: q.ctx.requestId,
          cause: "reset",
        });
        return;
      }
      resolve(buf);
      this.drainQueue();
    };
    const onReject = (err: Error) => {
      this.queryRunning = false;
      reject(err);
      this.drainQueue();
    };
    this.responseReject = onReject;

    this.responseTimer = setTimeout(() => {
      this.clearPending();
      this.queryRunning = false;
      reject(
        outcomeError(
          `${binary ? "Binary query" : "Query"} timeout after ${timeout}ms for command: ${pre ? `${pre} (${cmd})` : cmd}. ` +
            "The connection was reset; the next call reconnects.",
          "timeout"
        )
      );
      // A late reply would otherwise be read as the answer to the next query.
      // Resetting the connection discards it with the old socket.
      this.close("Connection reset after a timeout", "reset_after_timeout", {
        requestId: q.ctx.requestId,
        cause: "reset",
      });
    }, timeout);

    // Both writes go to this socket only. If the connection is reset and a
    // new one opened during the gap below, the delayed *OPC? must not land
    // in the new session.
    const socket = this.socket;
    // Recorded immediately before each write, so an attempt is on record even
    // if the process dies during it. A setter paced by *OPC? is two writes:
    // the setter (kind "command") and the *OPC? (kind "opc").
    const writeLine = (line: string, id: number, kind: ScpiKind, next?: () => void): void => {
      if (line === cmd) q.cmdWritten = true;
      q.startedAt ??= Date.now();
      audit.scpiWrite({ writeId: id, command: line, kind, host: this.host, port: this.port }, q.ctx);
      socket.write(line + "\n", (err) => {
        if (err) {
          // Only while this query is still the current one: a write error that
          // arrives after it ended must not clear the next query's state.
          if (this.responseReject !== onReject) return;
          if (id === q.preId) {
            q.preDone = true;
            audit.scpiResult({ writeId: id, outcome: "write_failed", startedAt: q.startedAt }, q.ctx);
          }
          this.clearPending();
          this.queryRunning = false;
          // The *OPC? after a failed setter was never written.
          reject(outcomeError(`Write failed: ${err.message}`, id === q.preId ? "not_written" : "write_failed"));
          this.drainQueue();
        } else {
          if (id === q.preId) {
            q.preDone = true;
            audit.scpiResult({ writeId: id, outcome: "written", startedAt: q.startedAt }, q.ctx);
          }
          next?.();
        }
      });
    };

    if (pre !== undefined) {
      writeLine(pre, q.preId!, "command", () =>
        setTimeout(() => {
          // Skipped if the connection was reset during the gap: the query has
          // been rejected by then, and its *OPC? is recorded as not_written.
          if (this.socket === socket && !socket.destroyed) writeLine(cmd, q.cmdId, "opc");
        }, OPC_GAP_MS)
      );
    } else {
      writeLine(cmd, q.cmdId, binary ? "binary-query" : "query");
    }
  }

  private setupSocketListeners(): void {
    this.socket!.on("data", (chunk: Buffer) => {
      this.dataBuffer = Buffer.concat([this.dataBuffer, chunk]);
      this.tryResolve();
    });

    this.socket!.on("close", () => {
      // The scope (or the network) closed the socket: no call caused it.
      audit.instrumentDisconnect(
        { host: this.host, port: this.port, reason: this.lastSocketError ? "socket_error" : "socket_closed" },
        { cause: "socket" }
      );
      this.lastSocketError = null;
      // Drain queued queries first so drainQueue() in the reject callback is a no-op
      const pending = this.queryQueue.splice(0);
      this.queryRunning = false;
      if (this.responseReject) {
        this.responseReject(new Error("Connection closed unexpectedly"));
      }
      this.clearPending();
      for (const q of pending) {
        q.reject(new Error("Connection closed unexpectedly"));
      }
      this.socket = null;
    });

    this.socket!.on("error", (err) => {
      this.lastSocketError = err.message;
      // Take the queue first: the reject below would otherwise drain the next
      // query into the dying socket. Queued queries were never written.
      const pending = this.queryQueue.splice(0);
      if (this.responseReject) {
        this.responseReject(new Error(`Socket error: ${err.message}`));
      }
      this.clearPending();
      for (const q of pending) {
        q.reject(new Error(`Socket error: ${err.message}`));
      }
    });
  }

  private tryResolve(): void {
    if (!this.responseResolve) return;

    // Try to detect the binary framing format
    if (!this.headerParsed && this.dataBuffer.length >= 6) {
      // Check for raw BMP: starts with "BM" magic bytes, file size at offset 2-5 (LE)
      if (this.dataBuffer[0] === 0x42 && this.dataBuffer[1] === 0x4d) {
        const bmpSize = this.dataBuffer.readUInt32LE(2);
        if (bmpSize > 0 && bmpSize < 100_000_000) {
          this.expectedBinaryLength = bmpSize;
          this.binaryDataStart = 0;
          this.headerParsed = true;
        }
      }

      // Check for IEEE 488.2 definite length block: #<digitCount><digits><data>
      // e.g. #9000012345 (9-digit length) or #71152054 (7-digit length)
      if (!this.headerParsed) {
        const hashIndex = this.dataBuffer.indexOf(0x23); // '#' character
        if (hashIndex >= 0 && hashIndex + 2 <= this.dataBuffer.length) {
          const digitCount = this.dataBuffer[hashIndex + 1] - 0x30;
          if (digitCount >= 1 && digitCount <= 9) {
            const headerSize = 2 + digitCount;
            if (hashIndex + headerSize <= this.dataBuffer.length) {
              const lengthStr = this.dataBuffer
                .subarray(hashIndex + 2, hashIndex + headerSize)
                .toString("ascii");
              const dataLength = parseInt(lengthStr, 10);
              if (!isNaN(dataLength) && dataLength > 0) {
                this.expectedBinaryLength = dataLength;
                this.binaryDataStart = hashIndex + headerSize;
                this.headerParsed = true;
              }
            }
          }
        }
      }
    }

    if (this.expectedBinaryLength !== null && this.headerParsed) {
      // Binary mode: wait for all expected data (+ trailing bytes for IEEE 488.2)
      const trailingBytes = this.binaryDataStart === 0 ? 1 : 2; // raw: +\n, IEEE: +\n\n
      const totalExpected = this.binaryDataStart + this.expectedBinaryLength + trailingBytes;
      if (this.dataBuffer.length >= totalExpected) {
        const binaryData = this.dataBuffer.subarray(
          this.binaryDataStart,
          this.binaryDataStart + this.expectedBinaryLength
        );
        const resolve = this.responseResolve;
        this.clearPending();
        resolve(Buffer.from(binaryData));
      }
    } else {
      // Text mode: look for newline terminator
      const newlineIndex = this.dataBuffer.indexOf(0x0a); // \n
      if (newlineIndex >= 0) {
        const response = this.dataBuffer.subarray(0, newlineIndex);
        const resolve = this.responseResolve;
        this.clearPending();
        resolve(Buffer.from(response));
      }
    }
  }

  private clearPending(): void {
    if (this.responseTimer) {
      clearTimeout(this.responseTimer);
      this.responseTimer = null;
    }
    this.responseResolve = null;
    this.responseReject = null;
    this.expectedBinaryLength = null;
    this.binaryDataStart = 0;
    this.headerParsed = false;
  }

  /**
   * Make sure there is a live connection, opening one on demand to the last
   * host (or the configured SIGLENT_IP) if it was closed, e.g. by the idle
   * timeout or a reset after a timeout. Goes through connect(), so the host
   * policy applies to reconnects too.
   */
  private async ensureReady(ctx: AuditContext): Promise<void> {
    if (this.connecting) {
      await this.connecting;
      return;
    }
    if (this.isConnected()) return;
    const host = this.host || this.options.defaultHost;
    if (!host || this.autoConnectSuppressed) {
      throw new Error("Not connected to oscilloscope. Use the 'connect' tool first.");
    }
    const port = this.host ? this.port : this.options.defaultPort;
    // The call that needed the connection caused the reconnect.
    await this.connectIn(host, port, { requestId: ctx.requestId, cause: "reconnect" });
  }

  private scheduleIdleClose(): void {
    const ms = this.options.idleTimeoutMs;
    // Not during a connect: the handshake pauses between its own queries, and
    // a short idle timeout would otherwise close the socket mid-handshake.
    if (!ms || this.connecting || !this.isConnected()) return;
    if (this.queryRunning || this.queryQueue.length > 0) return;
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.queryRunning && this.queryQueue.length === 0) {
        audit.log(`Idle for ${ms / 1000}s, releasing the scope connection`);
        // No call caused this; the timer was scheduled from the last query's completion.
        this.close("Connection closed", "idle", { cause: "idle-close" });
      }
    }, ms);
    // Don't keep the process alive just for this timer
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Singleton instance
export const connection = new SiglentConnection();
