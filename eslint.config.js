// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import boundaries from "eslint-plugin-boundaries";
import globals from "globals";

/**
 * Module boundaries — the mechanical enforcement of ADR-001.
 *
 * A modular monolith without enforced boundaries degrades into a big ball of
 * mud within a year, at which point it has every drawback of a monolith and
 * none of the benefits (blueprint risk A2). These rules are that enforcement.
 *
 * Layering (docs/04-context-map.md §2.1): a module may depend ONLY on modules
 * in a strictly lower layer. Same-layer and upward relationships are expressed
 * as events, never as imports.
 */
const LAYERS = {
  0: ["platform", "identity"],
  1: ["directory", "network", "fleet"],
  2: ["shipment", "pickup", "dispatch", "custody"],
  3: ["tracking", "finance", "notification", "fraud", "complaint"],
};

/** Explicit per-module allow-list, derived from the layer rule. */
const MODULE_DEPENDENCIES = {
  platform: [],
  identity: ["platform"],
  directory: ["platform", "identity"],
  network: ["platform", "identity", "directory"],
  fleet: ["platform", "identity", "network"],
  shipment: ["platform", "identity", "directory", "network"],
  pickup: ["platform", "identity", "directory"],
  // dispatch → shipment is the ONE sanctioned same-layer dependency.
  // Documented in docs/04-context-map.md §2.1. Do not add a second without an ADR.
  dispatch: ["platform", "identity", "directory", "network", "fleet", "shipment"],
  custody: ["platform", "identity", "network", "shipment"],
  // `identity` is the auth decorators every controller-owning module needs; it
  // is layer 0, so this is an ordinary downward dependency, not a boundary
  // exception. context-map §3.9 lists the DOMAIN dependencies only.
  tracking: ["platform", "identity", "fleet", "network"],
  finance: ["platform", "identity", "fleet", "directory"],
  notification: ["platform", "identity"],
  // Layer 3. A complaint is ABOUT a shipment, a merchant, a driver — it reads
  // their context and, for COD_DISPUTE, posts a reversing ledger transaction.
  complaint: ["platform", "identity", "directory", "shipment", "finance"],
  fraud: ["platform", "identity", "tracking"],
};

const ALL_MODULES = Object.values(LAYERS).flat();

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      // Next.js build output — generated, and not ours to lint.
      "**/.next/**",
      "**/*.config.js",
      "infra/**",
    ],
  },

  js.configs.recommended,

  // k6 load scripts.
  //
  // They run inside k6's own JS runtime, not Node: `open()`, `__VU` and `__ITER`
  // are k6 globals, and the `k6/*` module specifiers resolve only there.
  // Declaring the globals rather than ignoring the directory keeps every other
  // rule — unused vars, equality, shadowing — enforced on them.
  {
    files: ["load/**/*.js"],
    languageOptions: {
      globals: { open: "readonly", __VU: "readonly", __ITER: "readonly" },
    },
  },

  // Type-aware linting is scoped to TypeScript sources only. Left unscoped, the
  // TS parser is applied to plain .mjs tooling files that belong to no tsconfig
  // project, which fails with "not found by the project service".
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ["**/*.ts", "**/*.tsx"],
  })),

  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parserOptions: {
        // Both projects listed explicitly: projectService only discovers
        // tsconfig.json, and test files live in a separate ESM project because
        // Vitest runs them as ESM while src emits CommonJS for Nest decorators.
        project: [
          "./apps/api/tsconfig.json",
          "./apps/api/tsconfig.test.json",
          "./apps/track/tsconfig.json",
          "./apps/merchant/tsconfig.json",
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // ── Domain invariants (docs/02-domain-model.md §4) ────────────────────────
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          // Invariant I18: Tenant / Merchant / Recipient are three distinct
          // concepts. "customer" is ambiguous — it could mean the courier's
          // customer (Merchant) or the merchant's customer (Recipient).
          // Permitted only in user-facing UI copy, never in code identifiers.
          selector:
            "Identifier[name=/^(customer|Customer|customers|Customers|customerId|CustomerId)$/]",
          message:
            "Banned identifier 'customer' (invariant I18). Use Tenant, Merchant, or Recipient — they are three different concepts. See docs/02-domain-model.md §1.1.",
        },
        {
          // Invariant I17: per-tenant behaviour goes through TenantFeature
          // flags, never a hard-coded tenant comparison. This is what stops
          // `if (tenantId === '...')` spreading through every module.
          selector:
            "BinaryExpression[operator=/^(===|!==|==|!=)$/][left.name=/[Tt]enantId$/][right.type='Literal']",
          message:
            "Do not branch on a literal tenantId (invariant I17). Use FeatureService.isEnabled(). See docs/02-domain-model.md §3.17.",
        },
        {
          // Money is integer minor units. Floating-point arithmetic on money
          // is how COD reconciliation silently drifts.
          selector:
            "CallExpression[callee.object.name='Math'][callee.property.name='round'] > BinaryExpression[operator='*'][right.value=100]",
          message:
            "Do not hardcode x100 for money. Minor-unit scale comes from CurrencyService.exponentOf() — TND has 3 decimals, not 2.",
        },
        {
          // Mass-assignment protection (OWASP API6).
          selector: "CallExpression[callee.object.name='Object'][callee.property.name='assign']",
          message:
            "Object.assign onto an entity enables mass assignment. Use an explicit DTO allow-list. See docs/07-security-architecture.md §4.5.",
        },
      ],

      // Tenant context uses SET LOCAL, never SET — a session-scoped SET leaks
      // across pooled connections and is a silent cross-tenant data leak.
      // See docs/07-security-architecture.md §5.2.
      "no-restricted-properties": [
        "error",
        {
          object: "process",
          property: "env",
          message:
            "Read configuration through ConfigService, not process.env directly — values must be schema-validated at startup.",
        },
      ],

      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      eqeqeq: ["error", "always"],
      "no-console": "error",
    },
  },

  // ── Module boundaries ─────────────────────────────────────────────────────
  // Uses eslint-plugin-boundaries v7 `dependencies` API (policies + `captured`
  // selectors). The legacy `element-types` rule still exists in v7 but silently
  // matches nothing with this element layout — a lint rule that does not fire
  // is worse than no rule, so we use the current API and assert it in CI.
  {
    files: ["apps/api/src/**/*.ts"],
    plugins: { boundaries },
    settings: {
      // Required so `../platform/index.js` (NodeNext ESM specifier) resolves to
      // the real `index.ts`. Without it every import is classified "unknown"
      // and the boundary rules silently pass — which is exactly how this
      // config was broken on first write.
      "import/resolver": {
        typescript: { project: ["apps/api/tsconfig.json"] },
      },
      "boundaries/elements": [
        // NOTE: `capture` binds positionally to the wildcards in `pattern`.
        // A leading `**` would consume the first capture slot and leave
        // moduleName empty — keep exactly one wildcard here.
        {
          type: "module",
          pattern: "apps/api/src/modules/*",
          capture: ["moduleName"],
        },
        { type: "shared", pattern: "apps/api/src/shared/*" },
      ],
    },
    rules: {
      "boundaries/dependencies": [
        "error",
        {
          default: "disallow",
          policies: [
            // Anything may use shared utilities.
            {
              allow: { to: { element: { type: "shared" } } },
            },
            // A module may always import from itself.
            ...ALL_MODULES.map((name) => ({
              from: { element: { type: "module", captured: { moduleName: name } } },
              allow: { to: { element: { type: "module", captured: { moduleName: name } } } },
            })),
            // A module may import only its declared lower-layer dependencies.
            ...ALL_MODULES.flatMap((name) =>
              MODULE_DEPENDENCIES[name].map((dep) => ({
                from: { element: { type: "module", captured: { moduleName: name } } },
                allow: { to: { element: { type: "module", captured: { moduleName: dep } } } },
              })),
            ),
            // External packages are governed by dependency review, not layering.
            {
              allow: { to: { module: { origin: "external" } } },
            },
          ],
        },
      ],

      // Imports must come from the module barrel (index.ts). Reaching into
      // another module's domain/, infrastructure/, or entities is how
      // boundaries die. docs/04-context-map.md §5.
      "boundaries/entry-point": [
        "error",
        {
          default: "disallow",
          policies: [
            { target: { element: { type: "module" } }, allow: "index.ts" },
            { target: { element: { type: "shared" } }, allow: "**" },
          ],
        },
      ],
    },
  },

  // Build/CI tooling: plain ESM JavaScript, deliberately outside any tsconfig
  // project, so type-aware linting cannot apply to it.
  {
    files: ["tools/**/*.mjs", "tools/**/*.js"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.node,
    },
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      "no-console": "off",
    },
  },

  // Tests may reach further — they verify internals by design.
  {
    files: ["**/*.spec.ts", "**/*.test.ts", "**/__tests__/**/*.ts", "**/test/**/*.ts"],
    rules: {
      "boundaries/dependencies": "off",
      "boundaries/entry-point": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "no-restricted-properties": "off",
    },
  },

  // Config, migration, script, and the telemetry bootstrap files legitimately
  // read env directly. The telemetry bootstrap runs BEFORE the Nest DI container
  // exists (it must patch http/fastify/ioredis first), so it cannot go through
  // AppConfigService — exactly like the config schema itself.
  {
    files: [
      "**/*.config.ts",
      "**/migrations/**/*.ts",
      "**/scripts/**/*.ts",
      "**/shared/observability/telemetry.ts",
      // Frontend apps' single env boundary — same arrangement as the API's
      // config schema: read here, validated here, nowhere else.
      "apps/track/src/lib/config.ts",
      "apps/merchant/src/lib/config.ts",
    ],
    rules: {
      "no-restricted-properties": "off",
      "no-console": "off",
    },
  },
);
