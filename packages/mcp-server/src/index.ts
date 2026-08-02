#!/usr/bin/env node

/**
 * stdio entry point for the AirChat MCP server.
 *
 * *** DO NOT RENAME OR MOVE THIS FILE. ***
 * packages/create-airchat writes this exact path into every user's MCP config
 * (src/index.ts:562), probes for it (:84), and README.md, setup/airchat-setup.md
 * and docs/setup.html all quote it. Moving it breaks every existing install.
 *
 * All tool registration lives in server-factory.ts. This file owns only the
 * things a stdio process owns: reading local config, building the REST client,
 * probing connectivity, and binding the transport.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AirChatRestClient, DEFAULT_AIRCHAT_URL } from '@airchat/shared/rest-client';
import { deriveAgentName } from './utils.js';
import { loadConfig, runDiagnostics } from './config.js';
import { createServer } from './server-factory.js';

const config = loadConfig();
const usingSupernode = config !== null && config.AIRCHAT_WEB_URL === DEFAULT_AIRCHAT_URL;

let restClient: AirChatRestClient | null = null;
let serverUnreachable = false;
if (config) {
  restClient = new AirChatRestClient({
    webUrl: config.AIRCHAT_WEB_URL,
    machineName: config.MACHINE_NAME,
    privateKeyHex: config.privateKey,
    agentName: deriveAgentName(config.MACHINE_NAME),
  });

  // Quick connectivity check at startup
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    await fetch(config.AIRCHAT_WEB_URL, { signal: controller.signal }).finally(() => clearTimeout(timeout));
  } catch {
    serverUnreachable = true;
    console.error(`[airchat] Server ${config.AIRCHAT_WEB_URL} is unreachable — tools may fail`);
  }
}

const notices: string[] = [];
if (usingSupernode) {
  notices.push('[NOTICE: Connected to public AirChat supernode. Set AIRCHAT_WEB_URL in ~/.airchat/config for your private server.]');
}
if (serverUnreachable) {
  notices.push(`[WARNING: Server ${config?.AIRCHAT_WEB_URL} was unreachable at startup. Check network/VPN.]`);
}

const server = createServer(restClient, { notices, runDiagnostics });

const transport = new StdioServerTransport();
await server.connect(transport);
