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
const startedAt = new Date().toISOString();
const stamp = startedAt.replace(/[:.]/g, '-');
const reportPath = path.join(reportDir, `shopify-shipping-pac-config-${stamp}.json`);
const latestPath = path.join(reportDir, 'shopify-shipping-pac-config-latest.json');

const WRITE_CONFIRM_TOKEN = process.env.SHOPIFY_MCP_WRITE_CONFIRM || 'RBL_WRITE_CONFIRM';
const PAC_CARRIER_SERVICE_NAME = process.env.SHOPIFY_PAC_CARRIER_SERVICE_NAME || 'rb_living_pac_live_rates';
const PAC_CALLBACK_BASE_URL =
  process.env.SHOPIFY_PAC_CALLBACK_URL || 'https://api.rbliving.com.au/api/shopify/carrier-service';
const CALLBACK_TOKEN = String(process.env.SHOPIFY_CARRIER_CALLBACK_TOKEN || '').trim();
const REMOVE_STATIC_RATES = ['1', 'true', 'yes', 'on'].includes(
  String(process.env.SHOPIFY_PAC_REMOVE_STATIC_RATES || '').trim().toLowerCase()
);

function buildCallbackUrl() {
  if (!CALLBACK_TOKEN) return PAC_CALLBACK_BASE_URL;
  const separator = PAC_CALLBACK_BASE_URL.includes('?') ? '&' : '?';
  return `${PAC_CALLBACK_BASE_URL}${separator}token=${encodeURIComponent(CALLBACK_TOKEN)}`;
}

function toPowershellPath(inputPath) {
  if (process.platform === 'win32') return inputPath;
  const match = inputPath.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
  if (!match) return inputPath;
  const drive = match[1].toUpperCase();
  const rest = match[2].replace(/\//g, '\\');
  return `${drive}:\\${rest}`;
}

function toText(toolResult) {
  if (!toolResult?.content || !Array.isArray(toolResult.content)) return '';
  return toolResult.content
    .filter((entry) => entry?.type === 'text' && typeof entry?.text === 'string')
    .map((entry) => entry.text)
    .join('\n');
}

function parseJsonText(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function connectShopifyMcp() {
  const powershellCommand = process.platform === 'win32' ? 'powershell' : 'powershell.exe';
  const startScript = toPowershellPath(path.join(repoRoot, 'scripts', 'mcp', 'start-shopify-mcp.ps1'));
  const client = new Client({ name: 'shopify-shipping-pac-config', version: '1.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: powershellCommand,
    args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', startScript],
    env: {
      ...process.env,
      SHOPIFY_MCP_ENABLE_WRITES: 'true',
      SHOPIFY_MCP_WRITE_CONFIRM: WRITE_CONFIRM_TOKEN,
    },
  });
  await client.connect(transport);
  return client;
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

function carrierServiceGid(numericId) {
  return `gid://shopify/DeliveryCarrierService/${numericId}`;
}

function zoneGidFromNumeric(numericId) {
  return `gid://shopify/DeliveryZone/${numericId}`;
}

function firstUserError(responseJson, mutationName) {
  return responseJson?.data?.data?.[mutationName]?.userErrors || [];
}

async function main() {
  await fs.mkdir(reportDir, { recursive: true });
  const report = {
    startedAt,
    actions: [],
    blockers: [],
    summary: {},
  };

  const callbackUrl = buildCallbackUrl();
  const shopify = await connectShopifyMcp();

  try {
    const mcpConfig = await callTool(shopify, 'get_mcp_config', {});
    report.actions.push({ step: 'get_mcp_config', result: mcpConfig });
    const writeEnabled = mcpConfig?.json?.ok === true && mcpConfig?.json?.mode?.writeEnabled === true;
    if (!writeEnabled) {
      throw new Error('Shopify MCP write mode is disabled. Set SHOPIFY_MCP_ENABLE_WRITES=true.');
    }

    const zonesRead = await callTool(shopify, 'admin_rest', {
      endpoint: 'shipping_zones.json',
      method: 'GET',
    });
    report.actions.push({ step: 'shipping_zones_read', result: zonesRead });
    const shippingZones = Array.isArray(zonesRead?.json?.data?.shipping_zones)
      ? zonesRead.json.data.shipping_zones
      : [];
    if (!shippingZones.length) throw new Error('No shipping zones returned from Shopify.');

    const domesticZone =
      shippingZones.find((zone) => /domestic/i.test(String(zone?.name || ''))) ||
      shippingZones.find((zone) =>
        Array.isArray(zone?.countries) && zone.countries.some((country) => country?.code === 'AU')
      );
    if (!domesticZone?.id) throw new Error('Could not resolve Domestic/AU shipping zone.');

    const deliveryProfileId = domesticZone.profile_id;
    const deliveryLocationGroupId = domesticZone.location_group_id;
    const domesticZoneGid = domesticZone.admin_graphql_api_id || zoneGidFromNumeric(domesticZone.id);
    if (!deliveryProfileId || !deliveryLocationGroupId || !domesticZoneGid) {
      throw new Error('Domestic zone is missing profile_id/location_group_id/admin_graphql_api_id.');
    }

    const carrierRead = await callTool(shopify, 'admin_rest', {
      endpoint: 'carrier_services.json',
      method: 'GET',
    });
    report.actions.push({ step: 'carrier_services_read', result: carrierRead });
    const carrierServices = Array.isArray(carrierRead?.json?.data?.carrier_services)
      ? carrierRead.json.data.carrier_services
      : [];

    const existingCarrier = carrierServices.find(
      (carrier) => String(carrier?.name || '').trim().toLowerCase() === PAC_CARRIER_SERVICE_NAME.toLowerCase()
    );

    let carrierServiceEntity = null;
    let carrierSource = 'custom';
    let carrierCreateOrUpdateError = null;
    if (existingCarrier?.id) {
      const carrierUpdate = await callTool(shopify, 'admin_rest', {
        endpoint: `carrier_services/${existingCarrier.id}.json`,
        method: 'PUT',
        confirm: WRITE_CONFIRM_TOKEN,
        body: {
          carrier_service: {
            id: existingCarrier.id,
            name: PAC_CARRIER_SERVICE_NAME,
            callback_url: callbackUrl,
            service_discovery: true,
          },
        },
      });
      report.actions.push({ step: 'carrier_service_update', result: carrierUpdate });
      if (carrierUpdate?.json?.ok === true) {
        carrierServiceEntity = carrierUpdate?.json?.data?.carrier_service || existingCarrier;
      } else {
        carrierCreateOrUpdateError = carrierUpdate?.json?.error || carrierUpdate?.error || 'carrier_service_update_failed';
      }
    } else {
      const carrierCreate = await callTool(shopify, 'admin_rest', {
        endpoint: 'carrier_services.json',
        method: 'POST',
        confirm: WRITE_CONFIRM_TOKEN,
        body: {
          carrier_service: {
            name: PAC_CARRIER_SERVICE_NAME,
            callback_url: callbackUrl,
            service_discovery: true,
          },
        },
      });
      report.actions.push({ step: 'carrier_service_create', result: carrierCreate });
      if (carrierCreate?.json?.ok === true) {
        carrierServiceEntity = carrierCreate?.json?.data?.carrier_service || null;
      } else {
        carrierCreateOrUpdateError = carrierCreate?.json?.error || carrierCreate?.error || 'carrier_service_create_failed';
      }
    }

    if (!carrierServiceEntity?.id) {
      const fallbackCarrier =
        carrierServices.find((carrier) =>
          /australia_post_mypost_business/i.test(String(carrier?.name || ''))
        ) ||
        carrierServices.find((carrier) => carrier?.active === true) ||
        null;

      if (fallbackCarrier?.id) {
        carrierServiceEntity = fallbackCarrier;
        carrierSource = 'fallback_existing_carrier';
        report.blockers.push({
          type: 'custom_carrier_service_not_created',
          message:
            'Could not create/update dedicated RB PAC carrier service. Falling back to existing active carrier service.',
          details: {
            error: carrierCreateOrUpdateError,
            fallbackCarrier: {
              id: fallbackCarrier.id,
              name: fallbackCarrier.name || null,
            },
          },
        });
      }
    }

    const carrierServiceId = Number(carrierServiceEntity?.id || 0);
    if (!Number.isInteger(carrierServiceId) || carrierServiceId <= 0) {
      throw new Error('Carrier service create/update did not return a valid carrier_service.id');
    }
    const carrierServiceIdGid = carrierServiceGid(carrierServiceId);

    const profileRead = await callTool(shopify, 'admin_graphql', {
      query: `query DeliveryProfileForPac($id: ID!) {
  deliveryProfile(id: $id) {
    id
    name
    profileLocationGroups {
      locationGroup {
        id
      }
      locationGroupZones(first: 20) {
        edges {
          node {
            zone {
              id
              name
            }
            methodDefinitions(first: 50) {
              edges {
                node {
                  id
                  name
                  active
                  rateProvider {
                    __typename
                    ... on DeliveryParticipant {
                      id
                      carrierService {
                        id
                        name
                      }
                    }
                    ... on DeliveryRateDefinition {
                      id
                      price {
                        amount
                        currencyCode
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}`,
      variables: { id: deliveryProfileId },
    });
    report.actions.push({ step: 'delivery_profile_read_before', result: profileRead });

    const deliveryProfile = profileRead?.json?.data?.data?.deliveryProfile;
    if (!deliveryProfile?.id) {
      throw new Error('deliveryProfile query failed; cannot attach carrier method to Domestic zone.');
    }

    const locationGroups = Array.isArray(deliveryProfile.profileLocationGroups)
      ? deliveryProfile.profileLocationGroups
      : [];
    const targetLocationGroup =
      locationGroups.find((group) => group?.locationGroup?.id === deliveryLocationGroupId) || locationGroups[0];
    if (!targetLocationGroup?.locationGroup?.id) {
      throw new Error('No delivery profile location group found for Domestic zone.');
    }

    const zoneEdges = targetLocationGroup?.locationGroupZones?.edges || [];
    const domesticZoneNode =
      zoneEdges.find((edge) => edge?.node?.zone?.id === domesticZoneGid)?.node ||
      zoneEdges.find((edge) => /domestic/i.test(String(edge?.node?.zone?.name || '')))?.node;
    if (!domesticZoneNode?.zone?.id) {
      throw new Error('Domestic delivery zone not found in profileLocationGroups.');
    }

    const methodsBefore = (domesticZoneNode?.methodDefinitions?.edges || []).map((edge) => edge?.node).filter(Boolean);
    const existingPacMethod = methodsBefore.find(
      (method) =>
        method?.rateProvider?.__typename === 'DeliveryParticipant' &&
        method?.rateProvider?.carrierService?.id === carrierServiceIdGid
    );
    const staticMethodIds = methodsBefore
      .filter((method) => method?.rateProvider?.__typename === 'DeliveryRateDefinition')
      .map((method) => method.id)
      .filter(Boolean);

    let deliveryProfileUpdateResult = null;
    let mutationUserErrors = [];
    if (!existingPacMethod) {
      const profileInput = {
        locationGroupsToUpdate: [
          {
            id: targetLocationGroup.locationGroup.id,
            zonesToUpdate: [
              {
                id: domesticZoneNode.zone.id,
                methodDefinitionsToCreate: [
                  {
                    name: 'PAC Live Carrier Rates',
                    active: true,
                    participant: {
                      carrierServiceId: carrierServiceIdGid,
                      adaptToNewServices: true,
                    },
                  },
                ],
              },
            ],
          },
        ],
      };

      if (REMOVE_STATIC_RATES && staticMethodIds.length > 0) {
        profileInput.methodDefinitionsToDelete = staticMethodIds;
      }

      deliveryProfileUpdateResult = await callTool(shopify, 'admin_graphql', {
        query: `mutation AttachPacCarrierToDomesticZone($id: ID!, $profile: DeliveryProfileInput!) {
  deliveryProfileUpdate(id: $id, profile: $profile) {
    profile {
      id
      name
    }
    userErrors {
      field
      message
    }
  }
}`,
        variables: {
          id: deliveryProfile.id,
          profile: profileInput,
        },
        confirm: WRITE_CONFIRM_TOKEN,
      });
      report.actions.push({ step: 'delivery_profile_update_attach_carrier', result: deliveryProfileUpdateResult });
      mutationUserErrors = firstUserError(deliveryProfileUpdateResult?.json, 'deliveryProfileUpdate');
    }

    const profileReadAfter = await callTool(shopify, 'admin_graphql', {
      query: `query DeliveryProfileAfterPac($id: ID!) {
  deliveryProfile(id: $id) {
    id
    profileLocationGroups {
      locationGroup {
        id
      }
      locationGroupZones(first: 20) {
        edges {
          node {
            zone {
              id
              name
            }
            methodDefinitions(first: 50) {
              edges {
                node {
                  id
                  name
                  active
                  rateProvider {
                    __typename
                    ... on DeliveryParticipant {
                      id
                      carrierService {
                        id
                        name
                        callbackUrl
                      }
                    }
                    ... on DeliveryRateDefinition {
                      id
                      price {
                        amount
                        currencyCode
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}`,
      variables: { id: deliveryProfile.id },
    });
    report.actions.push({ step: 'delivery_profile_read_after', result: profileReadAfter });

    const profileAfter = profileReadAfter?.json?.data?.data?.deliveryProfile;
    const locationGroupAfter =
      (profileAfter?.profileLocationGroups || []).find(
        (group) => group?.locationGroup?.id === targetLocationGroup.locationGroup.id
      ) || null;
    const domesticAfter =
      (locationGroupAfter?.locationGroupZones?.edges || []).find(
        (edge) => edge?.node?.zone?.id === domesticZoneNode.zone.id
      )?.node || null;
    const methodsAfter = (domesticAfter?.methodDefinitions?.edges || []).map((edge) => edge?.node).filter(Boolean);
    const pacMethodsAfter = methodsAfter.filter(
      (method) =>
        method?.rateProvider?.__typename === 'DeliveryParticipant' &&
        method?.rateProvider?.carrierService?.id === carrierServiceIdGid
    );
    const staticMethodsAfter = methodsAfter.filter(
      (method) => method?.rateProvider?.__typename === 'DeliveryRateDefinition'
    );

    const deliveryPromiseRead = await callTool(shopify, 'admin_graphql', {
      query: `query DeliveryPromiseSettings {
  deliveryPromiseSettings {
    deliveryDatesEnabled
    processingTime
  }
}`,
    });
    report.actions.push({ step: 'delivery_promise_settings_read', result: deliveryPromiseRead });
    const deliveryPromiseSettings = deliveryPromiseRead?.json?.data?.data?.deliveryPromiseSettings || null;

    if (Array.isArray(mutationUserErrors) && mutationUserErrors.length > 0) {
      report.blockers.push({
        type: 'delivery_profile_update_user_errors',
        message: 'Shopify returned userErrors while attaching PAC carrier to Domestic zone.',
        details: mutationUserErrors,
      });
    }

    if (pacMethodsAfter.length === 0) {
      report.blockers.push({
        type: 'pac_carrier_method_missing',
        message:
          'PAC carrier service exists but is not attached to Domestic delivery methods. Manual admin remediation is required.',
      });
    }

    if (deliveryPromiseSettings && deliveryPromiseSettings.deliveryDatesEnabled !== true) {
      report.blockers.push({
        type: 'estimated_delivery_dates_disabled',
        message:
          'Estimated delivery dates remain disabled. This toggle is not exposed through current API scopes in this workspace and must be enabled in Shopify Admin.',
      });
    }

    report.summary = {
      callbackUrl,
      pacCarrierServiceName: PAC_CARRIER_SERVICE_NAME,
      pacCarrierServiceId: carrierServiceId,
      pacCarrierServiceGid: carrierServiceIdGid,
      pacCarrierSource: carrierSource,
      deliveryProfileId: deliveryProfile.id,
      domesticZoneId: domesticZoneNode.zone.id,
      pacCarrierMethodCountAfter: pacMethodsAfter.length,
      staticRateMethodCountAfter: staticMethodsAfter.length,
      removeStaticRatesRequested: REMOVE_STATIC_RATES,
      deliveryPromiseSettings,
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
        blockers: report.blockers,
        summary: report.summary,
      },
      null,
      2
    )}\n`
  );
}

main().catch((error) => {
  process.stderr.write(`shopify-shipping-pac-config failed: ${error.message}\n`);
  process.exitCode = 1;
});
