import axios from 'axios';
import { getAccessToken, generateAWSSignature } from './src/utils/auth.js';

const HOST = 'sellingpartnerapi-fe.amazon.com';
const BASE = 'https://' + HOST;
const API_VER = '/listings/2021-08-01/items';

// ── Family definitions ───────────────────────────────────────────
const FAMILIES = [
    {
        parent: {
            sku: 'RBL-CRIMSON-TC',
            productType: 'TABLECLOTH',
            title: 'RB Living 100% Cotton Tablecloth — Crimson Botanical Floral Print, Washable Farmhouse Dining Table Cover (Multiple Sizes)',
        },
        variationTheme: 'SIZE_NAME',
        children: [
            { sku: 'CC-SQAN-QKBS', sizeName: '150x225cm' },
            { sku: 'CC-T0KS-NAW0', sizeName: '180x300cm' },
        ],
    },
    {
        parent: {
            sku: 'RBL-CRIMSON-NAPKIN',
            productType: 'CLOTH_NAPKIN',
            title: 'RB Living 100% Cotton Dinner Napkins — Crimson Botanical Floral Print, Washable Farmhouse Dining (Single or Set of 4)',
        },
        variationTheme: 'UNIT_COUNT',
        children: [
            { sku: 'CC-C10J-FICZ', sizeName: 'Single (1 Napkin)' },
            { sku: 'CC-00AI-CPTE', sizeName: 'Set of 4 Napkins' },
        ],
    },
    {
        parent: {
            sku: 'RBL-CRIMSON-MAT',
            productType: 'PLACEMAT',
            title: 'RB Living 100% Cotton Table Placemat — Crimson Botanical Floral Print, Washable Farmhouse Dining (Single or Set of 4)',
        },
        variationTheme: 'UNIT_COUNT',
        children: [
            { sku: 'CC-7KR2-FDD2', sizeName: 'Single Placemat' },
            { sku: 'CC-DJNZ-Y3BB', sizeName: 'Set of 4 Placemats' },
        ],
    },
    {
        parent: {
            sku: 'RBL-CRIMSON-RUNNER',
            productType: 'TABLE_RUNNER',
            title: 'RB Living 100% Cotton Table Runner — Crimson Botanical Floral Print, Washable Farmhouse Dining Table Decor',
        },
        variationTheme: 'SIZE_NAME',
        children: [
            { sku: 'CC-QYNQ-3RS0', sizeName: '50x150cm' },
        ],
    },
];

async function put(token, sku, payload) {
    const path = `${API_VER}/${process.env.SP_API_SELLER_ID}/${sku}`;
    const qs = { marketplaceIds: process.env.SP_API_MARKETPLACE_ID };
    const body = JSON.stringify(payload);
    const headers = generateAWSSignature(token, 'PUT', path, body, qs);
    return axios({
        method: 'PUT',
        url: BASE + path + '?' + new URLSearchParams(qs),
        data: payload,
        headers: { host: HOST, 'x-amz-access-token': token, 'content-type': 'application/json', ...headers },
    });
}

async function patch(token, sku, patches) {
    const path = `${API_VER}/${process.env.SP_API_SELLER_ID}/${sku}`;
    const qs = { marketplaceIds: process.env.SP_API_MARKETPLACE_ID };
    const payload = { productType: patches.productType, patches: patches.ops };
    const body = JSON.stringify(payload);
    const headers = generateAWSSignature(token, 'PATCH', path, body, qs);
    return axios({
        method: 'PATCH',
        url: BASE + path + '?' + new URLSearchParams(qs),
        data: payload,
        headers: { host: HOST, 'x-amz-access-token': token, 'content-type': 'application/json', ...headers },
    });
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
    const token = await getAccessToken();
    const mkt = process.env.SP_API_MARKETPLACE_ID;

    for (const family of FAMILIES) {
        const { parent, variationTheme, children } = family;

        // ── 1. Create/update Parent listing ────────────────────────
        console.log(`\n=== Creating PARENT: ${parent.sku} ===`);
        try {
            const res = await put(token, parent.sku, {
                productType: parent.productType,
                requirements: 'LISTING',
                attributes: {
                    item_name: [{ value: parent.title, language_tag: 'en_AU', marketplace_id: mkt }],
                    brand: [{ value: 'RB Living', language_tag: 'en_AU', marketplace_id: mkt }],
                    condition_type: [{ value: 'new_new', marketplace_id: mkt }],
                    parentage_level: [{ value: 'parent', marketplace_id: mkt }],
                    variation_theme: [{ name: variationTheme, marketplace_id: mkt }],
                    merchant_shipping_group: [{ value: 'Migrated Template', marketplace_id: mkt }],
                },
            });
            console.log(`  ✓ Parent created — HTTP ${res.status}`);
        } catch (e) {
            console.error(`  ✗ Parent failed:`, JSON.stringify(e.response?.data, null, 2));
        }
        await sleep(1500);

        // ── 2. Patch each child ────────────────────────────────────
        for (const child of children) {
            console.log(`  Patching CHILD: ${child.sku} (${child.sizeName}) → parent ${parent.sku}`);
            try {
                const res = await patch(token, child.sku, {
                    productType: parent.productType,
                    ops: [
                        {
                            op: 'replace',
                            path: '/attributes/parentage_level',
                            value: [{ value: 'child', marketplace_id: mkt }],
                        },
                        {
                            op: 'replace',
                            path: '/attributes/child_parent_sku_relationship',
                            value: [{ child_relationship_type: 'variation', parent_sku: parent.sku, marketplace_id: mkt }],
                        },
                        {
                            op: 'replace',
                            path: '/attributes/variation_theme',
                            value: [{ name: variationTheme, marketplace_id: mkt }],
                        },
                    ],
                });
                console.log(`    ✓ Child patched — HTTP ${res.status}`);
            } catch (e) {
                console.error(`    ✗ Child failed:`, JSON.stringify(e.response?.data, null, 2));
            }
            await sleep(1200);
        }
    }

    console.log('\nAll variation families processed.');
}

main();
