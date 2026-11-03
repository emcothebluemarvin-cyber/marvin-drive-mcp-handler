/**
 * The page the browser shows after the Google consent redirect hits our loopback server.
 * Self-contained by design: no scripts, no external fonts/images, strict CSP.
 */

export type CallbackPage =
  | { kind: 'success'; email: string }
  | { kind: 'failure'; message: string }
  | { kind: 'stale' }
  | { kind: 'finished' };

export const CALLBACK_PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
} as const;

type Tone = 'ok' | 'err' | 'neutral';

interface PageContent {
  tone: Tone;
  title: string;
  heading: string;
  /** Pre-escaped HTML fragment between the heading and the lead paragraph. */
  detail: string;
  lead: string;
  footnote: string;
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

function content(page: CallbackPage): PageContent {
  switch (page.kind) {
    case 'success':
      return {
        tone: 'ok',
        title: 'Drive connected',
        heading: 'Drive connected.',
        detail: `<dl class="record"><dt>Account</dt><dd>${escapeHtml(page.email)}</dd></dl>`,
        lead: 'You can close this tab and return to the terminal.',
        footnote: 'The refresh token is stored in your macOS Keychain — never on disk.',
      };
    case 'failure':
      return {
        tone: 'err',
        title: 'Couldn’t connect',
        heading: 'Couldn’t connect.',
        detail: `<p class="reason">${escapeHtml(page.message)}</p>`,
        lead: 'Return to the terminal and run the <code>marvin-drive auth</code> command again.',
        footnote: 'Nothing was saved.',
      };
    case 'stale':
      return {
        tone: 'neutral',
        title: 'Link expired',
        heading: 'This link has expired.',
        detail: '',
        lead: 'Start a new login from the terminal.',
        footnote: 'For your safety, each login link works only once.',
      };
    case 'finished':
      return {
        tone: 'neutral',
        title: 'Already done',
        heading: 'Already done.',
        detail: '',
        lead: 'This login has finished. You can close this tab.',
        footnote: 'The terminal has the result.',
      };
  }
}

const MARKS: Record<Tone, string> = {
  ok: '<path class="glyph" d="M15 24.5l6 6 12-13"/>',
  err: '<path class="glyph" d="M17 17l14 14M31 17L17 31"/>',
  neutral: '<path class="glyph" d="M15 24h18"/>',
};

const STYLES = `
:root {
  color-scheme: light dark;
  --bg: #f5f3ee;
  --ink: #15171b;
  --muted: #5d6169;
  --line: #dedbd3;
  --ok: #1d6f47;
  --err: #a8261d;
  --neutral: #5d6169;
  --sans: ui-sans-serif, -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", system-ui, sans-serif;
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0e0f11;
    --ink: #ecebe8;
    --muted: #a3a6ad;
    --line: #26282d;
    --ok: #5fcf96;
    --err: #ff8f86;
    --neutral: #a3a6ad;
  }
}
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  min-height: 100vh;
  min-height: 100dvh;
  display: grid;
  grid-template-columns: minmax(16px, 1fr) minmax(0, 34rem) minmax(16px, 2.2fr);
  align-items: center;
  background: var(--bg);
  color: var(--ink);
  font: 400 17px/1.55 var(--sans);
  -webkit-font-smoothing: antialiased;
}
main { grid-column: 2; padding: 12vh 0; }
.tone-ok { --accent: var(--ok); }
.tone-err { --accent: var(--err); }
.tone-neutral { --accent: var(--neutral); }
.brand {
  margin: 0 0 3.5rem;
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--muted);
}
.mark { display: block; width: 48px; height: 48px; margin-bottom: 1.75rem; }
.mark circle, .mark .glyph {
  fill: none;
  stroke: var(--accent);
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.mark circle { stroke-dasharray: 139; stroke-dashoffset: 139; animation: draw 700ms cubic-bezier(.65,0,.35,1) forwards; }
.mark .glyph { stroke-width: 2; stroke-dasharray: 40; stroke-dashoffset: 40; animation: draw 420ms cubic-bezier(.65,0,.35,1) 520ms forwards; }
h1 {
  margin: 0 0 2rem;
  font-size: clamp(2.4rem, 6vw, 3.6rem);
  line-height: 1.02;
  font-weight: 640;
  letter-spacing: -0.035em;
}
.record {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 1.5rem;
  align-items: baseline;
  margin: 0 0 1.5rem;
  padding: 0.9rem 0;
  border-block: 1px solid var(--line);
}
.record dt {
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--muted);
}
.record dd { margin: 0; font: 500 0.95rem/1.4 var(--mono); overflow-wrap: anywhere; }
.reason {
  margin: 0 0 1.5rem;
  padding-left: 1rem;
  border-left: 2px solid var(--accent);
  overflow-wrap: anywhere;
}
.lead { margin: 0; max-width: 28rem; }
code { font: 500 0.9em var(--mono); white-space: nowrap; }
footer {
  margin-top: 4.5rem;
  font-size: 0.8rem;
  color: var(--muted);
}
.rise { opacity: 0; transform: translateY(6px); animation: rise 520ms cubic-bezier(.2,.7,.2,1) forwards; animation-delay: var(--d, 0ms); }
@keyframes draw { to { stroke-dashoffset: 0; } }
@keyframes rise { to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) {
  .mark circle, .mark .glyph { animation: none; stroke-dashoffset: 0; }
  .rise { animation: none; opacity: 1; transform: none; }
}
`;

export function renderCallbackPage(page: CallbackPage): string {
  const c = content(page);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${c.title} · Marvin Drive</title>
<style>${STYLES}</style>
</head>
<body class="tone-${c.tone}">
<main>
<p class="brand rise">Marvin Drive</p>
<svg class="mark" viewBox="0 0 48 48" aria-hidden="true" focusable="false"><circle cx="24" cy="24" r="22"/>${MARKS[c.tone]}</svg>
<h1 class="rise" style="--d:120ms">${c.heading}</h1>
${c.detail ? `<div class="rise" style="--d:220ms">${c.detail}</div>` : ''}
<p class="lead rise" style="--d:300ms">${c.lead}</p>
<footer class="rise" style="--d:420ms">${c.footnote}</footer>
</main>
</body>
</html>
`;
}
