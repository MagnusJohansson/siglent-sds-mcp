/**
 * End-to-end security tests: real MCP client -> real server -> real TCP
 * socket -> SCPI simulator. Each rejection is proven by what did NOT reach
 * the wire, not just by the error message.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SdsSimulator, SIM_IDN } from "../simulator/sds-simulator.js";
import { createTestServer, callTool, getText } from "../helpers.js";
import { connection } from "../../src/connection.js";

/**
 * A tool call is rejected if the server throws (protocol error) or returns
 * isError. Only the call itself is inside try/catch: the assertion must stay
 * outside, or a successful call would turn into a caught assertion error and
 * the test would pass anyway.
 */
async function expectRejected(client: Client, name: string, args: Record<string, unknown>) {
  let result: Awaited<ReturnType<typeof callTool>>;
  try {
    result = await callTool(client, name, args);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  expect(result.isError, `expected ${name} to be rejected, got: ${getText(result)}`).toBe(true);
  return getText(result);
}

let sim: SdsSimulator;
let simPort: number;

beforeAll(async () => {
  sim = new SdsSimulator();
  simPort = await sim.start();
});

afterAll(async () => {
  connection.disconnect();
  await sim.stop();
});

/**
 * What reached the instrument. Sends a *OPC? round trip first: the socket is
 * ordered, so once its reply arrives every earlier write has been received.
 * Without this barrier, "nothing was sent" assertions would pass vacuously.
 */
async function wire(client: Client): Promise<string[]> {
  const res = await callTool(client, "scpi_query", { command: "*OPC?" });
  expect(getText(res)).toBe("1");
  return sim.commands().filter((l) => l !== "*OPC?");
}

function simEnv(extra: Record<string, string> = {}): Record<string, string> {
  return { SIGLENT_IP: "127.0.0.1", SIGLENT_PORT: String(simPort), ...extra };
}

async function connectedServer(extra: Record<string, string> = {}) {
  const ctx = await createTestServer(simEnv(extra));
  const res = await callTool(ctx.client, "connect");
  expect(getText(res)).toContain(SIM_IDN);
  sim.clear();
  sim.resetState();
  return ctx;
}

describe("default configuration", () => {
  let ctx: Awaited<ReturnType<typeof connectedServer>>;

  beforeAll(async () => {
    ctx = await connectedServer();
  });
  afterAll(async () => {
    connection.disconnect();
    await ctx.cleanup();
  });
  beforeEach(() => {
    sim.clear();
    sim.resetState();
  });

  it("does not expose the raw scpi_command tool", async () => {
    const { tools } = await ctx.client.listTools();
    expect(tools.map((t) => t.name)).not.toContain("scpi_command");
  });

  describe("scpi_query only sends queries", () => {
    it.each([
      ["a setter", "C1:VDIV 5V"],
      ["a long-form setter", "C1:VOLT_DIV 5V"],
      ["a compound query hiding a setter", "C1:VDIV?;C1:VDIV 5V"],
      ["a newline-injected setter", "C1:VDIV?\nC1:VDIV 5V"],
      ["a carriage-return-injected setter", "C1:VDIV?\rC1:VDIV 5V"],
      ["parameters after a query header", "C1:VDIV? 5V"],
      ["a reset in query form", "*RST?"],
      ["a self-calibration in query form", "*CAL?"],
      ["an auto setup in query form", "ASET?"],
      ["an action command without '?'", "ARM"],
      ["a measurement query with a second parameter", "C1:PAVA? FREQ,5V"],
    ])("rejects %s", async (_label, command) => {
      await expectRejected(ctx.client, "scpi_query", { command });
      expect(await wire(ctx.client)).toEqual([]);
      expect(sim.get("C1:VDIV")).toBe("1.00E+00");
    });

    it.each([["C1:VDIV?"], [":TDIV?"], ["*IDN?"], ["C1:PAVA? FREQ"], ["PAVA? STAT1"]])(
      "accepts %s",
      async (command) => {
        const res = await callTool(ctx.client, "scpi_query", { command });
        expect(res.isError).toBeFalsy();
        expect(await wire(ctx.client)).toEqual([command]);
      }
    );
  });

  describe("strict parameter formats", () => {
    it.each([
      ["configure_channel", { channel: "C1", vdiv: "1V\nC1:TRA OFF" }],
      ["configure_channel", { channel: "C1", vdiv: "1V,OFF" }],
      ["configure_channel", { channel: "C1", offset: "0V;C1:TRA OFF" }],
      ["configure_acquisition", { timebase: "1MS\nARM" }],
      ["configure_acquisition", { trigger_level: "1V;STOP" }],
      ["configure_acquisition", { trigger_delay: "0S\n*RST" }],
      ["configure_acquisition", { timebase: "-1MS" }],
    ])("%s rejects %j and sends nothing", async (tool, args) => {
      await expectRejected(ctx.client, tool, args);
      expect(await wire(ctx.client)).toEqual([]);
      expect(sim.get("C1:TRA")).toBe("ON");
      expect(sim.get("TRMD")).toBe("AUTO");
    });

    it("still applies valid settings", async () => {
      const res = await callTool(ctx.client, "configure_channel", { channel: "C1", vdiv: "500mV" });
      expect(res.isError).toBeFalsy();
      expect(await wire(ctx.client)).toEqual(["C1:VDIV 500mV"]);
      expect(sim.get("C1:VDIV")).toBe("500mV");
    });
  });

  describe("connect is restricted", () => {
    it.each([
      ["another LAN host", { host: "192.168.1.1" }],
      ["a cloud metadata endpoint", { host: "169.254.169.254" }],
      ["a host name", { host: "example.com" }],
      ["another port on the scope", { host: "127.0.0.1", port: 22 }],
    ])("rejects %s and keeps the session", async (_label, args) => {
      const msg = await expectRejected(ctx.client, "connect", args);
      expect(msg).toMatch(/not allowed|not in the allowed list/);
      const res = await callTool(ctx.client, "scpi_query", { command: "*IDN?" });
      expect(getText(res)).toBe(SIM_IDN);
    });
  });
});

describe("raw SCPI enabled", () => {
  let ctx: Awaited<ReturnType<typeof connectedServer>>;

  beforeAll(async () => {
    ctx = await connectedServer({ SIGLENT_ALLOW_RAW_SCPI: "true" });
  });
  afterAll(async () => {
    connection.disconnect();
    await ctx.cleanup();
  });
  beforeEach(() => {
    sim.clear();
    sim.resetState();
  });

  it("exposes scpi_command, marked destructive", async () => {
    const { tools } = await ctx.client.listTools();
    const tool = tools.find((t) => t.name === "scpi_command");
    expect(tool?.annotations?.destructiveHint).toBe(true);
  });

  it("sends a single command", async () => {
    const res = await callTool(ctx.client, "scpi_command", { command: "C1:VDIV 2V" });
    expect(res.isError).toBeFalsy();
    expect(await wire(ctx.client)).toEqual(["C1:VDIV 2V"]);
  });

  it.each([["C1:VDIV 2V\nARM"], ["C1:VDIV 2V;ARM"], ["C1:VDIV 2V\rARM"]])(
    "rejects an injected second command in %j",
    async (command) => {
      await expectRejected(ctx.client, "scpi_command", { command });
      expect(await wire(ctx.client)).toEqual([]);
    }
  );

  it.each([
    ["a query", "C1:VDIV?"],
    ["a query that answers '1' like the acknowledgement", "*OPC?"],
    ["a screen dump", "SCDP"],
  ])("rejects %s before it reaches the scope", async (_label, command) => {
    const msg = await expectRejected(ctx.client, "scpi_command", { command });
    expect(msg).toMatch(/is a query|returns data/);
    expect(await wire(ctx.client)).toEqual([]);
  });
});
