/**
 * The OTLP export in a real server process (build/index.js), against a local
 * HTTP server standing in for an OpenTelemetry collector.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import http from "node:http";
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { SdsSimulator } from "../simulator/sds-simulator.js";

const SERVER = join(__dirname, "../../build/index.js");
let sim: SdsSimulator;
let simPort: number;

/** A record as the collector received it, attributes flattened. */
interface Received {
  eventName: string;
  severity: string;
  body: string;
  attributes: Record<string, unknown>;
  resource: Record<string, unknown>;
}

function value(v: Record<string, unknown>): unknown {
  return v.stringValue ?? v.boolValue ?? (v.intValue !== undefined ? Number(v.intValue) : v.doubleValue);
}

/** A collector: answers 200, or the status set in `fail`. */
async function collector() {
  const records: Received[] = [];
  const headers: string[] = [];
  const state = { fail: 0, failBody: "{}", rejected: 0, rejectAll: false };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      headers.push(String(req.headers["authorization"] ?? ""));
      if (state.fail) {
        res.writeHead(state.fail).end(state.failBody);
        return;
      }
      const msg = JSON.parse(body) as {
        resourceLogs: Array<{
          resource: { attributes: Array<{ key: string; value: Record<string, unknown> }> };
          scopeLogs: Array<{ logRecords: Array<Record<string, unknown>> }>;
        }>;
      };
      for (const rl of msg.resourceLogs) {
        const resource = Object.fromEntries(rl.resource.attributes.map((a) => [a.key, value(a.value)]));
        for (const sl of rl.scopeLogs) {
          for (const lr of sl.logRecords) {
            records.push({
              eventName: String(lr.eventName),
              severity: String(lr.severityText),
              body: String((lr.body as { stringValue?: string }).stringValue),
              attributes: Object.fromEntries(
                (lr.attributes as Array<{ key: string; value: Record<string, unknown> }>).map((a) => [a.key, value(a.value)])
              ),
              resource,
            });
          }
        }
      }
      const inRequest = msg.resourceLogs.reduce(
        (n, rl) => n + rl.scopeLogs.reduce((m, sl) => m + sl.logRecords.length, 0),
        0
      );
      const rejected = state.rejectAll ? inRequest : state.rejected;
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(rejected ? JSON.stringify({ partialSuccess: { rejectedLogRecords: rejected } }) : "{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { records, headers, state, url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

function start(env: Record<string, string>) {
  const child = spawn(process.execPath, [SERVER], {
    env: {
      PATH: process.env.PATH ?? "",
      SIGLENT_IP: "127.0.0.1",
      SIGLENT_PORT: String(simPort),
      SIGLENT_AUDIT_OTLP: "1",
      ...env,
    },
  }) as ChildProcessWithoutNullStreams;
  const replies = new Map<number, Record<string, unknown>>();
  let buf = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buf.slice(0, i)) as { id?: number };
      buf = buf.slice(i + 1);
      if (typeof msg.id === "number") replies.set(msg.id, msg);
    }
  });
  let stderr = "";
  child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
  const closed = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
  let nextId = 1;
  const request = async (method: string, params: Record<string, unknown> = {}) => {
    const id = nextId++;
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    for (let t = 0; t < 1000 && !replies.has(id); t++) await new Promise((r) => setTimeout(r, 5));
    if (!replies.has(id)) throw new Error(`no reply to ${method}`);
    return replies.get(id)!;
  };
  return {
    stderr: () => stderr,
    closed,
    init: () => request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "otlp-test", version: "1" } }),
    call: (name: string, args: Record<string, unknown> = {}) => request("tools/call", { name, arguments: args }),
    stop: () => child.stdin.end(),
  };
}

async function until(cond: () => boolean, ms = 10_000) {
  for (let t = 0; t < ms / 25 && !cond(); t++) await new Promise((r) => setTimeout(r, 25));
  expect(cond()).toBe(true);
}

beforeAll(async () => {
  if (!existsSync(SERVER)) throw new Error("build/index.js is missing: run `npm run build` first.");
  sim = new SdsSimulator();
  simPort = await sim.start();
});
afterAll(async () => {
  await sim.stop();
});

describe("OTLP export", () => {
  it("exports the full trail as log records, flushes on shutdown, and keeps the key out of the log", async () => {
    const col = await collector();
    try {
      const s = start({
        OTEL_EXPORTER_OTLP_ENDPOINT: col.url,
        OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer s3cret-token",
      });
      await s.init();
      await until(() => s.stderr().includes('"event.name":"instrument.connect"'));
      await s.call("scpi_query", { command: "C1:VDIV 1V" });
      await s.call("get_channel", { channel: "C1" });
      s.stop();
      expect(await s.closed).toBe(0);

      const names = col.records.map((r) => r.eventName);
      expect(names[0]).toBe("siglent.audit.server.start");
      expect(names.at(-1)).toBe("siglent.audit.server.stop");
      // The full trail, read-only calls and wire events included.
      expect(names).toEqual(expect.arrayContaining(["siglent.audit.scpi.write", "siglent.audit.guard.refused"]));
      expect(col.records.some((r) => r.attributes["gen_ai.tool.name"] === "get_channel")).toBe(true);

      const refused = col.records.find((r) => r.eventName === "siglent.audit.guard.refused")!;
      expect(refused.severity).toBe("WARN");
      expect(refused.body).toBe("guard.refused: query.not_a_query");
      expect(refused.attributes).toMatchObject({ rule: "query.not_a_query", "scpi.command": "C1:VDIV 1V", "audit.sink": "otlp" });
      expect(refused.resource).toMatchObject({ "service.name": "siglent-sds-mcp", "service.version": "2.1.0" });

      // Gapless numbering of the otlp sink's own records.
      const seqs = col.records.map((r) => Number(r.attributes["audit.seq"]));
      expect(seqs).toEqual(seqs.map((_, i) => i + 1));

      // The key reaches the collector as a header, and nothing else.
      expect(col.headers.every((h) => h === "Bearer s3cret-token")).toBe(true);
      expect(JSON.stringify(col.records)).not.toContain("s3cret");
      expect(s.stderr()).not.toContain("s3cret");
    } finally {
      await col.close();
    }
  }, 60_000);

  it("exports only, with SIGLENT_AUDIT_LOG=off", async () => {
    const col = await collector();
    try {
      const s = start({ OTEL_EXPORTER_OTLP_ENDPOINT: col.url, SIGLENT_AUDIT_LOG: "off" });
      await s.init();
      await s.call("scpi_query", { command: "C1:VDIV 1V" });
      s.stop();
      expect(await s.closed).toBe(0);
      expect(s.stderr()).not.toContain('"event.name"');
      expect(col.records.some((r) => r.eventName === "siglent.audit.guard.refused")).toBe(true);
    } finally {
      await col.close();
    }
  }, 60_000);

  it("warns when the collector rejects the export, counts the losses, and reports them once it works", async () => {
    const col = await collector();
    col.state.fail = 400; // not retryable: each export fails at once
    try {
      const s = start({ OTEL_EXPORTER_OTLP_ENDPOINT: col.url, SIGLENT_AUDIT_LOG: "off" });
      await s.init();
      await until(() => s.stderr().includes("the OTLP export to"));
      expect(s.stderr()).toMatch(/isn't working.*records are counted as lost/);
      // Tool calls carry on while the export fails.
      const r = (await s.call("scpi_query", { command: "*IDN?" })) as { result?: { isError?: boolean } };
      expect(r.result?.isError).toBeFalsy();
      await new Promise((res) => setTimeout(res, 1500)); // let the failing export run

      col.state.fail = 0;
      await s.call("scpi_query", { command: "*IDN?" });
      s.stop();
      expect(await s.closed).toBe(0);
      const loss = col.records.find((x) => x.eventName === "siglent.audit.audit.loss");
      expect(Number(loss?.attributes["audit.lost"])).toBeGreaterThan(0);
      expect(s.stderr()).toMatch(/audit: \d+ events were lost on the otlp sink/);
      // The records missing from the otlp sink's numbering are exactly the
      // losses it counted (server.stop carries the total; a loss can be
      // reported over several audit.loss records).
      const seqs = col.records.map((x) => Number(x.attributes["audit.seq"]));
      const missing = Math.max(...seqs) - new Set(seqs).size;
      const stop = col.records.find((x) => x.eventName === "siglent.audit.server.stop");
      expect(missing).toBe(Number(stop?.attributes["audit.lost"]));
      const reported = col.records
        .filter((x) => x.eventName === "siglent.audit.audit.loss")
        .reduce((n, x) => n + Number(x.attributes["audit.lost"]), 0);
      expect(reported).toBeLessThanOrEqual(missing);
    } finally {
      await col.close();
    }
  }, 60_000);

  it("refuses to start with an invalid endpoint", async () => {
    const s = start({ OTEL_EXPORTER_OTLP_ENDPOINT: "not a url" });
    expect(await s.closed).toBe(1);
    expect(s.stderr()).toContain("OTEL_EXPORTER_OTLP_ENDPOINT is not a valid URL");
  });

  it("never logs the key, a stack or a response body when the collector echoes the key in an error", async () => {
    const col = await collector();
    col.state.fail = 401;
    col.state.failBody = "invalid api key secrettoken123 (header was Bearer secrettoken123)";
    try {
      const s = start({
        OTEL_EXPORTER_OTLP_ENDPOINT: col.url,
        OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer%20secrettoken123",
      });
      await s.init();
      for (let i = 0; i < 5; i++) {
        await s.call("scpi_query", { command: "*IDN?" });
        await new Promise((r) => setTimeout(r, 400)); // several failing exports
      }
      s.stop();
      await s.closed;
      const err = s.stderr();
      expect(err).toContain("otlp: export failed: Unauthorized (status 401)");
      expect(err).not.toContain("secrettoken123");
      expect(err).not.toMatch(/invalid api key|"stack"|\n\s+at /);
      // Rate-limited: one line per minute, however many exports fail.
      expect(err.match(/otlp: export failed/g)?.length).toBe(1);
    } finally {
      await col.close();
    }
  }, 60_000);

  it("counts records a collector rejects in a partial-success answer as lost", async () => {
    const col = await collector();
    col.state.rejected = 2;
    try {
      const s = start({ OTEL_EXPORTER_OTLP_ENDPOINT: col.url, SIGLENT_AUDIT_LOG: "off" });
      await s.init();
      await until(() => s.stderr().includes("rejected 2 records"));
      col.state.rejected = 0;
      await s.call("scpi_query", { command: "*IDN?" });
      s.stop();
      expect(await s.closed).toBe(0);
      const reported = col.records
        .filter((x) => x.eventName === "siglent.audit.audit.loss")
        .reduce((n, x) => n + Number(x.attributes["audit.lost"]), 0);
      expect(reported).toBeGreaterThanOrEqual(2);
      expect(reported % 2).toBe(0);
    } finally {
      await col.close();
    }
  }, 60_000);

  it("reports the records it couldn't export before shutdown, on the sinks that still work", async () => {
    const col = await collector();
    const url = col.url;
    await col.close(); // nothing listens there now
    const s = start({ OTEL_EXPORTER_OTLP_ENDPOINT: url, SIGLENT_AUDIT_LOG: "stderr" });
    await s.init();
    for (let i = 0; i < 20; i++) await s.call("scpi_query", { command: "*IDN?" });
    s.stop();
    expect(await s.closed).toBe(0);
    const stop = s
      .stderr()
      .split("\n")
      .filter((l) => l.includes('"event.name":"server.stop"'))
      .map((l) => JSON.parse(l) as Record<string, unknown>)[0];
    expect(Number(stop["otlp.unexported"])).toBeGreaterThan(50);
    expect(Number(stop["otlp.lost"])).toBeGreaterThanOrEqual(Number(stop["otlp.unexported"]));
    expect(s.stderr()).toMatch(/audit: \d+ records didn't reach the OTLP collector \(\d+ still unexported at shutdown\)/);
  }, 60_000);

  it("doesn't export with OTEL_LOGS_EXPORTER=none", async () => {
    const col = await collector();
    try {
      const s = start({ OTEL_EXPORTER_OTLP_ENDPOINT: col.url, OTEL_LOGS_EXPORTER: "none" });
      await s.init();
      s.stop();
      await s.closed;
      expect(col.records).toEqual([]);
    } finally {
      await col.close();
    }
  }, 60_000);

  it("keeps its own service.instance.id, so OTLP records join the local ones", async () => {
    const col = await collector();
    try {
      const s = start({
        OTEL_EXPORTER_OTLP_ENDPOINT: col.url,
        OTEL_RESOURCE_ATTRIBUTES: "service.instance.id=fixed,deployment.environment=bench",
        OTEL_SERVICE_NAME: "bench-sds",
      });
      await s.init();
      s.stop();
      await s.closed;
      const local = JSON.parse(s.stderr().split("\n").find((l) => l.includes('"server.start"'))!) as Record<string, unknown>;
      expect(col.records[0].resource).toMatchObject({
        "service.instance.id": local["service.instance.id"],
        "service.name": "bench-sds",
        "deployment.environment": "bench",
      });
    } finally {
      await col.close();
    }
  }, 60_000);

  it("warns at startup when the collector rejects every record", async () => {
    const col = await collector();
    col.state.rejectAll = true; // a partial-success answer rejecting the whole request
    try {
      const s = start({ OTEL_EXPORTER_OTLP_ENDPOINT: col.url, SIGLENT_AUDIT_LOG: "off" });
      await s.init();
      await until(() => s.stderr().includes("the OTLP export to"), 15_000);
      expect(s.stderr()).toMatch(/isn't working \(the collector rejected every record\)/);
      s.stop();
      await s.closed;
    } finally {
      await col.close();
    }
  }, 60_000);

  it("doesn't export on an inherited generic endpoint without the opt-in", async () => {
    const col = await collector();
    try {
      const s = start({ OTEL_EXPORTER_OTLP_ENDPOINT: col.url, SIGLENT_AUDIT_OTLP: "" });
      await s.init();
      await s.call("scpi_query", { command: "C1:VDIV 1V" });
      s.stop();
      await s.closed;
      expect(col.records).toEqual([]);
      expect(s.stderr()).toMatch(/isn't exported: set SIGLENT_AUDIT_OTLP=1/);
    } finally {
      await col.close();
    }
  }, 60_000);

  it("exports with the logs-specific endpoint alone", async () => {
    const col = await collector();
    try {
      const s = start({ OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${col.url}/v1/logs`, SIGLENT_AUDIT_OTLP: "" });
      await s.init();
      s.stop();
      await s.closed;
      expect(col.records.map((r) => r.eventName)).toContain("siglent.audit.server.stop");
    } finally {
      await col.close();
    }
  }, 60_000);

  it("reports on the local sinks what failed in the final export, even with nothing left unexported", async () => {
    const col = await collector();
    col.state.fail = 400; // fails at once: nothing stays unexported, everything is lost
    try {
      const s = start({ OTEL_EXPORTER_OTLP_ENDPOINT: col.url, SIGLENT_AUDIT_LOG: "stderr" });
      await s.init();
      await s.call("scpi_query", { command: "*IDN?" });
      s.stop();
      expect(await s.closed).toBe(0);
      const records = s
        .stderr()
        .split("\n")
        .filter((l) => l.startsWith("{"))
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      const stop = records.at(-1)!;
      expect(stop["event.name"]).toBe("server.stop"); // still the last record
      expect(Number(stop["otlp.unexported"])).toBe(0);
      // Every record sent to the collector, server.stop's own OTLP copy included.
      expect(Number(stop["otlp.lost"])).toBeGreaterThan(5);
      expect(s.stderr()).toMatch(/records didn't reach the OTLP collector \(0 still unexported/);
    } finally {
      await col.close();
    }
  }, 60_000);

  it("reports again the losses an audit.loss record carried when that record's export fails", async () => {
    const col = await collector();
    col.state.fail = 400;
    try {
      const s = start({ OTEL_EXPORTER_OTLP_ENDPOINT: col.url, SIGLENT_AUDIT_LOG: "off" });
      await s.init();
      // Several failing batches with records between them: the second batch
      // carries an audit.loss for the first, and fails too.
      for (let i = 0; i < 3; i++) {
        await s.call("scpi_query", { command: "*IDN?" });
        await new Promise((r) => setTimeout(r, 1300));
      }
      col.state.fail = 0;
      await s.call("scpi_query", { command: "*IDN?" });
      await new Promise((r) => setTimeout(r, 1300)); // exported, server still running
      s.stop();
      expect(await s.closed).toBe(0);
      const seqs = col.records.map((x) => Number(x.attributes["audit.seq"]));
      const missing = Math.max(...seqs) - new Set(seqs).size;
      const reported = col.records
        .filter((x) => x.eventName === "siglent.audit.audit.loss")
        .reduce((n, x) => n + Number(x.attributes["audit.lost"]), 0);
      expect(missing).toBeGreaterThan(0);
      expect(reported).toBe(missing);
    } finally {
      await col.close();
    }
  }, 60_000);
});
