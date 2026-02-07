import * as net from "node:net";

const DEFAULT_PORT = 5025;
const DEFAULT_TIMEOUT = 5000;
const BINARY_TIMEOUT = 30000;

interface QueuedQuery {
  cmd: string;
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

  async connect(host: string, port: number = DEFAULT_PORT): Promise<string> {
    if (this.socket) {
      this.disconnect();
    }

    this.host = host;
    this.port = port;

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
          await this.sendCommand("CHDR OFF");
          await this.delay(100);

          // Query identification
          const idn = await this.query("*IDN?");
          resolve(idn);
        } catch (err) {
          this.disconnect();
          reject(
            new Error(
              `Connected but failed to initialize: ${err instanceof Error ? err.message : String(err)}`
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

  disconnect(): void {
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

  getConnectionInfo(): string {
    if (!this.isConnected()) return "Not connected";
    return `${this.host}:${this.port}`;
  }

  async sendCommand(cmd: string): Promise<void> {
    this.ensureConnected();
    return new Promise((resolve, reject) => {
      this.socket!.write(cmd + "\n", (err) => {
        if (err) reject(new Error(`Write failed: ${err.message}`));
        else resolve();
      });
    });
  }

  async query(cmd: string, timeout: number = DEFAULT_TIMEOUT): Promise<string> {
    this.ensureConnected();
    const buf = await this.enqueueQuery(cmd, false, timeout);
    return buf.toString("utf-8").trim();
  }

  async queryBinary(
    cmd: string,
    timeout: number = BINARY_TIMEOUT
  ): Promise<Buffer> {
    this.ensureConnected();
    return this.enqueueQuery(cmd, true, timeout);
  }

  private enqueueQuery(
    cmd: string,
    binary: boolean,
    timeout: number
  ): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      this.queryQueue.push({ cmd, binary, timeout, resolve, reject });
      this.drainQueue();
    });
  }

  private drainQueue(): void {
    if (this.queryRunning || this.queryQueue.length === 0) return;
    this.queryRunning = true;

    const { cmd, binary, timeout, resolve, reject } = this.queryQueue.shift()!;

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
        `${binary ? "Binary query" : "Query"} timeout after ${timeout}ms for command: ${cmd}`
      );
      this.queryRunning = false;
      reject(err);
      this.drainQueue();
    }, timeout);

    this.socket!.write(cmd + "\n", (err) => {
      if (err) {
        this.clearPending();
        this.queryRunning = false;
        reject(new Error(`Write failed: ${err.message}`));
        this.drainQueue();
      }
    });
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

  private ensureConnected(): void {
    if (!this.isConnected()) {
      throw new Error(
        "Not connected to oscilloscope. Use the 'connect' tool first."
      );
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Singleton instance
export const connection = new SiglentConnection();
