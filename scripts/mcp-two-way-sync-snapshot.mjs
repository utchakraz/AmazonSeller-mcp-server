#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const reportDir = path.join(repoRoot, 'docs', 'reports');
const reportPath = path.join(reportDir, 'mcp-two-way-sync-snapshot.json');

function toPowershellPath(inputPath) {
  if (process.platform === 'win32') return inputPath;
  const match = inputPath.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
  if (!match) return inputPath;
  const drive = match[1].toUpperCase();
  const rest = match[2].replace(/\//g, '\\');
  return `${drive}:\\${rest}`;
}

function safeNowIso() {
  return new Date().toISOString();
}

function isoHoursAgo(hours) {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function toText(toolResult) {
  if (!toolResult?.content || !Array.isArray(toolResult.content)) return '';
  return toolResult.content
    .filter((entry) => entry?.type === 'text' && typeof entry?.text === 'string')
    .map((entry) => entry.text)
    .join('\n');
}

function parseJsonText(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseShopifyProductIds(listProductsText) {
  const ids = [];
  const regex = /ID:\s*([0-9]{5,})/g;
  let match = null;
  while ((match = regex.exec(listProductsText))) {
    ids.push(match[1]);
  }
  return Array.from(new Set(ids));
}

function parseSkusFromVariantText(variantText) {
  const skus = [];
  const regex = /SKU:\s*([^\r\n]+)/g;
  let match = null;
  while ((match = regex.exec(variantText))) {
    const sku = String(match[1] || '').trim();
    if (sku && sku !== 'N/A') skus.push(sku);
  }
  return Array.from(new Set(skus));
}

function parseLocationIds(locationsText) {
  const ids = [];
  const regex = /ID:\s*([0-9]{3,})/g;
  let match = null;
  while ((match = regex.exec(locationsText))) {
    ids.push(match[1]);
  }
  return Array.from(new Set(ids));
}

function summarizeAmazonInventory(rawJson) {
  const out = [];
  const summaries =
    rawJson?.inventorySummaries ||
    rawJson?.payload?.inventorySummaries ||
    rawJson?.payload?.inventorySummary ||
    [];

  for (const item of summaries) {
    const sku = item?.sellerSku || item?.sellerSKU || item?.sku || null;
    const total =
      item?.totalQuantity ??
      item?.inventoryDetails?.fulfillableQuantity ??
      item?.inventoryDetails?.availableQuantity ??
      null;
    out.push({
      sellerSku: sku,
      quantity: total
    });
  }
  return out;
}

async function connectMcp(name, command, args) {
  const client = new Client({ name: `snapshot-${name}`, version: '1.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command,
    args,
    env: process.env
  });

  await client.connect(transport);
  return client;
}

async function main() {
  const startedAt = safeNowIso();
  const snapshot = {
    startedAt,
    platform: process.platform,
    tools: {},
    shopify: {},
    amazon: {},
    recommendations: []
  };

  const amazonStartScript = toPowershellPath(
    path.join(repoRoot, 'scripts', 'mcp', 'start-amazon-mcp.ps1')
  );
  const shopifyStartScript = toPowershellPath(
    path.join(repoRoot, 'scripts', 'mcp', 'start-shopify-mcp.ps1')
  );

  const powershellCommand = process.platform === 'win32' ? 'powershell' : 'powershell.exe';

  const amazon = await connectMcp('amazon', powershellCommand, [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    amazonStartScript
  ]);

  let shopify = null;
  try {
    shopify = await connectMcp('shopify', powershellCommand, [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      shopifyStartScript
    ]);
  } catch (error) {
    snapshot.shopify.error = error.message;
  }

  try {
    const amazonTools = await amazon.listTools();
    snapshot.tools.amazon = amazonTools.tools.map((tool) => tool.name);
    snapshot.tools.amazonCount = snapshot.tools.amazon.length;

    if (shopify) {
      const shopifyTools = await shopify.listTools();
      snapshot.tools.shopify = shopifyTools.tools.map((tool) => tool.name);
      snapshot.tools.shopifyCount = snapshot.tools.shopify.length;
    }

    if (shopify) {
      const shopInfo = await shopify.callTool({ name: 'get_shop_info', arguments: {} });
      snapshot.shopify.shopInfo = toText(shopInfo);

      const locations = await shopify.callTool({ name: 'get_locations', arguments: {} });
      const locationsText = toText(locations);
      snapshot.shopify.locationsText = locationsText;
      snapshot.shopify.locationIds = parseLocationIds(locationsText);

      const products = await shopify.callTool({
        name: 'list_products',
        arguments: { limit: 50, status: 'active' }
      });
      const productsText = toText(products);
      snapshot.shopify.productsText = productsText;

      const productIds = parseShopifyProductIds(productsText);
      snapshot.shopify.productIds = productIds;
      snapshot.shopify.productCount = productIds.length;

      const skuSet = new Set();
      for (const productId of productIds) {
        try {
          const variants = await shopify.callTool({
            name: 'get_product_variants',
            arguments: { product_id: productId }
          });
          const variantText = toText(variants);
          for (const sku of parseSkusFromVariantText(variantText)) {
            skuSet.add(sku);
          }
        } catch {
          // Continue best-effort if an individual product parse fails.
        }
      }
      snapshot.shopify.skus = Array.from(skuSet).sort();
      snapshot.shopify.skuCount = snapshot.shopify.skus.length;

      const paidOrders = await shopify.callTool({
        name: 'list_orders',
        arguments: {
          limit: 20,
          status: 'any',
          financial_status: 'paid'
        }
      });
      snapshot.shopify.paidOrdersText = toText(paidOrders);
    }

    const orders = await amazon.callTool({
      name: 'getOrders',
      arguments: {
        createdAfter: isoHoursAgo(24)
      }
    });
    const ordersText = toText(orders);
    snapshot.amazon.ordersRawText = ordersText;
    snapshot.amazon.ordersJson = parseJsonText(ordersText);

    const inventoryArgs = { granularityType: 'Marketplace' };
    if (Array.isArray(snapshot.shopify.skus) && snapshot.shopify.skus.length) {
      inventoryArgs.sellerSkus = snapshot.shopify.skus;
    }
    const inventory = await amazon.callTool({
      name: 'getInventorySummaries',
      arguments: inventoryArgs
    });
    const inventoryText = toText(inventory);
    snapshot.amazon.inventoryRawText = inventoryText;
    const inventoryJson = parseJsonText(inventoryText);
    snapshot.amazon.inventoryJson = inventoryJson;
    snapshot.amazon.inventorySummary = summarizeAmazonInventory(inventoryJson);

    const knownAmazonSkus = new Set(
      snapshot.amazon.inventorySummary
        .map((item) => item?.sellerSku)
        .filter(Boolean)
    );
    const missingOnAmazon = (snapshot.shopify.skus || []).filter((sku) => !knownAmazonSkus.has(sku));

    if (!snapshot.shopify.skuCount) {
      snapshot.recommendations.push(
        'Shopify SKU extraction returned no SKUs. Confirm product variants include SKU values before running two-way stock sync.'
      );
    }
    if (missingOnAmazon.length) {
      snapshot.recommendations.push(
        `Shopify SKUs missing from Amazon inventory summaries: ${missingOnAmazon.join(', ')}`
      );
    } else if (snapshot.shopify.skuCount) {
      snapshot.recommendations.push(
        'All extracted Shopify SKUs were returned by Amazon inventory summaries for this snapshot window.'
      );
    }
    if (!snapshot.shopify.locationIds?.length) {
      snapshot.recommendations.push(
        'No Shopify location IDs detected from MCP output. Set SHOPIFY_PRIMARY_LOCATION_GID explicitly before automated inventory pushes.'
      );
    } else {
      snapshot.recommendations.push(
        `Use ${snapshot.shopify.locationIds[0]} as initial SHOPIFY_PRIMARY_LOCATION_GID candidate after manual admin verification.`
      );
    }
  } finally {
    try {
      await amazon.close();
    } catch {
      // no-op
    }
    if (shopify) {
      try {
        await shopify.close();
      } catch {
        // no-op
      }
    }
  }

  snapshot.completedAt = safeNowIso();

  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');

  const summary = {
    reportPath,
    amazonTools: snapshot.tools.amazonCount || 0,
    shopifyTools: snapshot.tools.shopifyCount || 0,
    shopifySkus: snapshot.shopify.skuCount || 0,
    amazonInventoryRows: snapshot.amazon.inventorySummary?.length || 0
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`mcp-two-way-sync-snapshot failed: ${error.message}\n`);
  process.exitCode = 1;
});
