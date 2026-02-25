import axios from 'axios';
import { getAccessToken, generateAWSSignature } from './src/utils/auth.js';

const HOST = 'sellingpartnerapi-fe.amazon.com';
const MKT = process.env.SP_API_MARKETPLACE_ID;
const SELLER = process.env.SP_API_SELLER_ID;

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function putParent(token, sku, productType, title, theme, bullets) {
    const path = `/listings/2021-08-01/items/${SELLER}/${sku}`;
    const qs = { marketplaceIds: MKT };
    const payload = {
        productType,
        requirements: 'LISTING',
        attributes: {
            item_name: [{ value: title, language_tag: 'en_AU', marketplace_id: MKT }],
            brand: [{ value: 'RB Living', language_tag: 'en_AU', marketplace_id: MKT }],
            condition_type: [{ value: 'new_new', marketplace_id: MKT }],
            parentage_level: [{ value: 'parent', marketplace_id: MKT }],
            variation_theme: [{ name: theme, marketplace_id: MKT }],
            supplier_declared_dg_hz_regulation: [{ value: 'not_applicable', marketplace_id: MKT }],
            batteries_required: [{ value: false, marketplace_id: MKT }],
            country_of_origin: [{ value: 'IN', marketplace_id: MKT }],
            recommended_browse_nodes: [{ value: '5014389051', marketplace_id: MKT }],
            product_description: [{ value: title, language_tag: 'en_AU', marketplace_id: MKT }],
            bullet_point: bullets.map(b => ({ value: b, language_tag: 'en_AU', marketplace_id: MKT })),
        },
    };
    const body = JSON.stringify(payload);
    const h = generateAWSSignature(token, 'PUT', path, body, qs);
    const r = await axios({
        method: 'PUT',
        url: `https://${HOST}${path}?${new URLSearchParams(qs)}`,
        data: payload,
        headers: { host: HOST, 'x-amz-access-token': token, 'content-type': 'application/json', ...h },
    });
    return r.data;
}

async function main() {
    const token = await getAccessToken();

    const families = [
        {
            sku: 'RBL-CRIMSON-NAPKIN',
            productType: 'CLOTH_NAPKIN',
            theme: 'SIZE_NAME',
            title: 'RB Living 100% Cotton Dinner Napkins — Crimson Botanical Floral Print, Washable Reusable Farmhouse Dining',
            bullets: [
                'PREMIUM 100% COTTON — Naturally soft, absorbent, and durable. Gets better with every wash.',
                'HERITAGE CRIMSON BOTANICAL DESIGN — Intricate crimson floral print for timeless elegance.',
                'ECO-FRIENDLY & REUSABLE — Replace paper napkins with sustainable, premium textiles.',
                'PERFECTLY SIZED — Generous 45x45cm dimensions for full lap coverage at any dining occasion.',
                'COMPLETE THE COLLECTION — Match with RB Living tablecloths, runners, and placemats.',
            ],
        },
        {
            sku: 'RBL-CRIMSON-MAT',
            productType: 'PLACEMAT',
            theme: 'SIZE_NAME',
            title: 'RB Living 100% Cotton Table Placemat — Crimson Botanical Floral Print, Washable Farmhouse Dining Decor',
            bullets: [
                'PREMIUM 100% COTTON — Naturally soft and durable, protecting your table while looking beautiful.',
                'HERITAGE CRIMSON BOTANICAL DESIGN — Intricate floral crimson print framed by a finely striped border.',
                'ECO-FRIENDLY & REUSABLE — Sustainable alternative to disposable mats. Cold hand wash.',
                'PERFECTLY SIZED — 33x48cm provides excellent plate coverage for all standard dining settings.',
                'COMPLETE THE COLLECTION — Match with RB Living tablecloths, runners, and napkins.',
            ],
        },
    ];

    for (const f of families) {
        console.log('Creating parent:', f.sku);
        const r = await putParent(token, f.sku, f.productType, f.title, f.theme, f.bullets);
        const errors = r.issues?.filter(i => i.severity === 'ERROR').map(i => i.attributeNames?.join(',')) || [];
        const warnings = r.issues?.filter(i => i.severity === 'WARNING').length || 0;
        console.log('  errors:', errors.join(' | ') || 'NONE ✓', '  warnings:', warnings);
        await sleep(1500);
    }

    console.log('\nDone. Please verify in Seller Central in a few minutes.');
}

main();
