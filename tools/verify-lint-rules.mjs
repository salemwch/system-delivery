#!/usr/bin/env node
/**
 * Regression test for the architecture lint rules.
 *
 * WHY THIS EXISTS: during initial setup, the module-boundary configuration was
 * syntactically valid, ESLint exited 0, and the rules matched NOTHING. A lint
 * rule that silently stops firing is worse than no rule at all — it produces
 * false confidence while boundaries rot. This script proves each rule rejects a
 * known-bad case, and that it does not over-block a known-good one.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SAFETY — read before changing the cleanup logic.
 *
 * An earlier version of this script removed a whole directory
 * (`rm -r platform/domain`) during cleanup. That directory later came to hold
 * real source, and the script DELETED IT. Tooling that can destroy source is
 * more dangerous than the problem it solves.
 *
 * Four independent guards now make that impossible:
 *   1. Every fixture filename must contain the FIXTURE_MARKER. Enforced on
 *      write AND on delete.
 *   2. Cleanup deletes only exact file paths this run created — never a
 *      directory, never a glob, never recursively.
 *   3. Before deleting, the file's content is compared to what we wrote. If it
 *      differs, the file is left alone and the run fails loudly.
 *   4. Directories created by this script are removed with a NON-recursive
 *      rmdir, which refuses to act on a non-empty directory.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { ESLint } from "eslint";
import { mkdir, readFile, rm, rmdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dirname, "..");
const MODULES = path.join(ROOT, "apps/api/src/modules");

/** Every fixture path must contain this. Guards 1 and 2 depend on it. */
const FIXTURE_MARKER = "__lintfixture_";

/** @typedef {{ name: string, file: string, source: string, expect: string[] }} Fixture */

/** @type {Fixture[]} */
const FIXTURES = [
  {
    name: "upward layer dependency is rejected",
    file: `platform/${FIXTURE_MARKER}upward.ts`,
    source: [
      'import { SHIPMENT_MODULE } from "../shipment/index.js";',
      "export const value = SHIPMENT_MODULE;",
    ].join("\n"),
    expect: ["boundaries/dependencies"],
  },
  {
    name: "deep import bypassing the module barrel is rejected",
    file: `shipment/${FIXTURE_MARKER}deep.ts`,
    source: [
      `import { INTERNAL } from "../platform/${FIXTURE_MARKER}support/${FIXTURE_MARKER}internal.js";`,
      "export const value = INTERNAL;",
    ].join("\n"),
    expect: ["boundaries/entry-point"],
  },
  {
    name: "banned 'customer' identifier is rejected (invariant I18)",
    file: `shipment/${FIXTURE_MARKER}naming.ts`,
    source: [
      "export function get(): string {",
      '  const customer = "x";',
      "  return customer;",
      "}",
    ].join("\n"),
    expect: ["no-restricted-syntax"],
  },
  {
    name: "literal tenantId branching is rejected (invariant I17)",
    file: `shipment/${FIXTURE_MARKER}tenant.ts`,
    source: [
      "export function check(tenantId: string): boolean {",
      '  return tenantId === "018f7a00-0000-0000-0000-000000000000";',
      "}",
    ].join("\n"),
    expect: ["no-restricted-syntax"],
  },
  {
    name: "Object.assign mass-assignment is rejected",
    file: `shipment/${FIXTURE_MARKER}massassign.ts`,
    source: [
      "export function apply(target: object, body: object): object {",
      "  return Object.assign(target, body);",
      "}",
    ].join("\n"),
    expect: ["no-restricted-syntax"],
  },
];

/**
 * Support file the deep-import fixture reaches into.
 *
 * It lives in its OWN marker-named directory, never in a real source folder
 * such as `domain/`, so cleanup can never collide with production code.
 */
const SUPPORT = {
  file: `platform/${FIXTURE_MARKER}support/${FIXTURE_MARKER}internal.ts`,
  source: 'export const INTERNAL = "internal";',
};

/**
 * A legal import that MUST NOT report — guards against over-blocking.
 *
 * `shipment` is allowed to depend on `platform` (a lower layer) provided it
 * goes through the barrel. Imports a real, stable export so the fixture fails
 * loudly if the barrel is ever removed, rather than silently type-erroring.
 */
const LEGAL = {
  name: "legal lower-layer barrel import is allowed",
  file: `shipment/${FIXTURE_MARKER}legal.ts`,
  source: ['import { tenants } from "../platform/index.js";', "export const table = tenants;"].join(
    "\n",
  ),
};

/** GUARD 1: refuse to touch any path that is not clearly a fixture. */
function assertFixturePath(relative) {
  const segments = relative.split(/[/\\]/);
  const unmarked = segments.filter((segment) => !segment.includes(FIXTURE_MARKER));

  // Only the leading module name (e.g. "platform") may be unmarked.
  if (unmarked.length > 1) {
    throw new Error(
      `Refusing to operate on "${relative}": every path segment below the module ` +
        `must contain "${FIXTURE_MARKER}". This guard exists because an earlier ` +
        `version of this script deleted real source.`,
    );
  }
}

/** @type {{ path: string, source: string }[]} */
const writtenFiles = [];
/** @type {string[]} */
const createdDirs = [];

async function writeFixture(relative, source) {
  assertFixturePath(relative);

  const full = path.join(MODULES, relative);
  const dir = path.dirname(full);

  // Record only directories we actually create, so cleanup never removes a
  // pre-existing one.
  let dirExists = true;
  try {
    await stat(dir);
  } catch {
    dirExists = false;
  }
  if (!dirExists) {
    await mkdir(dir, { recursive: true });
    createdDirs.push(dir);
  }

  const contents = `${source}\n`;
  await writeFile(full, contents, "utf8");
  writtenFiles.push({ path: full, source: contents });
  return full;
}

/**
 * GUARDS 2–4: delete only exact files we created, only after verifying their
 * contents are unchanged, then remove only directories we created and only if
 * they are empty.
 */
async function cleanup() {
  let unsafe = 0;

  for (const { path: full, source } of writtenFiles) {
    assertFixturePath(path.relative(MODULES, full));

    let current;
    try {
      current = await readFile(full, "utf8");
    } catch {
      continue; // already gone
    }

    // GUARD 3: content must match exactly what we wrote.
    if (current !== source) {
      unsafe += 1;
      console.error(
        `REFUSED to delete ${full}: contents changed since this script wrote it. ` +
          `Leaving it in place. Remove it manually after checking what it is.`,
      );
      continue;
    }

    await rm(full, { force: true });
  }

  // GUARD 4: non-recursive rmdir — throws on a non-empty directory, which is
  // exactly the behaviour we want.
  for (const dir of createdDirs.reverse()) {
    try {
      await rmdir(dir);
    } catch {
      console.error(`Left directory in place (not empty): ${dir}`);
    }
  }

  return unsafe;
}

async function main() {
  let failures = 0;

  try {
    await writeFixture(SUPPORT.file, SUPPORT.source);
    for (const fixture of FIXTURES) {
      await writeFixture(fixture.file, fixture.source);
    }
    await writeFixture(LEGAL.file, LEGAL.source);

    const eslint = new ESLint({ cwd: ROOT, errorOnUnmatchedPattern: false });
    const results = await eslint.lintFiles(writtenFiles.map((file) => file.path));
    const byFile = new Map(results.map((result) => [path.resolve(result.filePath), result]));

    for (const fixture of FIXTURES) {
      const full = path.resolve(path.join(MODULES, fixture.file));
      const result = byFile.get(full);
      const reported = new Set((result?.messages ?? []).map((m) => m.ruleId).filter(Boolean));
      const missing = fixture.expect.filter((rule) => !reported.has(rule));

      if (missing.length > 0) {
        failures += 1;
        console.error(`FAIL  ${fixture.name}`);
        console.error(
          `      expected ${missing.join(", ")} to report, got: ${[...reported].join(", ") || "(nothing)"}`,
        );
      } else {
        console.log(`ok    ${fixture.name}`);
      }
    }

    const legalResult = byFile.get(path.resolve(path.join(MODULES, LEGAL.file)));
    const legalErrors = (legalResult?.messages ?? []).filter((m) => m.severity === 2);
    if (legalErrors.length > 0) {
      failures += 1;
      console.error(`FAIL  ${LEGAL.name}`);
      for (const message of legalErrors) {
        console.error(`      unexpected ${message.ruleId ?? "error"}: ${message.message}`);
      }
    } else {
      console.log(`ok    ${LEGAL.name}`);
    }
  } finally {
    const unsafe = await cleanup();
    if (unsafe > 0) {
      failures += unsafe;
    }
  }

  if (failures > 0) {
    console.error(
      `\n${failures} problem(s). See docs/04-context-map.md §5 for the boundary rules.`,
    );
    process.exit(1);
  }
  console.log("\nAll architecture lint rules are enforcing.");
}

await main();
