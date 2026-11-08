import { describe, expect, it } from "vitest";
import { ipv4ToInt, isPubliclyRoutable } from "./ip";

describe("ipv4ToInt", () => {
  it("parses a normal valid IPv4 address", () => {
    expect(ipv4ToInt("192.168.1.1")).toBe(192 * 256 ** 3 + 168 * 256 ** 2 + 1 * 256 + 1);
  });

  it("rejects a trailing-dot truncated octet (Number('') is 0)", () => {
    expect(() => ipv4ToInt("1.2.3.")).toThrow();
  });

  it("rejects exponential notation (Number('1e2') is 100)", () => {
    expect(() => ipv4ToInt("1e2.2.3.4")).toThrow();
  });

  it("rejects hex notation (Number('0x10') is 16)", () => {
    expect(() => ipv4ToInt("0x10.2.3.4")).toThrow();
  });

  it("rejects a leading-space octet (Number(' 24') is 24)", () => {
    expect(() => ipv4ToInt(" 24.2.3.4")).toThrow();
  });

  it("rejects a leading-plus octet (Number('+24') is 24)", () => {
    expect(() => ipv4ToInt("+24.2.3.4")).toThrow();
  });

  it("still rejects an out-of-range octet", () => {
    expect(() => ipv4ToInt("1.2.3.256")).toThrow();
  });
});

describe("isPubliclyRoutable", () => {
  it("allows a normal public IPv4 address", () => {
    expect(isPubliclyRoutable("8.8.8.8")).toBe(true);
  });

  it("rejects link-local 169.254.169.254 — the cloud metadata SSRF payload", () => {
    expect(isPubliclyRoutable("169.254.169.254")).toBe(false);
  });

  it("rejects IPv4 loopback", () => {
    expect(isPubliclyRoutable("127.0.0.1")).toBe(false);
  });

  it("rejects RFC1918 private ranges", () => {
    expect(isPubliclyRoutable("10.0.0.1")).toBe(false);
    expect(isPubliclyRoutable("172.16.0.1")).toBe(false);
    expect(isPubliclyRoutable("192.168.1.1")).toBe(false);
  });

  it("rejects CGNAT (100.64.0.0/10)", () => {
    expect(isPubliclyRoutable("100.64.0.1")).toBe(false);
  });

  it("rejects multicast and the misc reserved IPv4 blocks", () => {
    expect(isPubliclyRoutable("224.0.0.1")).toBe(false);
    expect(isPubliclyRoutable("0.0.0.1")).toBe(false);
    expect(isPubliclyRoutable("192.0.0.1")).toBe(false);
  });

  it("allows a normal public IPv6 address", () => {
    expect(isPubliclyRoutable("2606:4700:4700::1111")).toBe(true);
  });

  it("rejects IPv6 loopback", () => {
    expect(isPubliclyRoutable("::1")).toBe(false);
  });

  it("rejects IPv6 link-local", () => {
    expect(isPubliclyRoutable("fe80::1")).toBe(false);
  });

  it("rejects IPv6 unique-local", () => {
    expect(isPubliclyRoutable("fd00::1")).toBe(false);
  });

  it("rejects IPv6 multicast", () => {
    expect(isPubliclyRoutable("ff02::1")).toBe(false);
  });

  it("rejects an IPv4-mapped private address — the smuggling case", () => {
    expect(isPubliclyRoutable("::ffff:10.0.0.1")).toBe(false);
    expect(isPubliclyRoutable("::ffff:169.254.169.254")).toBe(false);
  });

  it("allows an IPv4-mapped public address", () => {
    expect(isPubliclyRoutable("::ffff:8.8.8.8")).toBe(true);
  });

  it("returns false rather than throwing on garbage input", () => {
    expect(isPubliclyRoutable("not-an-ip")).toBe(false);
    expect(isPubliclyRoutable("")).toBe(false);
  });
});
