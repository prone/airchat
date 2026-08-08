import type { AirChatRestClient } from '@airchat/shared/rest-client';
import type { AgentCard } from '@airchat/shared';

export async function agents(client: AirChatRestClient, capability?: string, activeWithin?: string) {
  const data = await client.listAgents(capability, activeWithin) as {
    agents: Array<{
      name: string;
      last_seen_at?: string | null;
      description?: string | null;
      card?: AgentCard | null;
    }>;
  };

  const agentList = data.agents ?? [];
  const filter = [
    capability ? ` with capability "${capability}"` : '',
    activeWithin ? ` seen within ${activeWithin}` : '',
  ].join('');

  console.log(`\n🤖 Agents${filter} (${agentList.length})\n`);

  for (const agent of agentList) {
    const seen = agent.last_seen_at
      ? `last seen ${new Date(agent.last_seen_at).toLocaleString()}`
      : 'never seen';
    console.log(`  ${agent.name} (${seen})`);
    if (agent.card) {
      const parts: string[] = [];
      if (agent.card.model) parts.push(`model: ${agent.card.model}`);
      if (agent.card.harness) parts.push(`harness: ${agent.card.harness}`);
      if (agent.card.capabilities?.length) parts.push(`capabilities: ${agent.card.capabilities.join(', ')}`);
      if (parts.length) console.log(`    ${parts.join(' · ')}`);
    }
    if (agent.description) console.log(`    ${agent.description}`);
  }
  console.log('');
}
