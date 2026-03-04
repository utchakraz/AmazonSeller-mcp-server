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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function summarizeListing(item) {
  if (!item) {
    return { ok: false, error: 'unable_to_parse' };
  }
  if (Array.isArray(item.errors) && item.errors.length) {
    return { ok: false, error: item.errors[0]?.message || 'sp_api_error', errors: item.errors };
  }
  return {
    ok: true,
    sku: item?.sku || null,
    asin: item?.summaries?.[0]?.asin || null,
    productType: item?.summaries?.[0]?.productType || null,
    status: item?.summaries?.[0]?.status || [],
    parentage: item?.attributes?.parentage_level?.[0]?.value || null,
    parentSku: item?.attributes?.child_parent_sku_relationship?.[0]?.parent_sku || null,
    theme: item?.attributes?.variation_theme?.[0]?.name || null,
    qty: item?.attributes?.fulfillment_availability?.[0]?.quantity ?? null,
    restockDate: item?.attributes?.fulfillment_availability?.[0]?.restock_date ?? null,
    issueCodes: (item?.issues || []).map((x) => x.code),
    issues: item?.issues || []
  };
}

async function connectAmazonMcp() {
  const powershellCommand = process.platform === 'win32' ? 'powershell' : 'powershell.exe';
  const startScript = path.join(repoRoot, 'scripts', 'mcp', 'start-amazon-mcp.ps1');
  const client = new Client({ name: 'crimson-targeted-remediate', version: '1.0.0' }, { capabilities: {} });
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

async function getListing(client, sku) {
  return callToolJson(client, 'getListingsItem', {
    sellerId,
    sku,
    includedData: ['attributes', 'summaries', 'issues', 'offers']
  });
}

async function getListingOffers(client, sellerSku) {
  return callToolJson(client, 'getListingOffers', {
    sellerSku,
    marketplaceId,
    itemCondition: 'New'
  });
}

function buildNapkinParentAttributes() {
  return {
    item_name: [
      {
        value: 'RB Living Reusable Cloth Dinner Napkin - Variation Parent (Cotton Pack Variants)',
        language_tag: 'en_AU',
        marketplace_id: marketplaceId
      }
    ],
    brand: [{ value: 'RB Living', language_tag: 'en_AU', marketplace_id: marketplaceId }],
    manufacturer: [{ value: 'RB Living', language_tag: 'en_AU', marketplace_id: marketplaceId }],
    condition_type: [{ value: 'new_new', marketplace_id: marketplaceId }],
    parentage_level: [{ value: 'parent', marketplace_id: marketplaceId }],
    variation_theme: [{ name: 'SIZE_NAME', marketplace_id: marketplaceId }],
    supplier_declared_dg_hz_regulation: [{ value: 'not_applicable', marketplace_id: marketplaceId }],
    batteries_required: [{ value: false, marketplace_id: marketplaceId }],
    country_of_origin: [{ value: 'IN', marketplace_id: marketplaceId }],
    recommended_browse_nodes: [{ value: '5014389051', marketplace_id: marketplaceId }],
    merchant_shipping_group: [{ value: 'legacy-template-id', marketplace_id: marketplaceId }],
    material: [{ value: 'Cotton', language_tag: 'en_AU', marketplace_id: marketplaceId }],
    bullet_point: [
      {
        value: 'Parent listing for RB Living reusable cotton cloth dinner napkin variants.',
        language_tag: 'en_AU',
        marketplace_id: marketplaceId
      },
      {
        value: 'Non-disposable textile table linen family designed for repeated washing and reuse.',
        language_tag: 'en_AU',
        marketplace_id: marketplaceId
      }
    ],
    product_description: [
      {
        value:
          'Variation parent for RB Living reusable cloth dinner napkins in crimson botanical print. Cotton table linen pack variants.',
        language_tag: 'en_AU',
        marketplace_id: marketplaceId
      }
    ]
  };
}

async function main() {
  const report = {
    startedAt: nowIso(),
    sellerId,
    marketplaceId,
    runnerFix: {},
    napkinParentFix: {},
    completedAt: null
  };

  const docsListings = JSON.parse(
    await fs.readFile(path.join(repoRoot, 'docs', 'amazon-listings-data.json'), 'utf8')
  );
  const runnerDocItem = (docsListings.listings || []).find((x) => x.amazon_sku === 'CC-QYNQ-3RS0');
  if (!runnerDocItem) {
    throw new Error('Could not find CC-QYNQ-3RS0 in docs/amazon-listings-data.json');
  }

  const client = await connectAmazonMcp();
  try {
    // Runner child remediation: republish with immediate stock (no future restock date).
    const runnerBeforeRaw = await getListing(client, 'CC-QYNQ-3RS0');
    report.runnerFix.before = summarizeListing(runnerBeforeRaw);
    report.runnerFix.beforeOffers = await getListingOffers(client, 'CC-QYNQ-3RS0');

    const runnerAttrs = clone(runnerDocItem.attributes || {});
    runnerAttrs.parentage_level = [{ value: 'child', marketplace_id: marketplaceId }];
    runnerAttrs.child_parent_sku_relationship = [
      {
        child_relationship_type: 'variation',
        parent_sku: 'RBL-CRIMSON-RUNNER-PARENT',
        marketplace_id: marketplaceId
      }
    ];
    runnerAttrs.variation_theme = [{ name: 'SIZE_NAME', marketplace_id: marketplaceId }];
    runnerAttrs.fulfillment_availability = [{ fulfillment_channel_code: 'DEFAULT', quantity: 10 }];
    if (!runnerAttrs.merchant_shipping_group) {
      runnerAttrs.merchant_shipping_group = [{ value: 'legacy-template-id', marketplace_id: marketplaceId }];
    }

    report.runnerFix.putResult = await callToolJson(client, 'putListingsItem', {
      sellerId,
      sku: 'CC-QYNQ-3RS0',
      productType: runnerDocItem.productType || 'TABLE_RUNNER',
      requirements: runnerDocItem.requirements || 'LISTING',
      attributes: runnerAttrs
    });
    await sleep(3000);

    const runnerAfterRaw = await getListing(client, 'CC-QYNQ-3RS0');
    report.runnerFix.after = summarizeListing(runnerAfterRaw);
    report.runnerFix.afterOffers = await getListingOffers(client, 'CC-QYNQ-3RS0');

    // Napkin parent remediation: reinforce cloth parent content to reduce classification drift.
    const napkinBeforeRaw = await getListing(client, 'RBL-CRIMSON-NAPKIN-PARENT');
    report.napkinParentFix.before = summarizeListing(napkinBeforeRaw);

    report.napkinParentFix.putResult = await callToolJson(client, 'putListingsItem', {
      sellerId,
      sku: 'RBL-CRIMSON-NAPKIN-PARENT',
      productType: 'CLOTH_NAPKIN',
      requirements: 'LISTING',
      attributes: buildNapkinParentAttributes()
    });
    await sleep(3000);

    const napkinAfterRaw = await getListing(client, 'RBL-CRIMSON-NAPKIN-PARENT');
    report.napkinParentFix.after = summarizeListing(napkinAfterRaw);
  } finally {
    await client.close();
  }

  report.completedAt = nowIso();

  const reportPath = path.join(repoRoot, 'docs', 'reports', 'amazon-crimson-targeted-remediate-report.json');
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  process.stdout.write(
    `${JSON.stringify(
      {
        reportPath,
        runnerBeforeStatus: report.runnerFix?.before?.status || [],
        runnerAfterStatus: report.runnerFix?.after?.status || [],
        napkinParentBeforeType: report.napkinParentFix?.before?.productType || null,
        napkinParentAfterType: report.napkinParentFix?.after?.productType || null,
        napkinParentAfterIssues: report.napkinParentFix?.after?.issueCodes || []
      },
      null,
      2
    )}\n`
  );
}

main().catch((error) => {
  process.stderr.write(`mcp-crimson-targeted-remediate failed: ${error.message}\n`);
  process.exitCode = 1;
});
