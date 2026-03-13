#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { PRODUCT_CATALOG } from '../../../scripts/product-catalog.mjs';
import { connectMcpClient, parseJsonText, toText } from './lib/mcpClient.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const reportDir = path.join(repoRoot, 'docs', 'reports');

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const sellerId = process.env.SP_API_SELLER_ID;
const marketplaceId = process.env.SP_API_MARKETPLACE_ID;

if (!sellerId || !marketplaceId) {
  throw new Error('Missing SP_API_SELLER_ID or SP_API_MARKETPLACE_ID in services/amazon-mcp/.env');
}

const catalogById = new Map(PRODUCT_CATALOG.map((product) => [product.id, product]));

const GTIN_BY_PRODUCT_ID = {
  'rbl-gp-table-cloth-150': '9309003499349',
  'rbl-gp-table-cloth-180': '9309003499356',
  'rbl-gp-runner': '9309003499363',
  'rbl-gp-mat-1': '9309003499370',
  'rbl-gp-mat-4': '9309003499387',
  'rbl-gp-napkin-1': '9309003499394',
  'rbl-gp-napkin-4': '9309003499400',
};

const PARENT_FAMILIES = {
  tablecloth: {
    parentSku: 'RBL-GP-TC-PARENT',
    productType: 'TABLECLOTH',
    variationTheme: 'SIZE',
    title: 'RB Living Garden Party Tablecloth - Variation Parent (Size Variants)',
    description: 'Parent listing for RB Living Garden Party tablecloth size variants.',
  },
  runner: {
    parentSku: 'RBL-GP-RUNNER-PARENT',
    productType: 'TABLE_RUNNER',
    variationTheme: 'SIZE',
    title: 'RB Living Garden Party Table Runner - Variation Parent (Future Size Variants)',
    description: 'Parent listing for RB Living Garden Party table runner size variants.',
  },
  placemat: {
    parentSku: 'RBL-GP-MAT-PARENT',
    productType: 'PLACEMAT',
    variationTheme: 'SIZE',
    title: 'RB Living Garden Party Placemat - Variation Parent (Pack Variants)',
    description: 'Parent listing for RB Living Garden Party placemat pack variants.',
  },
  napkin: {
    parentSku: 'RBL-GP-NAPKIN-PARENT',
    productType: 'CLOTH_NAPKIN',
    variationTheme: 'SIZE',
    title: 'RB Living Garden Party Dinner Napkin - Variation Parent (Pack Variants)',
    description: 'Parent listing for RB Living Garden Party napkin pack variants.',
  },
};

const CHILD_LAUNCH_PLAN = [
  {
    productId: 'rbl-gp-table-cloth-150',
    sellerSku: 'GP-TC-150',
    sourceSku: 'CC-SQAN-QKBS',
    familyKey: 'tablecloth',
    productType: 'TABLECLOTH',
  },
  {
    productId: 'rbl-gp-table-cloth-180',
    sellerSku: 'GP-TC-180',
    sourceSku: 'CC-T0KS-NAW0',
    familyKey: 'tablecloth',
    productType: 'TABLECLOTH',
  },
  {
    productId: 'rbl-gp-runner',
    sellerSku: 'GP-RUN-150',
    sourceSku: 'CC-QYNQ-3RS0',
    familyKey: 'runner',
    productType: 'TABLE_RUNNER',
  },
  {
    productId: 'rbl-gp-mat-1',
    sellerSku: 'GP-MAT-1',
    sourceSku: 'CC-7KR2-FDD2',
    familyKey: 'placemat',
    productType: 'PLACEMAT',
  },
  {
    productId: 'rbl-gp-mat-4',
    sellerSku: 'GP-MAT-4',
    sourceSku: 'CC-DJNZ-Y3BB',
    familyKey: 'placemat',
    productType: 'PLACEMAT',
  },
  {
    productId: 'rbl-gp-napkin-1',
    sellerSku: 'GP-NAP-1',
    sourceSku: 'CC-C10J-FICZ',
    familyKey: 'napkin',
    productType: 'CLOTH_NAPKIN',
  },
  {
    productId: 'rbl-gp-napkin-4',
    sellerSku: 'GP-NAP-4',
    sourceSku: 'CC-00AI-CPTE',
    familyKey: 'napkin',
    productType: 'CLOTH_NAPKIN',
  },
];

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/\u2014/g, '-')
    .trim();
}

function normalizeAmazonGtin(value) {
  const digits = String(value || '').replace(/\D+/g, '');
  if (digits.length === 13) return `0${digits}`;
  return digits;
}

function getRunnerAreaSquareMeters(product) {
  const match = String(product.size || '')
    .replace(/\s+/g, '')
    .match(/^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)cm$/i);

  if (!match) return 0.75;

  const widthCm = Number(match[1]);
  const lengthCm = Number(match[2]);
  const area = (widthCm * lengthCm) / 10000;
  return Number(area.toFixed(2));
}

function getProduct(productId) {
  const product = catalogById.get(productId);
  if (!product) {
    throw new Error(`Missing catalog entry for ${productId}`);
  }
  return product;
}

function getImageUrl(filename) {
  return `https://s3.ap-southeast-2.amazonaws.com/media.ucrd/RBLiving/Green/${String(filename || '').replace(
    /^\/+/,
    '',
  )}`;
}

function buildParentAttributes(family) {
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
        value: family.description,
        language_tag: 'en_AU',
        marketplace_id: marketplaceId,
      },
    ],
    product_description: [
      {
        value: family.description,
        language_tag: 'en_AU',
        marketplace_id: marketplaceId,
      },
    ],
  };
}

function buildChildTitle(plan, product) {
  switch (plan.productId) {
    case 'rbl-gp-table-cloth-150':
      return 'RB Living 100% Cotton Tablecloth (150x225cm), Rectangle Washable Dining Table Cover, Garden Party Botanical Floral Print with Mustard Border, Entertaining Decor';
    case 'rbl-gp-table-cloth-180':
      return 'RB Living 100% Cotton Tablecloth (180x300cm), Large Rectangle Washable Dining Table Cover, Garden Party Botanical Floral Print with Mustard Border, Entertaining Decor';
    case 'rbl-gp-runner':
      return 'RB Living 100% Cotton Table Runner (50x150cm), Washable Garden Party Botanical Floral Print, Decorative Dining Table Centrepiece for Entertaining';
    case 'rbl-gp-mat-1':
      return 'RB Living 100% Cotton Table Placemat (33x48cm), Single Washable Garden Party Botanical Floral Print Mat for Dining, Brunch and Outdoor Entertaining';
    case 'rbl-gp-mat-4':
      return 'RB Living 100% Cotton Table Placemats Set of 4 (33x48cm), Washable Garden Party Botanical Floral Print Mats for Dining, Brunch and Outdoor Entertaining';
    case 'rbl-gp-napkin-1':
      return 'RB Living 100% Cotton Cloth Dinner Napkin (45x45cm), Washable Garden Party Botanical Floral Print, Reusable Table Linen for Entertaining';
    case 'rbl-gp-napkin-4':
      return 'RB Living 100% Cotton Cloth Dinner Napkins Set of 4 (45x45cm), Washable Garden Party Botanical Floral Print, Reusable Table Linen for Entertaining';
    default:
      return `${product.name} by RB Living`;
  }
}

function buildSizeValue(plan, product) {
  switch (plan.productId) {
    case 'rbl-gp-table-cloth-150':
      return '150x225cm';
    case 'rbl-gp-table-cloth-180':
      return '180x300cm';
    case 'rbl-gp-runner':
      return '50x150cm';
    case 'rbl-gp-mat-1':
      return 'Single (1 Placemat)';
    case 'rbl-gp-mat-4':
      return 'Set of 4 Placemats';
    case 'rbl-gp-napkin-1':
      return 'Single (1 Napkin)';
    case 'rbl-gp-napkin-4':
      return 'Set of 4 Napkins';
    default:
      return product.size || '';
  }
}

function buildIncludedComponents(plan) {
  switch (plan.productId) {
    case 'rbl-gp-table-cloth-150':
    case 'rbl-gp-table-cloth-180':
      return '1 x tablecloth';
    case 'rbl-gp-runner':
      return '1 x table runner';
    case 'rbl-gp-mat-1':
      return '1 x placemat';
    case 'rbl-gp-mat-4':
      return '4 x placemats';
    case 'rbl-gp-napkin-1':
      return '1 x napkin';
    case 'rbl-gp-napkin-4':
      return '4 x napkins';
    default:
      return `${getProduct(plan.productId).packSize} x item`;
  }
}

function shouldSendIncludedComponents(plan) {
  return plan.productType === 'TABLECLOTH' || plan.productType === 'TABLE_RUNNER';
}

function buildBulletPoints(plan, product) {
  const common = [
    '100% COTTON FOR ELEVATED ENTERTAINING - Premium breathable cotton with a soft yet structured drape for everyday use and repeat hosting.',
    'GARDEN PARTY BOTANICAL PRINT - Hand-inspired marigold, raspberry and sage florals on an ivory base with signature mustard border detailing.',
    'EASY-CARE REUSABLE TABLE LINEN - Cold hand wash with like colours and style again for brunches, long lunches and seasonal gatherings.',
    'COORDINATE THE FULL COLLECTION - Pair with the matching Garden Party tablecloth, runner, placemats and napkins for a complete RB Living tablescape.',
  ];

  switch (plan.productId) {
    case 'rbl-gp-table-cloth-150':
      return [
        common[0],
        common[1],
        'TAILORED FOR 6-SEAT SETTINGS - 150x225cm size delivers generous coverage and a composed drape for everyday dining and garden hosting.',
        common[2],
        common[3],
      ];
    case 'rbl-gp-table-cloth-180':
      return [
        common[0],
        common[1],
        'MADE FOR LARGER TABLES - 180x300cm size suits extended dining tables and layered entertaining setups with beautiful full-length coverage.',
        common[2],
        common[3],
      ];
    case 'rbl-gp-runner':
      return [
        common[0],
        common[1],
        'TABLE CENTREPIECE STYLING - 50x150cm runner layers beautifully over timber, linen or tablecloths to create visual flow down the table.',
        common[2],
        common[3],
      ];
    case 'rbl-gp-mat-1':
      return [
        common[0],
        common[1],
        'POLISHED PLACE SETTING FOR ONE - 33x48cm placemat frames plates and cutlery neatly while helping protect your dining surface.',
        common[2],
        common[3],
      ];
    case 'rbl-gp-mat-4':
      return [
        common[0],
        common[1],
        'COORDINATED SET OF 4 - Four matching 33x48cm placemats create a complete hosting layout for family meals and guests.',
        common[2],
        common[3],
      ];
    case 'rbl-gp-napkin-1':
      return [
        common[0],
        common[1],
        'GENEROUS 45x45CM NAPKIN - Soft yet structured reusable cotton napkin that folds beautifully beside the plate or layered over the setting.',
        common[2],
        common[3],
      ];
    case 'rbl-gp-napkin-4':
      return [
        common[0],
        common[1],
        'SET OF 4 FOR COMPLETE PLACE SETTINGS - Four matching 45x45cm reusable napkins elevate brunches, dinners and seasonal entertaining.',
        common[2],
        common[3],
      ];
    default:
      return [normalizeText(product.description)];
  }
}

function summarizeListing(item) {
  const attributes = item?.attributes || {};
  const fulfillment = Array.isArray(attributes.fulfillment_availability)
    ? attributes.fulfillment_availability[0]
    : null;

  return {
    productType: item?.summaries?.[0]?.productType || null,
    status: item?.summaries?.[0]?.status || [],
    parentage: attributes.parentage_level?.[0]?.value || null,
    parentSku: attributes.child_parent_sku_relationship?.[0]?.parent_sku || null,
    variationTheme: attributes.variation_theme?.[0]?.name || null,
    itemName: attributes.item_name?.[0]?.value || null,
    quantity: fulfillment?.quantity ?? null,
    issueCount: Array.isArray(item?.issues) ? item.issues.length : 0,
    issueCodes: Array.isArray(item?.issues) ? item.issues.map((issue) => issue.code) : [],
  };
}

async function callToolJson(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  return parseJsonText(toText(result));
}

async function getListing(client, sku, includedData = ['attributes', 'summaries', 'issues']) {
  return callToolJson(client, 'getListingsItem', {
    sellerId,
    sku,
    includedData,
  });
}

function buildChildAttributes(plan, templateAttributes, sourceAttributes) {
  const product = getProduct(plan.productId);
  const family = PARENT_FAMILIES[plan.familyKey];
  const gtin = normalizeAmazonGtin(GTIN_BY_PRODUCT_ID[plan.productId]);
  const quantity = sourceAttributes?.fulfillment_availability?.[0]?.quantity;
  const attributes = clone(templateAttributes || sourceAttributes || {});

  for (const key of [
    'merchant_suggested_asin',
    'other_product_image_locator_1',
    'other_product_image_locator_2',
    'other_product_image_locator_3',
    'other_product_image_locator_4',
    'other_product_image_locator_5',
  ]) {
    delete attributes[key];
  }

  attributes.item_name = [
    {
      value: buildChildTitle(plan, product),
      language_tag: 'en_AU',
      marketplace_id: marketplaceId,
    },
  ];
  attributes.brand = [{ value: 'RB Living', language_tag: 'en_AU', marketplace_id: marketplaceId }];
  attributes.manufacturer = [{ value: 'RB Living', language_tag: 'en_AU', marketplace_id: marketplaceId }];
  attributes.externally_assigned_product_identifier = [
    {
      value: gtin,
      type: 'gtin',
      marketplace_id: marketplaceId,
    },
  ];
  attributes.bullet_point = buildBulletPoints(plan, product).map((value) => ({
    value,
    language_tag: 'en_AU',
    marketplace_id: marketplaceId,
  }));
  attributes.product_description = [
    {
      value: normalizeText(product.description),
      language_tag: 'en_AU',
      marketplace_id: marketplaceId,
    },
  ];
  attributes.color = [
    {
      value: 'Ivory, marigold, raspberry and sage',
      language_tag: 'en_AU',
      marketplace_id: marketplaceId,
    },
  ];
  attributes.material = [{ value: 'Cotton', language_tag: 'en_AU', marketplace_id: marketplaceId }];
  attributes.number_of_items = [{ value: product.packSize, marketplace_id: marketplaceId }];
  attributes.part_number = [{ value: gtin, marketplace_id: marketplaceId }];
  attributes.model_number = [{ value: gtin, marketplace_id: marketplaceId }];
  attributes.main_product_image_locator = [
    {
      marketplace_id: marketplaceId,
      media_location: getImageUrl(product.image),
    },
  ];
  attributes.parentage_level = [{ value: 'child', marketplace_id: marketplaceId }];
  attributes.child_parent_sku_relationship = [
    {
      child_relationship_type: 'variation',
      parent_sku: family.parentSku,
      marketplace_id: marketplaceId,
    },
  ];
  attributes.variation_theme = [{ name: family.variationTheme, marketplace_id: marketplaceId }];
  attributes.size = [
    {
      value: buildSizeValue(plan, product),
      language_tag: 'en_AU',
      marketplace_id: marketplaceId,
    },
  ];
  if (shouldSendIncludedComponents(plan)) {
    attributes.included_components = [
      {
        value: buildIncludedComponents(plan),
        language_tag: 'en_AU',
        marketplace_id: marketplaceId,
      },
    ];
  } else {
    delete attributes.included_components;
  }
  attributes.list_price = [
    {
      value_with_tax: Number(product.price.toFixed(2)),
      currency: 'AUD',
      marketplace_id: marketplaceId,
    },
  ];
  attributes.purchasable_offer = [
    {
      marketplace_id: marketplaceId,
      currency: 'AUD',
      our_price: [
        {
          schedule: [
            {
              value_with_tax: Number(product.price.toFixed(2)),
            },
          ],
        },
      ],
    },
  ];

  if (plan.productType === 'TABLE_RUNNER') {
    delete attributes.item_dimensions;
    attributes.unit_count = [
      {
        value: getRunnerAreaSquareMeters(product),
        type: {
          value: 'square meter',
          language_tag: 'en_AU',
        },
        marketplace_id: marketplaceId,
      },
    ];
  } else if (Array.isArray(sourceAttributes?.unit_count) && sourceAttributes.unit_count.length > 0) {
    attributes.unit_count = [
      {
        value: product.packSize,
        type: {
          value: 'count',
          marketplace_id: marketplaceId,
          language_tag: 'en_AU',
        },
        marketplace_id: marketplaceId,
      },
    ];
  }

  if (Number.isFinite(quantity)) {
    attributes.fulfillment_availability = [
      {
        fulfillment_channel_code: 'DEFAULT',
        quantity,
        marketplace_id: marketplaceId,
      },
    ];
  }

  return attributes;
}

function buildOfferActivationPatches(plan, product, templateAttributes, sourceAttributes) {
  const sourceOrTemplate = templateAttributes || sourceAttributes || {};
  const quantity = sourceAttributes?.fulfillment_availability?.[0]?.quantity;
  const productImage = getImageUrl(product.image);
  const patches = [
    {
      op: 'replace',
      path: '/attributes/merchant_shipping_group',
      value: [{ value: 'legacy-template-id', marketplace_id: marketplaceId }],
    },
    {
      op: 'replace',
      path: '/attributes/fulfillment_availability',
      value: [
        {
          ...(clone(sourceAttributes?.fulfillment_availability?.[0] || {})),
          fulfillment_channel_code: 'DEFAULT',
          quantity: Number.isFinite(quantity) ? quantity : product.packSize,
          marketplace_id: marketplaceId,
        },
      ],
    },
    {
      op: 'replace',
      path: '/attributes/purchasable_offer',
      value: [
        {
          marketplace_id: marketplaceId,
          currency: 'AUD',
          audience: 'ALL',
          our_price: [
            {
              schedule: [
                {
                  value_with_tax: Number(product.price.toFixed(2)),
                },
              ],
            },
          ],
        },
      ],
    },
    {
      op: 'replace',
      path: '/attributes/list_price',
      value: [
        {
          value_with_tax: Number(product.price.toFixed(2)),
          currency: 'AUD',
          marketplace_id: marketplaceId,
        },
      ],
    },
    {
      op: 'replace',
      path: '/attributes/main_product_image_locator',
      value: [
        {
          marketplace_id: marketplaceId,
          media_location: productImage,
        },
      ],
    },
  ];

  const packageWeight =
    sourceOrTemplate.item_package_weight ||
    sourceOrTemplate.package_weight ||
    [
      {
        value: 0.5,
        unit: 'kilograms',
        marketplace_id: marketplaceId,
      },
    ];
  const packageDimensions =
    sourceOrTemplate.item_package_dimensions ||
    [
      {
        length: { unit: 'centimeters', value: 28 },
        width: { unit: 'centimeters', value: 20 },
        height: { unit: 'centimeters', value: 4 },
        marketplace_id: marketplaceId,
      },
    ];
  const ageRestriction =
    sourceOrTemplate.is_this_product_subject_to_buyer_age_restrictions ||
    [{ value: false, marketplace_id: marketplaceId }];

  patches.push({
    op: 'add',
    path: '/attributes/item_package_weight',
    value: clone(packageWeight),
  });
  patches.push({
    op: 'add',
    path: '/attributes/item_package_dimensions',
    value: clone(packageDimensions),
  });
  patches.push({
    op: 'add',
    path: '/attributes/is_this_product_subject_to_buyer_age_restrictions',
    value: clone(ageRestriction),
  });

  return patches;
}

async function main() {
  await fs.mkdir(reportDir, { recursive: true });

  const report = {
    startedAt: nowIso(),
    sellerId,
    marketplaceId,
    parents: [],
    children: [],
    sourceStockMirrors: [],
    verification: [],
    notes: [
      'Parent listings are structural only. Child listings carry the commercial SEO copy.',
      'Garden Party stock is mirrored from the matching Crimson Courtyard child SKU by product type.',
    ],
  };

  const amazon = await connectMcpClient({
    repoRoot,
    service: 'amazon',
    clientName: 'garden-party-amazon-launch',
  });

  try {
    const templateData = JSON.parse(
      await fs.readFile(path.join(repoRoot, 'docs', 'amazon-listings-data.json'), 'utf8'),
    );
    const templateBySourceSku = new Map(
      (templateData?.listings || [])
        .filter((entry) => entry?.amazon_sku && entry?.attributes)
        .map((entry) => [entry.amazon_sku, entry.attributes]),
    );

    const sourceListingsBySku = new Map();
    for (const plan of CHILD_LAUNCH_PLAN) {
      if (sourceListingsBySku.has(plan.sourceSku)) continue;
      const sourceListing = await getListing(amazon, plan.sourceSku);
      sourceListingsBySku.set(plan.sourceSku, sourceListing);
      await sleep(250);
    }

    for (const family of Object.values(PARENT_FAMILIES)) {
      const parentResult = await callToolJson(amazon, 'putListingsItem', {
        sellerId,
        sku: family.parentSku,
        productType: family.productType,
        requirements: 'LISTING',
        attributes: buildParentAttributes(family),
      });

      report.parents.push({
        parentSku: family.parentSku,
        productType: family.productType,
        result: parentResult,
      });
      await sleep(1200);
    }

    for (const plan of CHILD_LAUNCH_PLAN) {
      const sourceListing = sourceListingsBySku.get(plan.sourceSku);
      const sourceAttributes = sourceListing?.attributes || {};
      const templateAttributes = templateBySourceSku.get(plan.sourceSku) || sourceAttributes;
      const sourceQuantity = sourceAttributes?.fulfillment_availability?.[0]?.quantity ?? null;
      const childAttributes = buildChildAttributes(plan, templateAttributes, sourceAttributes);
      const product = getProduct(plan.productId);

      report.sourceStockMirrors.push({
        targetSku: plan.sellerSku,
        sourceSku: plan.sourceSku,
        mirroredQuantity: sourceQuantity,
      });

      const childResult = await callToolJson(amazon, 'putListingsItem', {
        sellerId,
        sku: plan.sellerSku,
        productType: plan.productType,
        requirements: 'LISTING',
        attributes: childAttributes,
      });

      report.children.push({
        productId: plan.productId,
        sellerSku: plan.sellerSku,
        sourceSku: plan.sourceSku,
        parentSku: PARENT_FAMILIES[plan.familyKey].parentSku,
        title: buildChildTitle(plan, product),
        mirroredQuantity: sourceQuantity,
        result: childResult,
      });
      await sleep(900);

      const relationPatchResult = await callToolJson(amazon, 'patchListingsItem', {
        sellerId,
        sku: plan.sellerSku,
        productType: plan.productType,
        patches: [
          {
            op: 'replace',
            path: '/attributes/parentage_level',
            value: [{ value: 'child', marketplace_id: marketplaceId }],
          },
          {
            op: 'replace',
            path: '/attributes/child_parent_sku_relationship',
            value: [
              {
                child_relationship_type: 'variation',
                parent_sku: PARENT_FAMILIES[plan.familyKey].parentSku,
                marketplace_id: marketplaceId,
              },
            ],
          },
          {
            op: 'replace',
            path: '/attributes/variation_theme',
            value: [{ name: PARENT_FAMILIES[plan.familyKey].variationTheme, marketplace_id: marketplaceId }],
          },
        ],
      });

      report.children[report.children.length - 1].relationPatchResult = relationPatchResult;
      await sleep(900);

      const offerPatchResult = await callToolJson(amazon, 'patchListingsItem', {
        sellerId,
        sku: plan.sellerSku,
        productType: plan.productType,
        patches: buildOfferActivationPatches(plan, product, templateAttributes, sourceAttributes),
      });

      report.children[report.children.length - 1].offerPatchResult = offerPatchResult;
      await sleep(1800);
    }

    const verifySkus = [
      ...Object.values(PARENT_FAMILIES).map((family) => family.parentSku),
      ...CHILD_LAUNCH_PLAN.map((plan) => plan.sellerSku),
    ];

    for (const sku of verifySkus) {
      const item = await getListing(amazon, sku);
      report.verification.push({
        sku,
        ...summarizeListing(item),
      });
      await sleep(350);
    }
  } finally {
    await amazon.close();
  }

  const childVerification = report.verification.filter((item) => item.sku.startsWith('GP-'));
  const parentVerification = report.verification.filter((item) => item.sku.includes('-PARENT'));

  report.summary = {
    parentsExpected: Object.keys(PARENT_FAMILIES).length,
    parentsVerified: parentVerification.length,
    childrenExpected: CHILD_LAUNCH_PLAN.length,
    childrenVerified: childVerification.length,
    childBuyableCount: childVerification.filter((item) => item.status.includes('BUYABLE')).length,
    childDiscoverableCount: childVerification.filter((item) => item.status.includes('DISCOVERABLE')).length,
    parentIssueCount: parentVerification.reduce((sum, item) => sum + (item.issueCount || 0), 0),
    childIssueCount: childVerification.reduce((sum, item) => sum + (item.issueCount || 0), 0),
    allChildrenLinkedToCanonicalParents: childVerification.every((item) =>
      CHILD_LAUNCH_PLAN.some(
        (plan) =>
          plan.sellerSku === item.sku &&
          item.parentSku === PARENT_FAMILIES[plan.familyKey].parentSku &&
          item.parentage === 'child' &&
          item.variationTheme === PARENT_FAMILIES[plan.familyKey].variationTheme,
      ),
    ),
  };

  report.completedAt = nowIso();

  const stamp = report.completedAt.replace(/[:.]/g, '-');
  const reportPath = path.join(reportDir, `amazon-garden-party-launch-report-${stamp}.json`);
  const latestPath = path.join(reportDir, 'amazon-garden-party-launch-report-latest.json');

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
      2,
    )}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`mcp-garden-party-amazon-launch failed: ${error.message}\n`);
  process.exitCode = 1;
});
