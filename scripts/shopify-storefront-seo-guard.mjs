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
const reportPath = path.join(reportDir, `shopify-storefront-seo-guard-${stamp}.json`);
const latestPath = path.join(reportDir, 'shopify-storefront-seo-guard-latest.json');

const WRITE_CONFIRM_TOKEN = process.env.SHOPIFY_MCP_WRITE_CONFIRM || 'RBL_WRITE_CONFIRM';
const STOREFRONT_HOSTS = ['shopify.rbliving.com.au', 'rb-living.myshopify.com'];
const PRIMARY_SITE_ORIGIN = 'https://rbliving.com.au';
const SEO_GUARD_START = '{% comment %} RB Living storefront SEO guard start {% endcomment %}';
const SEO_GUARD_END = '{% comment %} RB Living storefront SEO guard end {% endcomment %}';
const SEO_GUARD_BLOCK = `${SEO_GUARD_START}
    {%- liquid
      assign rbl_storefront_host = request.host | downcase
      assign rbl_secondary_storefront = false
      if rbl_storefront_host == 'shopify.rbliving.com.au' or rbl_storefront_host == 'rb-living.myshopify.com'
        assign rbl_secondary_storefront = true
      endif
      assign rbl_primary_origin = '${PRIMARY_SITE_ORIGIN}'
      assign rbl_canonical_url = canonical_url
      if rbl_secondary_storefront
        if request.page_type == 'index'
          assign rbl_canonical_url = rbl_primary_origin | append: '/'
        elsif request.page_type == 'product'
          assign rbl_canonical_url = rbl_primary_origin | append: request.path
        elsif request.page_type == 'collection' or request.page_type == 'list-collections' or request.page_type == 'search' or request.page_type == 'cart'
          assign rbl_canonical_url = rbl_primary_origin | append: '/shop/'
        elsif request.page_type == 'blog'
          assign rbl_canonical_url = rbl_primary_origin | append: '/blog/'
        elsif request.page_type == 'article'
          assign rbl_article_parts = request.path | split: '/'
          assign rbl_article_slug = rbl_article_parts | last
          assign rbl_canonical_url = rbl_primary_origin | append: '/blog/' | append: rbl_article_slug
        elsif request.page_type == 'customers/account' or request.page_type == 'customers/login' or request.page_type == 'customers/register' or request.page_type == 'customers/reset_password'
          assign rbl_canonical_url = rbl_primary_origin | append: '/signin/'
        endif
      endif
    -%}
    {% if rbl_secondary_storefront %}
      <meta name="robots" content="noindex,follow,noarchive">
      <meta name="googlebot" content="noindex,follow,noarchive">
    {% endif %}
${SEO_GUARD_END}`;
const ROBOTS_GUARD_START = '{% comment %} RB Living storefront robots guard start {% endcomment %}';
const ROBOTS_GUARD_END = '{% comment %} RB Living storefront robots guard end {% endcomment %}';
const DEFAULT_ROBOTS_TEMPLATE = `{% for group in robots.default_groups %}
{{- group.user_agent -}}
{% for rule in group.rules %}
{{- rule -}}
{% endfor %}
{%- if group.sitemap != blank -%}
{{ group.sitemap }}
{%- endif -%}
{% endfor %}
`;

async function connectShopifyMcp() {
  return connectMcpClient({
    repoRoot,
    service: 'shopify',
    clientName: 'shopify-storefront-seo-guard',
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

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceMarkedBlock(current, startMarker, endMarker, nextBlock) {
  if (!current.includes(startMarker) || !current.includes(endMarker)) {
    return { replaced: false, next: current };
  }

  const pattern = new RegExp(`${escapeRegExp(startMarker)}[\\s\\S]*?${escapeRegExp(endMarker)}`, 'm');
  return {
    replaced: true,
    next: current.replace(pattern, nextBlock),
  };
}

function applySeoGuard(layoutSource) {
  const current = String(layoutSource || '');
  if (!current.trim()) {
    throw new Error('layout/theme.liquid is empty or missing.');
  }

  const replaced = replaceMarkedBlock(current, SEO_GUARD_START, SEO_GUARD_END, SEO_GUARD_BLOCK);
  if (replaced.replaced) {
    return { changed: replaced.next !== current, next: replaced.next };
  }

  const anchorPattern = /([ \t]*\{%-?\s*render 'meta-tags'\s*-?%\})/;
  if (!anchorPattern.test(current)) {
    throw new Error("Could not find render 'meta-tags' anchor in layout/theme.liquid.");
  }

  return {
    changed: true,
    next: current.replace(anchorPattern, `${SEO_GUARD_BLOCK}\n$1`),
  };
}

function applySeoGuardToMetaTags(source) {
  const current = String(source || '');
  if (!current.trim()) {
    throw new Error('snippets/meta-tags.liquid is empty or missing.');
  }

  let next = current;
  const replaced = replaceMarkedBlock(next, SEO_GUARD_START, SEO_GUARD_END, SEO_GUARD_BLOCK);
  if (replaced.replaced) {
    next = replaced.next;
  } else {
    next = `${SEO_GUARD_BLOCK}\n${next}`;
  }

  next = next.replace(
    /assign og_url = canonical_url \| default: request\.origin/,
    'assign og_url = rbl_canonical_url | default: request.origin'
  );
  next = next.replace(
    /href=\\"?\{\{\s*canonical_url\s*\}\}\\"?/,
    'href="{{ rbl_canonical_url }}"'
  );

  if (!next.includes('rbl_canonical_url')) {
    throw new Error('Failed to apply canonical override to snippets/meta-tags.liquid.');
  }

  return {
    changed: next !== current,
    next,
  };
}

async function fetchMetaProbe(url) {
  try {
    const response = await fetch(url, {
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; RB-Living-SEO-Guard/1.0)',
        'cache-control': 'no-cache',
        pragma: 'no-cache',
      },
    });
    const html = await response.text();
    return {
      url,
      status: response.status,
      title: html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() || '',
      canonical: html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)?.[1] || '',
      robots: html.match(/<meta[^>]+name=["']robots["'][^>]+content=["']([^"']+)["']/i)?.[1] || '',
      googlebot:
        html.match(/<meta[^>]+name=["']googlebot["'][^>]+content=["']([^"']+)["']/i)?.[1] || '',
    };
  } catch (error) {
    return {
      url,
      status: 0,
      error: error?.message || String(error),
      title: '',
      canonical: '',
      robots: '',
      googlebot: '',
    };
  }
}

function buildRobotsTemplate(existingSource) {
  const current = String(existingSource || '');
  const cleaned = replaceMarkedBlock(current, ROBOTS_GUARD_START, ROBOTS_GUARD_END, '').next.trim();
  const primaryRules = cleaned || DEFAULT_ROBOTS_TEMPLATE.trim();
  const next = `${ROBOTS_GUARD_START}
{%- liquid
  assign rbl_storefront_host = request.host | downcase
  assign rbl_secondary_storefront = false
  if rbl_storefront_host == 'shopify.rbliving.com.au' or rbl_storefront_host == 'rb-living.myshopify.com'
    assign rbl_secondary_storefront = true
  endif
-%}
{% if rbl_secondary_storefront %}
User-agent: *
Disallow: /
{% else %}
${primaryRules}
{% endif %}
${ROBOTS_GUARD_END}
`;

  return {
    changed: next.trim() !== current.trim(),
    next,
  };
}

async function fetchRobotsProbe(url) {
  try {
    const response = await fetch(url, {
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; RB-Living-SEO-Guard/1.0)',
        'cache-control': 'no-cache',
        pragma: 'no-cache',
      },
    });
    const text = await response.text();
    return {
      url,
      status: response.status,
      disallowAll: /User-agent:\s*\*\s+Disallow:\s*\/(\s|$)/im.test(text),
      bodyPreview: text.slice(0, 400),
    };
  } catch (error) {
    return {
      url,
      status: 0,
      error: error?.message || String(error),
      disallowAll: false,
      bodyPreview: '',
    };
  }
}

async function main() {
  const report = {
    startedAt,
    actions: [],
    summary: {},
    probes: [],
    robotsTxtProbes: [],
  };

  await fs.mkdir(reportDir, { recursive: true });
  const shopify = await connectShopifyMcp();

  try {
    const mcpConfig = await callTool(shopify, 'get_mcp_config', {});
    report.actions.push({ step: 'get_mcp_config', result: mcpConfig });
    if (!(mcpConfig?.json?.ok === true && mcpConfig?.json?.mode?.writeEnabled === true)) {
      throw new Error('Shopify MCP write mode is disabled.');
    }

    const themes = await callTool(shopify, 'admin_rest', {
      endpoint: 'themes.json',
      method: 'GET',
    });
    report.actions.push({ step: 'list_themes', result: themes });
    const themeList = Array.isArray(themes?.json?.data?.themes) ? themes.json.data.themes : [];
    const activeTheme = themeList.find((theme) => String(theme?.role || '').toLowerCase() === 'main');
    if (!activeTheme?.id) {
      throw new Error('Could not resolve active Shopify theme.');
    }

    const layoutRead = await callTool(shopify, 'admin_rest', {
      endpoint: `themes/${activeTheme.id}/assets.json`,
      method: 'GET',
      query: { 'asset[key]': 'layout/theme.liquid' },
    });
    report.actions.push({ step: 'read_theme_layout', result: layoutRead });
    const layoutSource = layoutRead?.json?.data?.asset?.value;
    if (typeof layoutSource !== 'string') {
      throw new Error('Missing layout/theme.liquid payload.');
    }

    const { changed, next } = applySeoGuard(layoutSource);
    report.actions.push({
      step: 'prepare_theme_layout_patch',
      detail: {
        activeThemeId: activeTheme.id,
        changed,
      },
    });

    if (changed) {
      const layoutWrite = await callTool(shopify, 'admin_rest', {
        endpoint: `themes/${activeTheme.id}/assets.json`,
        method: 'PUT',
        confirm: WRITE_CONFIRM_TOKEN,
        body: {
          asset: {
            key: 'layout/theme.liquid',
            value: next,
          },
        },
      });
      report.actions.push({ step: 'write_theme_layout', result: layoutWrite });
      if (!(layoutWrite?.json?.ok === true)) {
        throw new Error(
          `Failed writing layout/theme.liquid: ${layoutWrite?.json?.error || layoutWrite?.error || 'unknown error'}`
        );
      }
    }

    const metaTagsRead = await callTool(shopify, 'admin_rest', {
      endpoint: `themes/${activeTheme.id}/assets.json`,
      method: 'GET',
      query: { 'asset[key]': 'snippets/meta-tags.liquid' },
    });
    report.actions.push({ step: 'read_meta_tags_snippet', result: metaTagsRead });
    const metaTagsSource = metaTagsRead?.json?.data?.asset?.value;
    if (typeof metaTagsSource !== 'string') {
      throw new Error('Missing snippets/meta-tags.liquid payload.');
    }

    const { changed: metaTagsChanged, next: nextMetaTags } = applySeoGuardToMetaTags(metaTagsSource);
    report.actions.push({
      step: 'prepare_meta_tags_patch',
      detail: {
        activeThemeId: activeTheme.id,
        changed: metaTagsChanged,
      },
    });

    if (metaTagsChanged) {
      const metaTagsWrite = await callTool(shopify, 'admin_rest', {
        endpoint: `themes/${activeTheme.id}/assets.json`,
        method: 'PUT',
        confirm: WRITE_CONFIRM_TOKEN,
        body: {
          asset: {
            key: 'snippets/meta-tags.liquid',
            value: nextMetaTags,
          },
        },
      });
      report.actions.push({ step: 'write_meta_tags_snippet', result: metaTagsWrite });
      if (!(metaTagsWrite?.json?.ok === true)) {
        throw new Error(
          `Failed writing snippets/meta-tags.liquid: ${metaTagsWrite?.json?.error || metaTagsWrite?.error || 'unknown error'}`
        );
      }
    }

    const robotsTemplateRead = await callTool(shopify, 'admin_rest', {
      endpoint: `themes/${activeTheme.id}/assets.json`,
      method: 'GET',
      query: { 'asset[key]': 'templates/robots.txt.liquid' },
    });
    report.actions.push({ step: 'read_robots_template', result: robotsTemplateRead });
    const robotsTemplateSource = robotsTemplateRead?.json?.data?.asset?.value || '';
    const { changed: robotsTemplateChanged, next: nextRobotsTemplate } = buildRobotsTemplate(robotsTemplateSource);
    report.actions.push({
      step: 'prepare_robots_template_patch',
      detail: {
        activeThemeId: activeTheme.id,
        changed: robotsTemplateChanged,
      },
    });

    if (robotsTemplateChanged) {
      const robotsTemplateWrite = await callTool(shopify, 'admin_rest', {
        endpoint: `themes/${activeTheme.id}/assets.json`,
        method: 'PUT',
        confirm: WRITE_CONFIRM_TOKEN,
        body: {
          asset: {
            key: 'templates/robots.txt.liquid',
            value: nextRobotsTemplate,
          },
        },
      });
      report.actions.push({ step: 'write_robots_template', result: robotsTemplateWrite });
      if (!(robotsTemplateWrite?.json?.ok === true)) {
        throw new Error(
          `Failed writing templates/robots.txt.liquid: ${robotsTemplateWrite?.json?.error || robotsTemplateWrite?.error || 'unknown error'}`
        );
      }
    }

    const probePaths = [
      'https://shopify.rbliving.com.au/',
      'https://shopify.rbliving.com.au/products/rbl-crimson-courtyard-table-cloth',
      'https://shopify.rbliving.com.au/products/rbl-garden-party-table-cloth',
    ];
    report.probes = await Promise.all(probePaths.map((url) => fetchMetaProbe(url)));
    report.robotsTxtProbes = await Promise.all(
      STOREFRONT_HOSTS.map((host) => fetchRobotsProbe(`https://${host}/robots.txt`))
    );

    report.summary = {
      activeThemeId: activeTheme.id,
      changed: changed || metaTagsChanged || robotsTemplateChanged,
      layoutChanged: changed,
      metaTagsChanged,
      robotsTemplateChanged,
      storefrontHosts: STOREFRONT_HOSTS,
      robotsMetaGuardHealthy: report.probes.every(
        (probe) =>
          probe.status === 200 &&
          probe.robots.toLowerCase() === 'noindex,follow,noarchive' &&
          probe.googlebot.toLowerCase() === 'noindex,follow,noarchive'
      ),
      canonicalGuardHealthy: report.probes.every(
        (probe) => probe.status === 200 && probe.canonical.startsWith(PRIMARY_SITE_ORIGIN)
      ),
      robotsTxtGuardHealthy: report.robotsTxtProbes.every(
        (probe) => probe.status === 200 && probe.disallowAll
      ),
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
  process.stderr.write(`shopify-storefront-seo-guard failed: ${error.message}\n`);
  process.exitCode = 1;
});
