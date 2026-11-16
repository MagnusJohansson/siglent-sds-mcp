/**
 * A writer that never blocks the event loop.
 *
 * Node's own stderr writes are synchronous for pipes and files on Linux. A
 * client that pipes the server's stderr and never reads it would fill the
 * pipe (~64 KB) and stall every tool call; so would a file on a hung network
 * filesystem. This writer keeps lines in a bounded queue and drains it with
 * one `fs.write` at a time on the libuv thread pool. When the descriptor is
 * blocking, a stuck write ties up one pool thread, never the event loop; when
 * it's non-blocking (stderr usually is, because Node's process.stderr sets
 * O_NONBLOCK once anything reads it), a full pipe returns EAGAIN and the
 * writer retries with a backoff. When the queue is full, lines are dropped
 * and the caller is told, so the loss can be counted.
 *
 * It is the only writer to its descriptor, so a short write is simply
 * continued: lines are never interleaved, whatever the platform's PIPE_BUF.
 */
import * as fs from "node:fs";

type WriteFn = (
  fd: number,
  buffer: Buffer,
  offset: number,
  length: number,
  position: null,
  callback: (err: NodeJS.ErrnoException | null, written: number) => void
) => void;

export interface FdWriterOptions {
  /** Maximum number of lines waiting to be written. */
  maxQueue?: number;
  /** Replaceable for tests. */
  write?: WriteFn;
}

interface Item {
  buf: Buffer;
  /** Called if the line is lost after it was accepted. */
  onLost?: () => void;
}

const MAX_BACKOFF_MS = 1000;

export class FdWriter {
  private readonly queue: Item[] = [];
  private readonly maxQueue: number;
  private readonly writeFn: WriteFn;
  private writing = false;
  /** An fs.write is in the thread pool right now (not just waiting out a backoff). */
  private inPool = false;
  /** A write failed part-way: the next line must start on a fresh line. */
  private fragment = false;
  private closed = false;
  private backoffMs = 0;
  private idleWaiters: Array<() => void> = [];

  constructor(
    private readonly fd: number,
    options: FdWriterOptions = {}
  ) {
    this.maxQueue = options.maxQueue ?? 4096;
    this.writeFn = options.write ?? (fs.write as unknown as WriteFn);
  }

  /** Queue a line (include the newline). Returns false if it was dropped. */
  write(line: string, onLost?: () => void): boolean {
    if (this.closed || this.queue.length >= this.maxQueue) return false;
    this.queue.push({ buf: Buffer.from(line, "utf8"), onLost });
    this.pump();
    return true;
  }

  /** Lines accepted but not yet fully written. */
  get pending(): number {
    return this.queue.length;
  }

  /**
   * True while an fs.write is in the thread pool. Node joins the pool when the
   * process exits, so exiting now would wait for that write, possibly forever
   * (a hung network filesystem, a FIFO nobody reads).
   */
  get writeInFlight(): boolean {
    return this.inPool;
  }

  /** True once the reader has gone (EPIPE) or the descriptor is invalid. */
  get isClosed(): boolean {
    return this.closed;
  }

  /** Resolves true when the queue is empty, false if the timeout passes first. */
  flush(timeoutMs: number): Promise<boolean> {
    if (!this.writing && this.queue.length === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.idleWaiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  private pump(): void {
    if (this.writing) return;
    const item = this.queue[0];
    if (!item || this.closed) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const w of waiters) w();
      return;
    }
    if (this.fragment) {
      // The previous line was cut off part-way: end it, so this one parses.
      item.buf = Buffer.concat([Buffer.from("\n"), item.buf]);
      this.fragment = false;
    }
    this.writing = true;
    this.writeFrom(item, 0);
  }

  private writeFrom(item: Item, offset: number): void {
    this.inPool = true;
    this.writeFn(this.fd, item.buf, offset, item.buf.length - offset, null, (err, written) => {
      this.inPool = false;
      if (err) {
        if (err.code === "EAGAIN") {
          // Non-blocking descriptor that is full: retry the same bytes later.
          this.backoffMs = Math.min(this.backoffMs === 0 ? 10 : this.backoffMs * 2, MAX_BACKOFF_MS);
          setTimeout(() => this.writeFrom(item, offset), this.backoffMs);
          return;
        }
        if (err.code === "EPIPE" || err.code === "EBADF") {
          // The reader has gone: nothing queued can be delivered any more.
          this.closed = true;
          for (const q of this.queue.splice(0)) q.onLost?.();
          this.writing = false;
          this.pump();
          return;
        }
        // Any other error (ENOSPC, EIO) loses this line only.
        if (offset > 0) this.fragment = true;
        this.queue.shift();
        item.onLost?.();
        this.writing = false;
        this.pump();
        return;
      }
      this.backoffMs = 0;
      if (offset + written < item.buf.length) {
        this.writeFrom(item, offset + written);
        return;
      }
      this.queue.shift();
      this.writing = false;
      this.pump();
    });
  }
}
