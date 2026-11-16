#!/usr/bin/env node

import * as fs from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { audit, JsonlSink, logSync, withAuditContext, type AuditSink } from "./audit/audit.js";
import { startOtlpSink, type OtlpSink } from "./audit/otlp.js";
import { FdWriter } from "./audit/writer.js";
import { loadConfig, type AuditConfig, type ServerConfig } from "./config.js";
import { connection } from "./connection.js";
import { connectServer, createServer, SERVER_VERSION } from "./server.js";

// Fail closed on invalid configuration: exit non-zero instead of starting
// with a security setting silently ignored. These are the only synchronous
// stderr writes; everything after goes through the non-blocking queue.
let config: ServerConfig;
try {
  config = loadConfig();
} catch (err) {
  logSync(`Configuration error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

// One writer for everything on stderr, so nothing can block on a full pipe
// and nothing interleaves with an audit event.
const stderr = new FdWriter(2);
const sinks: AuditSink[] = [];
if (config.audit.sink === "stderr") {
  sinks.push(new JsonlSink("stderr", config.audit.level, stderr));
} else if (config.audit.sink === "file") {
  let fd: number;
  try {
    fd = fs.openSync(config.audit.path, "a", 0o600);
  } catch (err) {
    logSync(
      `Configuration error: can't open the audit log ${config.audit.path}: ` +
        (err instanceof Error ? err.message : String(err))
    );
    process.exit(1);
  }
  sinks.push(new JsonlSink("file", "full", new FdWriter(fd)));
}
audit.configure({ service: { name: "siglent-sds-mcp", version: SERVER_VERSION }, sinks, stderr });

// The OTLP export, loaded only when an endpoint is configured.
let otlp: OtlpSink | undefined;
if (config.otlp) {
  try {
    otlp = await startOtlpSink({
      service: { name: "siglent-sds-mcp", version: SERVER_VERSION, instanceId: audit.instanceId },
      log: (message) => audit.log(message),
    });
    audit.addSink(otlp);
  } catch (err) {
    logSync(`Configuration error: can't start the OTLP export: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

// Prevent uncaught errors from killing the MCP server process
process.on("uncaughtException", (err) => {
  audit.log(`Uncaught exception: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
});
process.on("unhandledRejection", (reason) => {
  audit.log(`Unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
});
// Node's default printer for process warnings writes to stderr synchronously.
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  audit.log(`${warning.name}: ${warning.message}`);
});

for (const note of config.notes) {
  audit.log(note);
}
audit.serverStart({
  rawScpiEnabled: config.rawScpiEnabled,
  allowedHosts: config.hostPolicy.allowedHosts,
  allowedPorts: config.hostPolicy.allowedPorts,
  audit: describeAudit(config.audit) + (config.otlp ? ` otlp:${config.otlp.endpoint}` : ""),
});
const server = createServer(config);

// An unreachable collector is a runtime failure, so it doesn't stop the
// server, but nobody should believe they have an off-machine trail when they
// don't: server.start is exported right away, and a failure is reported.
if (otlp && config.otlp) {
  const sink = otlp;
  const endpoint = config.otlp.endpoint;
  void sink.flush(10_000).then(() => {
    if (sink.delivered === 0) {
      const why = sink.status.lastError
        ? sink.status.lastError
        : sink.status.rejected > 0
          ? "the collector rejected every record"
          : "no answer within 10 s";
      audit.log(
        `audit: the OTLP export to ${endpoint} isn't working (${why}); ` +
          "records are counted as lost until it does."
      );
    }
  });
}

function describeAudit(a: AuditConfig): string {
  if (a.sink === "off") return "off";
  if (a.sink === "file") return `file:${a.path}`;
  return `stderr:${a.level}`;
}

// Stop on stdin end (the client has gone) or a signal. An open instrument
// socket would otherwise keep the process alive after stdin closes.
let stopping = false;
async function shutdown(reason: "stdin_closed" | "signal"): Promise<void> {
  if (stopping) {
    // A second signal: the first shutdown is stuck. Stop now.
    if (reason === "signal") hardExit();
    return;
  }
  stopping = true;
  connection.disconnect("shutdown", { cause: "shutdown" });
  // Drain first, so server.stop (last, with the final loss count) isn't
  // dropped by a queue that's still full from a stalled stderr.
  await audit.flush(1000);
  let drained: boolean;
  if (otlp) {
    // server.stop goes to the collector first. The local sinks get theirs
    // after that final export, with the OTLP totals it settled, so losses in
    // the final flush are reported too, on sinks that still work.
    const sink = otlp;
    audit.serverStop(reason, {}, (name) => name === sink.name);
    await sink.flush(1000);
    audit.serverStop(
      reason,
      { "otlp.lost": sink.lostTotal + sink.unexported, "otlp.unexported": sink.unexported },
      (name) => name !== sink.name
    );
    drained = await audit.flush(1000);
    const lost = sink.lostTotal + sink.unexported;
    if (lost > 0) {
      audit.log(
        `audit: ${lost} records didn't reach the OTLP collector ` +
          `(${sink.unexported} still unexported at shutdown); they are lost.`
      );
      await audit.flushStderr(500);
    }
  } else {
    audit.serverStop(reason);
    drained = await audit.flush(1000);
  }
  // process.exit joins the libuv thread pool, so it would wait for a write
  // stuck in the kernel (a hung network filesystem, a FIFO nobody reads)
  // without any time limit. What's still queued is lost either way.
  if (!drained && audit.writeInFlight) hardExit();
  process.exit(0);
}

/** Exit without joining the thread pool. */
function hardExit(): void {
  process.kill(process.pid, "SIGKILL");
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await connectServer(server, transport, config);
  process.stdin.on("end", () => void shutdown("stdin_closed"));
  process.on("SIGTERM", () => void shutdown("signal"));
  process.on("SIGINT", () => void shutdown("signal"));
  audit.log("siglent-sds-mcp server running on stdio");

  // Auto-connect if env var is set (fire-and-forget, don't block MCP startup)
  const autoIp = config.defaultHost;
  if (autoIp) {
    // connect() applies the host policy.
    withAuditContext({ cause: "auto-connect" }, () => connection.connect(autoIp, config.defaultPort)).then(
      (idn) => audit.log(`Auto-connected to ${autoIp}: ${idn}`),
      (err) => {
        audit.log(`Auto-connect to ${autoIp} failed: ${err instanceof Error ? err.message : String(err)}`);
        audit.log("Use the 'connect' tool to connect manually.");
      }
    );
  }
}

main().catch((error) => {
  audit.log(`Startup error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
});
