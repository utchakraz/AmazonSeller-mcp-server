#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { PRODUCT_CATALOG } from '../../../scripts/product-catalog.mjs';
import { connectMcpClient, parseJsonText, toText } from './lib/mcpClient.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const reportDir = path.join(repoRoot, 'docs', 'reports');
const startedAt = new Date().toISOString();
const stamp = startedAt.replace(/[:.]/g, '-');
const reportPath = path.join(reportDir, `shopify-catalog-sync-${stamp}.json`);
const latestPath = path.join(reportDir, 'shopify-catalog-sync-latest.json');
const WRITE_CONFIRM_TOKEN = process.env.SHOPIFY_MCP_WRITE_CONFIRM || 'RBL_WRITE_CONFIRM';

const PRODUCT_ID_TO_SKU = {
  'rb-living-fountain': 'OL-Z0QN-B0VE',
  'rbl-crimson-table-cloth-150': 'CC-SQAN-QKBS',
  'rbl-crimson-table-cloth-180': 'CC-T0KS-NAW0',
  'rbl-crimson-runner': 'CC-QYNQ-3RS0',
  'rbl-crimson-mat-1': 'CC-7KR2-FDD2',
  'rbl-crimson-mat-4': 'CC-DJNZ-Y3BB',
  'rbl-crimson-napkin-1': 'CC-C10J-FICZ',
  'rbl-crimson-napkin-4': 'CC-00AI-CPTE',
  'rbl-gp-table-cloth-150': 'GP-TC-150',
  'rbl-gp-table-cloth-180': 'GP-TC-180',
  'rbl-gp-runner': 'GP-RUN-150',
  'rbl-gp-mat-1': 'GP-MAT-1',
  'rbl-gp-mat-4': 'GP-MAT-4',
  'rbl-gp-napkin-1': 'GP-NAP-1',
  'rbl-gp-napkin-4': 'GP-NAP-4',
};

const PRODUCT_GTIN_BY_ID = {
  'rb-living-fountain': '9309003499264',
  'rbl-crimson-table-cloth-150': '9309003499271',
  'rbl-crimson-table-cloth-180': '9309003499288',
  'rbl-crimson-runner': '9309003499295',
  'rbl-crimson-mat-1': '9309003499301',
  'rbl-crimson-mat-4': '9309003499318',
  'rbl-crimson-napkin-1': '9309003499325',
  'rbl-crimson-napkin-4': '9309003499332',
  'rbl-gp-table-cloth-150': '9309003499349',
  'rbl-gp-table-cloth-180': '9309003499356',
  'rbl-gp-runner': '9309003499363',
  'rbl-gp-mat-1': '9309003499370',
  'rbl-gp-mat-4': '9309003499387',
  'rbl-gp-napkin-1': '9309003499394',
  'rbl-gp-napkin-4': '9309003499400',
};

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function getMediaUrl(filename) {
  const cleanFilename = String(filename || '').replace(/^\/+/, '');
  return `https://s3.ap-southeast-2.amazonaws.com/media.ucrd/RBLiving/Green/${cleanFilename}`;
}

function getProductFamily(productId) {
  if (productId === 'rb-living-fountain') return 'drink-fountain';
  if (productId.startsWith('rbl-crimson-')) return 'crimson-courtyard';
  if (productId.startsWith('rbl-gp-')) return 'garden-party';
  return 'unknown';
}

function getProductType(productId) {
  if (productId === 'rb-living-fountain') return 'drink-fountain';
  if (productId.includes('table-cloth')) return 'table-cloth';
  if (productId.includes('runner')) return 'table-runner';
  if (productId.includes('mat')) return 'table-mat';
  if (productId.includes('napkin')) return 'napkin';
  return 'unknown';
}

function getProductTypeLabel(productId) {
  switch (getProductType(productId)) {
    case 'drink-fountain':
      return 'Drink Fountain';
    case 'table-cloth':
      return 'Table Cloth';
    case 'table-runner':
      return 'Table Runner';
    case 'table-mat':
      return 'Table Mat';
    case 'napkin':
      return 'Napkin';
    default:
      return 'Product';
  }
}

function getFamilyLabel(productId) {
  switch (getProductFamily(productId)) {
    case 'drink-fountain':
      return 'RB Living Drink Fountain';
    case 'crimson-courtyard':
      return 'Crimson Courtyard';
    case 'garden-party':
      return 'Garden Party';
    default:
      return 'RB Living';
  }
}

function getVariantLabel(product) {
  if (product.size) return product.size;
  if (product.packSize > 1) return `Pack of ${product.packSize}`;
  return 'Single';
}

function getGroupSeoDescription(group) {
  const primary = group.products[0];
  const familyLabel = getFamilyLabel(primary.id);
  switch (getProductType(primary.id)) {
    case 'drink-fountain':
      return 'LED drink fountain for parties, weddings, mocktails, punch bowls, and self-serve entertaining in Australia.';
    case 'table-cloth':
      return `Shop RB Living ${familyLabel} table cloths in premium 100% cotton for elevated Australian entertaining.`;
    case 'table-runner':
      return `Shop RB Living ${familyLabel} table runners in premium 100% cotton for layered tablescapes and hosting.`;
    case 'table-mat':
      return `Shop RB Living ${familyLabel} table mats in 100% cotton with single and multipack options for polished place settings.`;
    case 'napkin':
      return `Shop RB Living ${familyLabel} reusable cotton napkins in single and multipack options for elevated entertaining.`;
    default:
      return primary.description;
  }
}

function getShopifyProductTitle(group) {
  const primary = group.products[0];
  const typeLabel = getProductTypeLabel(primary.id);
  const familyLabel = getFamilyLabel(primary.id);

  if (getProductType(primary.id) === 'drink-fountain') {
    return 'RB Living Illuminated 3-Tier Party Drink Fountain';
  }

  return `RB Living 100% Cotton ${typeLabel} - ${familyLabel}`;
}

function getGroupHandle(group) {
  return slugify(group.products[0].name);
}

function getMaterialLabel(productId) {
  return getProductType(productId) === 'drink-fountain'
    ? 'Food-grade materials with integrated LED lighting'
    : '100% premium cotton';
}

function getCareLabel(productId) {
  return getProductType(productId) === 'drink-fountain'
    ? 'Components detach for easy cleaning after use.'
    : 'Cold hand wash. Warm iron on the reverse if required.';
}

function getCollectionPairingCopy(group) {
  const primary = group.products[0];
  switch (getProductType(primary.id)) {
    case 'drink-fountain':
      return 'Style the drinks station with RB Living table linen to create a polished setup for parties, weddings, and hosting at home.';
    case 'table-cloth':
      return `Pair it with the matching ${getFamilyLabel(primary.id)} runner, mats, and napkins to build a fully coordinated table setting.`;
    case 'table-runner':
      return `Layer it with the matching ${getFamilyLabel(primary.id)} table cloth, mats, and napkins for a cohesive hosting look.`;
    case 'table-mat':
      return `Use it on its own or complete the table with the matching ${getFamilyLabel(primary.id)} cloth, runner, and napkins.`;
    case 'napkin':
      return `Complete the setting with the matching ${getFamilyLabel(primary.id)} table cloth, runner, and mats for a polished collection-led table.`;
    default:
      return '';
  }
}

function getProductDetailItems(group) {
  const primary = group.products[0];
  const details = [
    `<li><strong>Material:</strong> ${getMaterialLabel(primary.id)}</li>`,
    `<li><strong>Care:</strong> ${getCareLabel(primary.id)}</li>`,
  ];

  if (getProductType(primary.id) === 'drink-fountain') {
    details.push('<li><strong>Setup:</strong> Quick assembly in minutes with a self-serve flowing drinks presentation.</li>');
    details.push('<li><strong>Use case:</strong> Built for parties, weddings, brunches, mocktails, punch bowls, and celebration service.</li>');
    return details;
  }

  if (group.products.some((product) => product.size)) {
    details.push(
      `<li><strong>Available sizes:</strong> ${group.products
        .map((product) => product.size)
        .filter(Boolean)
        .join(', ')}</li>`
    );
  }

  if (group.products.some((product) => Number(product.packSize) > 1)) {
    details.push(
      `<li><strong>Pack options:</strong> ${group.products
        .map((product) => (Number(product.packSize) > 1 ? `Pack of ${product.packSize}` : 'Single'))
        .join(', ')}</li>`
    );
  }

  details.push('<li><strong>Use case:</strong> Designed for repeat entertaining, family dining, and collection-led tablescapes.</li>');
  return details;
}

function getTrustItems(group) {
  const primary = group.products[0];
  const trust = [
    '<li>Free standard shipping within Australia on orders over AUD 100.</li>',
    '<li>Live shipping rates and express options show at checkout.</li>',
  ];

  if (getProductType(primary.id) === 'drink-fountain') {
    trust.push('<li>Drink Fountain damage or fault claims are supported when reported within 48 hours of delivery.</li>');
  } else {
    trust.push('<li>Unused table linen can be returned within 30 days when kept in original, resaleable condition.</li>');
  }

  trust.push('<li>Post-purchase reviews help future RB Living shoppers choose the right product with confidence.</li>');
  return trust;
}

function buildBodyHtml(group) {
  const hero = group.products[0];
  const variantsHtml =
    group.products.length > 1
      ? `<p><strong>Available options:</strong> ${group.products.map((product) => getVariantLabel(product)).join(', ')}.</p>`
      : '';
  const features = hero.features.map((feature) => `<li>${feature}</li>`).join('');
  const details = getProductDetailItems(group).join('');
  const trust = getTrustItems(group).join('');
  const pairingCopy = getCollectionPairingCopy(group);
  return [
    `<p>${hero.description}</p>`,
    variantsHtml,
    '<h3>Why shoppers choose it</h3>',
    `<ul>${features}</ul>`,
    '<h3>Product details</h3>',
    `<ul>${details}</ul>`,
    '<h3>Shipping and returns</h3>',
    `<ul>${trust}</ul>`,
    pairingCopy ? `<p><strong>Complete the look:</strong> ${pairingCopy}</p>` : '',
  ]
    .filter(Boolean)
    .join('');
}

function groupCatalog(products) {
  const grouped = new Map();
  for (const product of products.filter((entry) => entry.active !== false)) {
    const key = product.name;
    const current = grouped.get(key) || { name: key, products: [] };
    current.products.push(product);
    grouped.set(key, current);
  }

  return Array.from(grouped.values())
    .map((group) => ({
      ...group,
      products: group.products.sort((left, right) => (left.sortOrder ?? 99) - (right.sortOrder ?? 99)),
    }))
    .sort((left, right) => (left.products[0]?.sortOrder ?? 99) - (right.products[0]?.sortOrder ?? 99));
}

function getOptionConfig(group) {
  const sizes = Array.from(new Set(group.products.map((product) => product.size).filter(Boolean)));
  const packSizes = Array.from(new Set(group.products.map((product) => product.packSize))).filter(
    (value) => Number.isFinite(value)
  );

  if (sizes.length > 1) {
    return {
      name: 'Size',
      valueFor: (product) => product.size,
    };
  }

  if (packSizes.length > 1) {
    return {
      name: 'Pack Size',
      valueFor: (product) => `Pack of ${product.packSize}`,
    };
  }

  return {
    name: 'Title',
    valueFor: () => 'Default Title',
  };
}

function buildTags(group) {
  const primary = group.products[0];
  const tags = [
    'RB Living',
    'SEO Max',
    'Channel Ready',
    getFamilyLabel(primary.id),
    getProductTypeLabel(primary.id),
    getProductFamily(primary.id),
    getProductType(primary.id),
    'Australia',
    'Home Entertaining',
  ];

  if (getProductType(primary.id) === 'drink-fountain') {
    tags.push('LED', 'Party Entertaining', 'Wedding Entertaining');
  } else {
    tags.push('Cotton', 'Reusable', 'Table Linen');
  }

  return Array.from(new Set(tags));
}

function buildVariantPayload(group, existingProduct = null) {
  const option = getOptionConfig(group);
  const existingVariantsBySku = new Map(
    (existingProduct?.variants || [])
      .filter((variant) => variant?.sku)
      .map((variant) => [String(variant.sku), variant])
  );

  return group.products.map((product) => {
    const sku = PRODUCT_ID_TO_SKU[product.id];
    const existingVariant = existingVariantsBySku.get(sku) || null;
    const payload = {
      option1: option.valueFor(product),
      price: String(product.price.toFixed(2)),
      sku,
      barcode: PRODUCT_GTIN_BY_ID[product.id],
      inventory_management: 'shopify',
      inventory_policy: 'deny',
      requires_shipping: true,
      taxable: true,
    };

    if (existingVariant?.id) {
      payload.id = existingVariant.id;
    }

    return payload;
  });
}

function buildProductPayload(group, existingProduct = null) {
  const primary = group.products[0];
  const option = getOptionConfig(group);
  const payload = {
    title: getShopifyProductTitle(group),
    body_html: buildBodyHtml(group),
    vendor: 'RB Living',
    product_type: getProductTypeLabel(primary.id),
    handle: existingProduct?.handle || getGroupHandle(group),
    status: 'active',
    tags: buildTags(group).join(', '),
    published_scope: 'global',
    options: [{ name: option.name }],
    variants: buildVariantPayload(group, existingProduct),
    metafields_global_title_tag: `${getShopifyProductTitle(group)} | RB Living Australia`,
    metafields_global_description_tag: getGroupSeoDescription(group),
  };

  if (!existingProduct?.images?.length) {
    payload.images = [
      {
        src: getMediaUrl(primary.image),
        alt: `${primary.name} by RB Living`,
      },
    ];
  }

  if (existingProduct?.id) {
    payload.id = existingProduct.id;
  }

  return payload;
}

function buildCanonicalHandleBySku(groups) {
  const out = new Map();
  for (const group of groups) {
    const handle = getGroupHandle(group);
    for (const product of group.products) {
      out.set(PRODUCT_ID_TO_SKU[product.id], handle);
    }
  }
  return out;
}

function normalizeProductId(id) {
  const raw = String(id || '').trim();
  const match = raw.match(/(\d+)$/);
  return match ? match[1] : raw;
}

function compareRank(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    if (leftValue < rightValue) return -1;
    if (leftValue > rightValue) return 1;
  }
  return 0;
}

function pickPreferredProduct(products, expectedHandle) {
  if (!Array.isArray(products) || products.length === 0) return null;

  return [...products].sort((left, right) => {
    const leftHandle = String(left?.handle || '').trim();
    const rightHandle = String(right?.handle || '').trim();
    const leftRank = [
      leftHandle === expectedHandle ? 0 : 1,
      /-\d+$/.test(leftHandle) ? 1 : 0,
      String(left?.status || '').toUpperCase() === 'ACTIVE' ? 0 : 1,
      Number(normalizeProductId(left?.id) || Number.MAX_SAFE_INTEGER),
    ];
    const rightRank = [
      rightHandle === expectedHandle ? 0 : 1,
      /-\d+$/.test(rightHandle) ? 1 : 0,
      String(right?.status || '').toUpperCase() === 'ACTIVE' ? 0 : 1,
      Number(normalizeProductId(right?.id) || Number.MAX_SAFE_INTEGER),
    ];
    return compareRank(leftRank, rightRank);
  })[0];
}

function mapGraphqlProducts(nodes) {
  return (Array.isArray(nodes) ? nodes : []).map((node) => ({
    id: normalizeProductId(node?.id),
    adminGraphqlApiId: node?.id || null,
    title: String(node?.title || '').trim(),
    handle: String(node?.handle || '').trim(),
    status: String(node?.status || '').trim().toUpperCase(),
    totalVariants: Number(node?.totalVariants ?? node?.variants?.nodes?.length ?? 0),
    images: Array.isArray(node?.images?.nodes)
      ? node.images.nodes
          .map((image) => ({
            url: String(image?.url || '').trim(),
            alt: String(image?.altText || '').trim(),
          }))
          .filter((image) => image.url)
      : [],
    variants: Array.isArray(node?.variants?.nodes)
      ? node.variants.nodes.map((variant) => ({
          id: normalizeProductId(variant?.id),
          sku: String(variant?.sku || '').trim(),
          barcode: String(variant?.barcode || '').trim(),
          price: variant?.price ?? null,
        }))
      : [],
  }));
}

function getGraphqlProductQuery() {
  return `query CatalogProducts {
  products(first: 100, sortKey: TITLE) {
    nodes {
      id
      title
      handle
      status
      images(first: 1) {
        nodes {
          url
          altText
        }
      }
      variants(first: 10) {
        nodes {
          id
          sku
          barcode
          price
        }
      }
    }
  }
}`;
}

function getManagedSkusForGroup(group) {
  return group.products.map((product) => PRODUCT_ID_TO_SKU[product.id]).filter(Boolean);
}

function findProductsForManagedSkus(products, managedSkus) {
  const skuSet = new Set(managedSkus);
  return (Array.isArray(products) ? products : []).filter((product) =>
    (product?.variants || []).some((variant) => skuSet.has(String(variant?.sku || '').trim()))
  );
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
  await fs.mkdir(reportDir, { recursive: true });

  const report = {
    startedAt,
    groupsAttempted: [],
    actions: [],
    summary: {},
  };

  const shopify = await connectMcpClient({
    repoRoot,
    service: 'shopify',
    clientName: 'shopify-catalog-sync',
    env: {
      SHOPIFY_MCP_ENABLE_WRITES: 'true',
      SHOPIFY_MCP_WRITE_CONFIRM: WRITE_CONFIRM_TOKEN,
    },
  });

  try {
    const mcpConfig = await callTool(shopify, 'get_mcp_config', {});
    report.actions.push({ step: 'get_mcp_config', result: mcpConfig });
    if (!(mcpConfig?.json?.ok === true && mcpConfig?.json?.mode?.writeEnabled === true)) {
      throw new Error('Shopify MCP write mode is disabled.');
    }

    const existingProductsRes = await callTool(shopify, 'admin_graphql', {
      query: getGraphqlProductQuery(),
    });
    report.actions.push({ step: 'read_existing_products', result: existingProductsRes });
    const existingProducts = mapGraphqlProducts(existingProductsRes?.json?.data?.data?.products?.nodes);

    const groups = groupCatalog(PRODUCT_CATALOG);
    const syncedProductIdsByGroup = new Map();
    report.groupsAttempted = groups.map((group) => ({
      name: group.name,
      expectedHandle: getGroupHandle(group),
      variants: group.products.map((product) => ({
        id: product.id,
        sku: PRODUCT_ID_TO_SKU[product.id],
      })),
    }));

    for (const group of groups) {
      const managedSkus = getManagedSkusForGroup(group);
      const existingProduct = pickPreferredProduct(
        findProductsForManagedSkus(existingProducts, managedSkus),
        getGroupHandle(group)
      );
      const endpoint = existingProduct?.id ? `products/${existingProduct.id}.json` : 'products.json';
      const method = existingProduct?.id ? 'PUT' : 'POST';
      const body = {
        product: buildProductPayload(group, existingProduct),
      };

      const upsertRes = await callTool(shopify, 'admin_rest', {
        endpoint,
        method,
        confirm: WRITE_CONFIRM_TOKEN,
        body,
      });

      report.actions.push({
        step: existingProduct?.id ? 'update_product_group' : 'create_product_group',
        group: group.name,
        existingProductId: existingProduct?.id || null,
        result: upsertRes,
      });

      if (!(upsertRes?.json?.ok === true)) {
        throw new Error(
          `Failed syncing ${group.name}: ${upsertRes?.json?.error || upsertRes?.error || 'unknown error'}`
        );
      }

      const syncedProductId = normalizeProductId(upsertRes?.json?.data?.product?.id || existingProduct?.id);
      if (syncedProductId) {
        syncedProductIdsByGroup.set(group.name, syncedProductId);
      }
    }

    const postSyncProductsRes = await callTool(shopify, 'admin_graphql', {
      query: getGraphqlProductQuery(),
    });
    report.actions.push({ step: 'read_post_sync_products', result: postSyncProductsRes });
    const postSyncProducts = mapGraphqlProducts(postSyncProductsRes?.json?.data?.data?.products?.nodes);
    const archivedProductIds = new Set();
    for (const product of postSyncProducts) {
      if (archivedProductIds.has(product?.id)) continue;
      if (String(product?.status || '').toUpperCase() !== 'ACTIVE') continue;

      for (const group of groups) {
        const managedSkus = getManagedSkusForGroup(group);
        if (!findProductsForManagedSkus([product], managedSkus).length) continue;

        const duplicateCandidates = findProductsForManagedSkus(postSyncProducts, managedSkus).filter(
          (candidate) => String(candidate?.status || '').toUpperCase() === 'ACTIVE'
        );
        if (duplicateCandidates.length <= 1) continue;

        const canonicalProductId =
          syncedProductIdsByGroup.get(group.name) ||
          pickPreferredProduct(duplicateCandidates, getGroupHandle(group))?.id;
        if (!canonicalProductId || product.id === canonicalProductId) break;

        const archiveRes = await callTool(shopify, 'admin_rest', {
          endpoint: `products/${product.id}.json`,
          method: 'PUT',
          confirm: WRITE_CONFIRM_TOKEN,
          body: {
            product: {
              id: Number(product.id),
              status: 'archived',
            },
          },
        });

        report.actions.push({
          step: 'archive_duplicate_product',
          group: group.name,
          canonicalProductId,
          archivedProductId: product.id,
          archivedTitle: product.title,
          archivedHandle: product.handle,
          managedSkus,
          result: archiveRes,
        });

        if (!(archiveRes?.json?.ok === true)) {
          throw new Error(
            `Failed archiving duplicate product ${product.id}: ${archiveRes?.json?.error || archiveRes?.error || 'unknown error'}`
          );
        }

        archivedProductIds.add(product.id);
        break;
      }
    }

    const verificationRes = await callTool(shopify, 'admin_graphql', {
      query: `query CatalogSyncVerification {
  products(first: 50, query: "status:active", sortKey: TITLE) {
    nodes {
      id
      title
      handle
      status
      totalVariants
      variants(first: 10) {
        nodes {
          sku
          barcode
        }
      }
    }
  }
}`,
    });
    report.actions.push({ step: 'verify_products', result: verificationRes });
    const verifiedProducts = mapGraphqlProducts(verificationRes?.json?.data?.data?.products?.nodes);
    const managedActiveProducts = verifiedProducts.filter((product) =>
      groups.some((group) => findProductsForManagedSkus([product], getManagedSkusForGroup(group)).length > 0)
    );
    const groupedProductsVerified = groups.filter((group) =>
      managedActiveProducts.some(
        (product) => findProductsForManagedSkus([product], getManagedSkusForGroup(group)).length > 0
      )
    ).length;

    report.summary = {
      groupedProductsExpected: groups.length,
      groupedProductsVerified,
      archivedDuplicates: report.actions.filter((action) => action.step === 'archive_duplicate_product').length,
      managedActiveProducts: managedActiveProducts.length,
      variantCountVerified: managedActiveProducts.reduce(
        (count, product) => count + Number(product?.totalVariants || 0),
        0
      ),
      shopifyProductTitles: managedActiveProducts.map((product) => product?.title).filter(Boolean),
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
  process.stderr.write(`shopify-catalog-sync failed: ${error.message}\n`);
  process.exitCode = 1;
});
