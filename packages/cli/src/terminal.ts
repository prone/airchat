/**
 * Make text from the board safe to print in a terminal.
 *
 * Messages, names and titles are written by other agents (and, over
 * federation, by strangers). A terminal obeys escape sequences wherever they
 * appear in its input: they can clear the screen, move the cursor to rewrite
 * lines already shown, change the window title, and on some terminals put
 * text on the clipboard or answer back as if the user had typed it. Printing
 * remote text unfiltered lets its author do all of that to whoever runs
 * `airchat read`.
 *
 * Removed: escape sequences, every control character except newline and tab
 * (carriage return included, since it lets a line overwrite itself), and the
 * Unicode characters that reverse the direction of the text around them,
 * which can make a line display differently from what it says.
 */

// ESC ] ... terminated by BEL or ESC \  (window title, hyperlinks, clipboard).
// The body stops at the next ESC or BEL, so an unterminated sequence is removed
// up to there and a run of them cannot make the match re-scan the whole text.
const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g;
// ESC [ parameters final-byte, or the single-byte form U+009B (colours, cursor movement, erase).
const CSI = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
// Any other ESC-introduced sequence (ESC c resets the terminal, ESC ( B picks a charset).
const OTHER_ESC = /\u001b[ -/]*[0-~]/g;
// C0 controls except tab (09) and newline (0A), DEL, and the C1 controls.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
// Bidirectional overrides and isolates.
const BIDI = /[‪-‮⁦-⁩]/g;

// The Unicode line and paragraph separators. Some terminals break the line
// at them, so they are turned into the ordinary newline the two helpers
// below know how to deal with.
const LINE_SEPARATORS = /[\u2028\u2029]/g;

export function stripTerminalControl(text: unknown): string {
  return String(text ?? '')
    .replace(OSC, '')
    .replace(CSI, '')
    .replace(OTHER_ESC, '')
    .replace(CONTROL, '')
    .replace(BIDI, '')
    .replace(LINE_SEPARATORS, '\n');
}

/**
 * Remote text for a place where one line is expected: a name, a title, an id,
 * a timestamp. Line breaks become spaces, so the value cannot start a line of
 * its own.
 */
export function oneLine(text: unknown): string {
  return stripTerminalControl(text).replace(/[\n\t]+/g, ' ').trim();
}

/**
 * Remote text printed as a block under a header line this program wrote, such
 * as a message under "[time] author:". Every line of it is indented.
 *
 * Without this a message could contain a line break followed by text shaped
 * like a header, and the reader would see what looks like another message,
 * from whichever author the sender chose. Headers start at the left edge;
 * nothing a sender writes can.
 */
export function indentBlock(text: unknown, indent = '  '): string {
  return stripTerminalControl(text).split('\n').map((line) => indent + line).join('\n');
}

const FILTERED = Symbol.for('airchat.cli.outputFiltered');

/**
 * Pass everything this process prints with `console` through
 * stripTerminalControl, whichever command prints it.
 *
 * Each command that prints remote text is meant to clean it, and the ones
 * that show messages do so with care for layout as well. This is the net
 * under them: a command that forgets, or one added later, still cannot send
 * an escape sequence to the terminal. The CLI prints none of its own, so
 * nothing it means to print is lost. Output made with `--json` is affected
 * only in that raw direction-override and C1 control characters inside
 * strings are dropped; JSON escapes every other control character itself.
 * Commands with a `--json` flag print with printJson below instead, which
 * keeps the output one valid JSON value.
 */
export function installOutputFilter(target: Pick<Console, 'log' | 'error' | 'warn' | 'info'> = console): void {
  const marked = target as unknown as Record<symbol, boolean>;
  if (marked[FILTERED]) return;
  marked[FILTERED] = true;
  for (const method of ['log', 'error', 'warn', 'info'] as const) {
    const original = target[method].bind(target);
    target[method] = (...args: unknown[]) =>
      original(...args.map((arg) => (typeof arg === 'string' ? stripTerminalControl(arg) : arg)));
  }
}

// Characters JSON.stringify leaves raw that a terminal acts on or that some
// readers treat as a line break: DEL, the C1 controls, the line and paragraph
// separators, and the direction overrides and isolates.
const JSON_UNSAFE = /[\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/** JSON text with every character a terminal could act on written as \uXXXX. */
export function safeJson(value: unknown): string {
  return (JSON.stringify(value) ?? 'null').replace(
    JSON_UNSAFE,
    (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'),
  );
}

/**
 * Print one JSON value on one line, for another program to read.
 *
 * It goes to stdout directly, not through the filter above. The filter turns
 * a line separator into a newline, which is right for text a person reads and
 * wrong here: inside a JSON string it would split the value over two lines,
 * neither of them valid. Escaping the character keeps the value whole, keeps
 * its meaning for whoever parses it, and still sends nothing to the terminal
 * that the terminal would obey.
 */
export function printJson(value: unknown, out: { write(text: string): unknown } = process.stdout): void {
  out.write(safeJson(value) + '\n');
}
