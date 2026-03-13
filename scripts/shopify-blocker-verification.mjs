#!/usr/bin/env node
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { connectMcpClient, parseJsonText, toText } from './lib/mcpClient.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const reportDir = path.join(repoRoot, 'docs', 'reports');
const checkedAt = new Date().toISOString();
const stamp = checkedAt.replace(/[:.]/g, '-');
const timestampedReportPath = path.join(reportDir, `shopify-blocker-verification-${stamp}.json`);
const latestReportPath = path.join(reportDir, 'shopify-blocker-verification-latest.json');
const endpointTarget = 'https://api.rbliving.com.au/api/webhooks/shopify';
const storefrontTarget = 'https://shopify.rbliving.com.au';
const fallbackShopDomain = 'rb-living.myshopify.com';

function parseShopPasswordState(shopInfoText) {
  const match = shopInfoText.match(/Password Enabled:\s*([^\r\n]+)/i);
  if (!match) return { parsed: null, state: 'unknown' };
  const value = String(match[1] || '').trim().toLowerCase();
  if (value === 'yes') return { parsed: true, state: 'enabled' };
  if (value === 'no') return { parsed: false, state: 'disabled' };
  return { parsed: null, state: value };
}

function extractShopDomain(shopInfoText) {
  const match = shopInfoText.match(/Domain:\s*([^\r\n]+)/i);
  return match ? String(match[1] || '').trim() : fallbackShopDomain;
}

function normalizeSecret(rawSecret) {
  return String(rawSecret || '').replace(/\r/g, '').trim();
}

function extractShopifyClientSecret(envContent) {
  const line = String(envContent || '')
    .split('\n')
    .find((entry) => entry.trim().startsWith('SHOPIFY_CLIENT_SECRET='));
  if (!line) return '';
  const raw = line.slice(line.indexOf('=') + 1);
  return normalizeSecret(raw);
}

async function connectShopifyMcp() {
  return connectMcpClient({
    repoRoot,
    service: 'shopify',
    clientName: 'shopify-blocker-verification',
  });
}

async function callTool(client, tool, args = {}) {
  const startedAt = new Date().toISOString();
  try {
    const result = await client.callTool({ name: tool, arguments: args });
    const text = toText(result);
    return {
      ok: true,
      tool,
      args,
      startedAt,
      completedAt: new Date().toISOString(),
      text,
      json: parseJsonText(text),
    };
  } catch (error) {
    return {
      ok: false,
      tool,
      args,
      startedAt,
      completedAt: new Date().toISOString(),
      error: error?.message || String(error),
    };
  }
}

async function httpProbe(url, init, options = {}) {
  try {
    const response = await fetch(url, init);
    const text = await response.text();
    const fullBody = options?.fullBody === true ? text : undefined;
    return {
      ok: true,
      statusCode: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      bodyPreview: text.slice(0, 500),
      ...(fullBody !== undefined ? { body: fullBody } : {}),
    };
  } catch (error) {
    return {
      ok: false,
      error: error?.message || String(error),
    };
  }
}

function parseAppTitles(channelsCallJson) {
  const nodes = channelsCallJson?.data?.data?.appInstallations?.nodes || [];
  return nodes
    .map((node) => String(node?.app?.title || '').trim())
    .filter(Boolean);
}

function parseThemeSocialLinks(settingsDataJson) {
  const settings = settingsDataJson?.current || {};
  const links = [];
  for (const [key, value] of Object.entries(settings)) {
    if (!/^social_/i.test(key)) continue;
    if (typeof value !== 'string') continue;
    const url = value.trim();
    if (!url) continue;
    links.push({ key, url });
  }
  return links;
}

function includesAny(titleSet, candidates) {
  for (const candidate of candidates) {
    if (titleSet.has(candidate)) return true;
  }
  return false;
}

function extractSocialUrlsFromHtml(html) {
  const matches = String(html || '').match(
    /https?:\/\/[^"'\\\s<>]*(facebook|instagram|youtube|tiktok|pinterest|x\.com|twitter|linkedin)[^"'\\\s<>]*/gi
  );
  if (!matches) return [];
  return Array.from(new Set(matches.map((entry) => entry.trim())));
}

async function main() {
  const report = {
    checkedAt,
    blockers: {},
    evidence: {},
    summary: {},
  };

  const envFilePath = path.join(repoRoot, 'services', 'shopify-mcp', '.env');
  const envContent = await fs.readFile(envFilePath, 'utf8');
  const webhookSecret = extractShopifyClientSecret(envContent);

  if (!webhookSecret) {
    throw new Error('Missing SHOPIFY_CLIENT_SECRET in services/shopify-mcp/.env');
  }

  const shopify = await connectShopifyMcp();
  try {
    const shopInfo = await callTool(shopify, 'get_shop_info', {});
    report.evidence.shopInfo = shopInfo;
    const shopInfoText = shopInfo.text || '';
    const passwordState = parseShopPasswordState(shopInfoText);
    const shopDomain = extractShopDomain(shopInfoText);

    const channelsGraphql = await callTool(shopify, 'admin_graphql', {
      query: `query AppChannels {
  appInstallations(first: 100) {
    nodes {
      app {
        title
      }
    }
  }
  channels(first: 50) {
    nodes {
      handle
      name
    }
  }
}`,
    });
    report.evidence.channelsGraphql = channelsGraphql;
    const channelsJson = channelsGraphql.json;
    const installedAppsSeen = parseAppTitles(channelsJson);
    const channelsSeen =
      channelsJson?.data?.data?.channels?.nodes?.map((node) => ({
        handle: String(node?.handle || '').trim(),
        name: String(node?.name || '').trim(),
      })) || [];
    const channelNamesSeen = channelsSeen.map((channel) => channel.name).filter(Boolean);
    const channelHandlesSeen = channelsSeen.map((channel) => channel.handle).filter(Boolean);
    const titleSet = new Set(installedAppsSeen.map((title) => title.toLowerCase()));
    const channelNameSet = new Set(channelNamesSeen.map((name) => name.toLowerCase()));
    const channelHandleSet = new Set(channelHandlesSeen.map((handle) => handle.toLowerCase()));

    const googleEvidence = {
      inAppInstallations: includesAny(titleSet, ['google & youtube', 'google and youtube', 'google channel', 'youtube']),
      inChannelsByName: includesAny(channelNameSet, ['google & youtube', 'google and youtube']),
      inChannelsByHandle: includesAny(channelHandleSet, ['google']),
    };
    const facebookEvidence = {
      inAppInstallations: includesAny(titleSet, ['facebook & instagram', 'facebook and instagram', 'facebook', 'instagram', 'meta']),
      inChannelsByName: includesAny(channelNameSet, ['facebook & instagram', 'facebook and instagram']),
      inChannelsByHandle: includesAny(channelHandleSet, ['facebook-ads', 'facebook_instagram']),
    };

    const googleAndYoutubeInstalled =
      googleEvidence.inAppInstallations || googleEvidence.inChannelsByName || googleEvidence.inChannelsByHandle;
    const facebookAndInstagramInstalled =
      facebookEvidence.inAppInstallations || facebookEvidence.inChannelsByName || facebookEvidence.inChannelsByHandle;

    const themesRest = await callTool(shopify, 'admin_rest', {
      endpoint: 'themes.json',
      method: 'GET',
    });
    report.evidence.themesRest = themesRest;

    const themes = Array.isArray(themesRest?.json?.data?.themes) ? themesRest.json.data.themes : [];
    const activeTheme = themes.find((theme) => String(theme?.role || '').toLowerCase() === 'main');

    let themeSettings = null;
    if (activeTheme?.id) {
      const themeSettingsRest = await callTool(shopify, 'admin_rest', {
        endpoint: `themes/${activeTheme.id}/assets.json`,
        method: 'GET',
        query: {
          'asset[key]': 'config/settings_data.json',
        },
      });
      report.evidence.themeSettingsRest = themeSettingsRest;
      const value = themeSettingsRest?.json?.data?.asset?.value;
      if (typeof value === 'string') {
        themeSettings = parseJsonText(value);
      }
    }
    const socialLinks = parseThemeSocialLinks(themeSettings);

    const storefrontPage = await httpProbe(storefrontTarget, { method: 'GET' }, { fullBody: true });
    const storefrontSocialLinks = extractSocialUrlsFromHtml(storefrontPage.body || '');
    report.evidence.storefrontSocialLinks = {
      target: storefrontTarget,
      statusCode: storefrontPage.statusCode ?? null,
      discoveredCount: storefrontSocialLinks.length,
      discoveredLinks: storefrontSocialLinks,
    };

    const webhooksRest = await callTool(shopify, 'admin_rest', {
      endpoint: 'webhooks.json',
      method: 'GET',
    });
    report.evidence.shopifyWebhooks = webhooksRest;
    const registeredWebhookTopics = Array.isArray(webhooksRest?.json?.data?.webhooks)
      ? webhooksRest.json.data.webhooks.map((webhook) => webhook.topic).filter(Boolean)
      : [];

    const unsignedBody = JSON.stringify({ probe: 'unsigned', at: checkedAt });
    const webhookId = `manual-signed-probe-${Date.now()}`;
    const signedBody = JSON.stringify({
      id: Date.now(),
      email: 'webhook-smoke@rbliving.com.au',
      source: 'shopify-blocker-verification',
    });
    const signedHmac = crypto.createHmac('sha256', webhookSecret).update(signedBody).digest('base64');

    const httpGet = await httpProbe(endpointTarget, { method: 'GET' });
    const httpPostUnsigned = await httpProbe(endpointTarget, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: unsignedBody,
    });
    const signedHeaders = {
      'content-type': 'application/json',
      'x-shopify-hmac-sha256': signedHmac,
      'x-shopify-topic': 'orders/create',
      'x-shopify-shop-domain': shopDomain || fallbackShopDomain,
      'x-shopify-webhook-id': webhookId,
    };
    const httpPostSigned = await httpProbe(endpointTarget, {
      method: 'POST',
      headers: signedHeaders,
      body: signedBody,
    });
    const httpPostReplay = await httpProbe(endpointTarget, {
      method: 'POST',
      headers: signedHeaders,
      body: signedBody,
    });

    report.evidence.webhookEndpointHttp = {
      target: endpointTarget,
      get: httpGet,
      postUnsigned: httpPostUnsigned,
      postSigned: httpPostSigned,
      postReplay: httpPostReplay,
    };

    const storefrontPasswordRemoved = passwordState.parsed === false;
    const socialLinksRemoved = socialLinks.length > 0 || storefrontSocialLinks.length > 0;
    const socialChannelsRemoved = googleAndYoutubeInstalled && facebookAndInstagramInstalled;
    const webhookEndpointRemoved =
      httpPostUnsigned.statusCode === 401 &&
      httpPostSigned.statusCode === 200 &&
      httpPostReplay.statusCode === 200;

    report.blockers = {
      storefront_password: {
        removed: storefrontPasswordRemoved,
        currentState: passwordState.state,
        source: 'shopify_mcp:get_shop_info',
      },
      social_links: {
        removed: socialLinksRemoved,
        configuredCount: socialLinks.length,
        configuredLinks: socialLinks,
        storefrontDiscoveredCount: storefrontSocialLinks.length,
        storefrontDiscoveredLinks: storefrontSocialLinks,
        source: 'shopify_mcp:admin_rest themes + storefront_html_probe',
      },
      social_channels: {
        removed: socialChannelsRemoved,
        inferredSignals: {
          googleAndYoutubeInstalled,
          facebookAndInstagramInstalled,
          installedAppsSeen,
          channelNamesSeen,
          channelHandlesSeen,
          googleEvidence,
          facebookEvidence,
        },
        confidence: 'high',
        source: 'shopify_mcp:admin_graphql appInstallations + channels',
      },
      webhook_endpoint: {
        removed: webhookEndpointRemoved,
        currentState: {
          unsignedStatus: httpPostUnsigned.statusCode ?? null,
          signedStatus: httpPostSigned.statusCode ?? null,
          replayStatus: httpPostReplay.statusCode ?? null,
        },
        expectedForUnsigned: 401,
        expectedForSigned: 200,
        source: 'https_probe + hmac_signed_probe',
      },
    };

    const blockersRemovedCount = Object.values(report.blockers).filter((item) => item?.removed).length;
    const blockersTotal = Object.keys(report.blockers).length;

    report.summary = {
      blockersRemovedCount,
      blockersTotal,
      storefrontPasswordRemoved,
      socialLinksRemoved,
      socialChannelsRemoved,
      webhookEndpointRemoved,
      registeredWebhookTopics,
    };
  } finally {
    await shopify.close();
  }

  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(timestampedReportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await fs.writeFile(latestReportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  const output = {
    checkedAt,
    timestampedReportPath,
    latestReportPath,
    summary: report.summary,
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`shopify-blocker-verification failed: ${error.message}\n`);
  process.exitCode = 1;
});
