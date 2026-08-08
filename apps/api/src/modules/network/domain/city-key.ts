/**
 * City-name normalisation — the single definition of "the same city".
 *
 * A merchant importing a CSV types `Ariana`, `ARIANA`, `Ariana Ville`,
 * `Aryanah`, `أريانة` or `اريانة`, and every one of them means the city the
 * courier's tariff list calls `TUN-ARIANA`. Matching on the raw string fails on
 * all but the first; matching too loosely merges Sousse with Sfax. This is the
 * middle: fold the differences that are *spelling*, keep the ones that are
 * *identity*.
 *
 * Pure and dependency-free on purpose. It runs on every city write (to build
 * `cities.search_keys`) and on every lookup, so the two can never disagree — and
 * being pure, its behaviour is pinned by unit tests rather than inferred from a
 * query plan.
 */

/**
 * Combining marks — the accents left behind by NFD.
 *
 * This one substitution does double duty: `é` → `e` for French, and the Arabic
 * tashkeel (fatha, damma, shadda …) disappear along with it, because Unicode
 * classifies them the same way. Decomposing first is what makes that possible:
 * `é` as a single precomposed code point has no mark to strip.
 */
const COMBINING_MARKS = /\p{M}+/gu;

/** Tatweel — a typographic stretch, never a letter. `ســوسة` is `سوسة`. */
const TATWEEL = /ـ/gu;

/**
 * Alef wasla. Its siblings — أ إ آ — are already plain alef by this point,
 * because NFD decomposed each into alef plus a combining hamza that the line
 * above removed. ٱ does not decompose, so it is handled explicitly.
 */
const ALEF_WASLA = /ٱ/gu;

/** Alef maqsura → yeh. `بنزرت` spellings differ on this letter alone. */
const ALEF_MAQSURA = /ى/gu;

/**
 * Teh marbuta → heh.
 *
 * ة and ه are pronounced identically at the end of a word and typed
 * interchangeably: `أريانة` and `أريانه` are one city, and a keyboard decides
 * which one arrives.
 */
const TEH_MARBUTA = /ة/gu;

/**
 * Anything that is not a letter or a digit becomes a single space.
 *
 * Covers the hyphen in `Ariana-Ville`, the apostrophe in `M'saken`, and the
 * double space in a pasted cell — none of which change which city is meant.
 */
const SEPARATORS = /[^\p{L}\p{N}]+/gu;

/**
 * A city name reduced to its matching key. Returns `""` for input with no
 * letters or digits at all, which callers must treat as "no key" rather than
 * as a key that matches everything.
 */
export function normaliseCityKey(value: string): string {
  return value
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .replace(TATWEEL, "")
    .replace(ALEF_WASLA, "ا")
    .replace(ALEF_MAQSURA, "ي")
    .replace(TEH_MARBUTA, "ه")
    .toLowerCase()
    .replace(SEPARATORS, " ")
    .trim();
}

/** The names a city answers to, as stored. */
export interface CityNames {
  readonly name: string;
  readonly nameAr?: string | null;
  readonly aliases?: readonly string[];
}

/**
 * Every key a city should match on, deduplicated and in a stable order.
 *
 * Stable because the array is compared in tests and shown in an audit diff; a
 * set's iteration order is insertion order, and insertion order here is
 * name → Arabic name → aliases as the operator listed them.
 */
export function searchKeysFor(names: CityNames): string[] {
  const keys = new Set<string>();
  for (const candidate of [names.name, names.nameAr ?? "", ...(names.aliases ?? [])]) {
    const key = normaliseCityKey(candidate);
    if (key !== "") {
      keys.add(key);
    }
  }
  return [...keys];
}
