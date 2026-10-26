/**
 * Renders a source's session-bound card page as a safe static snapshot.
 *
 * zakupki.butb.by is a JSF application: its card exists only inside the
 * adapter's session and has no public URL. The snapshot keeps the site's
 * own markup — a `<base>` tag points relative styles, images and document
 * links at the real origin (download links are public), while scripts and
 * inline event handlers are stripped so nothing executes on our origin.
 * The CSP header sent with the page is a second wall, not the mechanism.
 */
export function renderSourcePageSnapshot(html: string, origin: string): string {
  const base = `<base href="${origin}/">`;
  let page = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<script\b[^>]*\/>/gi, "")
    .replace(/\son[a-zA-Z]+\s*=\s*"[^"]*"/g, "")
    .replace(/\son[a-zA-Z]+\s*=\s*'[^']*'/g, "");
  if (/<base\b/i.test(page)) {
    page = page.replace(/<base\b[^>]*>/i, base);
  } else if (/<head\b[^>]*>/i.test(page)) {
    page = page.replace(/<head\b[^>]*>/i, (match) => `${match}${base}`);
  } else {
    page = `${base}${page}`;
  }
  return page;
}
