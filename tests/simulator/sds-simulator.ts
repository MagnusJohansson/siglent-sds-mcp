/**
 * Minimal SCPI simulator for a Siglent SDS oscilloscope, over real TCP.
 *
 * It records every line that reaches it, keeps settings in a key-value store
 * ("C1:VDIV 1V" sets C1:VDIV, "C1:VDIV?" reads it), and answers *IDN? and
 * *OPC?. Like the real scope, unknown commands are accepted silently. Security
 * tests assert on what did (or did not) reach the wire and on the state.
 */
import * as net from "node:net";

export const SIM_IDN = "Siglent Technologies,SDS1104X-E,SIMSDS0001,8.2.6.1.37R9";

const DEFAULT_STATE: Record<string, string> = {
  "C1:VDIV": "1.00E+00",
  "C2:VDIV": "1.00E+00",
  "C1:OFST": "0.00E+00",
  "C1:CPL": "D1M",
  "C1:TRA": "ON",
  "C1:ATTN": "1",
  TDIV: "1.00E-03",
  TRDL: "0.00E+00",
  TRMD: "AUTO",
  TRSE: "EDGE,SR,C1,HT,OFF",
  "C1:TRLV": "0.00E+00",
  "C1:TRSL": "POS",
  SARA: "1.00E+09",
  SAST: "Trig'd",
};

export class SdsSimulator {
  private server: net.Server | null = null;
  private sockets = new Set<net.Socket>();
  private lines: string[] = [];
  private state: Record<string, string> = { ...DEFAULT_STATE };
  /** Delay before answering *OPC?, to simulate a slow command. */
  opcDelayMs = 0;

  async start(): Promise<number> {
    this.server = net.createServer((sock) => {
      this.sockets.add(sock);
      sock.on("close", () => this.sockets.delete(sock));
      let buf = "";
      sock.on("data", (chunk) => {
        buf += chunk.toString("latin1");
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line) this.handle(sock, line);
        }
      });
      sock.on("error", () => {});
    });
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
    return (this.server!.address() as net.AddressInfo).port;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise((r) => this.server?.close(r));
  }

  /** Every line received since the last clear(), in order. */
  commands(): string[] {
    return [...this.lines];
  }

  clear(): void {
    this.lines = [];
  }

  get(key: string): string | undefined {
    return this.state[key];
  }

  resetState(): void {
    this.state = { ...DEFAULT_STATE };
    this.opcDelayMs = 0;
  }

  connectionCount(): number {
    return this.sockets.size;
  }

  /**
   * Replies go out in order, like a real scope that works through its input
   * one command at a time: a slow *OPC? delays every reply queued behind it.
   */
  private replyChains = new WeakMap<net.Socket, Promise<void>>();

  private reply(sock: net.Socket, text: string, delayMs = 0): void {
    const prev = this.replyChains.get(sock) ?? Promise.resolve();
    const next = prev
      .then(() => (delayMs > 0 ? new Promise<void>((r) => setTimeout(r, delayMs)) : undefined))
      .then(() => {
        if (!sock.destroyed) sock.write(text + "\n");
      });
    this.replyChains.set(sock, next);
  }

  private handle(sock: net.Socket, line: string): void {
    this.lines.push(line);
    const upper = line.toUpperCase();
    if (upper === "*IDN?") return this.reply(sock, SIM_IDN);
    if (upper === "*OPC?") return this.reply(sock, "1", this.opcDelayMs);
    if (upper === "*RST") {
      this.state = { ...DEFAULT_STATE };
      return;
    }

    const q = /^([A-Z0-9:_*]+)\?(?: (.*))?$/i.exec(line);
    if (q) {
      const key = q[1].toUpperCase();
      if (key.endsWith("PAVA")) return this.reply(sock, "1.000000E+03");
      return this.reply(sock, this.state[key] ?? "0");
    }

    const set = /^([A-Z0-9:_]+) (.+)$/i.exec(line);
    if (set) {
      this.state[set[1].toUpperCase()] = set[2];
    }
  }
}
