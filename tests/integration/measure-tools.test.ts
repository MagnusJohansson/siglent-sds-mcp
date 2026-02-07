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
      "C1:PAVA? FREQ": "FREQ,1.000000E+03Hz",
      "C1:PAVA? PKPK": "PKPK,3.280E+00V",
      "PAVA? STAT1": "C1:MEAN,curr=1.234E+00V,mean=1.230E+00V,min=1.200E+00V,max=1.260E+00V,sdev=1.500E-02V,num=100",
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

describe("measure", () => {
  it("installs measurement and returns formatted value", async () => {
    const result = await callTool(client, "measure", {
      channel: "C1",
      parameter: "FREQ",
    });
    const text = getText(result);
    expect(text).toContain("C1 FREQ");
    expect(text).toContain("1.000000E+03Hz");
    expect(mockConnection.sendCommand).toHaveBeenCalledWith("PACU FREQ,C1");
  });

  it("returns PKPK measurement", async () => {
    const result = await callTool(client, "measure", {
      channel: "C1",
      parameter: "PKPK",
    });
    const text = getText(result);
    expect(text).toContain("PKPK");
    expect(text).toContain("3.280E+00V");
  });
});

describe("measure_statistics", () => {
  it("enables statistics with 'on' action", async () => {
    const result = await callTool(client, "measure_statistics", {
      channel: "C1",
      parameter: "MEAN",
      action: "on",
    });
    const text = getText(result);
    expect(text).toContain("Statistics enabled");
    expect(mockConnection.sendCommand).toHaveBeenCalledWith("PACU MEAN,C1");
    expect(mockConnection.sendCommand).toHaveBeenCalledWith("PASTAT ON");
  });

  it("returns statistics with 'read' action", async () => {
    const result = await callTool(client, "measure_statistics", {
      channel: "C1",
      parameter: "MEAN",
      action: "read",
    });
    const text = getText(result);
    expect(text).toContain("statistics");
    expect(text).toContain("curr=1.234E+00V");
    expect(text).toContain("mean=1.230E+00V");
  });

  it("resets statistics with 'reset' action", async () => {
    const result = await callTool(client, "measure_statistics", {
      channel: "C1",
      parameter: "MEAN",
      action: "reset",
    });
    const text = getText(result);
    expect(text).toContain("Statistics reset");
    expect(mockConnection.sendCommand).toHaveBeenCalledWith("PASTAT RESET");
  });

  it("disables statistics with 'off' action", async () => {
    const result = await callTool(client, "measure_statistics", {
      channel: "C1",
      parameter: "MEAN",
      action: "off",
    });
    const text = getText(result);
    expect(text).toContain("Statistics disabled");
    expect(mockConnection.sendCommand).toHaveBeenCalledWith("PASTAT OFF");
  });
});
