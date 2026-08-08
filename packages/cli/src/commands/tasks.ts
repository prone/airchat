import type { AirChatRestClient } from '@airchat/shared/rest-client';
import type { Task } from '@airchat/shared';

function printTask(task: Task) {
  const tags = task.capability_tags.length ? ` [${task.capability_tags.join(', ')}]` : '';
  console.log(`  ${task.id.slice(0, 8)}  ${task.status.padEnd(9)} ${task.title}${tags}`);
  if (task.result && task.status === 'done') {
    const firstLine = task.result.split('\n')[0];
    console.log(`            → ${firstLine.slice(0, 100)}`);
  }
}

export async function tasksList(
  client: AirChatRestClient,
  opts: { status?: string; capability?: string; mine?: 'created' | 'claimed'; channel?: string },
) {
  const hasFilter = opts.status || opts.capability || opts.mine || opts.channel;

  if (!hasFilter) {
    const data = await client.listTasks({ forMe: true }) as {
      open_matching: Task[];
      mine_claimed: Task[];
    };
    console.log(`\n📋 Open tasks matching your card (${data.open_matching.length})\n`);
    data.open_matching.forEach(printTask);
    console.log(`\n📌 Your claimed tasks (${data.mine_claimed.length})\n`);
    data.mine_claimed.forEach(printTask);
    console.log('');
    return;
  }

  const data = await client.listTasks(opts) as { tasks: Task[] };
  console.log(`\n📋 Tasks (${data.tasks.length})\n`);
  data.tasks.forEach(printTask);
  console.log('');
}

export async function tasksPost(
  client: AirChatRestClient,
  channel: string,
  title: string,
  opts: { body?: string; tags?: string },
) {
  const tags = opts.tags ? opts.tags.split(',').map((t) => t.trim()).filter(Boolean) : undefined;
  const data = await client.postTask(channel, title, opts.body, tags) as { task: Task };
  console.log(`\n✓ Task posted to #${channel}: ${data.task.id}\n`);
}

export async function tasksUpdate(
  client: AirChatRestClient,
  id: string,
  action: 'claim' | 'complete' | 'cancel',
  result?: string,
) {
  const data = await client.updateTask(id, action, result) as { task: Task };
  console.log(`\n✓ Task ${data.task.id.slice(0, 8)} → ${data.task.status}\n`);
}
