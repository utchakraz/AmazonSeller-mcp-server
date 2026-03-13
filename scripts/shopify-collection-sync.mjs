#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { connectMcpClient, parseJsonText, toText } from './lib/mcpClient.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const reportDir = path.join(repoRoot, 'docs', 'reports');
const startedAt = new Date().toISOString();
const stamp = startedAt.replace(/[:.]/g, '-');
const reportPath = path.join(reportDir, `shopify-collection-sync-${stamp}.json`);
const latestPath = path.join(reportDir, 'shopify-collection-sync-latest.json');
const WRITE_CONFIRM_TOKEN = process.env.SHOPIFY_MCP_WRITE_CONFIRM || 'RBL_WRITE_CONFIRM';

const COLLECTION_SPECS = [
  {
    title: 'Drink Fountains',
    handle: 'drink-fountains',
    body_html:
      '<p>Shop the RB Living Drink Fountain collection for parties, weddings, mocktails, and celebration-ready self-serve drinks presentation.</p>',
    sort_order: 'best-selling',
    disjunctive: false,
    rules: [{ column: 'type', relation: 'equals', condition: 'Drink Fountain' }],
  },
  {
    title: 'Crimson Courtyard',
    handle: 'crimson-courtyard',
    body_html:
      '<p>Explore the full Crimson Courtyard range of premium cotton table cloths, runners, mats, and napkins for rich, heritage-led entertaining.</p>',
    sort_order: 'best-selling',
    disjunctive: false,
    rules: [{ column: 'tag', relation: 'equals', condition: 'crimson-courtyard' }],
  },
  {
    title: 'Garden Party',
    handle: 'garden-party',
    body_html:
      '<p>Shop the Garden Party collection of 100% cotton table linen in bright floral tones for relaxed hosting and indoor-outdoor entertaining.</p>',
    sort_order: 'best-selling',
    disjunctive: false,
    rules: [{ column: 'tag', relation: 'equals', condition: 'garden-party' }],
  },
  {
    title: 'Table Cloths',
    handle: 'table-cloths',
    body_html:
      '<p>Discover RB Living table cloths in premium cotton across Crimson Courtyard and Garden Party, with versatile sizes for everyday dining and entertaining.</p>',
    sort_order: 'best-selling',
    disjunctive: false,
    rules: [{ column: 'type', relation: 'equals', condition: 'Table Cloth' }],
  },
  {
    title: 'Table Runners',
    handle: 'table-runners',
    body_html:
      '<p>Browse RB Living table runners for layered tablescapes, buffet styling, and refined hosting moments across both textile collections.</p>',
    sort_order: 'best-selling',
    disjunctive: false,
    rules: [{ column: 'type', relation: 'equals', condition: 'Table Runner' }],
  },
  {
    title: 'Table Mats',
    handle: 'table-mats',
    body_html:
      '<p>Shop RB Living table mats in single and multipack options for polished place settings, table protection, and collection-led entertaining.</p>',
    sort_order: 'best-selling',
    disjunctive: false,
    rules: [{ column: 'type', relation: 'equals', condition: 'Table Mat' }],
  },
  {
    title: 'Napkins',
    handle: 'napkins',
    body_html:
      '<p>Explore reusable RB Living cotton napkins in single and pack options, designed to coordinate with the full Crimson Courtyard and Garden Party ranges.</p>',
    sort_order: 'best-selling',
    disjunctive: false,
    rules: [{ column: 'type', relation: 'equals', condition: 'Napkin' }],
  },
];

async function connectShopifyMcp() {
  return connectMcpClient({
    repoRoot,
    service: 'shopify',
    clientName: 'shopify-collection-sync',
    env: {
      SHOPIFY_MCP_ENABLE_WRITES: 'true',
      SHOPIFY_MCP_WRITE_CONFIRM: WRITE_CONFIRM_TOKEN,
    },
  });
}

async function callTool(client, tool, args = {}) {
  const started = new Date().toISOString();
  try {
    const result = await client.callTool({ name: tool, arguments: args });
    const text = toText(result);
    return {
      ok: true,
      tool,
      args,
      startedAt: started,
      completedAt: new Date().toISOString(),
      text,
      json: parseJsonText(text),
    };
  } catch (error) {
    return {
      ok: false,
      tool,
      args,
      startedAt: started,
      completedAt: new Date().toISOString(),
      error: error?.message || String(error),
    };
  }
}

function normalizeId(id) {
  const raw = String(id || '').trim();
  const match = raw.match(/(\d+)$/);
  return match ? match[1] : raw;
}

function normalizeRules(rules) {
  return JSON.stringify(
    (Array.isArray(rules) ? rules : [])
      .map((rule) => ({
        column: String(rule?.column || '').trim(),
        relation: String(rule?.relation || '').trim(),
        condition: String(rule?.condition || '').trim(),
      }))
      .sort((left, right) =>
        `${left.column}:${left.relation}:${left.condition}`.localeCompare(
          `${right.column}:${right.relation}:${right.condition}`
        )
      )
  );
}

function needsUpdate(existing, spec) {
  if (!existing) return true;
  return (
    String(existing.title || '').trim() !== spec.title ||
    String(existing.handle || '').trim() !== spec.handle ||
    String(existing.body_html || '').trim() !== spec.body_html ||
    String(existing.sort_order || '').trim() !== spec.sort_order ||
    Boolean(existing.disjunctive) !== Boolean(spec.disjunctive) ||
    normalizeRules(existing.rules) !== normalizeRules(spec.rules)
  );
}

function buildPayload(spec, existing = null) {
  const payload = {
    title: spec.title,
    handle: spec.handle,
    body_html: spec.body_html,
    sort_order: spec.sort_order,
    disjunctive: spec.disjunctive,
    rules: spec.rules,
    published: true,
    published_scope: 'global',
  };

  if (existing?.id) {
    payload.id = Number(normalizeId(existing.id));
  }

  return payload;
}

async function main() {
  await fs.mkdir(reportDir, { recursive: true });

  const report = {
    startedAt,
    actions: [],
    blockers: [],
    summary: {},
  };

  const shopify = await connectShopifyMcp();
  try {
    const mcpConfig = await callTool(shopify, 'get_mcp_config', {});
    report.actions.push({ step: 'get_mcp_config', result: mcpConfig });
    if (!(mcpConfig?.json?.ok === true && mcpConfig?.json?.mode?.writeEnabled === true)) {
      throw new Error('Shopify MCP write mode is disabled.');
    }

    const smartCollectionsRead = await callTool(shopify, 'admin_rest', {
      endpoint: 'smart_collections.json',
      method: 'GET',
      query: { limit: 250 },
    });
    report.actions.push({ step: 'read_smart_collections', result: smartCollectionsRead });
    const smartCollections = Array.isArray(smartCollectionsRead?.json?.data?.smart_collections)
      ? smartCollectionsRead.json.data.smart_collections
      : [];

    const customCollectionsRead = await callTool(shopify, 'admin_rest', {
      endpoint: 'custom_collections.json',
      method: 'GET',
      query: { limit: 250 },
    });
    report.actions.push({ step: 'read_custom_collections', result: customCollectionsRead });
    const customCollections = Array.isArray(customCollectionsRead?.json?.data?.custom_collections)
      ? customCollectionsRead.json.data.custom_collections
      : [];

    for (const spec of COLLECTION_SPECS) {
      const customConflict = customCollections.find(
        (collection) => String(collection?.handle || '').trim() === spec.handle
      );
      if (customConflict) {
        report.blockers.push({
          type: 'custom_collection_conflict',
          handle: spec.handle,
          title: customConflict.title || spec.title,
        });
        continue;
      }

      const existing = smartCollections.find(
        (collection) => String(collection?.handle || '').trim() === spec.handle
      );

      if (!needsUpdate(existing, spec)) {
        report.actions.push({
          step: 'smart_collection_noop',
          handle: spec.handle,
          title: spec.title,
          existingId: normalizeId(existing?.id),
        });
        continue;
      }

      const endpoint = existing?.id
        ? `smart_collections/${normalizeId(existing.id)}.json`
        : 'smart_collections.json';
      const method = existing?.id ? 'PUT' : 'POST';
      const upsert = await callTool(shopify, 'admin_rest', {
        endpoint,
        method,
        confirm: WRITE_CONFIRM_TOKEN,
        body: {
          smart_collection: buildPayload(spec, existing),
        },
      });
      report.actions.push({
        step: existing?.id ? 'update_smart_collection' : 'create_smart_collection',
        handle: spec.handle,
        title: spec.title,
        result: upsert,
      });

      if (!(upsert?.json?.ok === true)) {
        throw new Error(
          `Failed syncing collection ${spec.handle}: ${upsert?.json?.error || upsert?.error || 'unknown error'}`
        );
      }
    }

    const verificationRead = await callTool(shopify, 'admin_rest', {
      endpoint: 'smart_collections.json',
      method: 'GET',
      query: { limit: 250 },
    });
    report.actions.push({ step: 'verify_smart_collections', result: verificationRead });
    const verifiedCollections = Array.isArray(verificationRead?.json?.data?.smart_collections)
      ? verificationRead.json.data.smart_collections
      : [];
    const byHandle = new Map(
      verifiedCollections.map((collection) => [String(collection?.handle || '').trim(), collection])
    );

    report.summary = {
      collectionsTargeted: COLLECTION_SPECS.length,
      blockers: report.blockers.length,
      collectionsVerified: COLLECTION_SPECS.filter((spec) => byHandle.has(spec.handle)).length,
      verifiedCollections: COLLECTION_SPECS.map((spec) => {
        const collection = byHandle.get(spec.handle);
        return {
          title: spec.title,
          handle: spec.handle,
          id: normalizeId(collection?.id),
          rulesMatch: normalizeRules(collection?.rules) === normalizeRules(spec.rules),
          productsCount: Number(collection?.products_count || 0),
        };
      }),
    };
  } finally {
    await shopify.close();
  }

  report.completedAt = new Date().toISOString();
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
  process.stderr.write(`shopify-collection-sync failed: ${error.message}\n`);
  process.exitCode = 1;
});
