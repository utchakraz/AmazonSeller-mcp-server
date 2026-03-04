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

const sellerId = process.env.SP_API_SELLER_ID;
const marketplaceId = process.env.SP_API_MARKETPLACE_ID;
if (!sellerId || !marketplaceId) {
  throw new Error('Missing SP_API_SELLER_ID or SP_API_MARKETPLACE_ID in services/amazon-mcp/.env');
}

const TARGET_SKUS = ['CC-QYNQ-3RS0', 'CC-SQAN-QKBS'];

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const client = new Client({ name: 'crimson-offer-diagnostics', version: '1.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: powershellCommand,
    args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', startScript],
    env: process.env
  });
  await client.connect(transport);
  return client;
}

async function callToolJson(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  return parseJson(toText(result));
}

async function main() {
  const report = {
    generatedAt: nowIso(),
    sellerId,
    marketplaceId,
    skus: []
  };

  const client = await connectAmazonMcp();
  try {
    for (const sku of TARGET_SKUS) {
      const entry = { sku };
      entry.listing = await callToolJson(client, 'getListingsItem', {
        sellerId,
        sku,
        includedData: ['attributes', 'summaries', 'issues', 'offers']
      });
      await sleep(200);
      entry.listingOffers = await callToolJson(client, 'getListingOffers', {
        sellerSku: sku,
        marketplaceId,
        itemCondition: 'New'
      });
      await sleep(200);
      entry.pricing = await callToolJson(client, 'getPricing', {
        itemType: 'Sku',
        itemIds: [sku],
        marketplaceId
      });
      await sleep(200);
      entry.competitivePricing = await callToolJson(client, 'getCompetitivePricing', {
        itemType: 'Sku',
        itemIds: [sku],
        marketplaceId
      });
      report.skus.push(entry);
      await sleep(250);
    }
  } finally {
    await client.close();
  }

  const reportPath = path.join(repoRoot, 'docs', 'reports', 'amazon-crimson-offer-diagnostics-report.json');
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  const compact = report.skus.map((x) => ({
    sku: x.sku,
    listingStatus: x.listing?.summaries?.[0]?.status || [],
    listingOfferStatus: x.listingOffers?.payload?.status || null,
    listingOfferCount: x.listingOffers?.payload?.Summary?.TotalOfferCount ?? null
  }));

  process.stdout.write(`${JSON.stringify({ reportPath, results: compact }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`mcp-crimson-offer-diagnostics failed: ${error.message}\n`);
  process.exitCode = 1;
});
