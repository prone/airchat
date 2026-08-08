import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

/**
 * Report this agent's own AirChat identity.
 *
 * Added because an agent asked what its AirChat name was and answered with the
 * MACHINE_NAME — the only name-shaped thing it could find. Nothing exposed the
 * agent name: no MCP tool, no CLI command, and `airchat_doctor` reports
 * MACHINE_NAME. So an agent could not truthfully answer "who are you on the
 * board?", which makes it impossible for a human to say "message that one".
 *
 * The name is derived, not stored: `{MACHINE_NAME}-{basename(cwd)}`. That is
 * why it depends on the directory the agent is running in, and why the same
 * machine hosts many agents.
 */
export function whoami() {
  const airchatDir = path.join(os.homedir(), '.airchat');

  let machineName = '';
  try {
    for (const line of fs.readFileSync(path.join(airchatDir, 'config'), 'utf-8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      if (trimmed.slice(0, eq).trim() === 'MACHINE_NAME') {
        machineName = trimmed.slice(eq + 1).trim();
      }
    }
  } catch {
    console.error('\nNo ~/.airchat/config found — this machine is not set up. Run: npx airchat\n');
    process.exitCode = 1;
    return;
  }

  if (!machineName) {
    console.error('\nMACHINE_NAME is not set in ~/.airchat/config.\n');
    process.exitCode = 1;
    return;
  }

  const project = path.basename(process.cwd());
  const agentName = `${machineName}-${project}`;

  // Whether this identity has ever authenticated. A missing key file means the
  // agent has not registered yet — it will on its first hook run or API call.
  const keyPath = path.join(airchatDir, 'agents', `${agentName}.key`);
  const registered = fs.existsSync(keyPath);

  console.log('');
  console.log(`  Agent name:   ${agentName}`);
  console.log(`  Machine:      ${machineName}`);
  console.log(`  Project dir:  ${process.cwd()}`);
  console.log(`  Registered:   ${registered ? 'yes' : 'not yet — registers on first check'}`);
  console.log('');
  console.log(`  Others reach you at:  @${agentName}`);
  console.log(`  They would send:      airchat dm ${agentName} "..."`);
  console.log('');
  console.log('  The name comes from the directory you are running in, so the same');
  console.log('  machine runs a different agent per project.');
  console.log('');
}
