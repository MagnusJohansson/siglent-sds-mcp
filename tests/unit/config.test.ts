import { describe, it, expect } from "vitest";
import { loadConfig } from "../../src/config.js";

describe("loadConfig", () => {
  it("defaults to secure settings with an empty environment", () => {
    const c = loadConfig({});
    expect(c.rawScpiEnabled).toBe(false);
    expect(c.defaultHost).toBeUndefined();
    expect(c.defaultPort).toBe(5025);
    expect(c.idleTimeoutMs).toBe(0);
    expect(c.hostPolicy).toEqual({ allowedHosts: [], allowedPorts: [5025] });
  });

  it("allows the configured scope host and port", () => {
    const c = loadConfig({ SIGLENT_IP: "192.168.1.126", SIGLENT_PORT: "5026" });
    expect(c.hostPolicy.allowedHosts).toEqual(["192.168.1.126"]);
    expect(c.hostPolicy.allowedPorts).toEqual([5025, 5026]);
  });

  it("merges explicitly allowed hosts with the configured scope", () => {
    const c = loadConfig({ SIGLENT_IP: "10.0.0.5", SIGLENT_ALLOWED_HOSTS: "10.0.0.6, sds.lab" });
    expect(c.hostPolicy.allowedHosts).toEqual(["10.0.0.6", "sds.lab", "10.0.0.5"]);
  });

  it("enables raw SCPI only when explicitly asked", () => {
    expect(loadConfig({ SIGLENT_IP: "192.168.1.126", SIGLENT_ALLOW_RAW_SCPI: "true" }).rawScpiEnabled).toBe(true);
    expect(loadConfig({ SIGLENT_IP: "192.168.1.126", SIGLENT_ALLOW_RAW_SCPI: "no" }).rawScpiEnabled).toBe(false);
  });

  it("refuses raw SCPI unless the reachable hosts are named", () => {
    expect(() => loadConfig({ SIGLENT_ALLOW_RAW_SCPI: "true" })).toThrow(/requires SIGLENT_IP/);
    expect(() =>
      loadConfig({ SIGLENT_ALLOW_RAW_SCPI: "true", SIGLENT_ALLOWED_HOSTS: "*" })
    ).toThrow(/not accepted/);
  });

  it("parses the idle timeout in seconds", () => {
    expect(loadConfig({ SIGLENT_IDLE_TIMEOUT: "60" }).idleTimeoutMs).toBe(60_000);
    expect(loadConfig({ SIGLENT_IDLE_TIMEOUT: "0.5" }).idleTimeoutMs).toBe(500);
    expect(loadConfig({ SIGLENT_IDLE_TIMEOUT: "2147483" }).idleTimeoutMs).toBe(2_147_483_000);
  });

  it.each([
    ["SIGLENT_PORT", "abc"],
    ["SIGLENT_PORT", "70000"],
    ["SIGLENT_IDLE_TIMEOUT", "-1"],
    ["SIGLENT_IDLE_TIMEOUT", "soon"],
    // Beyond setTimeout's range, Node would fire after 1 ms instead.
    ["SIGLENT_IDLE_TIMEOUT", "2592000"],
  ])("fails on invalid %s=%s instead of ignoring it", (name, value) => {
    expect(() => loadConfig({ [name]: value })).toThrow();
  });
});

describe("SIGLENT_AUDIT_LOG", () => {
  it.each([
    [undefined, { sink: "stderr", level: "security" }],
    ["", { sink: "stderr", level: "security" }],
    ["stderr", { sink: "stderr", level: "full" }],
    ["STDERR", { sink: "stderr", level: "full" }],
    ["off", { sink: "off" }],
    ["/var/log/sdg.jsonl", { sink: "file", level: "full", path: "/var/log/sdg.jsonl" }],
  ])("%s -> %o", (value, expected) => {
    expect(loadConfig(value === undefined ? {} : { SIGLENT_AUDIT_LOG: value }).audit).toEqual(expected);
  });

  it.each(["audit.jsonl", "./logs/a.jsonl", "on"])("fails closed on %s (not an absolute path)", (value) => {
    expect(() => loadConfig({ SIGLENT_AUDIT_LOG: value })).toThrow(/SIGLENT_AUDIT_LOG/);
  });
});

describe("OTLP export configuration", () => {
  it("is off without an endpoint", () => {
    expect(loadConfig({}).otlp).toBeUndefined();
  });

  it("uses OTEL_EXPORTER_OTLP_ENDPOINT, logged without userinfo, query or fragment", () => {
    const c = loadConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "https://user:pw@collector.example:4318/base?api_key=x#f", SIGLENT_AUDIT_OTLP: "1" });
    // The exporter appends /v1/logs to the generic endpoint; the logged URL is the one it posts to.
    expect(c.otlp).toEqual({ endpoint: "https://collector.example:4318/base/v1/logs" });
  });

  it("needs an opt-in for the generic endpoint, which is often inherited", () => {
    const generic = loadConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://a.example:4318" });
    expect(generic.otlp).toBeUndefined();
    expect(generic.notes.join("\n")).toMatch(/isn't exported: set SIGLENT_AUDIT_OTLP=1/);
    expect(loadConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://a.example:4318", SIGLENT_AUDIT_OTLP: "true" }).otlp).toBeDefined();
    // The logs-specific endpoint is the opt-in itself.
    expect(loadConfig({ OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://a.example:4318/v1/logs" }).otlp).toBeDefined();
  });

  it("fails closed on the opt-in without an endpoint, unless the export is switched off", () => {
    expect(() => loadConfig({ SIGLENT_AUDIT_OTLP: "1" })).toThrow(/SIGLENT_AUDIT_OTLP=1 needs OTEL_EXPORTER_OTLP_ENDPOINT/);
    expect(loadConfig({ SIGLENT_AUDIT_OTLP: "1", OTEL_LOGS_EXPORTER: "none" }).otlp).toBeUndefined();
    expect(loadConfig({ SIGLENT_AUDIT_OTLP: "1", OTEL_SDK_DISABLED: "true" }).otlp).toBeUndefined();
  });

  it("prefers OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", () => {
    const c = loadConfig({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://a.example:4318",
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://b.example:4318/v1/logs",
    });
    expect(c.otlp?.endpoint).toBe("http://b.example:4318/v1/logs");
  });

  it("honours OTEL_LOGS_EXPORTER", () => {
    const base = { OTEL_EXPORTER_OTLP_ENDPOINT: "http://a.example:4318", SIGLENT_AUDIT_OTLP: "1" };
    expect(loadConfig({ ...base, OTEL_LOGS_EXPORTER: "none" }).otlp).toBeUndefined();
    expect(loadConfig({ ...base, OTEL_LOGS_EXPORTER: "otlp" }).otlp).toBeDefined();
    const console = loadConfig({ ...base, OTEL_LOGS_EXPORTER: "console" });
    expect(console.otlp).toBeUndefined();
    expect(console.notes.join("\n")).toMatch(/OTEL_LOGS_EXPORTER=console is not supported/);
  });

  it("respects OTEL_SDK_DISABLED", () => {
    expect(loadConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://a.example:4318", SIGLENT_AUDIT_OTLP: "1", OTEL_SDK_DISABLED: "true" }).otlp).toBeUndefined();
  });

  it.each(["not a url", "ftp://a.example/", "localhost:4318"])("fails closed on the endpoint %s", (value) => {
    expect(() => loadConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: value, SIGLENT_AUDIT_OTLP: "1" })).toThrow(/OTEL_EXPORTER_OTLP_ENDPOINT/);
  });

  it("notes an unsupported protocol instead of ignoring it silently", () => {
    const c = loadConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://a.example:4318", SIGLENT_AUDIT_OTLP: "1", OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" });
    expect(c.notes.join("\n")).toMatch(/grpc is not supported/);
  });
});
