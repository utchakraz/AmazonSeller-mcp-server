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

const FAMILIES = [
  {
    family: 'TABLECLOTH',
    expectedParent: 'RBL-CRIMSON-TC-PARENT',
    expectedTheme: 'SIZE_NAME',
    expectedProductType: 'TABLECLOTH',
    children: [
      { sku: 'CC-SQAN-QKBS', expectedDimensions: '150x225cm', expectedUnitCount: 1, expectedQty: 7 },
      { sku: 'CC-T0KS-NAW0', expectedDimensions: '180x300cm', expectedUnitCount: 1, expectedQty: 3 }
    ]
  },
  {
    family: 'NAPKIN',
    expectedParent: 'RBL-CRIMSON-NAPKIN-PARENT',
    expectedTheme: 'SIZE_NAME',
    expectedProductType: 'CLOTH_NAPKIN',
    children: [
      { sku: 'CC-C10J-FICZ', expectedDimensions: '45x45cm', expectedUnitCount: 1, expectedQty: 10 },
      { sku: 'CC-00AI-CPTE', expectedDimensions: '45x45cm', expectedUnitCount: 4, expectedQty: 5 }
    ]
  },
  {
    family: 'PLACEMAT',
    expectedParent: 'RBL-CRIMSON-MAT-PARENT',
    expectedTheme: 'SIZE_NAME',
    expectedProductType: 'PLACEMAT',
    children: [
      { sku: 'CC-7KR2-FDD2', expectedDimensions: '33x48cm', expectedUnitCount: 1, expectedQty: 10 },
      { sku: 'CC-DJNZ-Y3BB', expectedDimensions: '33x48cm', expectedUnitCount: 4, expectedQty: 5 }
    ]
  },
  {
    family: 'RUNNER',
    expectedParent: 'RBL-CRIMSON-RUNNER-PARENT',
    expectedTheme: 'SIZE_NAME',
    expectedProductType: 'TABLE_RUNNER',
    children: [{ sku: 'CC-QYNQ-3RS0', expectedDimensions: '50x150cm', expectedUnitCount: 1, expectedQty: 10 }]
  }
];

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

function lc(value) {
  return `${value || ''}`.trim().toLowerCase();
}

function statusOf(item) {
  return item?.summaries?.[0]?.status || [];
}

function issueList(item) {
  return Array.isArray(item?.issues) ? item.issues : [];
}

function blockingIssues(item) {
  return issueList(item).filter((issue) => lc(issue?.severity) === 'error');
}

function getAttr(item, key) {
  const list = item?.attributes?.[key];
  return Array.isArray(list) ? list[0] : null;
}

function getParentage(item) {
  return getAttr(item, 'parentage_level')?.value || null;
}

function getParentSku(item) {
  return getAttr(item, 'child_parent_sku_relationship')?.parent_sku || null;
}

function getVariationTheme(item) {
  return getAttr(item, 'variation_theme')?.name || null;
}

function getQuantity(item) {
  const rows = item?.attributes?.fulfillment_availability;
  if (!Array.isArray(rows)) return null;
  const row =
    rows.find((x) => x?.fulfillment_channel_code === 'DEFAULT') ||
    rows.find((x) => typeof x?.quantity === 'number') ||
    rows[0];
  if (!row || typeof row.quantity !== 'number') return null;
  return row.quantity;
}

function getRestockDate(item) {
  const rows = item?.attributes?.fulfillment_availability;
  if (!Array.isArray(rows)) return null;
  const row =
    rows.find((x) => x?.fulfillment_channel_code === 'DEFAULT') ||
    rows.find((x) => x?.restock_date) ||
    rows[0];
  return row?.restock_date || null;
}

function getPrice(item) {
  const offer = getAttr(item, 'purchasable_offer');
  const schedule = offer?.our_price?.[0]?.schedule?.[0];
  if (typeof schedule?.value_with_tax === 'number') {
    return schedule.value_with_tax;
  }
  const listPrice = getAttr(item, 'list_price');
  if (typeof listPrice?.value_with_tax === 'number') {
    return listPrice.value_with_tax;
  }
  return null;
}

function getDimensions(item) {
  const sizeName = getAttr(item, 'size_name')?.value;
  if (sizeName) return sizeName;

  const itemName = getAttr(item, 'item_name')?.value || '';
  const dimensions = item?.attributes?.item_length_width?.[0];
  if (dimensions?.length?.value && dimensions?.width?.value) {
    const w = Number(dimensions.width.value);
    const l = Number(dimensions.length.value);
    if (!Number.isNaN(w) && !Number.isNaN(l)) {
      return `${Math.round(w)}x${Math.round(l)}cm`;
    }
  }

  if (itemName.match(/set of 4/i)) return 'Set of 4';
  if (itemName.match(/single/i)) return 'Single';
  return null;
}

function getUnitCount(item) {
  const unitCount = getAttr(item, 'unit_count')?.value;
  if (typeof unitCount === 'number') return unitCount;
  const numberOfItems = getAttr(item, 'number_of_items')?.value;
  if (typeof numberOfItems === 'number') return numberOfItems;
  return null;
}

function summarizeListing(item, sku) {
  if (!item) {
    return { ok: false, sku, error: 'unable_to_parse' };
  }
  if (Array.isArray(item.errors) && item.errors.length) {
    return { ok: false, sku, error: item.errors[0]?.message || 'sp_api_error', errors: item.errors };
  }

  return {
    ok: true,
    sku,
    asin: item?.summaries?.[0]?.asin || null,
    productType: item?.summaries?.[0]?.productType || null,
    status: statusOf(item),
    parentage: getParentage(item),
    parentSku: getParentSku(item),
    variationTheme: getVariationTheme(item),
    dimensions: getDimensions(item),
    unitCount: getUnitCount(item),
    qty: getQuantity(item),
    restockDate: getRestockDate(item),
    price: getPrice(item),
    issueCount: issueList(item).length,
    issues: issueList(item).map((issue) => ({
      code: issue.code || null,
      severity: issue.severity || null,
      message: issue.message || null,
      attributeNames: issue.attributeNames || []
    })),
    blockingIssueCount: blockingIssues(item).length,
    raw: item
  };
}

function summarizeOffers(offers) {
  const payload = offers?.payload || null;
  const status = payload?.status || null;
  const totalOfferCount = payload?.Summary?.TotalOfferCount ?? null;
  return {
    status,
    totalOfferCount,
    hasBuyableOffer: status === 'Success' && typeof totalOfferCount === 'number' && totalOfferCount > 0,
    raw: offers
  };
}

function addCheck(checks, pass, message) {
  checks.push({ pass: Boolean(pass), message });
}

function isSizeMatch(actual, expected) {
  if (!expected) return true;
  const a = lc(actual);
  const e = lc(expected);
  if (!a || !e) return false;
  if (a === e) return true;
  return a.includes(e) || e.includes(a);
}

function evaluateParent(parent, family) {
  const checks = [];
  const isAmazonNapkinAutoClassified =
    family.family === 'NAPKIN' &&
    parent.productType === 'DISPOSABLE_NAPKIN' &&
    (parent.issues || []).some((issue) => issue.code === '18367');

  addCheck(checks, parent.ok, 'Parent listing fetched');
  addCheck(
    checks,
    parent.productType === family.expectedProductType || isAmazonNapkinAutoClassified,
    isAmazonNapkinAutoClassified
      ? `Parent productType is Amazon-classified (${parent.productType}) with warning 18367`
      : `Parent productType is ${family.expectedProductType}`
  );
  addCheck(checks, parent.parentage === 'parent', 'Parentage is parent');
  addCheck(checks, parent.variationTheme === family.expectedTheme, `Variation theme is ${family.expectedTheme}`);
  addCheck(checks, (parent.status || []).includes('DISCOVERABLE'), 'Status includes DISCOVERABLE');
  addCheck(checks, parent.blockingIssueCount === 0, 'No blocking issues (ERROR severity)');

  return { checks, listing: parent };
}

function evaluateChild(child, offerSummary, family, expected) {
  const checks = [];
  const hasDiscoverableStatus = (child.status || []).includes('DISCOVERABLE');
  const hasBuyableStatus = (child.status || []).includes('BUYABLE');
  const hasBuyableOffer = offerSummary?.hasBuyableOffer === true;

  addCheck(checks, child.ok, 'Child listing fetched');
  addCheck(checks, child.productType === family.expectedProductType, `Child productType is ${family.expectedProductType}`);
  addCheck(checks, child.parentage === 'child', 'Child parentage is child');
  addCheck(checks, child.parentSku === family.expectedParent, `Parent SKU is ${family.expectedParent}`);
  addCheck(checks, child.variationTheme === family.expectedTheme, `Variation theme is ${family.expectedTheme}`);
  addCheck(
    checks,
    hasDiscoverableStatus || hasBuyableOffer,
    hasDiscoverableStatus ? 'Status includes DISCOVERABLE' : 'Discoverable inferred from active buyable offer'
  );
  addCheck(
    checks,
    hasBuyableStatus || hasBuyableOffer,
    hasBuyableStatus ? 'Status includes BUYABLE' : 'Buyable inferred from active offer status'
  );
  addCheck(checks, typeof child.qty === 'number' && child.qty > 0, `Quantity is > 0 (now ${child.qty ?? 'null'})`);
  addCheck(checks, child.price === null || child.price > 0, `Price is valid (now ${child.price ?? 'null'})`);
  addCheck(checks, child.blockingIssueCount === 0, 'No blocking issues (ERROR severity)');
  addCheck(
    checks,
    isSizeMatch(child.dimensions, expected.expectedDimensions),
    `Dimensions match expected (${expected.expectedDimensions})`
  );
  addCheck(
    checks,
    expected.expectedUnitCount === null || expected.expectedUnitCount === undefined
      ? true
      : child.unitCount === expected.expectedUnitCount,
    `Unit count matches expected (${expected.expectedUnitCount})`
  );
  addCheck(
    checks,
    typeof child.qty === 'number' ? child.qty >= Math.max(1, expected.expectedQty) : false,
    `Quantity >= target (${expected.expectedQty})`
  );

  return {
    sku: expected.sku,
    expectedDimensions: expected.expectedDimensions,
    expectedUnitCount: expected.expectedUnitCount,
    expectedQty: expected.expectedQty,
    offers: offerSummary,
    checks,
    listing: child
  };
}

async function connectAmazonMcp() {
  const powershellCommand = process.platform === 'win32' ? 'powershell' : 'powershell.exe';
  const startScript = path.join(repoRoot, 'scripts', 'mcp', 'start-amazon-mcp.ps1');
  const client = new Client({ name: 'crimson-deep-scan', version: '1.0.0' }, { capabilities: {} });
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

function collectFindings(report) {
  const findings = [];
  for (const family of report.families) {
    for (const check of family.parent.checks) {
      if (!check.pass) {
        findings.push({
          severity: 'high',
          family: family.family,
          sku: family.parent.listing.sku,
          message: check.message
        });
      }
    }
    for (const child of family.children) {
      for (const check of child.checks) {
        if (!check.pass) {
          const sev =
            check.message.includes('BUYABLE') ||
            check.message.includes('Quantity') ||
            check.message.includes('No blocking issues')
              ? 'high'
              : 'medium';
          findings.push({
            severity: sev,
            family: family.family,
            sku: child.sku,
            message: check.message
          });
        }
      }
    }
  }
  return findings;
}

async function main() {
  const report = {
    generatedAt: nowIso(),
    sellerId,
    marketplaceId,
    families: [],
    summary: {}
  };

  const client = await connectAmazonMcp();
  try {
    for (const family of FAMILIES) {
      const parentRaw = await getListing(client, family.expectedParent);
      const parent = summarizeListing(parentRaw, family.expectedParent);
      const parentEvaluation = evaluateParent(parent, family);

      const childEvaluations = [];
      for (const childSpec of family.children) {
        const childRaw = await getListing(client, childSpec.sku);
        const childSummary = summarizeListing(childRaw, childSpec.sku);
        const childOffers = summarizeOffers(await getListingOffers(client, childSpec.sku));
        childEvaluations.push(evaluateChild(childSummary, childOffers, family, childSpec));
        await sleep(250);
      }

      report.families.push({
        family: family.family,
        expectedParent: family.expectedParent,
        expectedTheme: family.expectedTheme,
        parent: parentEvaluation,
        children: childEvaluations
      });
      await sleep(250);
    }
  } finally {
    await client.close();
  }

  const parents = report.families.map((f) => f.parent.listing);
  const children = report.families.flatMap((f) => f.children.map((c) => c.listing));
  const parentChecks = report.families.flatMap((f) => f.parent.checks);
  const childChecks = report.families.flatMap((f) => f.children.flatMap((c) => c.checks));
  const allChecks = [...parentChecks, ...childChecks];
  const findings = collectFindings(report);

  report.summary = {
    totalFamilies: report.families.length,
    totalParents: parents.length,
    totalChildren: children.length,
    buyableChildren: children.filter((c) => (c.status || []).includes('BUYABLE')).length,
    discoverableChildren: children.filter((c) => (c.status || []).includes('DISCOVERABLE')).length,
    childrenWithStock: children.filter((c) => typeof c.qty === 'number' && c.qty > 0).length,
    childrenWithBlockingIssues: children.filter((c) => c.blockingIssueCount > 0).length,
    parentsWithBlockingIssues: parents.filter((p) => p.blockingIssueCount > 0).length,
    passedChecks: allChecks.filter((c) => c.pass).length,
    totalChecks: allChecks.length,
    allPassed: findings.length === 0,
    findings
  };

  const reportsDir = path.join(repoRoot, 'docs', 'reports');
  await fs.mkdir(reportsDir, { recursive: true });
  const latestPath = path.join(reportsDir, 'amazon-crimson-deep-scan-report.json');
  const stampedPath = path.join(
    reportsDir,
    `amazon-crimson-deep-scan-report-${report.generatedAt.replace(/[:.]/g, '-')}.json`
  );
  await fs.writeFile(latestPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await fs.writeFile(stampedPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  process.stdout.write(
    `${JSON.stringify(
      {
        reportPath: latestPath,
        archivedReportPath: stampedPath,
        ...report.summary
      },
      null,
      2
    )}\n`
  );
}

main().catch((error) => {
  process.stderr.write(`mcp-crimson-deep-scan failed: ${error.message}\n`);
  process.exitCode = 1;
});
