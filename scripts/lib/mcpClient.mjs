import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

function buildWindowsTransport(repoRoot, service, env) {
  const startScript = path.join(
    repoRoot,
    'scripts',
    'mcp',
    service === 'shopify' ? 'start-shopify-mcp.ps1' : 'start-amazon-mcp.ps1'
  );

  return new StdioClientTransport({
    command: 'powershell',
    args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', startScript],
    env,
  });
}

function buildUnixTransport(repoRoot, service, env) {
  const entrypoint =
    service === 'shopify'
      ? path.join(repoRoot, 'services', 'shopify-mcp', 'run-mcp-shopify.mjs')
      : path.join(repoRoot, 'services', 'amazon-mcp', 'src', 'index.js');

  return new StdioClientTransport({
    command: process.execPath,
    args: [entrypoint],
    env,
  });
}

export async function connectMcpClient({
  repoRoot,
  service,
  clientName,
  clientVersion = '1.0.0',
  env = {},
}) {
  const client = new Client({ name: clientName, version: clientVersion }, { capabilities: {} });
  const mergedEnv = { ...process.env, ...env };
  const transport =
    process.platform === 'win32'
      ? buildWindowsTransport(repoRoot, service, mergedEnv)
      : buildUnixTransport(repoRoot, service, mergedEnv);

  await client.connect(transport);
  return client;
}

export function toText(toolResult) {
  if (!toolResult?.content || !Array.isArray(toolResult.content)) return '';
  return toolResult.content
    .filter((entry) => entry?.type === 'text' && typeof entry?.text === 'string')
    .map((entry) => entry.text)
    .join('\n');
}

export function parseJsonText(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
