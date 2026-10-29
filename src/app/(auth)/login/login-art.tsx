import type { CSSProperties } from "react";

// Decorative artwork beside the sign-in form: an abstract stack of proposal
// sheets in blue and pale blue, drawn with inline SVG (no images or external
// files). The shapes settle into place once, within about 2.5 seconds, and
// then stay still (see .login-art in globals.css); with reduced motion they
// appear at once. Hidden from assistive technology.
const delay = (ms: number) => ({ "--art-delay": `${ms}ms` }) as CSSProperties;
const dash = (length: number, ms: number) => ({ "--dash": length, "--art-delay": `${ms}ms` }) as CSSProperties;

export function LoginArt({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 560 360"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className={`login-art h-auto w-full max-w-[560px] ${className}`}
    >
      {/* Soft background shapes. */}
      <circle className="art-rise" style={delay(0)} cx="392" cy="168" r="150" fill="#EFF6FF" />
      <circle className="art-rise" style={delay(120)} cx="120" cy="286" r="58" fill="#DBEAFE" opacity="0.7" />
      <path
        className="art-draw"
        style={dash(760, 200)}
        d="M24 220 C 120 120, 220 330, 330 210 S 500 90, 544 150"
        stroke="#BFDBFE"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray="760"
      />

      {/* Back sheet. */}
      <g className="art-rise" style={delay(260)}>
        <rect x="286" y="48" width="196" height="248" rx="18" fill="#FFFFFF" stroke="#BFDBFE" strokeWidth="2" transform="rotate(8 384 172)" />
      </g>

      {/* Front sheet with "text" bars and a page split. */}
      <g className="art-rise" style={delay(420)}>
        <rect x="184" y="64" width="216" height="264" rx="20" fill="#FFFFFF" stroke="#CBD5E1" strokeWidth="1.5" />
        <rect x="184" y="64" width="216" height="264" rx="20" fill="url(#login-art-sheen)" />
        <rect x="212" y="96" width="44" height="44" rx="12" fill="#2563EB" />
        <path d="M226 110h16M226 118h16M226 126h10" stroke="#FFFFFF" strokeWidth="3" strokeLinecap="round" />
      </g>
      <rect className="art-grow" style={delay(760)} x="270" y="102" width="102" height="10" rx="5" fill="#0B1E44" opacity="0.85" />
      <rect className="art-grow" style={delay(840)} x="270" y="122" width="70" height="8" rx="4" fill="#94A3B8" opacity="0.6" />
      <rect className="art-grow" style={delay(920)} x="212" y="168" width="160" height="8" rx="4" fill="#E2E8F0" />
      <rect className="art-grow" style={delay(980)} x="212" y="188" width="136" height="8" rx="4" fill="#E2E8F0" />
      <rect className="art-grow" style={delay(1040)} x="212" y="208" width="148" height="8" rx="4" fill="#E2E8F0" />
      <rect className="art-grow" style={delay(1120)} x="212" y="244" width="160" height="12" rx="6" fill="#EFF6FF" />
      <rect className="art-grow" style={delay(1240)} x="212" y="244" width="64" height="12" rx="6" fill="#2563EB" />
      <rect className="art-grow" style={delay(1320)} x="212" y="280" width="96" height="24" rx="12" fill="#DBEAFE" />

      {/* A small "link" chip and dots. */}
      <g className="art-rise" style={delay(1300)}>
        <rect x="372" y="250" width="132" height="48" rx="24" fill="#FFFFFF" stroke="#BFDBFE" strokeWidth="1.5" />
        <circle cx="398" cy="274" r="12" fill="#2563EB" />
        <path d="M392.5 274.5l4 4 7.5-8" stroke="#FFFFFF" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        <rect x="418" y="269" width="68" height="10" rx="5" fill="#BFDBFE" />
      </g>
      <circle className="art-rise" style={delay(1500)} cx="152" cy="92" r="6" fill="#2563EB" />
      <circle className="art-rise" style={delay(1600)} cx="176" cy="60" r="4" fill="#93C5FD" />
      <circle className="art-rise" style={delay(1700)} cx="520" cy="72" r="5" fill="#93C5FD" />

      <defs>
        <linearGradient id="login-art-sheen" x1="184" y1="64" x2="400" y2="328" gradientUnits="userSpaceOnUse">
          <stop stopColor="#EFF6FF" stopOpacity="0.6" />
          <stop offset="0.5" stopColor="#FFFFFF" stopOpacity="0" />
        </linearGradient>
      </defs>
    </svg>
  );
}
