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
  if (!item) return { ok: false, error: 'unable_to_parse' };
  if (Array.isArray(item.errors) && item.errors.length) {
    return { ok: false, error: item.errors[0]?.message || 'sp_api_error', errors: item.errors };
  }
  return {
    ok: true,
    sku: item?.sku || null,
    productType: item?.summaries?.[0]?.productType || null,
    status: item?.summaries?.[0]?.status || [],
    qty: item?.attributes?.fulfillment_availability?.[0]?.quantity ?? null,
    restockDate: item?.attributes?.fulfillment_availability?.[0]?.restock_date ?? null,
    hasShippingGroup: Array.isArray(item?.attributes?.merchant_shipping_group),
    hasPurchasableOffer: Array.isArray(item?.attributes?.purchasable_offer),
    issues: item?.issues || []
  };
}

async function connectAmazonMcp() {
  const powershellCommand = process.platform === 'win32' ? 'powershell' : 'powershell.exe';
  const startScript = path.join(repoRoot, 'scripts', 'mcp', 'start-amazon-mcp.ps1');
  const client = new Client({ name: 'crimson-runner-offer-fix', version: '1.0.0' }, { capabilities: {} });
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

async function main() {
  const report = {
    startedAt: nowIso(),
    sku: 'CC-QYNQ-3RS0',
    before: {},
    patch: null,
    after: {},
    completedAt: null
  };

  const client = await connectAmazonMcp();
  try {
    const docsListings = JSON.parse(
      await fs.readFile(path.join(repoRoot, 'docs', 'amazon-listings-data.json'), 'utf8')
    );
    const row = (docsListings.listings || []).find((x) => x.amazon_sku === 'CC-QYNQ-3RS0');
    if (!row) {
      throw new Error('Could not find CC-QYNQ-3RS0 in docs/amazon-listings-data.json');
    }
    const sourceAttrs = clone(row.attributes || {});

    const beforeRaw = await getListing(client, 'CC-QYNQ-3RS0');
    report.before.listing = summarizeListing(beforeRaw);
    report.before.offers = await getListingOffers(client, 'CC-QYNQ-3RS0');

    report.patch = await callToolJson(client, 'patchListingsItem', {
      sellerId,
      sku: 'CC-QYNQ-3RS0',
      productType: 'TABLE_RUNNER',
      patches: [
        {
          op: 'add',
          path: '/attributes/merchant_shipping_group',
          value: [{ value: 'legacy-template-id', marketplace_id: marketplaceId }]
        },
        {
          op: 'replace',
          path: '/attributes/fulfillment_availability',
          value: [{ fulfillment_channel_code: 'DEFAULT', quantity: 10 }]
        },
        {
          op: 'replace',
          path: '/attributes/purchasable_offer',
          value: [
            {
              currency: 'AUD',
              audience: 'ALL',
              our_price: [{ schedule: [{ value_with_tax: 59.99 }] }],
              marketplace_id: marketplaceId
            }
          ]
        },
        {
          op: 'add',
          path: '/attributes/main_product_image_locator',
          value: [
            {
              marketplace_id: marketplaceId,
              media_location: 'https://m.media-amazon.com/images/I/61JuEjJ4bbL.jpg'
            }
          ]
        },
        {
          op: 'add',
          path: '/attributes/item_package_weight',
          value: sourceAttrs.item_package_weight || [
            {
              value: 0.5,
              unit: 'kilograms',
              marketplace_id: marketplaceId
            }
          ]
        },
        {
          op: 'add',
          path: '/attributes/item_package_dimensions',
          value: sourceAttrs.item_package_dimensions || [
            {
              length: { unit: 'centimeters', value: 28 },
              width: { unit: 'centimeters', value: 20 },
              height: { unit: 'centimeters', value: 4 },
              marketplace_id: marketplaceId
            }
          ]
        },
        {
          op: 'add',
          path: '/attributes/is_this_product_subject_to_buyer_age_restrictions',
          value: sourceAttrs.is_this_product_subject_to_buyer_age_restrictions || [
            { value: false, marketplace_id: marketplaceId }
          ]
        }
      ]
    });

    await sleep(3500);

    const afterRaw = await getListing(client, 'CC-QYNQ-3RS0');
    report.after.listing = summarizeListing(afterRaw);
    report.after.offers = await getListingOffers(client, 'CC-QYNQ-3RS0');
  } finally {
    await client.close();
  }

  report.completedAt = nowIso();

  const reportPath = path.join(repoRoot, 'docs', 'reports', 'amazon-crimson-runner-offer-fix-report.json');
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  process.stdout.write(
    `${JSON.stringify(
      {
        reportPath,
        beforeStatus: report.before?.listing?.status || [],
        afterStatus: report.after?.listing?.status || [],
        beforeOfferStatus: report.before?.offers?.payload?.status || null,
        afterOfferStatus: report.after?.offers?.payload?.status || null,
        patchStatus: report.patch?.status || null,
        patchIssues: report.patch?.issues || []
      },
      null,
      2
    )}\n`
  );
}

main().catch((error) => {
  process.stderr.write(`mcp-crimson-runner-offer-fix failed: ${error.message}\n`);
  process.exitCode = 1;
});
