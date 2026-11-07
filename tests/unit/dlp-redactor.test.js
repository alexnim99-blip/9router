import { describe, it, expect } from "vitest";
import {
  redactSecretsInText,
  redactSecretsInBody,
} from "../../open-sse/services/dlpRedactor.js";

describe("Data Loss Prevention (DLP) & Secret Redactor", () => {
  it("redacts OpenAI API keys", () => {
    const raw = "Here is my key: sk-proj-1234567890abcdef1234567890abcdef please test it";
    const res = redactSecretsInText(raw);
    expect(res.redactedCount).toBe(1);
    expect(res.text).toContain("[REDACTED_SECRET:OPENAI_KEY]");
    expect(res.text).not.toContain("sk-proj-");
  });

  it("redacts Anthropic API keys", () => {
    const raw = "Anthropic token: sk-ant-api03-abcdef1234567890abcdef12345";
    const res = redactSecretsInText(raw);
    expect(res.redactedCount).toBe(1);
    expect(res.text).toContain("[REDACTED_SECRET:ANTHROPIC_KEY]");
    expect(res.text).not.toContain("sk-ant-");
  });

  it("redacts Google AI API keys", () => {
    const raw = "AIzaSyD-1234567890abcdefghijklmnopqrstuv";
    const res = redactSecretsInText(raw);
    expect(res.redactedCount).toBe(1);
    expect(res.text).toContain("[REDACTED_SECRET:GOOGLE_API_KEY]");
  });

  it("redacts GitHub tokens", () => {
    const raw = "My token is ghp_123456789012345678901234567890123456";
    const res = redactSecretsInText(raw);
    expect(res.redactedCount).toBe(1);
    expect(res.text).toContain("[REDACTED_SECRET:GITHUB_TOKEN]");
  });

  it("redacts AWS Access Keys", () => {
    const raw = "AWS key: AKIAIOSFODNN7EXAMPLE";
    const res = redactSecretsInText(raw);
    expect(res.redactedCount).toBe(1);
    expect(res.text).toContain("[REDACTED_SECRET:AWS_ACCESS_KEY]");
  });

  it("redacts Private SSH / RSA keys", () => {
    const raw = `
-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA0mFk7qV1a7...
-----END RSA PRIVATE KEY-----
    `;
    const res = redactSecretsInText(raw);
    expect(res.redactedCount).toBe(1);
    expect(res.text).toContain("[REDACTED_SECRET:PRIVATE_KEY]");
  });

  it("redacts database credentials in URLs", () => {
    const raw = "Connect to postgres://postgres:SuperSecretPassword123@db.example.com:5432/mydb";
    const res = redactSecretsInText(raw);
    expect(res.redactedCount).toBe(1);
    expect(res.text).toContain("postgres://postgres:[REDACTED_SECRET:DB_PASSWORD]@db.example.com:5432/mydb");
    expect(res.text).not.toContain("SuperSecretPassword123");
  });

  it("redacts secrets inside chat messages body", () => {
    const body = {
      model: "claude-3-5-sonnet",
      messages: [
        { role: "user", content: "Debug my config: sk-proj-1234567890abcdef1234567890" },
      ],
    };

    const res = redactSecretsInBody(body);
    expect(res.redactedCount).toBe(1);
    expect(res.body.messages[0].content).toContain("[REDACTED_SECRET:OPENAI_KEY]");
  });
});
