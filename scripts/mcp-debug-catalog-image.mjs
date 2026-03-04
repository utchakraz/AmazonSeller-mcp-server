#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..', '..');

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const marketplaceId = process.env.SP_API_MARKETPLACE_ID;
if (!marketplaceId) {
  throw new Error('Missing SP_API_MARKETPLACE_ID in services/amazon-mcp/.env');
}

function toText(toolResult) {
  if (!toolResult?.content || !Array.isArray(toolResult.content)) return '';
  return toolResult.content
    .filter((entry) => entry?.type === 'text' && typeof entry?.text === 'string')
    .map((entry) => entry.text)
    .join('\n');
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function connectAmazonMcp() {
  const powershellCommand = process.platform === 'win32' ? 'powershell' : 'powershell.exe';
  const startScript = path.join(repoRoot, 'scripts', 'mcp', 'start-amazon-mcp.ps1');
  const client = new Client({ name: 'catalog-image-debug', version: '1.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: powershellCommand,
    args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', startScript],
    env: process.env
  });
  await client.connect(transport);
  return client;
}

async function main() {
  const asin = 'B0GQ3JGLVV';
  const client = await connectAmazonMcp();
  let result;
  try {
    const toolResult = await client.callTool({
      name: 'getCatalogItem',
      arguments: { asin, marketplaceId }
    });
    result = parseJson(toText(toolResult));
  } finally {
    await client.close();
  }

  const out = {
    asin,
    marketplaceId,
    images: result?.images || null,
    itemName:
      result?.summaries?.[0]?.itemName ||
      result?.attributes?.item_name?.[0]?.value ||
      null,
    raw: result
  };

  const reportPath = path.join(repoRoot, 'docs', 'reports', 'amazon-crimson-runner-catalog-image-debug.json');
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ reportPath, hasImages: Array.isArray(out.images) }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`mcp-debug-catalog-image failed: ${error.message}\n`);
  process.exitCode = 1;
});
