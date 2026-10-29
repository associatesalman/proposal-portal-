// Supported unlock currencies and their ISO 4217 minor-unit precision.
// Prices are stored as integer minor units (cents, fils, paisa; yen has none).
// Keep in sync with the proposals_currency_supported check constraint
// (supabase/migrations/20261028090000_phase4_pdf_offer_links.sql).
// This is a placeholder list until the payment provider (Phase 7) confirms
// which currencies it settles.

export const CURRENCIES = {
  USD: { name: "US dollar", minorDigits: 2 },
  EUR: { name: "Euro", minorDigits: 2 },
  GBP: { name: "British pound", minorDigits: 2 },
  AED: { name: "UAE dirham", minorDigits: 2 },
  PKR: { name: "Pakistani rupee", minorDigits: 2 },
  JPY: { name: "Japanese yen", minorDigits: 0 },
} as const;

export type CurrencyCode = keyof typeof CURRENCIES;

export const CURRENCY_CODES = Object.keys(CURRENCIES) as CurrencyCode[];

// Upper bound for a single unlock price, in major units.
export const MAX_PRICE_MAJOR = 1_000_000;

export function isCurrencyCode(value: unknown): value is CurrencyCode {
  return typeof value === "string" && Object.hasOwn(CURRENCIES, value);
}

export type PriceParseResult = { ok: true; minor: number } | { ok: false; message: string };

// Parses a decimal string ("49.99", "1500") into integer minor units without
// floating-point arithmetic. Rejects more decimals than the currency allows.
export function parsePrice(input: string, currency: CurrencyCode): PriceParseResult {
  const digits = CURRENCIES[currency].minorDigits;
  const value = input.trim();
  const example = digits === 0 ? "1500" : "49.99";

  if (value === "") return { ok: false, message: "Enter a price." };

  const pattern = digits === 0 ? /^(\d+)$/ : new RegExp(`^(\\d+)(?:\\.(\\d{1,${digits}}))?$`);
  const match = pattern.exec(value);
  if (!match) {
    if (digits === 0 && /^\d+\.\d+$/.test(value)) {
      return { ok: false, message: `${currency} has no decimal places. Enter a whole amount.` };
    }
    if (new RegExp(`^\\d+\\.\\d{${digits + 1},}$`).test(value)) {
      return { ok: false, message: `${currency} allows at most ${digits} decimal places.` };
    }
    return { ok: false, message: `Enter an amount like ${example}, without symbols or commas.` };
  }

  const whole = match[1].replace(/^0+(?=\d)/, "");
  if (whole.length > String(MAX_PRICE_MAJOR).length) {
    return { ok: false, message: `Enter at most ${MAX_PRICE_MAJOR.toLocaleString("en-GB")}.` };
  }
  const fraction = (match[2] ?? "").padEnd(digits, "0");
  const minor = Number(whole) * 10 ** digits + (digits > 0 ? Number(fraction) : 0);

  if (minor <= 0) return { ok: false, message: "Enter a price greater than zero." };
  if (minor > MAX_PRICE_MAJOR * 10 ** digits) {
    return { ok: false, message: `Enter at most ${MAX_PRICE_MAJOR.toLocaleString("en-GB")}.` };
  }
  return { ok: true, minor };
}

// "4999" + USD -> "49.99" (for prefilling inputs).
export function minorToInput(minor: number, currency: CurrencyCode): string {
  const digits = CURRENCIES[currency].minorDigits;
  if (digits === 0) return String(minor);
  const text = String(minor).padStart(digits + 1, "0");
  return `${text.slice(0, -digits)}.${text.slice(-digits)}`;
}

export function formatPrice(minor: number, currency: CurrencyCode): string {
  const digits = CURRENCIES[currency].minorDigits;
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(minor / 10 ** digits);
}
