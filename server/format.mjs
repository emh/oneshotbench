export const HARNESS_VERSION = 2;
export const OUTPUT_INSTRUCTIONS = `You are completing a one-shot web implementation benchmark. Implement the user's request in one complete, self-contained HTML document, starting with <!DOCTYPE html> and ending with </html>. Return only the HTML, with no Markdown fences or explanation. Include all CSS and JavaScript inline. Use vanilla HTML, CSS, and JavaScript; no build step, imports, external scripts, fonts, images, network requests, or other files. Use inline SVG, CSS, or data URLs for visual assets. Make the implementation functional and polished. It must run in a sandboxed iframe with scripts enabled but without same-origin access, network access, popups, top navigation, downloads, or storage. Keep state in memory. Do not ask clarifying questions. Make reasonable design decisions and deliver the complete implementation in this single response.`;
export const PREVIEW_CSP =
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' data: blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
export function extractHtml(raw) {
  const fenced = raw.match(/```(?:html)?\s*\n([\s\S]*?)```/i);
  const text = (fenced?.[1] ?? raw).trim();
  const start = text.search(/<!doctype\s+html|<html[\s>]/i);
  if (start < 0)
    throw new Error(
      'The model did not return an HTML document. The original response is available in run details.',
    );
  const end = text.toLowerCase().lastIndexOf('</html>');
  if (end < 0)
    throw new Error(
      'The HTML document is incomplete. Try a larger output token limit. The original response is available in run details.',
    );
  return text.slice(start, end + 7);
}
export function safeDocument(html) {
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">\n${html.replace(/<!doctype[^>]*>/i, '')}`;
}
