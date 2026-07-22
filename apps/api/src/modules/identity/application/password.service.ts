import { randomBytes } from "node:crypto";

import { Injectable } from "@nestjs/common";
import { hash, verify } from "@node-rs/argon2";

/**
 * Password hashing.
 *
 * Argon2id per RFC 9106 — memory-hard, resistant to GPU and side-channel
 * attack, and the current OWASP recommendation. Parameters follow the OWASP
 * Password Storage Cheat Sheet's Argon2id baseline.
 *
 * `@node-rs/argon2` ships prebuilt native binaries, so there is no node-gyp
 * toolchain requirement on Windows development machines or in Linux containers.
 */

/** OWASP-recommended Argon2id parameters: 19 MiB, 2 iterations, 1 lane. */
const ARGON2_OPTIONS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

/** Parsed cost parameters from a PHC-format Argon2 string. */
interface Argon2Params {
  readonly memoryCost: number;
  readonly timeCost: number;
  readonly parallelism: number;
}

/**
 * Parses `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<digest>`.
 *
 * Returns null for anything unrecognisable, which callers treat as "needs
 * replacing" rather than trusting.
 */
function parseArgon2Params(phc: string): Argon2Params | null {
  const segments = phc.split("$");
  // ["", "argon2id", "v=19", "m=...,t=...,p=...", salt, digest]
  if (segments.length < 6 || segments[1] !== "argon2id") {
    return null;
  }

  const paramSegment = segments[3];
  if (paramSegment === undefined) {
    return null;
  }

  const parsed: Record<string, number> = {};
  for (const pair of paramSegment.split(",")) {
    const [key, rawValue] = pair.split("=");
    if (key === undefined || rawValue === undefined) {
      return null;
    }
    const value = Number.parseInt(rawValue, 10);
    if (!Number.isInteger(value)) {
      return null;
    }
    parsed[key] = value;
  }

  const memoryCost = parsed["m"];
  const timeCost = parsed["t"];
  const parallelism = parsed["p"];

  if (memoryCost === undefined || timeCost === undefined || parallelism === undefined) {
    return null;
  }

  return { memoryCost, timeCost, parallelism };
}

@Injectable()
export class PasswordService {
  /**
   * A real Argon2 hash of a random value, computed once and reused.
   *
   * Used to equalise response time when an account does not exist. It must be a
   * genuine hash produced with the current parameters: a hardcoded or malformed
   * string would fail at PARSE time, returning far faster than a real
   * verification and re-creating the exact user-enumeration timing oracle this
   * is meant to close (docs/07-security-architecture.md §3.1).
   */
  private dummyHash: Promise<string> | null = null;

  /** Hashes a plaintext password. Never log or persist the input. */
  async hash(plaintext: string): Promise<string> {
    if (plaintext.length === 0) {
      throw new Error("Cannot hash an empty password");
    }
    return hash(plaintext, ARGON2_OPTIONS);
  }

  /**
   * Verifies a password against a stored hash.
   *
   * Returns false rather than throwing on a malformed hash: one corrupt row
   * must fail that login, not crash the endpoint and turn a data problem into
   * an availability incident.
   */
  async verify(plaintext: string, storedHash: string): Promise<boolean> {
    try {
      return await verify(storedHash, plaintext, ARGON2_OPTIONS);
    } catch {
      return false;
    }
  }

  /**
   * Performs a real, always-failing verification so that a non-existent account
   * costs the same time as an existing one.
   */
  async verifyDummy(plaintext: string): Promise<false> {
    this.dummyHash ??= hash(randomBytes(32).toString("hex"), ARGON2_OPTIONS);

    try {
      await verify(await this.dummyHash, plaintext, ARGON2_OPTIONS);
    } catch {
      // Expected: the dummy never matches a real password.
    }
    return false;
  }

  /**
   * True when a stored hash was produced with weaker parameters than current
   * policy, or is not a recognisable Argon2id hash.
   *
   * Implemented here because `@node-rs/argon2` exposes no equivalent. Callers
   * transparently re-hash on the next successful login, so parameters can be
   * strengthened over time without forcing a password reset.
   */
  needsRehash(storedHash: string): boolean {
    const params = parseArgon2Params(storedHash);
    if (params === null) {
      return true;
    }

    return (
      params.memoryCost < ARGON2_OPTIONS.memoryCost ||
      params.timeCost < ARGON2_OPTIONS.timeCost ||
      params.parallelism !== ARGON2_OPTIONS.parallelism
    );
  }
}
