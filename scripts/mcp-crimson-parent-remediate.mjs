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

const FAMILY_CONFIG = [
  {
    family: 'TABLECLOTH',
    parentSku: 'RBL-CRIMSON-TC',
    productType: 'TABLECLOTH',
    theme: 'SIZE_NAME',
    title:
      'RB Living 100% Cotton Tablecloth - Crimson Botanical Floral Print, Washable Farmhouse Dining Table Cover (Multiple Sizes)',
    children: ['CC-SQAN-QKBS', 'CC-T0KS-NAW0']
  },
  {
    family: 'NAPKIN',
    parentSku: 'RBL-CRIMSON-NAPKIN',
    productType: 'CLOTH_NAPKIN',
    theme: 'SIZE_NAME',
    title:
      'RB Living 100% Cotton Dinner Napkins - Crimson Botanical Floral Print, Washable Farmhouse Dining (Single or Set of 4)',
    children: ['CC-C10J-FICZ', 'CC-00AI-CPTE']
  },
  {
    family: 'PLACEMAT',
    parentSku: 'RBL-CRIMSON-MAT',
    productType: 'PLACEMAT',
    theme: 'SIZE_NAME',
    title:
      'RB Living 100% Cotton Table Placemat - Crimson Botanical Floral Print, Washable Farmhouse Dining (Single or Set of 4)',
    children: ['CC-7KR2-FDD2', 'CC-DJNZ-Y3BB']
  },
  {
    family: 'RUNNER',
    parentSku: 'RBL-CRIMSON-RUNNER',
    productType: 'TABLE_RUNNER',
    theme: 'SIZE_NAME',
    title:
      'RB Living 100% Cotton Table Runner - Crimson Botanical Floral Print, Washable Farmhouse Dining Table Decor',
    children: ['CC-QYNQ-3RS0']
  }
];

const STOCK_TARGETS = {
  'CC-SQAN-QKBS': 7,
  'CC-T0KS-NAW0': 3,
  'CC-C10J-FICZ': 10,
  'CC-00AI-CPTE': 5,
  'CC-7KR2-FDD2': 10,
  'CC-DJNZ-Y3BB': 5,
  'CC-QYNQ-3RS0': 10
};

function nowIso() {
  return new Date().toISOString();
}

function restockDateIso() {
  return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
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

function buildParentAttributes(family) {
  return {
    item_name: [{ value: family.title, language_tag: 'en_AU', marketplace_id: marketplaceId }],
    brand: [{ value: 'RB Living', language_tag: 'en_AU', marketplace_id: marketplaceId }],
    manufacturer: [{ value: 'RB Living', language_tag: 'en_AU', marketplace_id: marketplaceId }],
    condition_type: [{ value: 'new_new', marketplace_id: marketplaceId }],
    parentage_level: [{ value: 'parent', marketplace_id: marketplaceId }],
    variation_theme: [{ name: family.theme, marketplace_id: marketplaceId }],
    supplier_declared_dg_hz_regulation: [{ value: 'not_applicable', marketplace_id: marketplaceId }],
    batteries_required: [{ value: false, marketplace_id: marketplaceId }],
    country_of_origin: [{ value: 'IN', marketplace_id: marketplaceId }],
    recommended_browse_nodes: [{ value: '5014389051', marketplace_id: marketplaceId }],
    merchant_shipping_group: [{ value: 'legacy-template-id', marketplace_id: marketplaceId }],
    bullet_point: [
      {
        value: 'Premium RB Living Crimson Courtyard textile designed for durable everyday entertaining.',
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
  const client = new Client({ name: 'crimson-parent-remediate', version: '1.0.0' }, { capabilities: {} });
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

async function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const report = {
    startedAt: nowIso(),
    sellerId,
    marketplaceId,
    familyActions: [],
    childRepublishActions: [],
    verification: []
  };

  const docsListingsRaw = await fs.readFile(path.join(repoRoot, 'docs', 'amazon-listings-data.json'), 'utf8');
  const docsListings = JSON.parse(docsListingsRaw);
  const docsByAmazonSku = new Map(
    (docsListings?.listings || [])
      .filter((x) => x?.amazon_sku)
      .map((x) => [x.amazon_sku, x])
  );

  const client = await connectAmazonMcp();
  try {
    for (const family of FAMILY_CONFIG) {
      const action = {
        family: family.family,
        parentSku: family.parentSku,
        children: family.children,
        beforeParent: null,
        deleteParent: null,
        recreateParent: null,
        relinkChildren: [],
        afterParent: null
      };

      const parentBeforeRaw = await getListing(client, family.parentSku);
      action.beforeParent = summarizeListing(parentBeforeRaw);

      if ((action.beforeParent.issueCodes || []).some((code) => code === '8007' || code === '8603')) {
        action.deleteParent = await callToolJson(client, 'deleteListingsItem', {
          sellerId,
          sku: family.parentSku
        });
        await pause(1200);
      }

      action.recreateParent = await callToolJson(client, 'putListingsItem', {
        sellerId,
        sku: family.parentSku,
        productType: family.productType,
        requirements: 'LISTING',
        attributes: buildParentAttributes(family)
      });
      await pause(1500);

      for (const childSku of family.children) {
        const relink = await callToolJson(client, 'patchListingsItem', {
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
                  parent_sku: family.parentSku,
                  marketplace_id: marketplaceId
                }
              ]
            },
            {
              op: 'replace',
              path: '/attributes/variation_theme',
              value: [{ name: family.theme, marketplace_id: marketplaceId }]
            }
          ]
        });
        action.relinkChildren.push({ sku: childSku, result: relink });
        await pause(600);
      }

      const parentAfterRaw = await getListing(client, family.parentSku);
      action.afterParent = summarizeListing(parentAfterRaw);
      report.familyActions.push(action);
    }

    // Explicitly republish child listings that still fail due missing required fields.
    for (const [sku, qty] of Object.entries(STOCK_TARGETS)) {
      const currentRaw = await getListing(client, sku);
      const current = summarizeListing(currentRaw);

      const hasBlocking = (current.issueCodes || []).includes('8560');
      if (!hasBlocking) {
        continue;
      }

      const docItem = docsByAmazonSku.get(sku);
      if (!docItem) {
        report.childRepublishActions.push({
          sku,
          republished: false,
          reason: 'missing_doc_payload'
        });
        continue;
      }

      const family = FAMILY_CONFIG.find((x) => x.children.includes(sku));
      const attrs = clone(docItem.attributes || {});
      attrs.parentage_level = [{ value: 'child', marketplace_id: marketplaceId }];
      attrs.child_parent_sku_relationship = [
        {
          child_relationship_type: 'variation',
          parent_sku: family?.parentSku || '',
          marketplace_id: marketplaceId
        }
      ];
      attrs.variation_theme = [{ name: family?.theme || 'SIZE_NAME', marketplace_id: marketplaceId }];
      attrs.fulfillment_availability = [
        {
          fulfillment_channel_code: 'DEFAULT',
          quantity: qty,
          restock_date: restockDateIso()
        }
      ];
      if (!attrs.merchant_shipping_group) {
        attrs.merchant_shipping_group = [{ value: 'legacy-template-id', marketplace_id: marketplaceId }];
      }

      const putResult = await callToolJson(client, 'putListingsItem', {
        sellerId,
        sku,
        productType: docItem.productType,
        requirements: docItem.requirements || 'LISTING',
        attributes: attrs
      });

      await pause(2000);
      const afterRaw = await getListing(client, sku);
      const after = summarizeListing(afterRaw);

      report.childRepublishActions.push({
        sku,
        republished: true,
        putResult,
        after
      });
    }

    // Final verification snapshot
    const verifySkus = [
      ...new Set([
        ...FAMILY_CONFIG.map((x) => x.parentSku),
        ...FAMILY_CONFIG.flatMap((x) => x.children)
      ])
    ];
    for (const sku of verifySkus) {
      const raw = await getListing(client, sku);
      report.verification.push({
        sku,
        ...summarizeListing(raw)
      });
      await pause(250);
    }
  } finally {
    await client.close();
  }

  const buyableChildren = report.verification.filter(
    (x) => !x.sku.startsWith('RBL-CRIMSON-') && (x.status || []).includes('BUYABLE')
  ).length;
  const totalChildren = FAMILY_CONFIG.reduce((sum, f) => sum + f.children.length, 0);
  const parentErrorCount = report.verification
    .filter((x) => x.sku.startsWith('RBL-CRIMSON-'))
    .reduce((sum, x) => sum + (x.issueCount || 0), 0);

  report.summary = {
    totalFamilies: FAMILY_CONFIG.length,
    totalChildren,
    buyableChildren,
    parentErrorCount
  };
  report.completedAt = nowIso();

  const reportPath = path.join(repoRoot, 'docs', 'reports', 'amazon-crimson-parent-remediate-report.json');
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
  process.stderr.write(`mcp-crimson-parent-remediate failed: ${error.message}\n`);
  process.exitCode = 1;
});
