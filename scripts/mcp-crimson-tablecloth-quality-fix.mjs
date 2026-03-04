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

const TARGETS = [
  {
    sku: 'CC-SQAN-QKBS',
    asin: 'B0GPWLPB3D',
    productType: 'TABLECLOTH',
    expectedTitleContains: '150x225cm',
  },
  {
    sku: 'CC-T0KS-NAW0',
    asin: 'B0GPWDVNKV',
    productType: 'TABLECLOTH',
    expectedTitleContains: '180x300cm',
  },
];

const MISSING_ATTR_WARNING_CODE = '18448';

function nowIso() {
  return new Date().toISOString();
}

function stampIsoSafe(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
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

function summarizeIssues(listing) {
  const issues = Array.isArray(listing?.issues) ? listing.issues : [];
  return issues.map((issue) => ({
    code: issue?.code || null,
    severity: issue?.severity || null,
    message: issue?.message || null,
    attributeNames: Array.isArray(issue?.attributeNames) ? issue.attributeNames : [],
  }));
}

function hasQualityWarning18448(listing) {
  return summarizeIssues(listing).some((issue) => String(issue.code) === MISSING_ATTR_WARNING_CODE);
}

async function connectAmazonMcp() {
  const powershellCommand = process.platform === 'win32' ? 'powershell' : 'powershell.exe';
  const startScript = path.join(repoRoot, 'scripts', 'mcp', 'start-amazon-mcp.ps1');

  const client = new Client(
    { name: 'crimson-tablecloth-quality-fix', version: '1.0.0' },
    { capabilities: {} }
  );
  const transport = new StdioClientTransport({
    command: powershellCommand,
    args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', startScript],
    env: process.env,
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
    includedData: ['attributes', 'summaries', 'issues'],
  });
}

function listingSummary(listing, sku) {
  if (!listing) {
    return { ok: false, sku, error: 'unable_to_parse' };
  }
  if (Array.isArray(listing.errors) && listing.errors.length) {
    return { ok: false, sku, error: listing.errors[0]?.message || 'sp_api_error', errors: listing.errors };
  }

  const summary = listing?.summaries?.[0] || {};
  const itemShape = listing?.attributes?.item_shape?.[0]?.value || null;
  const recommendedUses = listing?.attributes?.recommended_uses_for_product?.map((x) => x?.value).filter(Boolean) || [];

  return {
    ok: true,
    sku,
    asin: summary?.asin || null,
    productType: summary?.productType || null,
    status: summary?.status || [],
    itemName: summary?.itemName || null,
    itemShape,
    recommendedUses,
    issues: summarizeIssues(listing),
  };
}

function qualityPatches() {
  return [
    {
      op: 'add',
      path: '/attributes/item_shape',
      value: [
        {
          value: 'Rectangular',
          language_tag: 'en_AU',
          marketplace_id: marketplaceId,
        },
      ],
    },
    {
      op: 'add',
      path: '/attributes/recommended_uses_for_product',
      value: [
        {
          value: 'Dining Table',
          language_tag: 'en_AU',
          marketplace_id: marketplaceId,
        },
      ],
    },
  ];
}

async function patchQuality(client, sku, productType) {
  return callToolJson(client, 'patchListingsItem', {
    sellerId,
    sku,
    productType,
    patches: qualityPatches(),
  });
}

function fullQualityAttributes(baseAttributes, parentSku, sizeValue) {
  const attrs = clone(baseAttributes || {});
  attrs.item_shape = [
    {
      value: 'Rectangular',
      language_tag: 'en_AU',
      marketplace_id: marketplaceId,
    },
  ];
  attrs.recommended_uses_for_product = [
    {
      value: 'Dining Table',
      language_tag: 'en_AU',
      marketplace_id: marketplaceId,
    },
  ];
  if (sizeValue) {
    attrs.size = [
      {
        value: sizeValue,
        language_tag: 'en_AU',
        marketplace_id: marketplaceId,
      },
    ];
  }
  delete attrs.size_name;
  attrs.parentage_level = [{ value: 'child', marketplace_id: marketplaceId }];
  attrs.child_parent_sku_relationship = [
    {
      child_relationship_type: 'variation',
      parent_sku: parentSku,
      marketplace_id: marketplaceId,
    },
  ];
  attrs.variation_theme = [{ name: 'SIZE_NAME', marketplace_id: marketplaceId }];
  if (!Array.isArray(attrs.merchant_shipping_group) || attrs.merchant_shipping_group.length === 0) {
    attrs.merchant_shipping_group = [{ value: 'legacy-template-id', marketplace_id: marketplaceId }];
  }
  return attrs;
}

async function putFullListing(client, sku, productType, attributes) {
  return callToolJson(client, 'putListingsItem', {
    sellerId,
    sku,
    productType,
    requirements: 'LISTING',
    attributes,
  });
}

async function pollUntilSettled(client, sku, maxAttempts = 8, delayMs = 7000) {
  const polls = [];
  for (let i = 0; i < maxAttempts; i += 1) {
    const raw = await getListing(client, sku);
    const summary = listingSummary(raw, sku);
    polls.push({
      attempt: i + 1,
      at: nowIso(),
      status: summary.status,
      itemShape: summary.itemShape,
      recommendedUsesCount: summary.recommendedUses.length,
      issues: summary.issues,
      hasWarning18448: summary.issues.some((issue) => String(issue.code) === MISSING_ATTR_WARNING_CODE),
    });

    if (!polls[polls.length - 1].hasWarning18448 && summary.itemShape && summary.recommendedUses.length > 0) {
      break;
    }

    if (i < maxAttempts - 1) {
      await sleep(delayMs);
    }
  }
  return polls;
}

async function main() {
  const report = {
    startedAt: nowIso(),
    sellerId,
    marketplaceId,
    strategy:
      'Patch missing quality attributes first; if warning 18448 persists, republish full LISTING payload via PUT and poll again.',
    targets: [],
    summary: {},
    completedAt: null,
  };

  const docsListingsRaw = await fs.readFile(path.join(repoRoot, 'docs', 'amazon-listings-data.json'), 'utf8');
  const docsListings = parseJson(docsListingsRaw) || {};
  const docsByAmazonSku = new Map(
    (docsListings?.listings || []).filter((x) => x?.amazon_sku).map((x) => [x.amazon_sku, x])
  );

  const client = await connectAmazonMcp();
  try {
    for (const target of TARGETS) {
      const beforeRaw = await getListing(client, target.sku);
      const before = listingSummary(beforeRaw, target.sku);

      const patchResult = await patchQuality(client, target.sku, target.productType);
      await sleep(2500);

      const patchPolls = await pollUntilSettled(client, target.sku);
      let afterRaw = await getListing(client, target.sku);
      let after = listingSummary(afterRaw, target.sku);

      let republishPutResult = null;
      let republishPolls = [];
      const warningStillPresent = hasQualityWarning18448({ issues: after.issues });
      if (warningStillPresent) {
        const docItem = docsByAmazonSku.get(target.sku);
        if (docItem?.attributes) {
          const attrs = fullQualityAttributes(
            docItem.attributes,
            'RBL-CRIMSON-TC-PARENT',
            target.expectedTitleContains
          );
          republishPutResult = await putFullListing(client, target.sku, target.productType, attrs);
          await sleep(3500);
          republishPolls = await pollUntilSettled(client, target.sku, 8, 7000);
          afterRaw = await getListing(client, target.sku);
          after = listingSummary(afterRaw, target.sku);
        } else {
          republishPutResult = {
            skipped: true,
            reason: 'missing_doc_payload',
          };
        }
      }

      report.targets.push({
        sku: target.sku,
        asin: target.asin,
        expectedTitleContains: target.expectedTitleContains,
        before,
        patchResult,
        patchPolls,
        republishPutResult,
        republishPolls,
        after,
        fixed:
          before.ok &&
          after.ok &&
          hasQualityWarning18448({ issues: before.issues }) &&
          !hasQualityWarning18448({ issues: after.issues }) &&
          Boolean(after.itemShape) &&
          (after.recommendedUses || []).length > 0,
      });

      await sleep(500);
    }
  } finally {
    await client.close();
  }

  const fixedCount = report.targets.filter((x) => x.fixed).length;
  const warningBeforeCount = report.targets.filter((x) => hasQualityWarning18448({ issues: x.before.issues })).length;
  const warningAfterCount = report.targets.filter((x) => hasQualityWarning18448({ issues: x.after.issues })).length;
  const republishedCount = report.targets.filter((x) => x.republishPutResult && !x.republishPutResult.skipped).length;

  report.summary = {
    totalTargets: report.targets.length,
    warningBeforeCount,
    warningAfterCount,
    republishedCount,
    fixedCount,
    allFixed: fixedCount === report.targets.length,
  };
  report.completedAt = nowIso();

  const ts = stampIsoSafe(new Date());
  const reportDir = path.join(repoRoot, 'docs', 'reports');
  const reportPath = path.join(reportDir, `amazon-crimson-tablecloth-quality-fix-report-${ts}.json`);
  const latestPath = path.join(reportDir, 'amazon-crimson-tablecloth-quality-fix-report-latest.json');

  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await fs.writeFile(latestPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  process.stdout.write(
    `${JSON.stringify(
      {
        reportPath,
        latestPath,
        summary: report.summary,
      },
      null,
      2
    )}\n`
  );
}

main().catch((error) => {
  process.stderr.write(`mcp-crimson-tablecloth-quality-fix failed: ${error.message}\n`);
  process.exitCode = 1;
});
