/**
 * Text normalization pipeline for safety classification.
 *
 * Runs before heuristic pattern matching to defeat obfuscation.
 * Applied to message content AND metadata string values.
 * Original content is preserved in storage; normalization is classification-only.
 */

// Common Unicode homoglyph mappings (Cyrillic, Greek, etc. → ASCII)
const HOMOGLYPH_MAP: Record<string, string> = {
  // Cyrillic
  '\u0410': 'A', '\u0430': 'a', '\u0412': 'B', '\u0435': 'e',
  '\u0415': 'E', '\u041D': 'H', '\u043E': 'o', '\u041E': 'O',
  '\u0440': 'p', '\u0420': 'P', '\u0441': 'c', '\u0421': 'C',
  '\u0443': 'y', '\u0423': 'Y', '\u0445': 'x', '\u0425': 'X',
  '\u0422': 'T', '\u0442': 't', '\u041C': 'M', '\u043C': 'm',
  '\u041A': 'K', '\u043A': 'k', '\u0456': 'i', '\u0406': 'I',
  // Greek
  '\u0391': 'A', '\u03B1': 'a', '\u0392': 'B', '\u03B2': 'b',
  '\u0395': 'E', '\u03B5': 'e', '\u0397': 'H', '\u03B7': 'h',
  '\u0399': 'I', '\u03B9': 'i', '\u039A': 'K', '\u03BA': 'k',
  '\u039C': 'M', '\u039D': 'N', '\u039F': 'O', '\u03BF': 'o',
  '\u03A1': 'P', '\u03C1': 'p', '\u03A4': 'T', '\u03C4': 't',
  '\u03A5': 'Y', '\u03C5': 'y', '\u03A7': 'X', '\u03C7': 'x',
};

/** Zero-width characters to strip. */
const ZERO_WIDTH_REGEX = /[\u200B\u200C\u200D\uFEFF\u00AD\u2060\u180E]/g;

/** Multiple whitespace (including Unicode spaces) collapsed to single space. */
const WHITESPACE_REGEX = /[\s\u00A0\u2000-\u200A\u202F\u205F\u3000]+/g;

/** Base64 pattern: 20+ chars of base64 alphabet. */
const BASE64_REGEX = /[A-Za-z0-9+/=]{20,}/g;

/** Hex string pattern: 20+ hex chars (optionally space-separated). */
const HEX_REGEX = /(?:[0-9a-fA-F]{2}\s*){10,}/g;

/** URL-encoded pattern: repeated %XX sequences. */
const URL_ENCODED_REGEX = /(?:%[0-9a-fA-F]{2}){5,}/g;

/** Unicode escape pattern: repeated \uXXXX sequences. */
const UNICODE_ESCAPE_REGEX = /(?:\\u[0-9a-fA-F]{4}){3,}/g;

/** Octal escape pattern: repeated \NNN sequences. */
const OCTAL_REGEX = /(?:\\[0-3][0-7]{2}){3,}/g;

/** Decimal ASCII pattern: space-separated numbers 32-126. */
const DECIMAL_ASCII_REGEX = /(?:\b(?:3[2-9]|[4-9]\d|1[01]\d|12[0-6])\b\s+){4,}/g;

/**
 * Step 1: Strip zero-width characters.
 */
export function stripZeroWidth(text: string): string {
  return text.replace(ZERO_WIDTH_REGEX, '');
}

/**
 * Step 2: Resolve Unicode homoglyphs to ASCII equivalents.
 */
export function resolveHomoglyphs(text: string): string {
  let result = '';
  for (const char of text) {
    result += HOMOGLYPH_MAP[char] ?? char;
  }
  return result;
}

/**
 * Step 3: Collapse whitespace.
 */
export function collapseWhitespace(text: string): string {
  return text.replace(WHITESPACE_REGEX, ' ').trim();
}

/**
 * Step 4: Decode inline base64 fragments and return decoded text.
 * Returns both the original text with decoded annotations and
 * a list of decoded segments for separate classification.
 */
export function decodeBase64Fragments(text: string): { text: string; decoded: string[] } {
  const decoded: string[] = [];
  const result = text.replace(BASE64_REGEX, (match) => {
    try {
      const bytes = Buffer.from(match, 'base64');
      const str = bytes.toString('utf-8');
      // Only count as decoded if it contains printable ASCII
      if (/^[\x20-\x7E\n\r\t]+$/.test(str) && str.length > 5) {
        decoded.push(str);
        return `${match} [DECODED: ${str}]`;
      }
    } catch {
      // Not valid base64, leave as-is
    }
    return match;
  });
  return { text: result, decoded };
}

/**
 * Step 5: Decode extended encodings (hex, URL-encoded, Unicode escapes, octal, decimal ASCII).
 * Returns decoded segments for classification.
 */
export function decodeExtendedEncodings(text: string): string[] {
  const decoded: string[] = [];

  // Hex strings
  for (const match of text.matchAll(HEX_REGEX)) {
    try {
      const hex = match[0].replace(/\s/g, '');
      const bytes = Buffer.from(hex, 'hex');
      const str = bytes.toString('utf-8');
      if (/^[\x20-\x7E\n\r\t]+$/.test(str) && str.length > 3) {
        decoded.push(str);
      }
    } catch { /* not valid hex */ }
  }

  // URL-encoded
  for (const match of text.matchAll(URL_ENCODED_REGEX)) {
    try {
      const str = decodeURIComponent(match[0]);
      if (str.length > 3) decoded.push(str);
    } catch { /* not valid URL encoding */ }
  }

  // Unicode escapes (\uXXXX)
  for (const match of text.matchAll(UNICODE_ESCAPE_REGEX)) {
    try {
      const str = match[0].replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
        String.fromCharCode(parseInt(hex, 16))
      );
      if (str.length > 3) decoded.push(str);
    } catch { /* not valid unicode escapes */ }
  }

  // Octal escapes (\NNN)
  for (const match of text.matchAll(OCTAL_REGEX)) {
    try {
      const str = match[0].replace(/\\([0-3][0-7]{2})/g, (_, oct) =>
        String.fromCharCode(parseInt(oct, 8))
      );
      if (str.length > 3) decoded.push(str);
    } catch { /* not valid octal */ }
  }

  // Decimal ASCII (space-separated numbers)
  for (const match of text.matchAll(DECIMAL_ASCII_REGEX)) {
    try {
      const nums = match[0].trim().split(/\s+/).map(Number);
      if (nums.every((n) => n >= 32 && n <= 126)) {
        const str = String.fromCharCode(...nums);
        if (str.length > 3) decoded.push(str);
      }
    } catch { /* not valid decimal ASCII */ }
  }

  return decoded;
}

/**
 * Step 6: Strip markdown formatting artifacts that could hide content.
 */
export function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (match) => match.replace(/```\w*\n?/g, '').replace(/```/g, ''))
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1');
}

/**
 * Full normalization pipeline.
 * Returns normalized text for pattern matching plus any decoded segments.
 */
export function normalize(text: string): { normalized: string; decoded_segments: string[] } {
  let result = stripZeroWidth(text);
  result = resolveHomoglyphs(result);
  result = collapseWhitespace(result);

  const { text: withBase64, decoded: base64Decoded } = decodeBase64Fragments(result);
  result = withBase64;

  const extendedDecoded = decodeExtendedEncodings(text); // Run on original to catch pre-normalization encodings too
  result = stripMarkdown(result);
  result = collapseWhitespace(result); // Final collapse after markdown strip

  return {
    normalized: result,
    decoded_segments: [...base64Decoded, ...extendedDecoded],
  };
}

/**
 * Extract all string values from a metadata object for classification.
 * Fix #16: Depth-limited to prevent stack overflow on deeply nested objects.
 */
export function extractMetadataStrings(metadata: Record<string, unknown> | null): string[] {
  if (!metadata) return [];
  const strings: string[] = [];
  const MAX_DEPTH = 10;

  function walk(obj: unknown, depth: number): void {
    if (depth > MAX_DEPTH) return;
    if (typeof obj === 'string') {
      strings.push(obj);
    } else if (Array.isArray(obj)) {
      obj.forEach(item => walk(item, depth + 1));
    } else if (obj && typeof obj === 'object') {
      Object.values(obj).forEach(val => walk(val, depth + 1));
    }
  }

  walk(metadata, 0);
  return strings;
}
