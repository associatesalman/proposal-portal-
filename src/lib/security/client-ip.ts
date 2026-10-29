import { isIP } from "node:net";

// Works out the client address used to key public and login rate limits.
//
// Forwarded headers are only as trustworthy as the proxy that sets them.
// Next.js fills X-Forwarded-For from the socket only when the request has
// none, so on a directly exposed server a client can send any value.
// Configure one of:
//
//   RATE_LIMIT_CLIENT_IP_HEADER=x-real-ip   a header your edge proxy always
//                                           overwrites (e.g. Vercel sets
//                                           x-real-ip and x-forwarded-for)
//   RATE_LIMIT_TRUSTED_PROXY_HOPS=1         number of trusted proxies that
//                                           APPEND to X-Forwarded-For; the
//                                           client is that many entries from
//                                           the right
//
// With neither set (local development) the rightmost X-Forwarded-For entry
// is used. That is the socket address when the client sent no header, but a
// client can spoof it, so production must set one of the options above
// (see docs/PHASE_7_HARDENING_SUMMARY.md).
//
// IPv6 addresses are reduced to their /64, since one subscriber usually
// holds a whole /64. The result is only ever hashed, never stored or logged.

function readHops(): number {
  const value = Number(process.env.RATE_LIMIT_TRUSTED_PROXY_HOPS ?? "0");
  return Number.isInteger(value) && value >= 0 && value <= 10 ? value : 0;
}

function normalize(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let value = raw.trim();
  // "[2001:db8::1]:443" and "203.0.113.5:1234" forms.
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  if (bracketed) value = bracketed[1];
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(value)) value = value.slice(0, value.lastIndexOf(":"));
  if (value.toLowerCase().startsWith("::ffff:") && isIP(value.slice(7)) === 4) value = value.slice(7);

  const version = isIP(value);
  if (version === 4) return value;
  if (version === 6) return ipv6Prefix64(value);
  return null;
}

function ipv6Prefix64(address: string): string {
  const [head, tail = ""] = address.toLowerCase().split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = tail ? tail.split(":") : [];
  const missing = 8 - headParts.length - tailParts.length;
  const full = [...headParts, ...Array(Math.max(missing, 0)).fill("0"), ...tailParts];
  return `${full.slice(0, 4).map((part) => part.padStart(4, "0")).join(":")}::/64`;
}

export function clientAddress(headers: Headers): string {
  const header = process.env.RATE_LIMIT_CLIENT_IP_HEADER?.trim().toLowerCase();
  if (header) {
    // The first value: a trusted edge overwrites this header entirely.
    const value = headers.get(header)?.split(",")[0];
    return normalize(value) ?? "unknown";
  }

  const forwarded = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (forwarded.length === 0) return "unknown";
  const hops = readHops();
  const index = Math.max(forwarded.length - 1 - hops, 0);
  return normalize(forwarded[index]) ?? "unknown";
}
