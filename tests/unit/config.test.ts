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
  });

  it.each([
    ["SIGLENT_PORT", "abc"],
    ["SIGLENT_PORT", "70000"],
    ["SIGLENT_IDLE_TIMEOUT", "-1"],
    ["SIGLENT_IDLE_TIMEOUT", "soon"],
  ])("fails on invalid %s=%s instead of ignoring it", (name, value) => {
    expect(() => loadConfig({ [name]: value })).toThrow();
  });
});
