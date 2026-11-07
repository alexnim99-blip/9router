import { describe, expect, it, beforeEach, vi } from "vitest";
import dns from "node:dns";
import {
  resolveDomain,
  resolveRealIP,
  resolveTargetIP,
  resolveViaUdp,
  resolveViaDoh,
  clearDnsCache,
  getDnsCacheSize,
  isMitmInterceptedHost,
  DEFAULT_DNS_SERVERS,
} from "../../open-sse/utils/dnsResolver.js";
import { resolveDns } from "../../src/lib/tunnel/shared/dnsResolver.js";

describe("dnsResolver", () => {
  beforeEach(() => {
    clearDnsCache();
  });

  it("exports the required functions and constants", () => {
    expect(typeof resolveDomain).toBe("function");
    expect(typeof resolveRealIP).toBe("function");
    expect(typeof resolveTargetIP).toBe("function");
    expect(typeof resolveViaUdp).toBe("function");
    expect(typeof resolveViaDoh).toBe("function");
    expect(Array.isArray(DEFAULT_DNS_SERVERS)).toBe(true);
    expect(DEFAULT_DNS_SERVERS).toContain("8.8.8.8");
    expect(DEFAULT_DNS_SERVERS).toContain("1.1.1.1");
    expect(DEFAULT_DNS_SERVERS).toContain("223.5.5.5");
  });

  it("returns literal IP addresses immediately without resolution", async () => {
    expect(await resolveDomain("127.0.0.1")).toBe("127.0.0.1");
    expect(await resolveDomain("8.8.8.8")).toBe("8.8.8.8");
    expect(await resolveDomain("::1")).toBe("::1");
  });

  it("identifies MITM intercepted hosts correctly", () => {
    expect(isMitmInterceptedHost("cloudcode-pa.googleapis.com")).toBe(true);
    expect(isMitmInterceptedHost("daily-cloudcode-pa.googleapis.com")).toBe(true);
    expect(isMitmInterceptedHost("api2.cursor.sh")).toBe(true);
    expect(isMitmInterceptedHost("api.individual.githubcopilot.com")).toBe(true);
    expect(isMitmInterceptedHost("runtime.us-east-1.kiro.dev")).toBe(true);
    expect(isMitmInterceptedHost("example.com")).toBe(false);
  });

  it("caches resolved domains and returns cached IP on subsequent calls", async () => {
    expect(getDnsCacheSize()).toBe(0);
    const ip1 = await resolveDomain("google.com");
    expect(ip1).toBeTruthy();
    expect(getDnsCacheSize()).toBeGreaterThanOrEqual(1);

    const ip2 = await resolveDomain("google.com");
    expect(ip2).toBe(ip1);
  });

  it("resolves via Google DoH (DNS-over-HTTPS)", async () => {
    const dohIp = await resolveViaDoh("google.com", { family: 4, timeoutMs: 3000 });
    expect(dohIp).toBeTruthy();
    expect(typeof dohIp).toBe("string");
  }, 10000);

  it("handles non-existent domains gracefully by returning null without crashing", async () => {
    const nonExistent = "this-domain-does-not-exist-" + Date.now() + ".invalid";
    const result = await resolveDomain(nonExistent, { timeoutMs: 300 });
    expect(result).toBeNull();
  }, 10000);

  it("refuses system DNS fallback for MITM hosts to prevent 127.0.0.1 loop", async () => {
    const lookupSpy = vi.spyOn(dns.promises, "lookup");
    const fakeMitmHost = "nonexistent-mitm-test-" + Date.now() + ".invalid";
    const result = await resolveDomain(fakeMitmHost, { isMitmBypass: true, timeoutMs: 300 });
    expect(result).toBeNull();
    expect(lookupSpy).not.toHaveBeenCalled();
    lookupSpy.mockRestore();
  }, 10000);

  it("tunnel resolveDns returns boolean true for valid domains and false for invalid", async () => {
    const valid = await resolveDns("google.com", 3000);
    expect(valid).toBe(true);

    const invalid = await resolveDns("non-existent-domain-test-" + Date.now() + ".invalid", 300);
    expect(invalid).toBe(false);
  }, 10000);
});
