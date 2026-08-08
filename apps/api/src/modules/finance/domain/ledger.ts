/**
 * Double-entry vocabulary (docs/02-domain-model.md §3.14–3.15). Pure constants and
 * derivations — no I/O — so the accounting rules are unit-testable in isolation.
 */

/** The account kinds a party's balance lives in. */
export const ACCOUNT_TYPES = [
  "DRIVER_CASH",
  "HUB_CASH",
  "MERCHANT_PAYABLE",
  "PLATFORM_REVENUE",
  "BANK",
  "WRITE_OFF",
  "CUSTOMER_RECEIVABLE",
  /**
   * What the courier SPENDS — les dépenses (migration 0040).
   *
   * Owned by the TENANT even when an expense is attributed to a driver, vehicle
   * or hub: the attribution is a reporting dimension, not a balance anybody
   * holds. A driver does not owe the business the fuel they put in the van.
   */
  "EXPENSE",
] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

/** Who owns an account. Tenant-level accounts use owner = the tenant itself. */
export const OWNER_TYPES = ["DRIVER", "HUB", "MERCHANT", "TENANT"] as const;
export type OwnerType = (typeof OWNER_TYPES)[number];

export const DIRECTIONS = ["DEBIT", "CREDIT"] as const;
export type Direction = (typeof DIRECTIONS)[number];

export const ENTRY_TYPES = [
  "COD_COLLECTED",
  "COD_REMITTED",
  "SETTLEMENT",
  "ADJUSTMENT",
  "WRITE_OFF",
  "REVERSAL",
  "EXPENSE",
] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

/** The accounting direction that INCREASES an account's balance. */
export type NormalBalance = Direction;

/**
 * Normal balance per account type. Assets (cash the courier holds or is owed) and
 * expenses (write-offs) increase on DEBIT; liabilities (money owed to a merchant)
 * and revenue increase on CREDIT. This is what turns a raw DEBIT/CREDIT into a
 * signed movement of the cached balance.
 */
const NORMAL_BALANCE: Record<AccountType, NormalBalance> = {
  DRIVER_CASH: "DEBIT",
  HUB_CASH: "DEBIT",
  BANK: "DEBIT",
  CUSTOMER_RECEIVABLE: "DEBIT",
  WRITE_OFF: "DEBIT",
  // Spending RISES on a debit, exactly like an asset. Crediting it means money
  // came back — a refunded expense.
  EXPENSE: "DEBIT",
  MERCHANT_PAYABLE: "CREDIT",
  PLATFORM_REVENUE: "CREDIT",
};

export function normalBalanceFor(accountType: AccountType): NormalBalance {
  return NORMAL_BALANCE[accountType];
}

/**
 * The signed change to an account's cached `balance_minor` for one entry: a
 * movement in the account's normal direction increases it, the opposite decreases
 * it. `amountMinor` is always positive; this is where the sign comes from.
 */
export function balanceDelta(
  normalBalance: NormalBalance,
  direction: Direction,
  amountMinor: bigint,
): bigint {
  return direction === normalBalance ? amountMinor : -amountMinor;
}

/** Narrows the DB `text` column back to the union (the CHECK constraint guarantees it). */
export function asNormalBalance(value: string): NormalBalance {
  return value === "CREDIT" ? "CREDIT" : "DEBIT";
}

/**
 * Narrowing helpers for values read back out of the database.
 *
 * The columns are TEXT behind CHECK constraints, so a row is `string` to
 * TypeScript. These throw rather than defaulting: a value the build does not
 * recognise means the schema and the code disagree about the accounting
 * vocabulary, and guessing would post money to the wrong kind of account.
 */
const OWNER_TYPE_SET: ReadonlySet<string> = new Set<string>(OWNER_TYPES);
const ACCOUNT_TYPE_SET: ReadonlySet<string> = new Set<string>(ACCOUNT_TYPES);
const DIRECTION_SET: ReadonlySet<string> = new Set<string>(DIRECTIONS);

export function toOwnerType(value: string): OwnerType {
  if (!OWNER_TYPE_SET.has(value)) {
    throw new Error(`Unknown ledger owner type "${value}"`);
  }
  return value as OwnerType;
}

export function toAccountType(value: string): AccountType {
  if (!ACCOUNT_TYPE_SET.has(value)) {
    throw new Error(`Unknown ledger account type "${value}"`);
  }
  return value as AccountType;
}

export function toDirection(value: string): Direction {
  if (!DIRECTION_SET.has(value)) {
    throw new Error(`Unknown ledger direction "${value}"`);
  }
  return value as Direction;
}
