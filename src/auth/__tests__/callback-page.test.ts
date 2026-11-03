import { describe, expect, it } from 'vitest';
import { CALLBACK_PAGE_HEADERS, renderCallbackPage } from '../callback-page.js';

describe('renderCallbackPage', () => {
  it('confirms the connected account on success', () => {
    const html = renderCallbackPage({ kind: 'success', email: 'emco@example.com' });
    expect(html).toContain('<title>Drive connected · Marvin Drive</title>');
    expect(html).toContain('Drive connected.');
    expect(html).toContain('emco@example.com');
    expect(html).toContain('close this tab');
  });

  it('explains failures', () => {
    const html = renderCallbackPage({ kind: 'failure', message: 'Drive access was not granted.' });
    expect(html).toContain('Couldn’t connect.');
    expect(html).toContain('Drive access was not granted.');
    expect(html).toContain('marvin-drive auth');
  });

  it('has pages for stale links and finished logins', () => {
    expect(renderCallbackPage({ kind: 'stale' })).toContain('This link has expired.');
    expect(renderCallbackPage({ kind: 'finished' })).toContain('Already done.');
  });

  it('escapes untrusted text', () => {
    const html = renderCallbackPage({
      kind: 'failure',
      message: '<script>alert("x")</script> & co',
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; co');
  });

  it('is self-contained: no scripts, no external resources, dark mode and reduced motion', () => {
    const html = renderCallbackPage({ kind: 'success', email: 'a@b.c' });
    expect(html).not.toMatch(/<script|<link|src=|https?:\/\//);
    expect(html).toContain('prefers-color-scheme: dark');
    expect(html).toContain('prefers-reduced-motion');
    expect(html).toContain('lang="en"');
  });

  it('ships a restrictive content security policy', () => {
    expect(CALLBACK_PAGE_HEADERS['Content-Security-Policy']).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    expect(CALLBACK_PAGE_HEADERS['Content-Type']).toBe('text/html; charset=utf-8');
  });
});
