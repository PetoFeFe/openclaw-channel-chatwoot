/**
 * Media extraction for outbound Chatwoot replies.
 *
 * Tata is a text agent: when Knowledge returns a Help Center article that
 * embeds an image (for example the pricing table), the agent can only carry it
 * as a Markdown link in its reply. Chatwoot needs a real upload, so the plugin
 * lifts image URLs out of the text, sends them as message attachments, and
 * delivers the cleaned caption.
 *
 * Only explicit Markdown images (`![alt](url)`) are lifted. Bare links are left
 * untouched so ordinary prose that merely mentions a URL is not turned into an
 * attachment.
 */

const MARKDOWN_IMAGE = /!\[[^\]]*\]\(\s*(https?:\/\/[^\s)]+)\s*\)/g;

export interface ExtractedImages {
  /** Remaining caption text with Markdown image tokens removed. */
  text: string;
  /** Unique image URLs in the order they appeared. */
  images: string[];
}

export function extractImageUrls(input: string): ExtractedImages {
  const images: string[] = [];
  let text = input.replace(MARKDOWN_IMAGE, (_match, url: string) => {
    images.push(url);
    return "";
  });
  // Collapse the blank lines left behind by a removed image line.
  text = text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, images: dedupe(images) };
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}
