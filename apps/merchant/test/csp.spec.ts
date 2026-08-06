import { afterEach, describe, expect, it, vi } from "vitest";

import { contentSecurityPolicy, newNonce } from "../src/lib/csp";

/**
 * The policy that broke the app.
 *
 * As a static `script-src 'self'` it blocked every inline script Next uses to
 * hydrate React. Nothing errored visibly — the server HTML was perfect and the
 * client runtime simply never started, so a form's submit button did nothing.
 * These tests exist so that cannot come back quietly.
 */
describe("contentSecurityPolicy", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function production(): string {
    vi.stubEnv("NODE_ENV", "production");
    return contentSecurityPolicy("TESTNONCE");
  }

  function development(): string {
    vi.stubEnv("NODE_ENV", "development");
    return contentSecurityPolicy("TESTNONCE");
  }

  it("carries the nonce, so Next's inline scripts are allowed to run", () => {
    expect(production()).toContain("'nonce-TESTNONCE'");
  });

  it("allows a nonced script to load its own chunks", () => {
    // Without `strict-dynamic` every chunk Next's loader pulls in would have to
    // be named individually, which is unmaintainable and gets relaxed to
    // `'unsafe-inline'` by the next person who hits it.
    expect(production()).toContain("'strict-dynamic'");
  });

  it("never ships 'unsafe-eval' to production", () => {
    // Turbopack needs it to evaluate hot modules. A production bundle is
    // compiled and must not carry the weakest directive in the policy.
    expect(production()).not.toContain("'unsafe-eval'");
    expect(development()).toContain("'unsafe-eval'");
  });

  it("never allows inline SCRIPT, in either mode", () => {
    // The nonce exists precisely so this is unnecessary. Note browsers ignore
    // 'unsafe-inline' when a nonce is present — but a reviewer reading the
    // header should never see it against script-src.
    const scriptSrc = (policy: string): string =>
      policy.split("; ").find((d) => d.startsWith("script-src")) ?? "";
    expect(scriptSrc(production())).not.toContain("'unsafe-inline'");
    expect(scriptSrc(development())).not.toContain("'unsafe-inline'");
  });

  it("keeps third-party hosts out of production entirely", () => {
    const policy = production();
    // The dev error overlay fetches its own webfonts from Google. That
    // allowance is a development convenience and must not reach a deployment.
    expect(policy).not.toContain("googleapis.com");
    expect(policy).not.toContain("gstatic.com");
    expect(policy).not.toContain("localhost");
  });

  it("denies everything not explicitly granted", () => {
    const policy = production();
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("base-uri 'none'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("form-action 'self'");
  });

  it("upgrades insecure requests in production but not in development", () => {
    // localhost speaks plain HTTP; upgrading it makes the dev server
    // unreachable.
    expect(production()).toContain("upgrade-insecure-requests");
    expect(development()).not.toContain("upgrade-insecure-requests");
  });
});

describe("newNonce", () => {
  it("is unique per call — a reused nonce is no protection at all", () => {
    const nonces = new Set(Array.from({ length: 200 }, () => newNonce()));
    expect(nonces.size).toBe(200);
  });

  it("is long enough to be unguessable", () => {
    // 16 bytes of CSPRNG. Base64 of 16 bytes is 24 characters.
    expect(newNonce()).toHaveLength(24);
  });
});
