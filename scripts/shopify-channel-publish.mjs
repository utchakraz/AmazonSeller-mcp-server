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
const reportPath = path.join(reportDir, `shopify-channel-publish-${stamp}.json`);
const latestPath = path.join(reportDir, 'shopify-channel-publish-latest.json');

const WRITE_CONFIRM_TOKEN = process.env.SHOPIFY_MCP_WRITE_CONFIRM || 'RBL_WRITE_CONFIRM';
const EXCLUDED_PUBLICATION_NAMES = new Set(
  String(process.env.SHOPIFY_PUBLISH_EXCLUDE_PUBLICATIONS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
);

async function connectShopifyMcp() {
  return connectMcpClient({
    repoRoot,
    service: 'shopify',
    clientName: 'shopify-channel-publish',
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

async function main() {
  const report = {
    startedAt,
    publicationSelectionMode: 'all-except-excluded',
    actions: [],
    publishes: [],
    summary: {},
  };
  await fs.mkdir(reportDir, { recursive: true });

  const shopify = await connectShopifyMcp();
  try {
    const mcpConfig = await callTool(shopify, 'get_mcp_config', {});
    report.actions.push({ step: 'get_mcp_config', result: mcpConfig });
    const writeEnabled = mcpConfig?.json?.ok === true && mcpConfig?.json?.mode?.writeEnabled === true;
    if (!writeEnabled) throw new Error('Shopify MCP write mode is disabled.');

    const publicationsRes = await callTool(shopify, 'admin_graphql', {
      query: `query Publications {
  publications(first: 50) {
    nodes {
      id
      name
      autoPublish
      supportsFuturePublishing
    }
  }
}`,
    });
    report.actions.push({ step: 'list_publications', result: publicationsRes });
    const publications =
      publicationsRes?.json?.data?.data?.publications?.nodes?.map((node) => ({
        id: node?.id || null,
        name: String(node?.name || '').trim(),
        autoPublish: node?.autoPublish === true,
      })) || [];

    const targetPublications = publications.filter(
      (publication) => publication.id && !EXCLUDED_PUBLICATION_NAMES.has(publication.name)
    );
    const publicationInputs = targetPublications.map((publication) => ({ publicationId: publication.id }));

    const productsRes = await callTool(shopify, 'admin_graphql', {
      query: `query ActiveProducts {
  products(first: 100, query: "status:active") {
    nodes {
      id
      title
      status
    }
  }
}`,
    });
    report.actions.push({ step: 'list_active_products', result: productsRes });
    const products =
      productsRes?.json?.data?.data?.products?.nodes?.map((node) => ({
        id: node?.id || null,
        title: String(node?.title || '').trim(),
        status: String(node?.status || '').trim(),
      })) || [];

    if (publicationInputs.length > 0 && products.length > 0) {
      for (const product of products) {
        if (!product.id) continue;
        const publishRes = await callTool(shopify, 'admin_graphql', {
          confirm: WRITE_CONFIRM_TOKEN,
          query: `mutation PublishProduct($id: ID!, $input: [PublicationInput!]!) {
  publishablePublish(id: $id, input: $input) {
    publishable {
      ... on Product {
        id
        title
      }
    }
    userErrors {
      field
      message
    }
  }
}`,
          variables: {
            id: product.id,
            input: publicationInputs,
          },
        });
        const userErrors = publishRes?.json?.data?.data?.publishablePublish?.userErrors || [];
        report.publishes.push({
          productId: product.id,
          title: product.title,
          ok: publishRes?.json?.ok === true && userErrors.length === 0,
          userErrors,
          raw: publishRes?.json || null,
        });
      }
    }

    const okPublishes = report.publishes.filter((entry) => entry.ok).length;
    const failedPublishes = report.publishes.length - okPublishes;

    report.summary = {
      publicationsFound: publications.length,
      excludedPublications: Array.from(EXCLUDED_PUBLICATION_NAMES),
      targetPublications: targetPublications.map((publication) => ({
        id: publication.id,
        name: publication.name,
        autoPublish: publication.autoPublish,
      })),
      activeProductsFound: products.length,
      publishAttempts: report.publishes.length,
      publishSuccess: okPublishes,
      publishFailed: failedPublishes,
      note:
        publicationInputs.length === 0
          ? 'No eligible publications found after exclusions.'
          : 'Publish attempted for each active product against every eligible Shopify publication.',
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
  process.stderr.write(`shopify-channel-publish failed: ${error.message}\n`);
  process.exitCode = 1;
});
