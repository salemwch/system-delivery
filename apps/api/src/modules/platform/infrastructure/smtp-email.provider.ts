import { createConnection } from "node:net";
import type { Socket } from "node:net";
import { connect as createTlsConnection } from "node:tls";

import { Injectable } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";

import { AppConfigService } from "../../../shared/config/index.js";
import type {
  DeliveryReceipt,
  NotificationProvider,
  OutboundMessage,
} from "../domain/notification-provider.js";

/**
 * Transactional email over SMTP.
 *
 * ⚠️ EMAIL IS NOT A CUSTOMER CHANNEL IN THIS MARKET. A parcel recipient is
 * reached by SMS; a Tunisian consumer frequently has no email address on file at
 * all. This exists for the MERCHANT-facing documents a courier sends — a
 * settlement receipt, an invoice, a monthly report — which is why it is bound
 * here rather than added to the customer notification routes.
 *
 * ⚠️ NO SDK, AND NO DEPENDENCY. Nodemailer is the obvious choice and was
 * rejected: it is ~1.5 MB of transitive surface to speak a protocol that fits in
 * this file, on a service whose only email traffic is a handful of merchant
 * documents a day. The trade is deliberate — a hand-rolled client must handle
 * the protocol correctly, which is what the comments below are about.
 *
 * If volume ever justifies an API-based provider (SES, Postmark, Mailgun), it
 * implements `NotificationProvider` alongside this one and nothing upstream
 * changes.
 */

/** A hung socket is worse than a failed send: the consumer's retry never runs. */
const CONNECT_TIMEOUT_MS = 10_000;
const COMMAND_TIMEOUT_MS = 15_000;

@Injectable()
export class SmtpEmailProvider implements NotificationProvider {
  readonly name = "smtp";

  private readonly host: string;
  private readonly port: number;
  private readonly username: string;
  private readonly password: string;
  private readonly fromAddress: string;
  private readonly fromName: string;

  constructor(
    config: AppConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.host = config.get("SMTP_HOST");
    this.port = config.get("SMTP_PORT");
    this.username = config.get("SMTP_USERNAME");
    this.password = config.get("SMTP_PASSWORD");
    this.fromAddress = config.get("SMTP_FROM_ADDRESS");
    this.fromName = config.get("SMTP_FROM_NAME");
  }

  async send(message: OutboundMessage): Promise<DeliveryReceipt> {
    if (message.channel !== "EMAIL") {
      throw new Error(`SmtpEmailProvider received a ${message.channel} message`);
    }

    // ⚠️ Header injection. A recipient of `a@b.tn\r\nBcc: everyone@rival.tn`
    // would otherwise add its own headers to the message — the email equivalent
    // of CRLF injection, and the reason the address is validated rather than
    // interpolated on trust.
    const to = assertHeaderSafe(message.to, "recipient");
    const subject = assertHeaderSafe(message.subject ?? "", "subject");

    const socket = await this.open();

    try {
      await this.expect(socket, "220");
      await this.command(socket, `EHLO ${this.host}`, "250");

      if (this.username.length > 0) {
        // AUTH LOGIN: the base64 challenge-response every server supports. The
        // credentials never appear in a log because `command` logs the verb
        // only, never its argument.
        await this.command(socket, "AUTH LOGIN", "334");
        await this.command(socket, base64(this.username), "334", { secret: true });
        await this.command(socket, base64(this.password), "235", { secret: true });
      }

      await this.command(socket, `MAIL FROM:<${this.fromAddress}>`, "250");
      await this.command(socket, `RCPT TO:<${to}>`, "250");
      await this.command(socket, "DATA", "354");
      await this.command(socket, this.body(to, subject, message.body), "250");
      await this.command(socket, "QUIT", "221");

      // SMTP gives no durable handle at accept time — the queue id is in the
      // 250 text and is server-specific. An empty string says "accepted, no
      // handle" rather than inventing one that cannot be reconciled.
      return { accepted: true, providerMessageId: "" };
    } catch (error) {
      // ⚠️ NEVER logs the recipient — an email address is PII
      // (docs/07-security-architecture.md §6.3), and a failed send is exactly
      // when someone is tempted to log one "just to debug".
      this.logger.warn({ err: error, host: this.host }, "SMTP send failed");
      return { accepted: false, providerMessageId: "" };
    } finally {
      socket.destroy();
    }
  }

  /**
   * A connected socket.
   *
   * Implicit TLS on 465, plain otherwise. STARTTLS on 587 is NOT implemented:
   * negotiating it correctly means handling a downgrade attack, and a provider
   * that only ever speaks to one configured host is better served by implicit
   * TLS. A deployment needing 587 sets an stunnel or picks an API provider.
   */
  private async open(): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket =
        this.port === 465
          ? createTlsConnection({ host: this.host, port: this.port, servername: this.host })
          : createConnection({ host: this.host, port: this.port });

      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`SMTP connect timed out after ${String(CONNECT_TIMEOUT_MS)}ms`));
      }, CONNECT_TIMEOUT_MS);

      socket.once(this.port === 465 ? "secureConnect" : "connect", () => {
        clearTimeout(timer);
        resolve(socket);
      });
      // ⚠️ Annotated, not inferred. `socket` is `TLSSocket | net.Socket`, and on
      // that union `once` degrades to the generic `(...args: any[])` overload —
      // so the reason would be untyped and could reject with a non-Error.
      socket.once("error", (error: Error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  /** Writes one command and waits for the expected status code. */
  private async command(
    socket: Socket,
    line: string,
    expected: string,
    options: { readonly secret?: boolean } = {},
  ): Promise<void> {
    if (options.secret !== true) {
      this.logger.debug({ smtp: line.split(":")[0] }, "SMTP >");
    }
    socket.write(`${line}\r\n`);
    await this.expect(socket, expected);
  }

  /** Reads until a complete reply arrives, then asserts its code. */
  private async expect(socket: Socket, code: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let buffer = "";

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`SMTP expected ${code}, timed out`));
      }, COMMAND_TIMEOUT_MS);

      const onData = (chunk: Buffer): void => {
        buffer += chunk.toString("utf8");
        // A multi-line reply repeats the code with a hyphen; only `250 ` (space)
        // ends it. Resolving on the first line would send the next command into
        // the middle of a reply.
        if (!/^\d{3} /mu.test(buffer)) {
          return;
        }
        cleanup();
        if (buffer.startsWith(code) || buffer.includes(`\n${code} `)) {
          resolve();
        } else {
          reject(new Error(`SMTP expected ${code}, got ${buffer.trim().slice(0, 120)}`));
        }
      };

      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };

      function cleanup(): void {
        clearTimeout(timer);
        socket.off("data", onData);
        socket.off("error", onError);
      }

      socket.on("data", onData);
      socket.once("error", onError);
    });
  }

  /**
   * The message itself, MIME-encoded.
   *
   * UTF-8 base64 rather than quoted-printable: the body is Arabic or French as
   * often as English, and base64 removes every question about line length and
   * eight-bit characters at the cost of a third more bytes on a message nobody
   * counts.
   *
   * Dot-stuffing is unnecessary because base64 never produces a line that is a
   * bare `.`.
   */
  private body(to: string, subject: string, text: string): string {
    const from =
      this.fromName.length > 0
        ? `=?UTF-8?B?${base64(this.fromName)}?= <${this.fromAddress}>`
        : this.fromAddress;

    return [
      `From: ${from}`,
      `To: <${to}>`,
      `Subject: =?UTF-8?B?${base64(subject)}?=`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      base64(text),
      ".",
    ].join("\r\n");
  }
}

function base64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

/**
 * ⚠️ Refuses a value that could inject an SMTP header.
 *
 * A CR or LF in a recipient or subject lets the caller append arbitrary headers
 * — `Bcc:`, `Reply-To:` — to a message the courier believes it controls. Thrown
 * rather than stripped: a caller passing a newline has a bug, and silently
 * sending a different message than they asked for hides it.
 */
function assertHeaderSafe(value: string, field: string): string {
  if (/[\r\n\0]/u.test(value)) {
    throw new Error(`SMTP ${field} contains a line break`);
  }
  return value;
}
