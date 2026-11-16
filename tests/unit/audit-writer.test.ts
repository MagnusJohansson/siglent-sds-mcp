import { describe, it, expect } from "vitest";
import { FdWriter } from "../../src/audit/writer.js";
import { bound, boundArguments, MAX_LINE_BYTES, serialise, summariseContent } from "../../src/audit/bounds.js";

type Callback = (err: NodeJS.ErrnoException | null, written: number) => void;

/** A fake fs.write: each call is answered by the next step, or held until released. */
function fakeWrite(steps: Array<(len: number) => { err?: string; written?: number }>) {
  const out: string[] = [];
  let calls = 0;
  const write = (_fd: number, buf: Buffer, offset: number, length: number, _pos: null, cb: Callback) => {
    const step = steps[calls++] ?? (() => ({}));
    const r = step(length);
    if (r.err) {
      setImmediate(() => cb(Object.assign(new Error(r.err), { code: r.err }), 0));
      return;
    }
    const n = r.written ?? length;
    out.push(buf.subarray(offset, offset + n).toString());
    setImmediate(() => cb(null, n));
  };
  return { write, out, calls: () => calls };
}

describe("FdWriter", () => {
  it("writes lines in order, one write at a time", async () => {
    const f = fakeWrite([]);
    const w = new FdWriter(9, { write: f.write });
    expect(w.write("a\n")).toBe(true);
    expect(w.write("b\n")).toBe(true);
    expect(await w.flush(1000)).toBe(true);
    expect(f.out.join("")).toBe("a\nb\n");
  });

  it("continues a short write from the remaining bytes", async () => {
    const f = fakeWrite([() => ({ written: 3 }), () => ({ written: 2 })]);
    const w = new FdWriter(9, { write: f.write });
    w.write("hello\n");
    w.write("x\n");
    await w.flush(1000);
    expect(f.out.join("")).toBe("hello\nx\n");
  });

  it("retries EAGAIN with a backoff instead of dropping the line", async () => {
    const f = fakeWrite([() => ({ err: "EAGAIN" }), () => ({ err: "EAGAIN" })]);
    const w = new FdWriter(9, { write: f.write });
    w.write("line\n");
    const started = Date.now();
    expect(await w.flush(2000)).toBe(true);
    expect(f.out.join("")).toBe("line\n");
    expect(Date.now() - started).toBeGreaterThanOrEqual(25); // 10 ms, then 20 ms
  });

  it("on EPIPE, loses everything queued, reports each loss and accepts nothing more", async () => {
    const f = fakeWrite([() => ({ err: "EPIPE" })]);
    const w = new FdWriter(9, { write: f.write });
    let lost = 0;
    w.write("a\n", () => lost++);
    w.write("b\n", () => lost++);
    w.write("c\n", () => lost++);
    await w.flush(1000);
    expect(lost).toBe(3);
    expect(w.isClosed).toBe(true);
    expect(w.write("d\n")).toBe(false);
    expect(f.calls()).toBe(1); // no retry
  });

  it("resolves a waiting flush as soon as EPIPE closes the writer", async () => {
    const held: Callback[] = [];
    const w = new FdWriter(9, { write: (_fd, _buf, _off, _len, _pos, cb) => held.push(cb) });
    w.write("a\n");
    const started = Date.now();
    const flushed = w.flush(5000);
    held[0](Object.assign(new Error("EPIPE"), { code: "EPIPE" }), 0);
    await flushed;
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("starts a fresh line after a line that failed part-way", async () => {
    const f = fakeWrite([() => ({ written: 3 }), () => ({ err: "ENOSPC" })]);
    const w = new FdWriter(9, { write: f.write });
    let lost = 0;
    w.write("hello\n", () => lost++);
    w.write("next\n");
    await w.flush(1000);
    expect(lost).toBe(1);
    // The fragment "hel" is ended, so "next" parses as its own line.
    expect(f.out.join("")).toBe("hel\nnext\n");
  });

  it("reports a write in the thread pool, but not one waiting out a backoff", async () => {
    const held: Callback[] = [];
    const w = new FdWriter(9, { write: (_fd, _buf, _off, _len, _pos, cb) => held.push(cb) });
    w.write("a\n");
    expect(w.writeInFlight).toBe(true);
    held[0](Object.assign(new Error("EAGAIN"), { code: "EAGAIN" }), 0);
    expect(w.writeInFlight).toBe(false); // waiting for the retry timer
  });

  it("loses only the failing line on another error", async () => {
    const f = fakeWrite([() => ({ err: "EIO" })]);
    const w = new FdWriter(9, { write: f.write });
    let lost = 0;
    w.write("a\n", () => lost++);
    w.write("b\n", () => lost++);
    await w.flush(1000);
    expect(lost).toBe(1);
    expect(f.out.join("")).toBe("b\n");
  });

  it("drops lines when the queue is full, without waiting", () => {
    const held: Callback[] = [];
    const w = new FdWriter(9, {
      maxQueue: 2,
      write: (_fd, _buf, _off, _len, _pos, cb) => held.push(cb), // never completes: a stuck pipe
    });
    expect(w.write("1\n")).toBe(true);
    expect(w.write("2\n")).toBe(true);
    expect(w.write("3\n")).toBe(false);
    expect(w.pending).toBe(2);
  });

  it("flush gives up after the timeout when the descriptor is stuck", async () => {
    const w = new FdWriter(9, { write: () => {} });
    w.write("x\n");
    expect(await w.flush(50)).toBe(false);
  });
});

describe("bounds", () => {
  it("bounds strings and marks the cut", () => {
    expect(bound("abc", 5)).toBe("abc");
    expect(bound("abcdefgh", 5)).toBe("abcde…[truncated, 8 chars]");
  });

  it("bounds each string in the arguments and the arguments as a whole", () => {
    const one = JSON.parse(boundArguments({ load: "x".repeat(600) })) as { load: string };
    expect(one.load).toMatch(/^x{512}…\[truncated, 600 chars\]$/);
    const many = boundArguments(Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, "y".repeat(500)])));
    expect(many.length).toBeLessThan(4200);
  });

  it("summarises content as types and sizes, never the content", () => {
    expect(summariseContent([{ type: "text", text: "hello" }, { type: "image", data: "QUJD" }])).toBe("text:5,image:4");
  });

  it("cuts the longest fields until a line fits", () => {
    const line = serialise({ a: "x".repeat(20000), b: "keep", n: 1 });
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(MAX_LINE_BYTES);
    const r = JSON.parse(line) as Record<string, unknown>;
    expect(r.b).toBe("keep");
    expect(r["audit.truncated"]).toBe(true);
  });
});
