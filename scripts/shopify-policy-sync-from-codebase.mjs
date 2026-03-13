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
const reportPath = path.join(reportDir, `shopify-policy-sync-from-codebase-${stamp}.json`);
const latestPath = path.join(reportDir, 'shopify-policy-sync-from-codebase-latest.json');

const WRITE_CONFIRM_TOKEN = process.env.SHOPIFY_MCP_WRITE_CONFIRM || 'RBL_WRITE_CONFIRM';

const POLICY_BODIES = {
  SHIPPING_POLICY: `
<p>Last updated: December 2025</p>
<p>Our shipping terms include:</p>
<ul>
  <li>Delivery timeframes are estimates and not guaranteed.</li>
  <li>Shipping costs are calculated at checkout.</li>
  <li>Shipping charges are carrier-calculated from destination and parcel details.</li>
  <li>Service options include AusPost Standard, AusPost Express, and Aramex Courier where coverage exists.</li>
  <li>Risk of loss transfers to you upon delivery.</li>
  <li>We are not responsible for delays caused by courier services.</li>
  <li>International shipping may incur customs duties (buyer's responsibility).</li>
  <li>Incorrect shipping addresses provided by customers are not our responsibility.</li>
  <li>Signature may be required for delivery.</li>
</ul>
`.trim(),
  REFUND_POLICY: `
<p>Last updated: December 2025</p>
<p>We want you to love your RB Living order. If something is not right, our return policy is:</p>
<h3>Table napery return window and condition</h3>
<ul>
  <li>Table napery products (table cloths, runners, placemats, and napkins) may be returned within 30 days of delivery.</li>
  <li>Table napery items must be unused, unwashed, in original packaging, and in resaleable condition.</li>
  <li>Proof of purchase is required for all returns.</li>
</ul>
<h3>Drink Fountain change-of-mind policy</h3>
<ul>
  <li>Change-of-mind returns are not accepted for RB Living Drink Fountain units.</li>
  <li>Used Drink Fountain units are not returnable. This includes products that have been filled, run, or used to dispense liquids.</li>
</ul>
<h3>Drink Fountain damaged-on-arrival or fault claims</h3>
<ul>
  <li>If your Drink Fountain arrives damaged or faulty, contact support@rbliving.com.au within 48 hours of delivery.</li>
  <li>Include your order number plus clear photo/video evidence of the issue, the product, and the outer packaging.</li>
  <li>Keep the original packaging and all components for assessment and return processing.</li>
</ul>
<h3>Return shipping and processing</h3>
<ul>
  <li>Return shipping costs are the responsibility of the customer unless the product is faulty.</li>
  <li>For approved returns sent by post, keep proof of postage as items remain your responsibility in transit.</li>
  <li>Refunds will be processed within 14 business days of receiving returned goods.</li>
  <li>Refunds are issued to the original payment method.</li>
</ul>
<h3>Australian Consumer Law</h3>
<p>Our goods come with guarantees that cannot be excluded under the Australian Consumer Law.</p>
`.trim(),
  TERMS_OF_SERVICE: `
<p>Last updated: December 2025</p>
<p>By accessing and using the RB Living website and purchasing our products, you agree to be bound by these Terms of Service.</p>
<p>When you place an order:</p>
<ul>
  <li>Your order constitutes an offer to purchase products.</li>
  <li>Order confirmation email does not constitute acceptance.</li>
  <li>Acceptance occurs when products are dispatched.</li>
  <li>Orders are subject to product availability.</li>
</ul>
<p>All payments are processed securely through our payment providers, and full payment is required at the time of order.</p>
<p>These Terms of Service are governed by Australian law.</p>
<p>Our goods come with guarantees that cannot be excluded under the Australian Consumer Law. You are entitled to a replacement or refund for a major failure and compensation for any other reasonably foreseeable loss or damage.</p>
`.trim(),
  CONTACT_INFORMATION: `
<p>Last updated: December 2025</p>
<p>Contact RB Living for order, shipping, returns, and product support:</p>
<ul>
  <li>Email: support@rbliving.com.au</li>
  <li>Privacy contact: privacy@rbliving.com.au</li>
  <li>Phone: +61450707890</li>
  <li>Address: 34 Progress Road, Eltham North, VIC 3095, Australia</li>
</ul>
<p>Business entity reference: RB Living Pty Ltd, Australia.</p>
`.trim(),
};

const SOURCE_OF_TRUTH = {
  SHIPPING_POLICY: [
    'client-next/components/TermsOfServiceClient.tsx',
    'server/data/ribu-widget-kb.json',
    'server/index.js',
  ],
  REFUND_POLICY: [
    'client-next/components/TermsOfServiceClient.tsx',
    'server/data/ribu-widget-kb.json',
  ],
  TERMS_OF_SERVICE: [
    'client-next/components/TermsOfServiceClient.tsx',
  ],
  CONTACT_INFORMATION: [
    'client-next/app/contact/page.tsx',
    'client-next/components/PrivacyPolicyClient.tsx',
  ],
};

async function connectShopifyMcp() {
  return connectMcpClient({
    repoRoot,
    service: 'shopify',
    clientName: 'shopify-policy-sync-from-codebase',
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

function hasMutationErrors(result) {
  const errs = result?.json?.data?.data?.shopPolicyUpdate?.userErrors;
  return Array.isArray(errs) && errs.length > 0;
}

async function main() {
  await fs.mkdir(reportDir, { recursive: true });

  const report = {
    startedAt,
    sourceOfTruth: SOURCE_OF_TRUTH,
    actions: [],
    summary: {},
  };

  const mutation = `mutation UpsertShopPolicy($shopPolicy: ShopPolicyInput!) {
  shopPolicyUpdate(shopPolicy: $shopPolicy) {
    shopPolicy {
      id
      type
      title
      url
      updatedAt
    }
    userErrors {
      field
      message
    }
  }
}`;

  const policyTypes = [
    'SHIPPING_POLICY',
    'REFUND_POLICY',
    'TERMS_OF_SERVICE',
    'CONTACT_INFORMATION',
  ];

  const shopify = await connectShopifyMcp();
  try {
    const mcpConfig = await callTool(shopify, 'get_mcp_config', {});
    report.actions.push({ step: 'get_mcp_config', result: mcpConfig });

    const writeEnabled = mcpConfig?.json?.ok === true && mcpConfig?.json?.mode?.writeEnabled === true;
    if (!writeEnabled) {
      throw new Error('Shopify MCP write mode is not enabled.');
    }

    for (const type of policyTypes) {
      const body = POLICY_BODIES[type];
      const upsert = await callTool(shopify, 'admin_graphql', {
        query: mutation,
        variables: {
          shopPolicy: {
            type,
            body,
          },
        },
        confirm: WRITE_CONFIRM_TOKEN,
      });
      report.actions.push({
        step: 'shop_policy_update',
        policyType: type,
        sourceFiles: SOURCE_OF_TRUTH[type] || [],
        bodyLength: body.length,
        result: upsert,
      });
      if (!upsert.ok) {
        throw new Error(`shopPolicyUpdate failed for ${type}: ${upsert.error || 'unknown error'}`);
      }
      if (hasMutationErrors(upsert)) {
        throw new Error(`shopPolicyUpdate returned userErrors for ${type}`);
      }
    }

    const policiesRead = await callTool(shopify, 'admin_rest', {
      endpoint: 'policies.json',
      method: 'GET',
    });
    report.actions.push({ step: 'read_policies_rest', result: policiesRead });

    const shopRead = await callTool(shopify, 'admin_rest', {
      endpoint: 'shop.json',
      method: 'GET',
    });
    report.actions.push({ step: 'read_shop_rest', result: shopRead });

    const policies = Array.isArray(policiesRead?.json?.data?.policies) ? policiesRead.json.data.policies : [];
    const byType = Object.fromEntries(
      policies.map((policy) => [
        String(policy?.title || '').toLowerCase(),
        {
          handle: policy?.handle || null,
          bodyPresent: Boolean(String(policy?.body || '').trim()),
          updatedAt: policy?.updated_at || null,
          url: policy?.url || null,
        },
      ])
    );

    report.summary = {
      policyTypesAttempted: policyTypes,
      policyCountAfterWrite: policies.length,
      policiesByTitle: byType,
      shopContactSnapshot: {
        email: shopRead?.json?.data?.shop?.email || null,
        customer_email: shopRead?.json?.data?.shop?.customer_email || null,
        phone: shopRead?.json?.data?.shop?.phone || null,
        address1: shopRead?.json?.data?.shop?.address1 || null,
        city: shopRead?.json?.data?.shop?.city || null,
        province: shopRead?.json?.data?.shop?.province || null,
        zip: shopRead?.json?.data?.shop?.zip || null,
        country_name: shopRead?.json?.data?.shop?.country_name || null,
      },
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
  process.stderr.write(`shopify-policy-sync-from-codebase failed: ${error.message}\n`);
  process.exitCode = 1;
});
