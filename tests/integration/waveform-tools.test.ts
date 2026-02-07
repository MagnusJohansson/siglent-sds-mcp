import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestServer, callTool, getText } from "../helpers.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

// Build a minimal 4x2 RGB565 BMP for screenshot testing.
function buildMinimalBmp(): Buffer {
  const width = 4;
  const height = 2;
  const bpp = 16;
  const rowBytes = Math.ceil((width * 2) / 4) * 4;
  const pixelDataSize = rowBytes * height;
  const pixelOffset = 14 + 40 + 12; // file header + DIB header + 3 masks
  const fileSize = pixelOffset + pixelDataSize;

  const buf = Buffer.alloc(fileSize);

  // BMP file header (14 bytes)
  buf.write("BM", 0);
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt32LE(0, 6);
  buf.writeUInt32LE(pixelOffset, 10);

  // DIB header (40 bytes)
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(bpp, 28);
  buf.writeUInt32LE(3, 30); // BI_BITFIELDS
  buf.writeUInt32LE(pixelDataSize, 34);
  buf.writeInt32LE(2835, 38);
  buf.writeInt32LE(2835, 42);
  buf.writeUInt32LE(0, 46);
  buf.writeUInt32LE(0, 50);

  // Color masks (RGB565)
  buf.writeUInt32LE(0xf800, 54);
  buf.writeUInt32LE(0x07e0, 58);
  buf.writeUInt32LE(0x001f, 62);

  // Pixel data: fill with pure red (0xF800)
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      buf.writeUInt16LE(0xf800, pixelOffset + row * rowBytes + col * 2);
    }
  }

  return buf;
}

// Build canned waveform raw data: 10 bytes of ADC values
function buildWaveformData(): Buffer {
  return Buffer.from([0, 25, 50, 75, 100, 125, 150, 175, 200, 225]);
}

const waveformData = vi.hoisted(() => Buffer.from([0, 25, 50, 75, 100, 125, 150, 175, 200, 225]));
const bmpData = vi.hoisted(() => {
  const width = 4;
  const height = 2;
  const bpp = 16;
  const rowBytes = Math.ceil((width * 2) / 4) * 4;
  const pixelDataSize = rowBytes * height;
  const pixelOffset = 14 + 40 + 12;
  const fileSize = pixelOffset + pixelDataSize;
  const buf = Buffer.alloc(fileSize);
  buf.write("BM", 0);
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt32LE(0, 6);
  buf.writeUInt32LE(pixelOffset, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(bpp, 28);
  buf.writeUInt32LE(3, 30);
  buf.writeUInt32LE(pixelDataSize, 34);
  buf.writeInt32LE(2835, 38);
  buf.writeInt32LE(2835, 42);
  buf.writeUInt32LE(0, 46);
  buf.writeUInt32LE(0, 50);
  buf.writeUInt32LE(0xf800, 54);
  buf.writeUInt32LE(0x07e0, 58);
  buf.writeUInt32LE(0x001f, 62);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      buf.writeUInt16LE(0xf800, pixelOffset + row * rowBytes + col * 2);
    }
  }
  return buf;
});

const mockConnection = vi.hoisted(() => ({
  isConnected: vi.fn(() => true),
  getConnectionInfo: vi.fn(() => "192.168.1.126:5025"),
  connect: vi.fn(async () => "Siglent,SDS1104X-E,SDS1ECAX12345,8.2.6.1.37R1"),
  disconnect: vi.fn(),
  sendCommand: vi.fn(async () => {}),
  query: vi.fn(async (cmd: string) => {
    const responses: Record<string, string> = {
      "C1:VDIV?": "1.00E+00",
      "C1:OFST?": "0.00E+00",
      "TDIV?": "1.00E-03",
      "SARA?": "1.00E+06",
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
  // Re-set queryBinary to return proper data per command
  mockConnection.queryBinary.mockImplementation(async (cmd: string) => {
    if (cmd === "C1:WF? DAT2") return waveformData;
    if (cmd === "SCDP") return bmpData;
    return Buffer.alloc(0);
  });
  // Re-set query responses
  mockConnection.query.mockImplementation(async (cmd: string) => {
    const responses: Record<string, string> = {
      "C1:VDIV?": "1.00E+00",
      "C1:OFST?": "0.00E+00",
      "TDIV?": "1.00E-03",
      "SARA?": "1.00E+06",
    };
    return responses[cmd] ?? "";
  });
});

describe("get_waveform", () => {
  it("returns correct voltage reconstruction from raw ADC bytes", async () => {
    const result = await callTool(client, "get_waveform", { channel: "C1" });
    const text = getText(result);
    const parsed = JSON.parse(text);

    // vdiv=1V, so vdiv/25=0.04V per code. offset=0
    expect(parsed.channel).toBe("C1");
    expect(parsed.total_points).toBe(10);
    expect(parsed.returned_points).toBe(10);
    expect(parsed.sample_rate).toBe(1e6);

    const data = parsed.data as Array<{ time: number; voltage: number }>;
    expect(data[0].voltage).toBeCloseTo(0, 5);      // code 0
    expect(data[1].voltage).toBeCloseTo(1.0, 5);     // code 25
    expect(data[2].voltage).toBeCloseTo(2.0, 5);     // code 50
    expect(data[3].voltage).toBeCloseTo(3.0, 5);     // code 75
    expect(data[4].voltage).toBeCloseTo(4.0, 5);     // code 100
    expect(data[5].voltage).toBeCloseTo(5.0, 5);     // code 125
    // code 150 > 127 => codeValue = 150 - 255 = -105. voltage = -105 * 0.04 = -4.2
    expect(data[6].voltage).toBeCloseTo(-4.2, 5);
  });

  it("downsamples when max_points < total points", async () => {
    const result = await callTool(client, "get_waveform", {
      channel: "C1",
      max_points: 5,
    });
    const text = getText(result);
    const parsed = JSON.parse(text);

    expect(parsed.total_points).toBe(10);
    // step=ceil(10/5)=2, indices 0,2,4,6,8 = 5 points
    expect(parsed.returned_points).toBe(5);
  });
});

describe("screenshot", () => {
  it("converts BMP to PNG and returns base64 image", async () => {
    const result = await callTool(client, "screenshot");
    const content = result.content as Array<{
      type: string;
      data?: string;
      mimeType?: string;
    }>;
    const imageBlock = content.find((c) => c.type === "image");
    expect(imageBlock).toBeDefined();
    expect(imageBlock!.mimeType).toBe("image/png");
    // Verify valid base64 that decodes to PNG
    const pngBuf = Buffer.from(imageBlock!.data!, "base64");
    expect(pngBuf[0]).toBe(0x89);
    expect(pngBuf[1]).toBe(0x50); // 'P'
    expect(pngBuf[2]).toBe(0x4e); // 'N'
    expect(pngBuf[3]).toBe(0x47); // 'G'
  });
});
