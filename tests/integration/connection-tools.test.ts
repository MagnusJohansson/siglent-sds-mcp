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
    return "";
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

describe("identify", () => {
  it("returns parsed JSON with manufacturer, model, serial, firmware", async () => {
    const result = await callTool(client, "identify");
    const text = getText(result);
    const parsed = JSON.parse(text);
    expect(parsed).toEqual({
      manufacturer: "Siglent",
      model: "SDS1104X-E",
      serial: "SDS1ECAX12345",
      firmware: "8.2.6.1.37R1",
    });
  });
});

describe("disconnect", () => {
  it("reports previous host:port", async () => {
    const result = await callTool(client, "disconnect");
    const text = getText(result);
    expect(text).toContain("192.168.1.126:5025");
    expect(mockConnection.disconnect).toHaveBeenCalled();
  });
});

describe("connect", () => {
  it("returns error when no host is provided", async () => {
    const savedEnv = process.env.SIGLENT_IP;
    delete process.env.SIGLENT_IP;

    const result = await callTool(client, "connect", {});
    expect(result.isError).toBe(true);
    const text = getText(result);
    expect(text).toContain("No host specified");

    if (savedEnv !== undefined) process.env.SIGLENT_IP = savedEnv;
  });

  it("connects successfully with host provided", async () => {
    const result = await callTool(client, "connect", { host: "10.0.0.1" });
    const text = getText(result);
    expect(text).toContain("Connected to 10.0.0.1");
    expect(mockConnection.connect).toHaveBeenCalledWith("10.0.0.1", undefined);
  });
});
