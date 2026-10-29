import { generateKeyPairSync } from "node:crypto";

/**
 * Prints a fresh Ed25519 key pair for token signing, as env lines.
 *
 *   pnpm --filter @delivery/api build
 *   pnpm --filter @delivery/api jwt:keygen
 *
 * `JWT_SIGNING_KEY` goes into `.env` locally and into the deployment's secret
 * store — never into a file in the repo. The public half is printed for the
 * one moment it is needed: a rotation, when the OUTGOING key's public half
 * becomes `JWT_PREVIOUS_VERIFY_KEY` until every token it signed has expired
 * (the longest access TTL, 60 minutes for drivers).
 *
 * Output goes to this terminal only: nothing is written to disk.
 */
function main(): void {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privatePem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const publicPem = publicKey.export({ format: "pem", type: "spki" }).toString();

  process.stdout.write(`JWT_SIGNING_KEY=${oneLine(privatePem)}\n`);
  process.stdout.write(`# public half — JWT_PREVIOUS_VERIFY_KEY when this key is rotated out:\n`);
  process.stdout.write(`# ${oneLine(publicPem)}\n`);
}

/** A PEM on one env line, `\n` escaped — the form the config schema un-escapes. */
function oneLine(pem: string): string {
  return pem.trim().replace(/\n/gu, "\\n");
}

main();
