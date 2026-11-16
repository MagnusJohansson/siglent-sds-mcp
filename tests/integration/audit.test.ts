/**
 * Audit log: what's recorded, attributed to which request, at which level.
 * Runs the real MCP server (with the transport hooks) against the simulator.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SdsSimulator, SIM_IDN } from "../simulator/sds-simulator.js";
import { callTool, captureAudit, createTestServer, getText, MemorySink } from "../helpers.js";
import { audit, withAuditContext, type AuditRecord, type AuditSink } from "../../src/audit/audit.js";
import { connection } from "../../src/connection.js";
import { POLICY_RULES } from "../../src/security/scpi-guard.js";

let sim: SdsSimulator;
let simPort: number;
const full = new MemorySink("full", "full");
const security = new MemorySink("security", "security");

beforeAll(async () => {
  sim = new SdsSimulator();
  simPort = await sim.start();
});
afterAll(async () => {
  audit.reset();
  await sim.stop();
});

function simEnv(extra: Record<string, string> = {}): Record<string, string> {
  return { SIGLENT_IP: "127.0.0.1", SIGLENT_PORT: String(simPort), ...extra };
}

/** The request id the server saw for the call whose arguments contain `marker`. */
function requestIdFor(sink: MemorySink, marker: string): string {
  const req = sink
    .events("mcp.request")
    .find((r) => String(r["gen_ai.tool.call.arguments"] ?? "").includes(marker));
  expect(req, `an mcp.request containing ${marker}`).toBeDefined();
  return String(req!["jsonrpc.request.id"]);
}

function writesOf(sink: MemorySink, command: string): AuditRecord[] {
  return sink.events("scpi.write").filter((r) => r["scpi.command"] === command);
}

function resultOf(sink: MemorySink, writeId: unknown): AuditRecord[] {
  return sink.events("scpi.result").filter((r) => r["scpi.write_id"] === writeId);
}

/** Every write id has exactly one result, and every write has a result. */
function expectOneResultPerWrite(sink: MemorySink): void {
  const results = sink.events("scpi.result").map((r) => r["scpi.write_id"]);
  expect(new Set(results).size).toBe(results.length);
  for (const w of sink.events("scpi.write")) expect(results).toContain(w["scpi.write_id"]);
}

async function connectedServer(extra: Record<string, string> = {}) {
  full.clear();
  security.clear();
  captureAudit(full, security);
  const ctx = await createTestServer(simEnv(extra));
  expect(getText(await callTool(ctx.client, "connect"))).toContain(SIM_IDN);
  // Each test sees only its own events.
  full.clear();
  security.clear();
  sim.clear();
  sim.resetState();
  sim.silent.clear();
  sim.resetOn.clear();
  sim.opcDelayMs = 0;
  return ctx;
}

describe("audit log", () => {
  let ctx: Awaited<ReturnType<typeof createTestServer>>;

  beforeEach(async () => {
    ctx = await connectedServer();
  });
  afterEach(async () => {
    connection.disconnect();
    await ctx.cleanup();
  });

  it("records a state-changing tool call at the security level, a read-only one only in the full trail", async () => {
    await callTool(ctx.client, "configure_channel", { channel: "C1", vdiv: "500mV" });
    await callTool(ctx.client, "get_channel", { channel: "C1" });

    const tools = (s: MemorySink) => s.events("mcp.request").map((r) => r["gen_ai.tool.name"]);
    expect(tools(security)).toContain("configure_channel");
    expect(tools(security)).not.toContain("get_channel");
    expect(tools(full)).toEqual(expect.arrayContaining(["configure_channel", "get_channel"]));
    expect(security.events("scpi.write")).toEqual([]);
  });

  it("records a setter as a command write and its *OPC? as an opc write, both on the call's request id", async () => {
    await callTool(ctx.client, "configure_channel", { channel: "C1", vdiv: "500mV" });
    const id = requestIdFor(full, "500mV");
    const setter = full.events("scpi.write").find((r) => String(r["scpi.command"]).startsWith("C1:VDIV"))!;
    expect(setter).toMatchObject({ "scpi.kind": "command", "jsonrpc.request.id": id });
    expect(resultOf(full, setter["scpi.write_id"])).toEqual([expect.objectContaining({ outcome: "written" })]);
    const opc = full.events("scpi.write").find((r) => r["scpi.kind"] === "opc")!;
    expect(opc).toMatchObject({ "scpi.command": "*OPC?", "jsonrpc.request.id": id });
    expect(resultOf(full, opc["scpi.write_id"])).toEqual([expect.objectContaining({ outcome: "replied", "reply.text": "1" })]);
    expectOneResultPerWrite(full);
  });

  it("records a guard refusal with its rule and request id, and no write", async () => {
    await callTool(ctx.client, "scpi_query", { command: "C1:VDIV 1V" });
    const id = requestIdFor(full, "C1:VDIV 1V");
    expect(security.events("guard.refused")).toEqual([
      expect.objectContaining({ guard: "query", rule: "query.not_a_query", "scpi.command": "C1:VDIV 1V", "jsonrpc.request.id": id }),
    ]);
    expect(writesOf(full, "C1:VDIV 1V")).toEqual([]);
  });

  it("records a schema refusal (an injection attempt in a tool argument) at the security level", async () => {
    await callTool(ctx.client, "configure_channel", { channel: "C1", vdiv: "1V\nTDIV 2MS" });
    expect(security.events("guard.refused")).toEqual([
      expect.objectContaining({ guard: "schema", rule: "schema.invalid" }),
    ]);
    expect(full.events("scpi.write")).toEqual([]);
  });

  it("doesn't take tool error text that mentions the SDK's schema error for a schema refusal", async () => {
    await callTool(ctx.client, "scpi_query", { command: "Input validation error" });
    expect(security.events("guard.refused").map((r) => r["rule"])).toEqual(["query.not_a_query"]);
  });

  it("records a call to the disabled scpi_command as a refusal, its request beside it", async () => {
    await callTool(ctx.client, "scpi_command", { command: "*RST" });
    const [refused] = security.events("guard.refused");
    expect(refused).toMatchObject({ guard: "raw-scpi", rule: "raw.disabled", "scpi.command": "*RST" });
    expect(security.events("mcp.request").some((r) => r["jsonrpc.request.id"] === refused["jsonrpc.request.id"])).toBe(true);
  });

  it("attributes each write to its own call when calls run in parallel", async () => {
    await Promise.all(["C1:VDIV?", "C2:VDIV?", "TDIV?"].map((command) => callTool(ctx.client, "scpi_query", { command })));
    for (const cmd of ["C1:VDIV?", "C2:VDIV?", "TDIV?"]) {
      const id = requestIdFor(full, cmd);
      const write = writesOf(full, cmd).at(-1)!;
      expect(write["jsonrpc.request.id"], cmd).toBe(id);
      expect(resultOf(full, write["scpi.write_id"])).toEqual([expect.objectContaining({ outcome: "replied", "jsonrpc.request.id": id })]);
    }
  });

  it("records a timeout, the reset it causes, and the next call's reconnect on that call's id", async () => {
    sim.silent.add("C1:SILENT?");
    await callTool(ctx.client, "scpi_query", { command: "C1:SILENT?", timeout_ms: 600 });
    await callTool(ctx.client, "scpi_query", { command: "TDIV?" });
    const silentId = requestIdFor(full, "C1:SILENT?");
    const nextId = requestIdFor(full, "TDIV?");

    const [silentWrite] = writesOf(full, "C1:SILENT?");
    expect(resultOf(full, silentWrite["scpi.write_id"])).toEqual([expect.objectContaining({ outcome: "timeout" })]);
    expect(security.events("instrument.disconnect")).toEqual([
      expect.objectContaining({ reason: "reset_after_timeout", cause: "reset", "jsonrpc.request.id": silentId }),
    ]);
    // The reconnect is caused by, and attributed to, the call that needed it.
    expect(security.events("instrument.connect")).toEqual([
      expect.objectContaining({ outcome: "connected", cause: "reconnect", "jsonrpc.request.id": nextId }),
    ]);
    // The reconnect's own CHDR OFF and *IDN? carry that id too.
    expect(writesOf(full, "CHDR OFF").at(-1)?.["jsonrpc.request.id"]).toBe(nextId);
    expect(writesOf(full, "TDIV?").at(-1)?.["jsonrpc.request.id"]).toBe(nextId);
    expectOneResultPerWrite(full);
  });

  it("records an out-of-step reply and the reset it causes", async () => {
    connection.disconnect();
    await ctx.cleanup();
    ctx = await connectedServer({ SIGLENT_ALLOW_RAW_SCPI: "true" });
    await callTool(ctx.client, "scpi_command", { command: "ECHO hello" });
    const id = requestIdFor(full, "ECHO hello");
    const opc = full.events("scpi.result").filter((r) => r["outcome"] === "out_of_step");
    expect(opc).toEqual([expect.objectContaining({ "jsonrpc.request.id": id })]);
    expect(security.events("instrument.disconnect")).toEqual([
      expect.objectContaining({ reason: "reset_out_of_step", cause: "reset", "jsonrpc.request.id": id }),
    ]);
    expectOneResultPerWrite(full);
  });

  it("records the *OPC? as not written when the connection resets during the setter's gap", async () => {
    sim.resetOn.add("C1:VDIV 500MV");
    await callTool(ctx.client, "configure_channel", { channel: "C1", vdiv: "500mV" });
    const setter = full.events("scpi.write").find((r) => String(r["scpi.command"]).startsWith("C1:VDIV"))!;
    expect(resultOf(full, setter["scpi.write_id"])).toEqual([expect.objectContaining({ outcome: "written" })]);
    // The *OPC? was never written: a result without a write.
    expect(full.events("scpi.write").filter((r) => r["scpi.kind"] === "opc")).toEqual([]);
    expect(full.events("scpi.result").filter((r) => r["outcome"] === "not_written")).toHaveLength(1);
    expectOneResultPerWrite(full);
  });

  it("records queued queries as not written when the scope resets the connection", async () => {
    sim.silent.add("C1:SILENT?");
    const pending = [
      callTool(ctx.client, "scpi_query", { command: "C1:SILENT?", timeout_ms: 5000 }),
      callTool(ctx.client, "scpi_query", { command: "C2:VDIV?" }),
    ];
    await new Promise((r) => setTimeout(r, 100));
    sim.resetConnections();
    await Promise.all(pending);
    await new Promise((r) => setTimeout(r, 50)); // the socket's close event follows its error
    const [written] = writesOf(full, "C1:SILENT?");
    expect(resultOf(full, written["scpi.write_id"])).toEqual([expect.objectContaining({ outcome: "connection_closed" })]);
    expect(writesOf(full, "C2:VDIV?")).toEqual([]);
    expect(security.events("instrument.disconnect")).toEqual([expect.objectContaining({ reason: "socket_error", cause: "socket" })]);
    expectOneResultPerWrite(full);
  });

  it("records connects, refusals by policy and a replaced connection", async () => {
    await callTool(ctx.client, "connect");
    await callTool(ctx.client, "connect", { host: "192.168.1.1" });
    await callTool(ctx.client, "connect", { host: "127.0.0.1", port: 22 });
    expect(security.events("instrument.connect").map((r) => r["outcome"])).toEqual([
      "connected",
      "refused_by_policy",
      "refused_by_policy",
    ]);
    expect(security.events("instrument.disconnect")).toEqual([expect.objectContaining({ reason: "replaced" })]);
    expect(security.events("guard.refused").map((r) => r["rule"])).toEqual(["host.not_allowed", "host.port_not_allowed"]);
  });

  it("numbers each sink's records without gaps, whatever its level", async () => {
    await callTool(ctx.client, "configure_channel", { channel: "C1", vdiv: "1V" });
    await callTool(ctx.client, "scpi_query", { command: "C1:VDIV 1V" });
    for (const sink of [full, security]) {
      const seqs = sink.records.map((r) => r["audit.seq"] as number);
      expect(seqs.length).toBeGreaterThan(0);
      expect(seqs, sink.name).toEqual(seqs.map((_, i) => seqs[0] + i));
    }
  });

  it("logs binary replies by size only", async () => {
    await callTool(ctx.client, "screenshot");
    const binary = full.events("scpi.write").find((r) => r["scpi.kind"] === "binary-query")!;
    const [result] = resultOf(full, binary["scpi.write_id"]);
    expect(Number(result["reply.bytes"])).toBeGreaterThan(0);
    expect(result["reply.text"]).toBeUndefined();
  });
});

describe("audit log: idle close", () => {
  it("records the idle close without a request id, and the next call's reconnect on its id", async () => {
    const ctx = await connectedServer({ SIGLENT_IDLE_TIMEOUT: "0.2" });
    try {
      await callTool(ctx.client, "scpi_query", { command: "TDIV?" });
      await new Promise((r) => setTimeout(r, 400));
      await callTool(ctx.client, "scpi_query", { command: "C1:VDIV?" });
      const nextId = requestIdFor(full, "C1:VDIV?");
      const idle = security.events("instrument.disconnect").find((r) => r["reason"] === "idle")!;
      expect(idle).toMatchObject({ cause: "idle-close" });
      expect(idle["jsonrpc.request.id"]).toBeUndefined();
      expect(security.events("instrument.connect").at(-1)).toMatchObject({ cause: "reconnect", "jsonrpc.request.id": nextId });
    } finally {
      connection.disconnect();
      await ctx.cleanup();
    }
  });
});

describe("audit log: losses", () => {
  it("reports dropped records with audit.loss once the sink accepts again, and leaves a matching gap", () => {
    let accept = false;
    const records: AuditRecord[] = [];
    const flaky: AuditSink = {
      name: "flaky",
      level: "security",
      write(r) {
        if (!accept) return false;
        records.push(r);
        return true;
      },
    };
    captureAudit(flaky);
    const start = () => audit.serverStart({ rawScpiEnabled: false, allowedHosts: [], allowedPorts: [5025], audit: "test" });
    start();
    start();
    accept = true;
    start();
    expect(records.map((r) => [r["event.name"], r["audit.seq"]])).toEqual([
      ["audit.loss", 4],
      ["server.start", 5],
    ]);
    expect(records[0]["audit.lost"]).toBe(3);
    audit.reset();
  });
});

describe("audit log: coverage", () => {
  it("every registered tool declares readOnlyHint", async () => {
    captureAudit();
    const ctx = await createTestServer(simEnv({ SIGLENT_ALLOW_RAW_SCPI: "true" }));
    try {
      const { tools } = await ctx.client.listTools();
      expect(tools.length).toBe(13);
      for (const t of tools) {
        expect(typeof t.annotations?.readOnlyHint, t.name).toBe("boolean");
        expect(audit.registeredTools.get(t.name)?.readOnlyHint, t.name).toBe(t.annotations?.readOnlyHint);
      }
    } finally {
      await ctx.cleanup();
    }
  });

  it("every rule in POLICY_RULES is produced", async () => {
    const sink = new MemorySink();
    captureAudit(sink);
    const ctx = await createTestServer(simEnv({ SIGLENT_ALLOW_RAW_SCPI: "true" }));
    try {
      await callTool(ctx.client, "connect");
      const queries = [
        "", "C1:VDIV?\tX", "C1:VDIV?é", "C1:VDIV?;TDIV 1MS",
        "C1:VDIV 1V", "*RST?", "ASET?", "INR?", "C1:VDIV? 1V", "C1:PAVA? 9X",
      ];
      for (const command of queries) await callTool(ctx.client, "scpi_query", { command });
      await callTool(ctx.client, "scpi_command", { command: "C1:VDIV?" });
      await callTool(ctx.client, "scpi_command", { command: "SCDP" });
      // Not reachable through the tools (their schemas cap commands at 512
      // characters, and binary queries are fixed): straight to the connection.
      await withAuditContext({ cause: "internal" }, () => connection.queryBinary("C1:VDIV?").catch(() => {}));
      await withAuditContext({ cause: "internal" }, () => connection.query("C1:VDIV? " + "A".repeat(600)).catch(() => {}));
      await callTool(ctx.client, "connect", { host: "127.0.0.1", port: 22 });
      await callTool(ctx.client, "connect", { host: "192.168.1.1" });
      await callTool(ctx.client, "configure_channel", { channel: "C1", vdiv: "1V\n" });
      connection.disconnect();
      await ctx.cleanup();

      const noRaw = await createTestServer(simEnv());
      await callTool(noRaw.client, "scpi_command", { command: "*RST" });
      await noRaw.cleanup();

      const loose = await createTestServer({}); // no instrument configured: private-LAN policy
      await callTool(loose.client, "connect", { host: "8.8.8.8", port: 5025 });
      await loose.cleanup();

      const produced = new Set(sink.events("guard.refused").map((r) => r["rule"]));
      expect([...POLICY_RULES].filter((r) => !produced.has(r))).toEqual([]);
    } finally {
      audit.reset();
    }
  });

  it("every ScpiPolicyError in src/ is thrown with a rule from POLICY_RULES", () => {
    const dir = join(__dirname, "../../src");
    const files = readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".ts"))
      .map((e) => join(e.parentPath, e.name));
    let throws = 0;
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/new ScpiPolicyError\(([^`]*?),\s*[`"]/g)) {
        throws++;
        const rules = [...m[1].matchAll(/"([a-z_]+\.[a-z_]+)"/g)].map((r) => r[1]);
        expect(rules.length, `${file}: ${m[0]}`).toBeGreaterThan(0);
        for (const r of rules) expect(POLICY_RULES, `${file}: ${r}`).toContain(r);
      }
    }
    expect(throws).toBe(16);
  });

  it("nothing in src/ outside the audit module writes to stderr or the console", () => {
    const dir = join(__dirname, "../../src");
    const offenders = readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".ts") && !join(e.parentPath, e.name).includes(join("src", "audit")))
      .flatMap((e) => {
        const file = join(e.parentPath, e.name);
        return readFileSync(file, "utf8")
          .split("\n")
          .map((line, i) => ({ file, line: i + 1, text: line }))
          .filter((l) => /\bconsole\.|process\.stderr/.test(l.text));
      });
    expect(offenders).toEqual([]);
  });
});
