import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestServer, callTool, getText } from "../helpers.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const { mockConnection, defaultQuery } = vi.hoisted(() => {
  const defaultQuery = async (cmd: string) => {
    const responses: Record<string, string> = {
      "SAST?": "Trig'd",
      "SARA?": "1.00E+09",
      "TDIV?": "1.00E-06",
      "TRDL?": "0.00E+00",
      "TRMD?": "AUTO",
      "TRSE?": "EDGE,SR,C1,HT,OFF",
      "C1:TRLV?": "1.50E-01",
      "C1:TRSL?": "POS",
    };
    return responses[cmd] ?? "";
  };
  return {
    defaultQuery,
    mockConnection: {
      isConnected: vi.fn(() => true),
      getConnectionInfo: vi.fn(() => "192.168.1.126:5025"),
      connect: vi.fn(async () => "Siglent,SDS1104X-E,SDS1ECAX12345,8.2.6.1.37R1"),
      disconnect: vi.fn(),
      checkChannel: vi.fn(async () => {}),
      sendCommand: vi.fn(async () => {}),
      query: vi.fn(defaultQuery),
      queryBinary: vi.fn(async () => Buffer.alloc(0)),
    },
  };
});

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

describe("get_acquisition_status", () => {
  it("returns all fields", async () => {
    const result = await callTool(client, "get_acquisition_status");
    const text = getText(result);
    const parsed = JSON.parse(text);
    expect(parsed).toEqual({
      acquisition_status: "Trig'd",
      sample_rate: "1.00E+09",
      timebase: "1.00E-06",
      trigger_delay: "0.00E+00",
      trigger_mode: "AUTO",
      trigger_select: "EDGE,SR,C1,HT,OFF",
      trigger_source: "C1",
      trigger_level: "1.50E-01",
      trigger_slope: "POS",
    });
  });

  it("reports level/slope of the active trigger source, not C1", async () => {
    mockConnection.query.mockImplementation(async (cmd: string) => {
      const responses: Record<string, string> = {
        "TRSE?": "EDGE,SR,C2,HT,OFF",
        "C1:TRLV?": "1.50E-01",
        "C2:TRLV?": "2.92E-02",
        "C2:TRSL?": "NEG",
      };
      return responses[cmd] ?? "";
    });
    const parsed = JSON.parse(getText(await callTool(client, "get_acquisition_status")));
    expect(parsed.trigger_source).toBe("C2");
    expect(parsed.trigger_level).toBe("2.92E-02");
    expect(parsed.trigger_slope).toBe("NEG");
    mockConnection.query.mockImplementation(defaultQuery);
  });
});

describe("configure_acquisition", () => {
  it("sends ARM when command is 'run'", async () => {
    const result = await callTool(client, "configure_acquisition", {
      command: "run",
    });
    const text = getText(result);
    expect(text).toContain("ARM");
    expect(mockConnection.sendCommand).toHaveBeenCalledWith("ARM");
  });

  it("sends STOP when command is 'stop'", async () => {
    const result = await callTool(client, "configure_acquisition", {
      command: "stop",
    });
    const text = getText(result);
    expect(text).toContain("STOP");
    expect(mockConnection.sendCommand).toHaveBeenCalledWith("STOP");
  });

  it("builds correct trigger commands", async () => {
    const result = await callTool(client, "configure_acquisition", {
      trigger_source: "C2",
      trigger_level: "1.5V",
      trigger_slope: "NEG",
    });
    const text = getText(result);
    expect(text).toContain("C2:TRLV 1.5V");
    expect(text).toContain("C2:TRSL NEG");
    expect(mockConnection.sendCommand).toHaveBeenCalledWith("C2:TRLV 1.5V");
    expect(mockConnection.sendCommand).toHaveBeenCalledWith("C2:TRSL NEG");
  });

  it("applies level/slope to the active trigger source when none is given", async () => {
    mockConnection.query.mockImplementation(async (cmd: string) =>
      cmd === "TRSE?" ? "EDGE,SR,C2,HT,OFF" : ""
    );
    await callTool(client, "configure_acquisition", {
      trigger_level: "10mV",
      trigger_slope: "NEG",
    });
    expect(mockConnection.sendCommand).toHaveBeenCalledWith("C2:TRLV 10mV");
    expect(mockConnection.sendCommand).toHaveBeenCalledWith("C2:TRSL NEG");
    expect(mockConnection.sendCommand).not.toHaveBeenCalledWith("C1:TRLV 10mV");
    mockConnection.query.mockImplementation(defaultQuery);
  });

  it("sets the trigger source on its own", async () => {
    await callTool(client, "configure_acquisition", { trigger_source: "C2" });
    expect(mockConnection.sendCommand).toHaveBeenCalledWith("TRSE EDGE,SR,C2");
  });

  it("sets timebase and trigger mode together", async () => {
    await callTool(client, "configure_acquisition", {
      timebase: "1US",
      trigger_mode: "NORM",
    });
    expect(mockConnection.sendCommand).toHaveBeenCalledWith("TDIV 1US");
    expect(mockConnection.sendCommand).toHaveBeenCalledWith("TRMD NORM");
  });

  it("returns message when no params specified", async () => {
    const result = await callTool(client, "configure_acquisition", {});
    const text = getText(result);
    expect(text).toContain("No parameters specified");
  });
});
