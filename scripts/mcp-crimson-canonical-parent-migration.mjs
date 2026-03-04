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
    legacyParentSku: 'RBL-CRIMSON-TC',
    canonicalParentSku: 'RBL-CRIMSON-TC-PARENT',
    productType: 'TABLECLOTH',
    variationTheme: 'SIZE_NAME',
    title:
      'RB Living Crimson Courtyard Tablecloth - Variation Parent (Size Variants)',
    children: ['CC-SQAN-QKBS', 'CC-T0KS-NAW0']
  },
  {
    family: 'NAPKIN',
    legacyParentSku: 'RBL-CRIMSON-NAPKIN',
    canonicalParentSku: 'RBL-CRIMSON-NAPKIN-PARENT',
    productType: 'CLOTH_NAPKIN',
    variationTheme: 'SIZE_NAME',
    title:
      'RB Living Crimson Courtyard Dinner Napkin - Variation Parent (Pack Variants)',
    children: ['CC-C10J-FICZ', 'CC-00AI-CPTE']
  },
  {
    family: 'PLACEMAT',
    legacyParentSku: 'RBL-CRIMSON-MAT',
    canonicalParentSku: 'RBL-CRIMSON-MAT-PARENT',
    productType: 'PLACEMAT',
    variationTheme: 'SIZE_NAME',
    title:
      'RB Living Crimson Courtyard Placemat - Variation Parent (Pack Variants)',
    children: ['CC-7KR2-FDD2', 'CC-DJNZ-Y3BB']
  },
  {
    family: 'RUNNER',
    legacyParentSku: 'RBL-CRIMSON-RUNNER',
    canonicalParentSku: 'RBL-CRIMSON-RUNNER-PARENT',
    productType: 'TABLE_RUNNER',
    variationTheme: 'SIZE_NAME',
    title:
      'RB Living Crimson Courtyard Table Runner - Variation Parent (Size Variants)',
    children: ['CC-QYNQ-3RS0']
  }
];

function nowIso() {
  return new Date().toISOString();
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

function summarizeListing(item) {
  if (!item) {
    return { ok: false, error: 'unable_to_parse' };
  }
  if (Array.isArray(item.errors) && item.errors.length) {
    return { ok: false, error: item.errors[0]?.message || 'sp_api_error', errors: item.errors };
  }
  return {
    ok: true,
    productType: item?.summaries?.[0]?.productType || null,
    status: item?.summaries?.[0]?.status || [],
    parentage: item?.attributes?.parentage_level?.[0]?.value || null,
    parentSku: item?.attributes?.child_parent_sku_relationship?.[0]?.parent_sku || null,
    theme: item?.attributes?.variation_theme?.[0]?.name || null,
    qty: item?.attributes?.fulfillment_availability?.[0]?.quantity ?? null,
    issueCodes: (item?.issues || []).map((x) => x.code),
    issueCount: (item?.issues || []).length
  };
}

function buildCanonicalParentAttributes(family) {
  return {
    item_name: [{ value: family.title, language_tag: 'en_AU', marketplace_id: marketplaceId }],
    brand: [{ value: 'RB Living', language_tag: 'en_AU', marketplace_id: marketplaceId }],
    manufacturer: [{ value: 'RB Living', language_tag: 'en_AU', marketplace_id: marketplaceId }],
    condition_type: [{ value: 'new_new', marketplace_id: marketplaceId }],
    parentage_level: [{ value: 'parent', marketplace_id: marketplaceId }],
    variation_theme: [{ name: family.variationTheme, marketplace_id: marketplaceId }],
    supplier_declared_dg_hz_regulation: [{ value: 'not_applicable', marketplace_id: marketplaceId }],
    batteries_required: [{ value: false, marketplace_id: marketplaceId }],
    country_of_origin: [{ value: 'IN', marketplace_id: marketplaceId }],
    recommended_browse_nodes: [{ value: '5014389051', marketplace_id: marketplaceId }],
    merchant_shipping_group: [{ value: 'legacy-template-id', marketplace_id: marketplaceId }],
    bullet_point: [
      {
        value: 'Parent listing for RB Living Crimson Courtyard variant family.',
        language_tag: 'en_AU',
        marketplace_id: marketplaceId
      }
    ],
    product_description: [
      {
        value: family.title,
        language_tag: 'en_AU',
        marketplace_id: marketplaceId
      }
    ]
  };
}

async function connectAmazonMcp() {
  const powershellCommand = process.platform === 'win32' ? 'powershell' : 'powershell.exe';
  const startScript = path.join(repoRoot, 'scripts', 'mcp', 'start-amazon-mcp.ps1');
  const client = new Client({ name: 'crimson-canonical-parent-migration', version: '1.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: powershellCommand,
    args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', startScript],
    env: process.env
  });
  await client.connect(transport);
  return client;
}

async function callToolJson(client, name, args) {
  const res = await client.callTool({ name, arguments: args });
  return parseJson(toText(res));
}

async function getListing(client, sku) {
  return callToolJson(client, 'getListingsItem', {
    sellerId,
    sku,
    includedData: ['attributes', 'summaries', 'issues']
  });
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const report = {
    startedAt: nowIso(),
    sellerId,
    marketplaceId,
    migrations: [],
    verification: []
  };

  const client = await connectAmazonMcp();
  try {
    for (const family of FAMILIES) {
      const migration = {
        family: family.family,
        legacyParentSku: family.legacyParentSku,
        canonicalParentSku: family.canonicalParentSku,
        beforeCanonicalParent: null,
        createCanonicalParent: null,
        relinkChildren: [],
        deleteLegacyParent: null,
        afterCanonicalParent: null
      };

      migration.beforeCanonicalParent = summarizeListing(await getListing(client, family.canonicalParentSku));

      migration.createCanonicalParent = await callToolJson(client, 'putListingsItem', {
        sellerId,
        sku: family.canonicalParentSku,
        productType: family.productType,
        requirements: 'LISTING',
        attributes: buildCanonicalParentAttributes(family)
      });
      await sleep(1500);

      for (const childSku of family.children) {
        const relinkResult = await callToolJson(client, 'patchListingsItem', {
          sellerId,
          sku: childSku,
          productType: family.productType,
          patches: [
            {
              op: 'replace',
              path: '/attributes/parentage_level',
              value: [{ value: 'child', marketplace_id: marketplaceId }]
            },
            {
              op: 'replace',
              path: '/attributes/child_parent_sku_relationship',
              value: [
                {
                  child_relationship_type: 'variation',
                  parent_sku: family.canonicalParentSku,
                  marketplace_id: marketplaceId
                }
              ]
            },
            {
              op: 'replace',
              path: '/attributes/variation_theme',
              value: [{ name: family.variationTheme, marketplace_id: marketplaceId }]
            }
          ]
        });
        migration.relinkChildren.push({ sku: childSku, result: relinkResult });
        await sleep(500);
      }

      migration.deleteLegacyParent = await callToolJson(client, 'deleteListingsItem', {
        sellerId,
        sku: family.legacyParentSku
      });
      await sleep(1200);

      migration.afterCanonicalParent = summarizeListing(await getListing(client, family.canonicalParentSku));
      report.migrations.push(migration);
    }

    const verifySkus = [
      ...new Set([
        ...FAMILIES.map((x) => x.canonicalParentSku),
        ...FAMILIES.flatMap((x) => x.children)
      ])
    ];

    for (const sku of verifySkus) {
      report.verification.push({
        sku,
        ...summarizeListing(await getListing(client, sku))
      });
      await sleep(250);
    }
  } finally {
    await client.close();
  }

  const children = report.verification.filter((x) => x.sku.startsWith('CC-'));
  const parents = report.verification.filter((x) => x.sku.endsWith('-PARENT'));
  const allChildrenLinkedToCanonical = children.every((child) =>
    FAMILIES.some((family) => family.children.includes(child.sku) && child.parentSku === family.canonicalParentSku)
  );
  const buyableChildren = children.filter((x) => (x.status || []).includes('BUYABLE')).length;
  const parentIssueCount = parents.reduce((sum, p) => sum + (p.issueCount || 0), 0);

  report.summary = {
    familiesMigrated: FAMILIES.length,
    buyableChildren,
    totalChildren: children.length,
    allChildrenLinkedToCanonical,
    parentIssueCount
  };
  report.completedAt = nowIso();

  const reportPath = path.join(repoRoot, 'docs', 'reports', 'amazon-crimson-canonical-parent-migration-report.json');
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
  process.stderr.write(`mcp-crimson-canonical-parent-migration failed: ${error.message}\n`);
  process.exitCode = 1;
});
