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
    if (cmd === "*IDN?") return "Siglent,SDS1104X-E,SDS1ECAX12345,8.2.6.1.37R1";
    if (cmd === "C1:VDIV?") return "2.00E-01";
    return "OK";
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

describe("scpi_query", () => {
  it("forwards command and returns response", async () => {
    const result = await callTool(client, "scpi_query", { command: "*IDN?" });
    const text = getText(result);
    expect(text).toBe("Siglent,SDS1104X-E,SDS1ECAX12345,8.2.6.1.37R1");
    expect(mockConnection.query).toHaveBeenCalledWith("*IDN?", undefined);
  });

  it("passes timeout to query", async () => {
    await callTool(client, "scpi_query", {
      command: "C1:VDIV?",
      timeout_ms: 5000,
    });
    expect(mockConnection.query).toHaveBeenCalledWith("C1:VDIV?", 5000);
  });
});

describe("scpi_command", () => {
  it("sends command without expecting response", async () => {
    const result = await callTool(client, "scpi_command", {
      command: "*RST",
    });
    const text = getText(result);
    expect(text).toContain("Command sent: *RST");
    expect(mockConnection.sendCommand).toHaveBeenCalledWith("*RST");
  });

  it("sends arbitrary SCPI command", async () => {
    await callTool(client, "scpi_command", { command: "C1:VDIV 500mV" });
    expect(mockConnection.sendCommand).toHaveBeenCalledWith("C1:VDIV 500mV");
  });
});
