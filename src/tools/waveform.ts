import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import sharp from "sharp";
import { connection } from "../connection.js";

const channelEnum = z.enum(["C1", "C2", "C3", "C4"]);

export function registerWaveformTools(server: McpServer): void {
  server.tool(
    "get_waveform",
    "Download waveform data from a channel. Returns voltage and time arrays reconstructed from the raw oscilloscope data. By default returns up to 1000 points (downsampled from full memory depth).",
    {
      channel: channelEnum.describe(
        "Channel to download waveform from (C1, C2, C3, or C4)"
      ),
      max_points: z
        .number()
        .optional()
        .describe(
          "Maximum number of data points to return (default 1000). Higher values give more detail but use more context."
        ),
    },
    { readOnlyHint: true },
    async ({ channel, max_points }) => {
      const maxPts = max_points || 1000;

      try {
        // Query channel parameters for voltage reconstruction
        const [vdivStr, ofstStr, tdivStr, saraStr] = await Promise.all([
          connection.query(`${channel}:VDIV?`),
          connection.query(`${channel}:OFST?`),
          connection.query("TDIV?"),
          connection.query("SARA?"),
        ]);

        const vdiv = parseFloat(vdivStr);
        const ofst = parseFloat(ofstStr);
        const tdiv = parseFloat(tdivStr);
        const sara = parseSampleRate(saraStr);

        if (isNaN(vdiv) || isNaN(ofst) || isNaN(tdiv) || isNaN(sara)) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error parsing scope parameters: vdiv=${vdivStr}, ofst=${ofstStr}, tdiv=${tdivStr}, sara=${saraStr}`,
              },
            ],
            isError: true,
          };
        }

        // Configure waveform transfer - get all points
        await connection.sendCommand("WFSU SP,0,NP,0,FP,0");

        // Request waveform data (binary block response)
        const rawData = await connection.queryBinary(`${channel}:WF? DAT2`);

        // Convert raw bytes to voltage values
        const voltages: number[] = [];
        for (let i = 0; i < rawData.length; i++) {
          let codeValue = rawData[i];
          if (codeValue > 127) {
            codeValue = codeValue - 255;
          }
          voltages.push(codeValue * (vdiv / 25) - ofst);
        }

        // Generate time values
        const totalPoints = voltages.length;
        const timeInterval = 1 / sara;
        const startTime = -(tdiv * 14) / 2;

        // Downsample if needed
        let step = 1;
        if (totalPoints > maxPts) {
          step = Math.ceil(totalPoints / maxPts);
        }

        const data: Array<{ time: number; voltage: number }> = [];
        for (let i = 0; i < totalPoints; i += step) {
          data.push({
            time: startTime + i * timeInterval,
            voltage: voltages[i],
          });
        }

        const result = {
          channel,
          total_points: totalPoints,
          returned_points: data.length,
          sample_rate: sara,
          timebase: tdiv,
          volts_per_div: vdiv,
          offset: ofst,
          time_range: {
            start: data[0]?.time ?? 0,
            end: data[data.length - 1]?.time ?? 0,
          },
          voltage_range: {
            min: Math.min(...data.map((d) => d.voltage)),
            max: Math.max(...data.map((d) => d.voltage)),
          },
          data,
        };

        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "screenshot",
    "Capture the oscilloscope screen as a PNG image. Returns a base64-encoded image.",
    {},
    { readOnlyHint: true },
    async () => {
      try {
        const bmpData = await connection.queryBinary("SCDP");

        // The scope returns a 16-bit BI_BITFIELDS BMP (RGB565) which sharp
        // cannot decode directly. Parse the BMP header and convert pixels
        // to 24-bit RGB, then feed to sharp as raw data.
        const pixelOffset = bmpData.readUInt32LE(10);
        const width = bmpData.readInt32LE(18);
        const rawHeight = bmpData.readInt32LE(22);
        const height = Math.abs(rawHeight);
        const bpp = bmpData.readUInt16LE(28);
        const compression = bmpData.readUInt32LE(30);

        let pngData: Buffer;

        if (bpp === 16 && compression === 3) {
          // BI_BITFIELDS: read color masks
          const rMask = bmpData.readUInt32LE(54);
          const gMask = bmpData.readUInt32LE(58);
          const bMask = bmpData.readUInt32LE(62);

          const rShift = countTrailingZeros(rMask);
          const gShift = countTrailingZeros(gMask);
          const bShift = countTrailingZeros(bMask);
          const rMax = rMask >>> rShift;
          const gMax = gMask >>> gShift;
          const bMax = bMask >>> bShift;

          const rgb = Buffer.alloc(width * height * 3);
          const rowBytes = Math.ceil((width * 2) / 4) * 4; // BMP rows are 4-byte aligned
          const topDown = rawHeight < 0;

          for (let y = 0; y < height; y++) {
            const srcRow = topDown ? y : height - 1 - y;
            const srcOffset = pixelOffset + srcRow * rowBytes;
            const dstOffset = y * width * 3;
            for (let x = 0; x < width; x++) {
              const pixel = bmpData.readUInt16LE(srcOffset + x * 2);
              rgb[dstOffset + x * 3] = Math.round(((pixel & rMask) >>> rShift) * 255 / rMax);
              rgb[dstOffset + x * 3 + 1] = Math.round(((pixel & gMask) >>> gShift) * 255 / gMax);
              rgb[dstOffset + x * 3 + 2] = Math.round(((pixel & bMask) >>> bShift) * 255 / bMax);
            }
          }

          pngData = await sharp(rgb, { raw: { width, height, channels: 3 } }).png().toBuffer();
        } else {
          // Standard BMP format — let sharp handle it directly
          pngData = await sharp(bmpData).png().toBuffer();
        }

        const base64 = pngData.toString("base64");

        return {
          content: [
            {
              type: "image" as const,
              data: base64,
              mimeType: "image/png",
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}

export function countTrailingZeros(n: number): number {
  if (n === 0) return 32;
  let count = 0;
  while ((n & 1) === 0) {
    n >>>= 1;
    count++;
  }
  return count;
}

/**
 * Parse sample rate string that may include unit suffixes.
 * The scope returns values like "1.00E+09" (with CHDR OFF) or "1.00GSa/s" (with CHDR on).
 * With CHDR OFF the response is just the number, but handle both cases.
 */
export function parseSampleRate(str: string): number {
  const cleaned = str.trim();

  // Try direct parse first (works with CHDR OFF)
  const direct = parseFloat(cleaned);
  if (!isNaN(direct) && !cleaned.match(/[a-zA-Z]/)) {
    return direct;
  }

  // Handle unit suffixes like GSa/s, MSa/s, kSa/s
  const unitMap: Record<string, number> = {
    G: 1e9,
    M: 1e6,
    k: 1e3,
  };

  for (const [unit, multiplier] of Object.entries(unitMap)) {
    const idx = cleaned.indexOf(unit);
    if (idx !== -1) {
      const numPart = parseFloat(cleaned.substring(0, idx));
      if (!isNaN(numPart)) {
        return numPart * multiplier;
      }
    }
  }

  return parseFloat(cleaned);
}
