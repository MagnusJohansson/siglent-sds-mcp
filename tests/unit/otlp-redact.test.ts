import { describe, it, expect } from "vitest";
import { redactText, redactUrl } from "../../src/audit/otlp.js";

describe("OTLP redaction", () => {
  it("redacts URL userinfo, query and fragment", () => {
    expect(redactUrl("https://u:p@c.example:4318/v1/logs?k=v#x")).toBe("https://c.example:4318/v1/logs");
  });

  it("removes credentials from diagnostic text", () => {
    const env = { OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer%20s3cret-token,x-api-key=abcd1234" };
    const text =
      "export to https://user:pw@c.example/v1/logs?api_key=zzz failed; header Bearer s3cret-token rejected, key abcd1234";
    const out = redactText(text, env);
    expect(out).not.toMatch(/pw|zzz|s3cret-token|abcd1234/);
    expect(out).toContain("https://***@c.example/v1/logs?***");
  });

  it("removes the bare token of a 'Bearer <token>' header value, as a response body might echo it", () => {
    const env = { OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer%20secrettoken123" };
    const out = redactText("invalid api key secrettoken123 (header was Bearer secrettoken123)", env);
    expect(out).not.toContain("secrettoken123");
  });
});
