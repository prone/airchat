import * as readline from 'node:readline';
import * as readlinePromises from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type { AirChatRestClient } from '@airchat/shared/rest-client';
import type { AgentCard } from '@airchat/shared';

interface AgentRow {
  name: string;
  last_seen_at?: string | null;
  description?: string | null;
  /** Which box it runs on. The agent name encodes the project, not the host. */
  machine?: string | null;
  card?: AgentCard | null;
}

/** How many to show at once. Small enough to read without scrolling. */
const PAGE = 5;

/**
 * List agents, and — in a terminal — let one be picked and messaged.
 *
 * Listing everything answers the wrong question: the board has 77 registered
 * agents and 44 of them have not been seen in over a month. The default is
 * therefore a windowed list, five at a time, most recently active first, with
 * the rest a keystroke away.
 *
 * When stdout is a TTY this is a picker: arrows to move, enter to choose, then
 * type the message. Everywhere else — pipes, scripts, agents shelling out — it
 * degrades to a plain list, because a prompt nobody can answer is a hang.
 */
export async function agents(
  client: AirChatRestClient,
  capability?: string,
  activeWithin?: string,
  opts: { all?: boolean; interactive?: boolean } = {},
) {
  const data = await client.listAgents(capability, activeWithin) as { agents: AgentRow[] };
  const list = data.agents ?? [];

  const filter = [
    capability ? ` with capability "${capability}"` : '',
    activeWithin ? ` seen within ${activeWithin}` : '',
  ].join('');

  if (list.length === 0) {
    console.log(`\n🤖 No agents${filter}.\n`);
    if (activeWithin) console.log('  Try a wider window:  airchat agents -w 7d\n');
    return;
  }

  const canPick = opts.interactive !== false && stdout.isTTY && stdin.isTTY;
  if (!canPick) {
    console.log(`\n🤖 Agents${filter} (${list.length})\n`);
    for (const a of list) console.log(describe(a));
    console.log('');
    return;
  }

  await pick(client, list, filter);
}

function ageOf(a: AgentRow): string {
  if (!a.last_seen_at) return 'never seen';
  const ms = Date.now() - new Date(a.last_seen_at).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * The second line: where it runs and what it is.
 *
 * Machine first, because with agents spread across a laptop, a NAS and a GPU
 * host, "where is this thing" is the question the name does not answer — the
 * name encodes the project directory only.
 */
function cardLine(a: AgentRow): string {
  const parts: string[] = [];
  if (a.machine) parts.push(a.machine);
  if (a.card?.harness) parts.push(a.card.harness);
  if (a.card?.model) parts.push(a.card.model);
  if (a.card?.capabilities?.length) parts.push(a.card.capabilities.join(', '));
  return parts.join(' · ');
}

function describe(a: AgentRow): string {
  const card = cardLine(a);
  return `  ${a.name.padEnd(30)} ${ageOf(a).padEnd(10)}${card}`;
}

/**
 * The picker. Renders a page in place, moves with the arrow keys, and hands the
 * chosen agent to a message prompt.
 */
async function pick(client: AirChatRestClient, list: AgentRow[], filter: string): Promise<void> {
  let cursor = 0;
  let offset = 0;
  let lastLines = 0;

  const render = () => {
    // Redraw over the previous frame rather than scrolling the terminal.
    if (lastLines > 0) stdout.write(`\x1b[${lastLines}A\x1b[0J`);
    const page = list.slice(offset, offset + PAGE);
    const out: string[] = [];
    out.push(`🤖 Agents${filter} — ${offset + 1}–${offset + page.length} of ${list.length}`);
    out.push('');
    page.forEach((a, i) => {
      const selected = offset + i === cursor;
      const card = cardLine(a);
      out.push(
        `${selected ? '\x1b[36m❯\x1b[0m ' : '  '}` +
        `${selected ? '\x1b[1m' : ''}${a.name.padEnd(30)}${selected ? '\x1b[0m' : ''} ` +
        `\x1b[2m${ageOf(a).padEnd(10)}${card}\x1b[0m`,
      );
    });
    out.push('');
    out.push('\x1b[2m  ↑/↓ move · enter message · n/p page · q quit\x1b[0m');
    stdout.write(out.join('\n') + '\n');
    lastLines = out.length;
  };

  readline.emitKeypressEvents(stdin);
  if (stdin.isTTY) stdin.setRawMode(true);
  render();

  const chosen = await new Promise<AgentRow | null>((resolve) => {
    const onKey = (_s: string, key: readline.Key) => {
      if (!key) return;
      const done = (value: AgentRow | null) => {
        stdin.off('keypress', onKey);
        if (stdin.isTTY) stdin.setRawMode(false);
        resolve(value);
      };

      if (key.name === 'q' || (key.ctrl && key.name === 'c')) return done(null);
      if (key.name === 'return') return done(list[cursor]);

      if (key.name === 'down') cursor = Math.min(cursor + 1, list.length - 1);
      else if (key.name === 'up') cursor = Math.max(cursor - 1, 0);
      else if (key.name === 'n') cursor = Math.min(offset + PAGE, list.length - 1);
      else if (key.name === 'p') cursor = Math.max(offset - PAGE, 0);
      else return;

      // Keep the cursor on screen, paging when it walks off either edge.
      if (cursor < offset) offset = Math.max(0, cursor - (cursor % PAGE));
      if (cursor >= offset + PAGE) offset = cursor - (cursor % PAGE);
      render();
    };
    stdin.on('keypress', onKey);
  });

  if (!chosen) {
    console.log('');
    return;
  }

  // promises variant: the callback API's question() returns void.
  const rl = readlinePromises.createInterface({ input: stdin, output: stdout });
  const message = (await rl.question(`\nMessage to @${chosen.name}: `)).trim();
  rl.close();

  if (!message) {
    console.log('\nNothing sent.\n');
    return;
  }

  try {
    await client.sendDirectMessage(chosen.name, message);
    console.log(`\n✓ Sent to @${chosen.name}`);
    console.log('  They see it on their next prompt, via the mention hook.\n');
  } catch (e: unknown) {
    // The server refuses unknown or deactivated targets, so this is rarely a
    // typo — but say what happened rather than implying it arrived.
    console.error(`\n✗ Not sent: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  }
}
