import { CURRENCIES, isCurrencyCode, type CurrencyCode } from "@/lib/proposals/currencies";

// Amount conversion between the database's integer minor units and PayPal's
// decimal strings, without floating-point arithmetic.

// Portal currencies that PayPal's REST APIs accept (PayPal "Currency codes"
// reference). AED and PKR are offered in the portal but are not PayPal
// currencies, so proposals priced in them can't be paid online: the client
// page says so instead of showing the PayPal button.
export const PAYPAL_CURRENCIES: readonly CurrencyCode[] = ["USD", "EUR", "GBP", "JPY"];

export function isPayPalCurrency(currency: string): currency is CurrencyCode {
  return isCurrencyCode(currency) && PAYPAL_CURRENCIES.includes(currency);
}

// 4999 USD -> "49.99"; 1500 JPY -> "1500".
export function minorToPayPalValue(minor: number, currency: CurrencyCode): string {
  if (!Number.isSafeInteger(minor) || minor <= 0) throw new Error("invalid amount");
  const digits = CURRENCIES[currency].minorDigits;
  if (digits === 0) return String(minor);
  const text = String(minor).padStart(digits + 1, "0");
  return `${text.slice(0, -digits)}.${text.slice(-digits)}`;
}

// PayPal's value string -> minor units, or null if it isn't an exact,
// well-formed amount for that currency ("49.9" is accepted as 4990,
// "49.999" and "1e3" are not).
export function payPalValueToMinor(value: unknown, currency: string): number | null {
  if (typeof value !== "string" || !isCurrencyCode(currency)) return null;
  const digits = CURRENCIES[currency].minorDigits;
  const match = /^(\d{1,15})(?:\.(\d+))?$/.exec(value);
  if (!match) return null;
  const fraction = match[2] ?? "";
  if (fraction.length > digits) {
    // Trailing zeros beyond the currency's precision are still exact.
    if (!/^0*$/.test(fraction.slice(digits))) return null;
  }
  const kept = fraction.slice(0, digits).padEnd(digits, "0");
  const minor = Number(match[1]) * 10 ** digits + (digits > 0 ? Number(kept) : 0);
  return Number.isSafeInteger(minor) ? minor : null;
}
