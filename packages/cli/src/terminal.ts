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

export function stripTerminalControl(text: unknown): string {
  return String(text ?? '')
    .replace(OSC, '')
    .replace(CSI, '')
    .replace(OTHER_ESC, '')
    .replace(CONTROL, '')
    .replace(BIDI, '');
}
