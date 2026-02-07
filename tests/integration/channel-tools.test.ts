import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestServer, callTool, getText } from "../helpers.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const mockConnection = vi.hoisted(() => ({
  isConnected: vi.fn(() => true),
  getConnectionInfo: vi.fn(() => "192.168.1.126:5025"),
  connect: vi.fn(async () => "Siglent,SDS1104X-E,SDS1ECAX12345,8.2.6.1.37R1"),
  disconnect: vi.fn(),
  sendCommand: vi.fn(async () => {}),
  query: vi.fn(async (cmd: string) => {
    const responses: Record<string, string> = {
      "C1:VDIV?": "2.00E-01",
      "C1:OFST?": "-5.00E-01",
      "C1:CPL?": "D1M",
      "BWL?": "C1,OFF,C2,OFF,C3,OFF,C4,OFF",
      "C1:TRA?": "ON",
      "C1:ATTN?": "10",
      "C1:UNIT?": "V",
    };
    return responses[cmd] ?? "";
  }),
  queryBinary: vi.fn(async () => Buffer.alloc(0)),
}));

vi.mock("../../src/connection.js", () => ({
  connection: mockConnection,
}));

let client: Client;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const ctx = await createTestServer();
  client = ctx.client;
  cleanup = ctx.cleanup;
});

afterAll(async () => {
  await cleanup();
});

beforeEach(() => {
  vi.clearAllMocks();
  mockConnection.isConnected.mockReturnValue(true);
});

describe("get_channel", () => {
  it("parses multi-query results into structured JSON", async () => {
    const result = await callTool(client, "get_channel", { channel: "C1" });
    const text = getText(result);
    const parsed = JSON.parse(text);
    expect(parsed).toEqual({
      channel: "C1",
      volts_per_div: "2.00E-01",
      offset: "-5.00E-01",
      coupling: "D1M",
      bandwidth_limit: "OFF",
      trace: "ON",
      probe_attenuation: "10",
      unit: "V",
    });
  });
});

describe("configure_channel", () => {
  it("sends only specified SCPI commands", async () => {
    const result = await callTool(client, "configure_channel", {
      channel: "C1",
      vdiv: "500mV",
      coupling: "A1M",
    });
    const text = getText(result);
    expect(text).toContain("C1:VDIV 500mV");
    expect(text).toContain("C1:CPL A1M");
    expect(mockConnection.sendCommand).toHaveBeenCalledTimes(2);
    expect(mockConnection.sendCommand).toHaveBeenCalledWith("C1:VDIV 500mV");
    expect(mockConnection.sendCommand).toHaveBeenCalledWith("C1:CPL A1M");
  });

  it("returns message when no optional params provided", async () => {
    const result = await callTool(client, "configure_channel", {
      channel: "C1",
    });
    const text = getText(result);
    expect(text).toContain("No parameters specified");
    expect(mockConnection.sendCommand).not.toHaveBeenCalled();
  });

  it("sends bandwidth_limit command correctly", async () => {
    const result = await callTool(client, "configure_channel", {
      channel: "C2",
      bandwidth_limit: true,
    });
    const text = getText(result);
    expect(text).toContain("BWL C2,ON");
    expect(mockConnection.sendCommand).toHaveBeenCalledWith("BWL C2,ON");
  });

  it("sends trace on/off command", async () => {
    await callTool(client, "configure_channel", {
      channel: "C3",
      trace: false,
    });
    expect(mockConnection.sendCommand).toHaveBeenCalledWith("C3:TRA OFF");
  });
});
