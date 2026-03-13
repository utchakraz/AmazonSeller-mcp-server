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
const reportPath = path.join(reportDir, `shopify-auto-remediate-${stamp}.json`);
const latestPath = path.join(reportDir, 'shopify-auto-remediate-latest.json');

const WRITE_CONFIRM_TOKEN = process.env.SHOPIFY_MCP_WRITE_CONFIRM || 'RBL_WRITE_CONFIRM';
const SOCIAL_URLS = {
  social_facebook_link: 'https://www.facebook.com/RBLiving',
  social_instagram_link: 'https://www.instagram.com/rbliving.com.au',
  social_tiktok_link: 'https://www.tiktok.com/@rb_living',
  social_youtube_link: 'https://www.youtube.com/@RBLiving-au',
  social_twitter_link: 'https://x.com/rbliving',
  social_x_link: 'https://x.com/rbliving',
  social_pinterest_link: 'https://www.pinterest.com/rbliving',
};

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function connectShopifyMcp() {
  return connectMcpClient({
    repoRoot,
    service: 'shopify',
    clientName: 'shopify-auto-remediate',
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

function collectSchemaSocialKeys(schemaJson) {
  const out = new Set();
  const walk = (node) => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const id = typeof node.id === 'string' ? node.id : '';
    if (/^social_/i.test(id)) out.add(id);
    for (const value of Object.values(node)) walk(value);
  };
  walk(schemaJson);
  return Array.from(out).sort();
}

function applySocialLinksToSettingsData(settingsData, desiredMap, schemaKeys = []) {
  const next = deepClone(settingsData || {});
  if (!next.current || typeof next.current !== 'object') next.current = {};
  const current = next.current;
  const changed = [];
  const availableKeys = new Set([
    ...Object.keys(desiredMap),
    ...schemaKeys.filter((key) => /^social_/i.test(key)),
    ...Object.keys(current).filter((key) => /^social_/i.test(key)),
  ]);

  for (const key of availableKeys) {
    const desired = desiredMap[key];
    if (!desired) continue;
    const before = typeof current[key] === 'string' ? current[key] : '';
    if (before === desired) continue;
    current[key] = desired;
    changed.push({ key, before, after: desired });
  }
  return { next, changed };
}

function patchFooterSocialSettings(jsonValue) {
  const targetKeys = [
    'show_social_icons',
    'show_social',
    'enable_social_icons',
    'enable_social',
  ];
  const footerSocialMap = {
    facebook_url: SOCIAL_URLS.social_facebook_link,
    instagram_url: SOCIAL_URLS.social_instagram_link,
    youtube_url: SOCIAL_URLS.social_youtube_link,
    tiktok_url: SOCIAL_URLS.social_tiktok_link,
    twitter_url: SOCIAL_URLS.social_x_link,
    pinterest_url: SOCIAL_URLS.social_pinterest_link,
  };
  const next = deepClone(jsonValue || {});
  const changed = [];

  const walk = (node, pathParts = []) => {
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      const lower = key.toLowerCase();
      const path = [...pathParts, key].join('.');
      if (targetKeys.includes(lower) && typeof value === 'boolean' && value === false) {
        node[key] = true;
        changed.push({ path, before: false, after: true });
      }
      if (Object.hasOwn(footerSocialMap, lower) && typeof value === 'string') {
        const desired = footerSocialMap[lower];
        if (desired && value !== desired) {
          node[key] = desired;
          changed.push({ path, before: value, after: desired });
        }
      }
      if (value && typeof value === 'object') walk(value, [...pathParts, key]);
    }
  };
  walk(next);
  return { next, changed };
}

async function main() {
  const report = {
    startedAt,
    actions: [],
    summary: {},
  };
  await fs.mkdir(reportDir, { recursive: true });

  const shopify = await connectShopifyMcp();
  try {
    const mcpConfig = await callTool(shopify, 'get_mcp_config', {});
    report.actions.push({ step: 'get_mcp_config', result: mcpConfig });
    const writeEnabled = mcpConfig?.json?.ok === true && mcpConfig?.json?.mode?.writeEnabled === true;
    if (!writeEnabled) {
      throw new Error('Shopify MCP write mode is not enabled; cannot apply automatic remediation.');
    }

    const themes = await callTool(shopify, 'admin_rest', {
      endpoint: 'themes.json',
      method: 'GET',
    });
    report.actions.push({ step: 'list_themes', result: themes });
    const themeList = Array.isArray(themes?.json?.data?.themes) ? themes.json.data.themes : [];
    const activeTheme = themeList.find((theme) => String(theme?.role || '').toLowerCase() === 'main');
    if (!activeTheme?.id) throw new Error('Could not resolve active main theme.');

    const assets = await callTool(shopify, 'admin_rest', {
      endpoint: `themes/${activeTheme.id}/assets.json`,
      method: 'GET',
    });
    report.actions.push({ step: 'list_assets', result: assets });
    const assetKeys = Array.isArray(assets?.json?.data?.assets)
      ? assets.json.data.assets.map((asset) => asset?.key).filter(Boolean)
      : [];

    const settingsDataRead = await callTool(shopify, 'admin_rest', {
      endpoint: `themes/${activeTheme.id}/assets.json`,
      method: 'GET',
      query: { 'asset[key]': 'config/settings_data.json' },
    });
    report.actions.push({ step: 'read_settings_data', result: settingsDataRead });
    const settingsDataRaw = settingsDataRead?.json?.data?.asset?.value;
    if (typeof settingsDataRaw !== 'string') throw new Error('Missing config/settings_data.json payload');
    const settingsData = parseJsonText(settingsDataRaw);
    if (!settingsData) throw new Error('Could not parse config/settings_data.json');

    const settingsSchemaRead = await callTool(shopify, 'admin_rest', {
      endpoint: `themes/${activeTheme.id}/assets.json`,
      method: 'GET',
      query: { 'asset[key]': 'config/settings_schema.json' },
    });
    report.actions.push({ step: 'read_settings_schema', result: settingsSchemaRead });
    const settingsSchemaRaw = settingsSchemaRead?.json?.data?.asset?.value;
    const settingsSchema = typeof settingsSchemaRaw === 'string' ? parseJsonText(settingsSchemaRaw) : null;
    const schemaSocialKeys = collectSchemaSocialKeys(settingsSchema);

    const { next: settingsDataPatched, changed: socialChanged } = applySocialLinksToSettingsData(
      settingsData,
      SOCIAL_URLS,
      schemaSocialKeys
    );
    report.actions.push({
      step: 'prepare_social_link_patch',
      detail: {
        activeThemeId: activeTheme.id,
        schemaSocialKeys,
        socialChangedCount: socialChanged.length,
        socialChanged,
      },
    });

    if (socialChanged.length > 0) {
      const socialWrite = await callTool(shopify, 'admin_rest', {
        endpoint: `themes/${activeTheme.id}/assets.json`,
        method: 'PUT',
        confirm: WRITE_CONFIRM_TOKEN,
        body: {
          asset: {
            key: 'config/settings_data.json',
            value: `${JSON.stringify(settingsDataPatched, null, 2)}\n`,
          },
        },
      });
      report.actions.push({ step: 'write_social_links', result: socialWrite });
      if (!(socialWrite?.json?.ok === true)) {
        throw new Error(`Failed writing social links: ${socialWrite?.json?.error || socialWrite?.text || 'unknown error'}`);
      }
    }

    const footerAssets = assetKeys.filter((key) => /^sections\/.*footer.*\.json$/i.test(String(key || '')));
    const footerEnableChanges = [];
    for (const footerAsset of footerAssets) {
      const footerRead = await callTool(shopify, 'admin_rest', {
        endpoint: `themes/${activeTheme.id}/assets.json`,
        method: 'GET',
        query: { 'asset[key]': footerAsset },
      });
      report.actions.push({ step: 'read_footer_asset', asset: footerAsset, result: footerRead });
      const rawValue = footerRead?.json?.data?.asset?.value;
      if (typeof rawValue !== 'string') continue;
      const parsed = parseJsonText(rawValue);
      if (!parsed) continue;
      const { next, changed } = patchFooterSocialSettings(parsed);
      if (changed.length === 0) continue;

      const footerWrite = await callTool(shopify, 'admin_rest', {
        endpoint: `themes/${activeTheme.id}/assets.json`,
        method: 'PUT',
        confirm: WRITE_CONFIRM_TOKEN,
        body: {
          asset: {
            key: footerAsset,
            value: `${JSON.stringify(next, null, 2)}\n`,
          },
        },
      });
      report.actions.push({ step: 'write_footer_asset', asset: footerAsset, changed, result: footerWrite });
      footerEnableChanges.push({ asset: footerAsset, changedCount: changed.length, changed });
    }

    const channelCheck = await callTool(shopify, 'admin_graphql', {
      query: `query ChannelStatus {
  appInstallations(first: 100) {
    nodes {
      app {
        title
      }
    }
  }
  channels(first: 50) {
    nodes {
      id
      handle
      name
    }
  }
}`,
    });
    report.actions.push({ step: 'read_channel_status', result: channelCheck });

    const installedApps =
      channelCheck?.json?.data?.data?.appInstallations?.nodes
        ?.map((node) => String(node?.app?.title || '').trim())
        .filter(Boolean) || [];
    const channels =
      channelCheck?.json?.data?.data?.channels?.nodes?.map((node) => ({
        id: node?.id || null,
        handle: node?.handle || null,
        name: node?.name || null,
      })) || [];

    report.summary = {
      activeThemeId: activeTheme.id,
      socialLinksPatched: socialChanged.length,
      footerFlagsEnabled: footerEnableChanges.reduce((acc, item) => acc + item.changedCount, 0),
      installedApps,
      channels,
      channelInstallAutomated: false,
      note:
        'Sales channel app installations require Shopify UI OAuth/merchant consent. API can validate status but cannot complete app install consent flow.',
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
  process.stderr.write(`shopify-auto-remediate failed: ${error.message}\n`);
  process.exitCode = 1;
});
