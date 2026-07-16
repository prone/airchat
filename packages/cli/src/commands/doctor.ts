import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { AirChatRestClient, DEFAULT_AIRCHAT_URL } from '@airchat/shared/rest-client';

interface Check {
  name: string;
  status: 'pass' | 'fail' | 'warn';
  message: string;
}

export async function doctor() {
  const configDir = join(homedir(), '.airchat');
  const checks: Check[] = [];
  let machineName: string | undefined;
  let webUrl: string | undefined;
  let privateKey: string | undefined;

  console.log('\n🩺 AirChat Doctor\n');

  // 1. Config directory
  if (existsSync(configDir)) {
    checks.push({ name: 'Config directory', status: 'pass', message: configDir });
  } else {
    checks.push({ name: 'Config directory', status: 'fail', message: `Missing ${configDir}` });
    printChecks(checks);
    printFix(['Run "npx airchat" to set up AirChat.']);
    return;
  }

  // 2. Config file
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
      checks.push({ name: 'Config file', status: 'pass', message: configPath });
    } catch {
      checks.push({ name: 'Config file', status: 'fail', message: `Cannot read ${configPath}` });
    }
  } else {
    checks.push({ name: 'Config file', status: 'fail', message: `Missing ${configPath}` });
  }

  // 3. MACHINE_NAME
  if (machineName) {
    checks.push({ name: 'MACHINE_NAME', status: 'pass', message: machineName });
  } else {
    checks.push({ name: 'MACHINE_NAME', status: 'fail', message: 'Not set in config' });
  }

  // 4. AIRCHAT_WEB_URL
  if (webUrl) {
    checks.push({ name: 'AIRCHAT_WEB_URL', status: 'pass', message: webUrl });
  } else {
    webUrl = DEFAULT_AIRCHAT_URL;
    checks.push({ name: 'AIRCHAT_WEB_URL', status: 'warn', message: `Not set — using default: ${DEFAULT_AIRCHAT_URL}` });
  }

  // 5. Machine key
  const keyPath = join(configDir, 'machine.key');
  if (existsSync(keyPath)) {
    try {
      privateKey = readFileSync(keyPath, 'utf-8').trim();
      if (privateKey.length > 0) {
        checks.push({ name: 'Machine key', status: 'pass', message: `${keyPath} (${privateKey.length} chars)` });
      } else {
        checks.push({ name: 'Machine key', status: 'fail', message: 'Key file is empty' });
        privateKey = undefined;
      }
    } catch {
      checks.push({ name: 'Machine key', status: 'fail', message: `Cannot read ${keyPath}` });
    }
  } else {
    checks.push({ name: 'Machine key', status: 'fail', message: `Missing ${keyPath}` });
  }

  // 6. Server connectivity
  if (webUrl) {
    try {
      await fetch(webUrl, { signal: AbortSignal.timeout(5000) });
      checks.push({ name: 'Server connectivity', status: 'pass', message: `${webUrl} is reachable` });
    } catch (e: any) {
      checks.push({ name: 'Server connectivity', status: 'fail', message: `Cannot reach ${webUrl}: ${e?.message || 'network error'}` });
    }
  }

  // 7. Authentication
  if (machineName && privateKey && webUrl) {
    try {
      const dirName = process.cwd().split(/[\\/]/).pop() || 'unknown';
      const client = new AirChatRestClient({
        webUrl,
        machineName,
        privateKeyHex: privateKey,
        agentName: `${machineName}-${dirName}`,
      });
      await client.checkBoard();
      checks.push({ name: 'Authentication', status: 'pass', message: 'Successfully authenticated' });
    } catch (e: any) {
      checks.push({ name: 'Authentication', status: 'fail', message: `Auth failed: ${e?.message || 'unknown'}` });
    }
  }

  printChecks(checks);

  const fixes: string[] = [];
  const hasFail = checks.some(c => c.status === 'fail');
  if (!existsSync(configPath) || !machineName || !existsSync(keyPath)) {
    fixes.push('Run "npx airchat" to set up machine credentials.');
  }
  if (checks.find(c => c.name === 'Server connectivity' && c.status === 'fail')) {
    fixes.push('Check network/firewall — ensure outbound HTTPS (port 443) is allowed.');
  }
  if (checks.find(c => c.name === 'Authentication' && c.status === 'fail')) {
    fixes.push('Machine key may be invalid. Re-run "npx airchat" to regenerate credentials.');
  }

  if (fixes.length > 0) {
    printFix(fixes);
  } else if (!hasFail) {
    console.log('\n  All checks passed. AirChat is ready to use.\n');
  }
}

function printChecks(checks: Check[]) {
  for (const c of checks) {
    const icon = c.status === 'pass' ? '  ✓' : c.status === 'warn' ? '  ⚠' : '  ✗';
    console.log(`${icon} ${c.name}: ${c.message}`);
  }
}

function printFix(fixes: string[]) {
  console.log('\n  How to fix:');
  for (const f of fixes) {
    console.log(`    → ${f}`);
  }
  console.log('');
}
