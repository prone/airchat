/**
 * What download_file returns for a fetched file, by kind:
 *
 *   text     its content, as text
 *   image    its bytes in base64, which the MCP tool returns as an image
 *   other    nothing inline: the signed URL, for the caller to fetch itself
 *
 * Bytes that are not text were once decoded as text and returned mangled, and
 * no image was ever returned as an image.
 */

/** Largest text returned inline. */
export const MAX_INLINE_TEXT_BYTES = 2 * 1024 * 1024;
/** Largest image returned inline (it lands in the agent's context as base64). */
export const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;

const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const TEXT_TYPES = new Set([
  'application/json', 'application/xml', 'application/yaml', 'application/x-yaml',
  'application/javascript', 'application/x-ndjson', 'application/toml', 'application/sql',
]);

export type FileKind = 'text' | 'image' | 'binary';

/** The media type without parameters, lower-cased. */
export function mediaType(contentType: string | null | undefined): string {
  return (contentType ?? 'application/octet-stream').split(';')[0].trim().toLowerCase() || 'application/octet-stream';
}

export function fileKind(contentType: string | null | undefined): FileKind {
  const type = mediaType(contentType);
  if (INLINE_IMAGE_TYPES.has(type)) return 'image';
  if (type.startsWith('text/') || TEXT_TYPES.has(type) || type.endsWith('+json') || type.endsWith('+xml')) return 'text';
  return 'binary';
}

export type FileDownload =
  | { path: string; type: string; size: number; content: string }
  | { path: string; type: string; size: number; content_base64: string }
  | { path: string; type: string; size?: number; signed_url: string; note: string };

/** The answer for a file that is not returned inline. */
export function linkOnly(path: string, contentType: string | null | undefined, signedUrl: string, size?: number): FileDownload {
  return {
    path,
    type: mediaType(contentType),
    ...(size !== undefined ? { size } : {}),
    signed_url: signedUrl,
    note: 'Not returned inline (binary, or too large). Fetch signed_url; it expires in about an hour.',
  };
}

/** The answer for a file whose bytes have been fetched. */
export function inlineDownload(path: string, contentType: string | null | undefined, bytes: Uint8Array, signedUrl: string): FileDownload {
  const type = mediaType(contentType);
  const kind = fileKind(contentType);
  if (kind === 'text' && bytes.byteLength <= MAX_INLINE_TEXT_BYTES) {
    return { path, type, size: bytes.byteLength, content: new TextDecoder('utf-8').decode(bytes) };
  }
  if (kind === 'image' && bytes.byteLength <= MAX_INLINE_IMAGE_BYTES) {
    return { path, type, size: bytes.byteLength, content_base64: Buffer.from(bytes).toString('base64') };
  }
  return linkOnly(path, contentType, signedUrl, bytes.byteLength);
}
