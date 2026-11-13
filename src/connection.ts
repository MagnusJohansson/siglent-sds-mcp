import * as net from "node:net";

const DEFAULT_PORT = 5025;
const DEFAULT_TIMEOUT = 5000;
const BINARY_TIMEOUT = 30000;
// Gap between a command and its *OPC? so they reach the scope as separate
// reads; a write callback alone doesn't stop the receiver coalescing them.
const OPC_GAP_MS = 20;

/**
 * Seconds of inactivity after which the socket is closed (0 = never). The
 * scope serves one TCP client at a time, so holding the connection open
 * blocks any other client — e.g. a second MCP host using the same scope.
 */
function idleTimeoutMs(): number {
  const secs = parseFloat(process.env.SIGLENT_IDLE_TIMEOUT || "0");
  return Number.isFinite(secs) && secs > 0 ? secs * 1000 : 0;
}

/** Channel count from the model name, e.g. SDS1202X-E -> 2, SDS1104X-E -> 4 */
export function channelCountFromModel(model: string): number | undefined {
  const m = /SDS\d{3}(\d)/i.exec(model);
  return m ? parseInt(m[1], 10) : undefined;
}

interface QueuedQuery {
  cmd: string;
  /** Command written (and flushed) before `cmd`, e.g. a setter paced by *OPC? */
  pre?: string;
  binary: boolean;
  timeout: number;
  resolve: (value: Buffer) => void;
  reject: (reason: Error) => void;
}

export class SiglentConnection {
  private socket: net.Socket | null = null;
  private host = "";
  private port = DEFAULT_PORT;
  private dataBuffer = Buffer.alloc(0);
  private responseResolve: ((value: Buffer) => void) | null = null;
  private responseReject: ((reason: Error) => void) | null = null;
  private responseTimer: ReturnType<typeof setTimeout> | null = null;
  private expectedBinaryLength: number | null = null;
  private binaryDataStart: number = 0;
  private headerParsed = false;
  private queryQueue: QueuedQuery[] = [];
  private queryRunning = false;
  private model = "";
  private connecting: Promise<string> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  // Set by an explicit disconnect() so we don't silently reconnect afterwards
  private autoConnectSuppressed = false;

  async connect(host: string, port: number = DEFAULT_PORT): Promise<string> {
    // Track the attempt so tool calls made meanwhile wait for it (and get its
    // error) instead of queueing on a socket that may not initialize.
    const attempt = this.openConnection(host, port);
    this.connecting = attempt;
    try {
      return await attempt;
    } finally {
      if (this.connecting === attempt) this.connecting = null;
    }
  }

  private async openConnection(host: string, port: number): Promise<string> {
    if (this.socket) {
      this.close();
    }

    this.host = host;
    this.port = port;
    this.autoConnectSuppressed = false;

    return new Promise((resolve, reject) => {
      const socket = new net.Socket();

      const connectTimeout = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Connection timeout to ${host}:${port}`));
      }, 5000);

      socket.on("connect", async () => {
        clearTimeout(connectTimeout);
        // Remove the connect-phase error handler before installing runtime handlers
        socket.removeAllListeners("error");
        this.socket = socket;
        this.setupSocketListeners();

        try {
          // Drain the welcome banner the scope sends on TCP connect
          await this.delay(200);
          this.dataBuffer = Buffer.alloc(0);

          // Set CHDR OFF for clean numeric responses
          await this.enqueueQuery("*OPC?", false, DEFAULT_TIMEOUT, "CHDR OFF");
          await this.delay(100);

          // Query identification
          const idn = (
            await this.enqueueQuery("*IDN?", false, DEFAULT_TIMEOUT)
          )
            .toString("utf-8")
            .trim();
          this.model = idn.split(",")[1]?.trim() ?? "";
          resolve(idn);
        } catch (err) {
          this.close();
          const msg = err instanceof Error ? err.message : String(err);
          reject(
            new Error(
              /timeout/i.test(msg)
                ? `${host}:${port} accepted the connection but did not respond. ` +
                  `The scope serves one client at a time, so it is probably in ` +
                  `use by another program (another MCP server, EasyScopeX, ...). ` +
                  `Close that connection and try again.`
                : `Connected but failed to initialize: ${msg}`
            )
          );
        }
      });

      socket.on("error", (err) => {
        clearTimeout(connectTimeout);
        reject(new Error(`Connection failed: ${err.message}`));
      });

      socket.connect(port, host);
    });
  }

  /** Close the connection and don't auto-reconnect until connect() is called */
  disconnect(): void {
    this.autoConnectSuppressed = true;
    this.close();
  }

  private close(): void {
    this.clearIdleTimer();
    const pending = this.queryQueue.splice(0);
    this.queryRunning = false;
    if (this.responseReject) {
      this.responseReject(new Error("Connection closed"));
    }
    this.clearPending();
    for (const q of pending) {
      q.reject(new Error("Connection closed"));
    }
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
    this.dataBuffer = Buffer.alloc(0);
  }

  isConnected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  /** Model name from *IDN?, e.g. "SDS1202X-E" (empty until connected) */
  getModel(): string {
    return this.model;
  }

  /**
   * Throw if `channel` (e.g. "C3") doesn't exist on the connected model.
   * A 2-channel scope answers C3/C4 queries with placeholder values rather
   * than an error, so without this check tools return plausible junk.
   */
  async checkChannel(channel: string): Promise<void> {
    await this.ensureReady();
    const count = channelCountFromModel(this.model);
    const n = /^C(\d)$/.exec(channel);
    if (count !== undefined && n && parseInt(n[1], 10) > count) {
      throw new Error(
        `${channel} does not exist on the ${this.model} (${count} channels: C1-C${count})`
      );
    }
  }

  getConnectionInfo(): string {
    if (!this.isConnected()) return "Not connected";
    return `${this.host}:${this.port}`;
  }

  async sendCommand(cmd: string): Promise<void> {
    await this.ensureReady();
    // The scope silently drops commands that arrive while it is still applying
    // the previous one (e.g. a VDIV change takes ~250ms on SDS1202X-E fw 1.3.27).
    // Follow each command with *OPC? and wait for its reply so commands are
    // paced by the scope itself. Going through the query queue also keeps the
    // pair from interleaving with concurrent queries.
    // The two must be separate writes: if "*OPC?" arrives in the same packet
    // the scope mis-parses the command's numeric argument and clamps it
    // (e.g. "TDIV 50US" becomes 1ns).
    await this.enqueueQuery("*OPC?", false, DEFAULT_TIMEOUT, cmd);
  }

  async query(cmd: string, timeout: number = DEFAULT_TIMEOUT): Promise<string> {
    await this.ensureReady();
    const buf = await this.enqueueQuery(cmd, false, timeout);
    return buf.toString("utf-8").trim();
  }

  async queryBinary(
    cmd: string,
    timeout: number = BINARY_TIMEOUT
  ): Promise<Buffer> {
    await this.ensureReady();
    return this.enqueueQuery(cmd, true, timeout);
  }

  private enqueueQuery(
    cmd: string,
    binary: boolean,
    timeout: number,
    pre?: string
  ): Promise<Buffer> {
    this.clearIdleTimer();
    const result = new Promise<Buffer>((resolve, reject) => {
      this.queryQueue.push({ cmd, pre, binary, timeout, resolve, reject });
      this.drainQueue();
    });
    result.then(
      () => this.scheduleIdleClose(),
      () => this.scheduleIdleClose()
    );
    return result;
  }

  private drainQueue(): void {
    if (this.queryRunning || this.queryQueue.length === 0) return;
    this.queryRunning = true;

    const { cmd, pre, binary, timeout, resolve, reject } =
      this.queryQueue.shift()!;

    this.expectedBinaryLength = null;
    this.binaryDataStart = 0;
    this.headerParsed = false;
    this.dataBuffer = Buffer.alloc(0);

    this.responseResolve = (buf) => {
      this.queryRunning = false;
      resolve(buf);
      this.drainQueue();
    };
    this.responseReject = (err) => {
      this.queryRunning = false;
      reject(err);
      this.drainQueue();
    };

    this.responseTimer = setTimeout(() => {
      this.clearPending();
      const err = new Error(
        `${binary ? "Binary query" : "Query"} timeout after ${timeout}ms for command: ${pre ? `${pre} (${cmd})` : cmd}`
      );
      this.queryRunning = false;
      reject(err);
      this.drainQueue();
    }, timeout);

    const writeLine = (line: string, next?: () => void): void => {
      this.socket!.write(line + "\n", (err) => {
        if (err) {
          this.clearPending();
          this.queryRunning = false;
          reject(new Error(`Write failed: ${err.message}`));
          this.drainQueue();
        } else {
          next?.();
        }
      });
    };

    if (pre !== undefined) {
      writeLine(pre, () =>
        setTimeout(() => this.socket && writeLine(cmd), OPC_GAP_MS)
      );
    } else {
      writeLine(cmd);
    }
  }

  private setupSocketListeners(): void {
    this.socket!.on("data", (chunk: Buffer) => {
      this.dataBuffer = Buffer.concat([this.dataBuffer, chunk]);
      this.tryResolve();
    });

    this.socket!.on("close", () => {
      // Drain queued queries first so drainQueue() in the reject callback is a no-op
      const pending = this.queryQueue.splice(0);
      this.queryRunning = false;
      if (this.responseReject) {
        this.responseReject(new Error("Connection closed unexpectedly"));
      }
      this.clearPending();
      for (const q of pending) {
        q.reject(new Error("Connection closed unexpectedly"));
      }
      this.socket = null;
    });

    this.socket!.on("error", (err) => {
      if (this.responseReject) {
        this.responseReject(new Error(`Socket error: ${err.message}`));
      }
      this.clearPending();
    });
  }

  private tryResolve(): void {
    if (!this.responseResolve) return;

    // Try to detect the binary framing format
    if (!this.headerParsed && this.dataBuffer.length >= 6) {
      // Check for raw BMP: starts with "BM" magic bytes, file size at offset 2-5 (LE)
      if (this.dataBuffer[0] === 0x42 && this.dataBuffer[1] === 0x4d) {
        const bmpSize = this.dataBuffer.readUInt32LE(2);
        if (bmpSize > 0 && bmpSize < 100_000_000) {
          this.expectedBinaryLength = bmpSize;
          this.binaryDataStart = 0;
          this.headerParsed = true;
        }
      }

      // Check for IEEE 488.2 definite length block: #<digitCount><digits><data>
      // e.g. #9000012345 (9-digit length) or #71152054 (7-digit length)
      if (!this.headerParsed) {
        const hashIndex = this.dataBuffer.indexOf(0x23); // '#' character
        if (hashIndex >= 0 && hashIndex + 2 <= this.dataBuffer.length) {
          const digitCount = this.dataBuffer[hashIndex + 1] - 0x30;
          if (digitCount >= 1 && digitCount <= 9) {
            const headerSize = 2 + digitCount;
            if (hashIndex + headerSize <= this.dataBuffer.length) {
              const lengthStr = this.dataBuffer
                .subarray(hashIndex + 2, hashIndex + headerSize)
                .toString("ascii");
              const dataLength = parseInt(lengthStr, 10);
              if (!isNaN(dataLength) && dataLength > 0) {
                this.expectedBinaryLength = dataLength;
                this.binaryDataStart = hashIndex + headerSize;
                this.headerParsed = true;
              }
            }
          }
        }
      }
    }

    if (this.expectedBinaryLength !== null && this.headerParsed) {
      // Binary mode: wait for all expected data (+ trailing bytes for IEEE 488.2)
      const trailingBytes = this.binaryDataStart === 0 ? 1 : 2; // raw: +\n, IEEE: +\n\n
      const totalExpected = this.binaryDataStart + this.expectedBinaryLength + trailingBytes;
      if (this.dataBuffer.length >= totalExpected) {
        const binaryData = this.dataBuffer.subarray(
          this.binaryDataStart,
          this.binaryDataStart + this.expectedBinaryLength
        );
        const resolve = this.responseResolve;
        this.clearPending();
        resolve(Buffer.from(binaryData));
      }
    } else {
      // Text mode: look for newline terminator
      const newlineIndex = this.dataBuffer.indexOf(0x0a); // \n
      if (newlineIndex >= 0) {
        const response = this.dataBuffer.subarray(0, newlineIndex);
        const resolve = this.responseResolve;
        this.clearPending();
        resolve(Buffer.from(response));
      }
    }
  }

  private clearPending(): void {
    if (this.responseTimer) {
      clearTimeout(this.responseTimer);
      this.responseTimer = null;
    }
    this.responseResolve = null;
    this.responseReject = null;
    this.expectedBinaryLength = null;
    this.binaryDataStart = 0;
    this.headerParsed = false;
  }

  /**
   * Make sure there is a live connection, opening one on demand to the last
   * host (or SIGLENT_IP) if it was closed, e.g. by the idle timeout.
   */
  private async ensureReady(): Promise<void> {
    if (this.connecting) {
      await this.connecting;
      return;
    }
    if (this.isConnected()) return;
    const host = this.host || process.env.SIGLENT_IP;
    if (!host || this.autoConnectSuppressed) {
      throw new Error(
        "Not connected to oscilloscope. Use the 'connect' tool first."
      );
    }
    const port = this.host
      ? this.port
      : parseInt(process.env.SIGLENT_PORT || String(DEFAULT_PORT), 10);
    await this.connect(host, port);
  }

  private scheduleIdleClose(): void {
    const ms = idleTimeoutMs();
    if (!ms || this.queryRunning || this.queryQueue.length > 0) return;
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.queryRunning && this.queryQueue.length === 0) {
        console.error(`Idle for ${ms / 1000}s, releasing the scope connection`);
        this.close();
      }
    }, ms);
    // Don't keep the process alive just for this timer
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }


  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Singleton instance
export const connection = new SiglentConnection();
