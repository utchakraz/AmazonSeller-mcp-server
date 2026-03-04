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

const FAMILY_CHECKS = [
  {
    family: 'TABLECLOTH',
    parentSku: 'RBL-CRIMSON-TC',
    expectedTheme: 'SIZE_NAME',
    childSkus: ['CC-SQAN-QKBS', 'CC-T0KS-NAW0']
  },
  {
    family: 'NAPKIN',
    parentSku: 'RBL-CRIMSON-NAPKIN',
    expectedTheme: 'SIZE_NAME',
    childSkus: ['CC-C10J-FICZ', 'CC-00AI-CPTE']
  },
  {
    family: 'PLACEMAT',
    parentSku: 'RBL-CRIMSON-MAT',
    expectedTheme: 'SIZE_NAME',
    childSkus: ['CC-7KR2-FDD2', 'CC-DJNZ-Y3BB']
  },
  {
    family: 'RUNNER',
    parentSku: 'RBL-CRIMSON-RUNNER',
    expectedTheme: 'SIZE_NAME',
    childSkus: ['CC-QYNQ-3RS0']
  }
];

const STOCK_PLAN = [
  { sku: 'RBL-CRIMSON-TC-150', productType: 'TABLECLOTH', quantity: 7 },
  { sku: 'RBL-CRIMSON-TC-180', productType: 'TABLECLOTH', quantity: 3 },
  { sku: 'RBL-CRIMSON-RUNNER', productType: 'TABLE_RUNNER', quantity: 10 },
  { sku: 'RBL-CRIMSON-MAT-1', productType: 'PLACEMAT', quantity: 10 },
  { sku: 'RBL-CRIMSON-MAT-4', productType: 'PLACEMAT', quantity: 5 },
  { sku: 'RBL-CRIMSON-NAPKIN-1', productType: 'CLOTH_NAPKIN', quantity: 10 },
  { sku: 'RBL-CRIMSON-NAPKIN-4', productType: 'CLOTH_NAPKIN', quantity: 5 },
  { sku: 'CC-SQAN-QKBS', productType: 'TABLECLOTH', quantity: 7 },
  { sku: 'CC-T0KS-NAW0', productType: 'TABLECLOTH', quantity: 3 },
  { sku: 'CC-QYNQ-3RS0', productType: 'TABLE_RUNNER', quantity: 10 },
  { sku: 'CC-7KR2-FDD2', productType: 'PLACEMAT', quantity: 10 },
  { sku: 'CC-DJNZ-Y3BB', productType: 'PLACEMAT', quantity: 5 },
  { sku: 'CC-C10J-FICZ', productType: 'CLOTH_NAPKIN', quantity: 10 },
  { sku: 'CC-00AI-CPTE', productType: 'CLOTH_NAPKIN', quantity: 5 }
];

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

function nowIso() {
  return new Date().toISOString();
}

function oneDayAheadIso() {
  return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
}

function normalizeStatus(item) {
  return item?.summaries?.[0]?.status || [];
}

function normalizeQty(item) {
  return item?.attributes?.fulfillment_availability?.[0]?.quantity;
}

function summarizeListing(item) {
  if (!item) {
    return { ok: false, error: 'Unable to parse listing response' };
  }
  if (Array.isArray(item.errors) && item.errors.length) {
    return { ok: false, error: item.errors[0]?.message || 'SP-API error', raw: item.errors };
  }

  return {
    ok: true,
    productType: item?.summaries?.[0]?.productType || null,
    status: normalizeStatus(item),
    qty: normalizeQty(item),
    parentage: item?.attributes?.parentage_level?.[0]?.value || null,
    parentSku: item?.attributes?.child_parent_sku_relationship?.[0]?.parent_sku || null,
    theme: item?.attributes?.variation_theme?.[0]?.name || null,
    issues: item?.issues || []
  };
}

async function connectAmazonMcp() {
  const powershellCommand = process.platform === 'win32' ? 'powershell' : 'powershell.exe';
  const startScript = path.join(repoRoot, 'scripts', 'mcp', 'start-amazon-mcp.ps1');
  const client = new Client({ name: 'crimson-parent-stock-fix', version: '1.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: powershellCommand,
    args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', startScript],
    env: process.env
  });
  await client.connect(transport);
  return client;
}

async function getListing(client, sku) {
  const result = await client.callTool({
    name: 'getListingsItem',
    arguments: {
      sellerId,
      sku,
      includedData: ['attributes', 'summaries', 'issues']
    }
  });
  return parseJson(toText(result));
}

async function patchStock(client, sku, productType, quantity, restockDate) {
  const result = await client.callTool({
    name: 'patchListingsItem',
    arguments: {
      sellerId,
      sku,
      productType,
      patches: [
        {
          op: 'replace',
          path: '/attributes/fulfillment_availability',
          value: [
            {
              fulfillment_channel_code: 'DEFAULT',
              quantity,
              restock_date: restockDate
            }
          ]
        }
      ]
    }
  });
  const parsed = parseJson(toText(result));
  return parsed || { status: 'UNKNOWN', raw: toText(result) };
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const report = {
    startedAt: nowIso(),
    sellerId,
    marketplaceId,
    relationshipChecks: [],
    stockUpdates: [],
    summary: {}
  };

  const client = await connectAmazonMcp();
  try {
    for (const family of FAMILY_CHECKS) {
      const parentRaw = await getListing(client, family.parentSku);
      const parent = summarizeListing(parentRaw);

      const children = [];
      for (const childSku of family.childSkus) {
        const childRaw = await getListing(client, childSku);
        const child = summarizeListing(childRaw);
        const linkedCorrectly =
          child.ok &&
          child.parentage === 'child' &&
          child.parentSku === family.parentSku &&
          child.theme === family.expectedTheme;
        children.push({
          sku: childSku,
          ...child,
          linkedCorrectly
        });
        await sleep(250);
      }

      report.relationshipChecks.push({
        family: family.family,
        parentSku: family.parentSku,
        expectedTheme: family.expectedTheme,
        parent,
        children
      });
    }

    const restockDate = oneDayAheadIso();
    for (const plan of STOCK_PLAN) {
      const beforeRaw = await getListing(client, plan.sku);
      const before = summarizeListing(beforeRaw);
      const beforeBuyable = before.ok && before.status.includes('BUYABLE');
      const beforeQty = before.qty ?? 0;
      const shouldPatch = !beforeBuyable || beforeQty <= 0;

      let patchResult = null;
      if (shouldPatch) {
        patchResult = await patchStock(client, plan.sku, plan.productType, plan.quantity, restockDate);
        await sleep(700);
      }

      const afterRaw = await getListing(client, plan.sku);
      const after = summarizeListing(afterRaw);

      report.stockUpdates.push({
        sku: plan.sku,
        productType: plan.productType,
        targetQty: plan.quantity,
        restockDate,
        shouldPatch,
        before: {
          ok: before.ok,
          status: before.status || [],
          qty: before.qty ?? null,
          issueCount: before.issues?.length || 0,
          error: before.error || null
        },
        patchResult,
        after: {
          ok: after.ok,
          status: after.status || [],
          qty: after.qty ?? null,
          issueCount: after.issues?.length || 0,
          error: after.error || null
        }
      });
      await sleep(250);
    }
  } finally {
    await client.close();
  }

  const linkedChildren = report.relationshipChecks
    .flatMap((family) => family.children)
    .filter((child) => child.linkedCorrectly).length;
  const totalChildren = report.relationshipChecks.reduce((sum, family) => sum + family.children.length, 0);
  const patched = report.stockUpdates.filter((x) => x.shouldPatch).length;
  const accepted = report.stockUpdates.filter(
    (x) => x.patchResult && (x.patchResult.status === 'ACCEPTED' || x.patchResult.status === 'IN_PROGRESS')
  ).length;
  const nowBuyable = report.stockUpdates.filter((x) => (x.after.status || []).includes('BUYABLE')).length;

  report.summary = {
    totalFamilies: report.relationshipChecks.length,
    linkedChildren,
    totalChildren,
    patched,
    accepted,
    nowBuyable
  };
  report.completedAt = nowIso();

  const reportPath = path.join(repoRoot, 'docs', 'reports', 'amazon-crimson-parent-stock-report.json');
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  process.stdout.write(
    `${JSON.stringify(
      {
        reportPath,
        ...report.summary
      },
      null,
      2
    )}\n`
  );
}

main().catch((error) => {
  process.stderr.write(`mcp-crimson-parent-stock-fix failed: ${error.message}\n`);
  process.exitCode = 1;
});
