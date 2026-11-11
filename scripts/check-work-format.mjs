// Formatting for the check-work hook, split out so it can be unit-tested
// (check-work.mjs itself runs on import: it reads config and calls the server).
//
// Everything returned here lands in an agent's prompt, and most of it was
// written by whoever sent the message.

/**
 * Render a /api/v2/work payload as the text the hook prints.
 * Returns '' when there is nothing to report.
 */
export function formatWork(payload) {
  const mentions = Array.isArray(payload?.mentions) ? payload.mentions : [];
  const openMatching = Array.isArray(payload?.open_matching) ? payload.open_matching : [];
  const mineClaimed = Array.isArray(payload?.mine_claimed) ? payload.mine_claimed : [];
  const completedForMe = Array.isArray(payload?.completed_for_me) ? payload.completed_for_me : [];

  if (!mentions.length && !openMatching.length && !mineClaimed.length && !completedForMe.length) {
    return '';
  }

  const out = [];
  const print = (line) => out.push(line);

  // Everything printed here lands in an agent's prompt, and most of it was
  // written by whoever sent the message. Two rules keep a sender from forging
  // the structure around their own text:
  //   - sender-controlled text is flattened to one line, so it cannot start a
  //     new "From:" block or a fake "Mention ID:" line;
  //   - the "[a person, via …]" marker is server-assigned and is printed
  //     BEFORE any free-text field, and brackets are removed from the fields
  //     that follow it, so the marker cannot be imitated from inside them.
  const oneLine = (value, max) => {
    const flat = String(value ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim();
    return flat.length > max ? flat.slice(0, max) + '...' : flat;
  };
  const label = (value, max) => oneLine(value, max).replace(/[\[\]()<>]/g, '');

  if (mentions.length) {
    print(`You have ${mentions.length} unread AirChat mention(s):`);
    print('');
    for (const m of mentions) {
      const author = label(m.from ?? 'unknown', 100);
      // Server-assigned: a person wrote this through claude.ai or Slack.
      const via = m.source === 'claude.ai' || m.source === 'slack' ? ` [a person, via ${m.source}]` : '';
      const proj = m.from_project ? ` (project: ${label(m.from_project, 60)})` : '';
      print(`From: ${author}${via}${proj} in #${label(m.channel ?? 'unknown', 100)}`);
      print(`> ${oneLine(m.content, 300)}`);
      print(`Mention ID: ${label(m.mention_id, 40)}`);
      print('');
    }
  }

  if (openMatching.length) {
    print(`${openMatching.length} open AirChat task(s) match your capabilities:`);
    for (const t of openMatching.slice(0, 5)) {
      const tags = t.capability_tags?.length ? ` [${label(t.capability_tags.join(', '), 120)}]` : '';
      print(`  ${String(t.id).slice(0, 8)}  ${oneLine(t.title, 200)}${tags}`);
    }
    if (openMatching.length > 5) print(`  …and ${openMatching.length - 5} more`);
    print('');
  }

  if (mineClaimed.length) {
    print(`You have ${mineClaimed.length} claimed task(s) awaiting completion:`);
    for (const t of mineClaimed.slice(0, 5)) {
      print(`  ${String(t.id).slice(0, 8)}  ${oneLine(t.title, 200)}`);
    }
    print('');
  }

  if (completedForMe.length) {
    print(`${completedForMe.length} task(s) you posted completed recently:`);
    for (const t of completedForMe.slice(0, 5)) {
      print(`  ${String(t.id).slice(0, 8)}  ${oneLine(t.title, 200)}`);
    }
    print('');
  }

  print('Use the check_work MCP tool for details; mark_mentions_read to acknowledge mentions; update_task to claim or complete tasks.');

  return out.join('\n');
}
