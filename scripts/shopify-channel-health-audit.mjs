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
const reportPath = path.join(reportDir, `shopify-channel-health-audit-${stamp}.json`);
const latestPath = path.join(reportDir, 'shopify-channel-health-audit-latest.json');
const publishReportPath = path.join(reportDir, 'shopify-channel-publish-latest.json');

async function connectShopifyMcp() {
  return connectMcpClient({
    repoRoot,
    service: 'shopify',
    clientName: 'shopify-channel-health-audit',
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

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function toNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function summarizeProduct(product) {
  const variants = toArray(product?.variants);
  const images = toArray(product?.images);
  const hasBodyHtml = String(product?.body_html || '').replace(/<[^>]+>/g, ' ').trim().length >= 80;
  const hasImage = images.length > 0;
  const hasAnyVariant = variants.length > 0;
  const missingVariantSku = variants.filter((variant) => !String(variant?.sku || '').trim()).length;
  const missingVariantBarcode = variants.filter((variant) => !String(variant?.barcode || '').trim()).length;
  const missingVariantPrice = variants.filter((variant) => String(variant?.price || '').trim() === '').length;
  const missingInventoryManagement = variants.filter(
    (variant) => String(variant?.inventory_management || '').trim().toLowerCase() !== 'shopify'
  ).length;
  const outOfStockVariants = variants.filter((variant) => toNumber(variant?.inventory_quantity) <= 0).length;

  return {
    id: product?.id || null,
    title: String(product?.title || '').trim(),
    handle: String(product?.handle || '').trim(),
    productType: String(product?.product_type || '').trim(),
    vendor: String(product?.vendor || '').trim(),
    tags: String(product?.tags || '')
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean),
    hasBodyHtml,
    hasImage,
    variantCount: variants.length,
    missingVariantSku,
    missingVariantBarcode,
    missingVariantPrice,
    missingInventoryManagement,
    outOfStockVariants,
    readyForChannelExport:
      hasBodyHtml &&
      hasImage &&
      hasAnyVariant &&
      missingVariantSku === 0 &&
      missingVariantBarcode === 0 &&
      missingVariantPrice === 0 &&
      missingInventoryManagement === 0,
  };
}

async function readPublishSummary() {
  try {
    const raw = await fs.readFile(publishReportPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function main() {
  await fs.mkdir(reportDir, { recursive: true });

  const report = {
    startedAt,
    actions: [],
    summary: {},
    products: [],
  };

  const publishReport = await readPublishSummary();
  const shopify = await connectShopifyMcp();
  try {
    const publicationsRead = await callTool(shopify, 'admin_graphql', {
      query: `query PublicationNames {
  publications(first: 50) {
    nodes {
      id
      name
      autoPublish
    }
  }
}`,
    });
    report.actions.push({ step: 'read_publications', result: publicationsRead });

    const productsRead = await callTool(shopify, 'admin_rest', {
      endpoint: 'products.json',
      method: 'GET',
      query: {
        status: 'active',
        limit: 250,
      },
    });
    report.actions.push({ step: 'read_active_products_rest', result: productsRead });
    const products = toArray(productsRead?.json?.data?.products);

    report.products = products.map((product) => summarizeProduct(product));

    const targetPublications = toArray(publishReport?.summary?.targetPublications).map((publication) => ({
      id: publication?.id || null,
      name: publication?.name || null,
      autoPublish: publication?.autoPublish === true,
    }));

    report.summary = {
      publicationsFound:
        toArray(publicationsRead?.json?.data?.data?.publications?.nodes).length || targetPublications.length,
      targetPublications,
      publishSummary: publishReport?.summary || null,
      activeProductsFound: report.products.length,
      activeProductsReadyForChannelExport: report.products.filter((product) => product.readyForChannelExport).length,
      productsMissingBodyHtml: report.products.filter((product) => !product.hasBodyHtml).map((product) => product.handle),
      productsMissingImages: report.products.filter((product) => !product.hasImage).map((product) => product.handle),
      productsMissingVariantSku: report.products.filter((product) => product.missingVariantSku > 0).map((product) => product.handle),
      productsMissingVariantBarcode: report.products
        .filter((product) => product.missingVariantBarcode > 0)
        .map((product) => product.handle),
      productsMissingVariantPrice: report.products
        .filter((product) => product.missingVariantPrice > 0)
        .map((product) => product.handle),
      productsMissingInventoryManagement: report.products
        .filter((product) => product.missingInventoryManagement > 0)
        .map((product) => product.handle),
      note:
        'This audit verifies publication coverage plus product-data completeness for Shopify-owned channels. App-side approval diagnostics are not exposed through the generic Admin APIs used here.',
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
  process.stderr.write(`shopify-channel-health-audit failed: ${error.message}\n`);
  process.exitCode = 1;
});
