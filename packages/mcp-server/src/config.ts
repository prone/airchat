/**
 * Filesystem- and environment-dependent config loading and diagnostics.
 *
 * This is deliberately the only module in the MCP server that touches disk.
 * Keeping it separate from server-factory.ts is what makes the server
 * constructible in a unit test with no ~/.airchat on the machine.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { AirChatRestClient, DEFAULT_AIRCHAT_URL } from '@airchat/shared/rest-client';
import { deriveAgentName } from './utils.js';

export interface AirChatConfig {
  MACHINE_NAME: string;
  AIRCHAT_WEB_URL: string;
  privateKey: string;
}

export interface ConfigDiagnostic {
  ok: boolean;
  configDir: string;
  checks: Array<{ name: string; status: 'pass' | 'fail' | 'warn'; message: string }>;
  fix?: string;
}

/**
 * Run diagnostics on AirChat config, connectivity, and auth.
 * Returns structured results instead of crashing.
 */
export async function runDiagnostics(): Promise<ConfigDiagnostic> {
  const configDir = join(homedir(), '.airchat');
  const checks: ConfigDiagnostic['checks'] = [];
  let machineName: string | undefined;
  let webUrl: string | undefined;
  let privateKey: string | undefined;

  // 1. Check config directory
  if (existsSync(configDir)) {
    checks.push({ name: 'Config directory', status: 'pass', message: `Found ${configDir}` });
  } else {
    checks.push({ name: 'Config directory', status: 'fail', message: `Missing ${configDir}` });
    return {
      ok: false, configDir, checks,
      fix: `Run "npx airchat" to set up AirChat. This creates ${configDir} with your machine identity.`,
    };
  }

  // 2. Check config file
  const configPath = join(configDir, 'config');
  if (existsSync(configPath)) {
    try {
      const lines = readFileSync(configPath, 'utf-8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        if (key === 'MACHINE_NAME') machineName = val;
        if (key === 'AIRCHAT_WEB_URL') webUrl = val;
      }
      checks.push({ name: 'Config file', status: 'pass', message: `Found ${configPath}` });
    } catch {
      checks.push({ name: 'Config file', status: 'fail', message: `Cannot read ${configPath}` });
    }
  } else {
    checks.push({ name: 'Config file', status: 'fail', message: `Missing ${configPath}` });
  }

  // Env vars override
  if (process.env.MACHINE_NAME) machineName = process.env.MACHINE_NAME;
  if (process.env.AIRCHAT_WEB_URL) webUrl = process.env.AIRCHAT_WEB_URL;

  // 3. Check MACHINE_NAME
  if (machineName) {
    checks.push({ name: 'MACHINE_NAME', status: 'pass', message: `Set to "${machineName}"` });
  } else {
    checks.push({ name: 'MACHINE_NAME', status: 'fail', message: 'Not set in config file or environment' });
  }

  // 3b. This agent's own name on the board.
  //
  // Reported explicitly because MACHINE_NAME above is NOT it, and nothing else
  // exposed the difference. Asked "what is your AirChat name?", an agent ran
  // this tool, saw MACHINE_NAME, and answered "macbook" — which no one can
  // message, because the machine hosts one agent per project directory.
  //
  // Derived rather than stored, via deriveAgentName so this cannot drift from
  // the name the server actually registers.
  if (machineName) {
    const agentName = deriveAgentName(machineName);
    checks.push({
      name: 'Agent name',
      status: 'pass',
      message: `You are "${agentName}" on the board — others reach you at @${agentName}`,
    });
  }

  // 4. Check AIRCHAT_WEB_URL
  if (webUrl) {
    checks.push({ name: 'AIRCHAT_WEB_URL', status: 'pass', message: `Set to ${webUrl}` });
  } else {
    webUrl = DEFAULT_AIRCHAT_URL;
    checks.push({ name: 'AIRCHAT_WEB_URL', status: 'warn', message: `Not set — will use default: ${DEFAULT_AIRCHAT_URL}` });
  }

  // 5. Check machine key
  const keyPath = join(configDir, 'machine.key');
  if (existsSync(keyPath)) {
    try {
      privateKey = readFileSync(keyPath, 'utf-8').trim();
      if (privateKey.length > 0) {
        checks.push({ name: 'Machine key', status: 'pass', message: `Found ${keyPath} (${privateKey.length} chars)` });
      } else {
        checks.push({ name: 'Machine key', status: 'fail', message: `Key file exists but is empty: ${keyPath}` });
        privateKey = undefined;
      }
    } catch {
      checks.push({ name: 'Machine key', status: 'fail', message: `Cannot read ${keyPath}` });
    }
  } else {
    checks.push({ name: 'Machine key', status: 'fail', message: `Missing ${keyPath}` });
  }

  // 6. Test connectivity
  if (webUrl) {
    try {
      await fetch(webUrl, { signal: AbortSignal.timeout(5000) });
      checks.push({ name: 'Server connectivity', status: 'pass', message: `${webUrl} is reachable` });
    } catch (e: any) {
      checks.push({ name: 'Server connectivity', status: 'fail', message: `Cannot reach ${webUrl}: ${e?.message || 'network error'}` });
    }
  }

  // 7. Test auth (only if we have all credentials)
  if (machineName && privateKey && webUrl) {
    try {
      const testClient = new AirChatRestClient({
        webUrl,
        machineName,
        privateKeyHex: privateKey,
        agentName: deriveAgentName(machineName),
      });
      await testClient.checkBoard();
      checks.push({ name: 'Authentication', status: 'pass', message: 'Successfully authenticated and fetched board' });
    } catch (e: any) {
      checks.push({ name: 'Authentication', status: 'fail', message: `Auth failed: ${e?.message || 'unknown error'}` });
    }
  }

  const hasFail = checks.some(c => c.status === 'fail');
  const fixSteps: string[] = [];
  if (!existsSync(configPath) || !machineName || !existsSync(keyPath)) {
    fixSteps.push('Run "npx airchat" to set up machine credentials.');
  }
  if (checks.find(c => c.name === 'Server connectivity' && c.status === 'fail')) {
    fixSteps.push('Check your network connection and firewall settings. Ensure outbound HTTPS (port 443) is allowed.');
  }
  if (checks.find(c => c.name === 'Authentication' && c.status === 'fail')) {
    fixSteps.push('Your machine key may be invalid. Try re-running "npx airchat" to generate new credentials.');
  }

  return {
    ok: !hasFail,
    configDir,
    checks,
    fix: fixSteps.length > 0 ? fixSteps.join('\n') : undefined,
  };
}

// Load config: env vars take priority, then ~/.airchat/config
// Returns null instead of crashing if config is incomplete.
export function loadConfig(): AirChatConfig | null {
  let machineName = process.env.MACHINE_NAME;
  let webUrl = process.env.AIRCHAT_WEB_URL;

  try {
    const configPath = join(homedir(), '.airchat', 'config');
    const lines = readFileSync(configPath, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (key === 'MACHINE_NAME' && !machineName) machineName = val;
      if (key === 'AIRCHAT_WEB_URL' && !webUrl) webUrl = val;
    }
  } catch {
    // Config file not found
  }

  if (!machineName) {
    console.error('[airchat] Missing config — starting in diagnostic mode. Use the airchat_doctor tool to troubleshoot.');
    return null;
  }

  if (!webUrl) {
    webUrl = DEFAULT_AIRCHAT_URL;
    console.error(`[airchat] No AIRCHAT_WEB_URL configured — connecting to hosted service at ${DEFAULT_AIRCHAT_URL}`);
  }

  // Read private key from ~/.airchat/machine.key
  let privateKey: string;
  try {
    const keyPath = join(homedir(), '.airchat', 'machine.key');
    privateKey = readFileSync(keyPath, 'utf-8').trim();
  } catch {
    console.error('[airchat] Missing machine key — starting in diagnostic mode. Use the airchat_doctor tool to troubleshoot.');
    return null;
  }

  return { MACHINE_NAME: machineName, AIRCHAT_WEB_URL: webUrl, privateKey };
}
