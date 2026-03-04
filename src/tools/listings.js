import { z } from 'zod';
    import { makeSpApiRequest } from '../utils/auth.js';

export const listingsTools = {
  getListingsItem: {
    schema: {
      sellerId: z.string().describe("The seller identifier"),
      sku: z.string().describe("The seller SKU of the listings item"),
      marketplaceIds: z.array(z.string()).optional().describe("A list of marketplace identifiers"),
      issueLocale: z.string().optional().describe("A locale for localization of issues"),
      includedData: z.array(z.string()).optional().describe("Additional data to include (for example attributes,summaries,issues)")
    },
    handler: async ({ sellerId, sku, marketplaceIds, issueLocale, includedData }) => {
      try {
        const queryParams = {
          marketplaceIds: marketplaceIds || [process.env.SP_API_MARKETPLACE_ID]
        };

        if (issueLocale) {
          queryParams.issueLocale = issueLocale;
        }

        if (includedData && includedData.length > 0) {
          queryParams.includedData = includedData.join(',');
        }

        const data = await makeSpApiRequest(
          'GET',
          `/listings/2021-08-01/items/${sellerId}/${sku}`,
          null,
              queryParams
            );
            
            return {
              content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: `Error getting listings item: ${error.message}` }],
              isError: true
            };
          }
        },
    description: "Returns details about a listings item for a selling partner"
  },

  patchListingsItem: {
    schema: {
      sellerId: z.string().describe("The seller identifier"),
      sku: z.string().describe("The seller SKU of the listings item"),
      marketplaceIds: z.array(z.string()).optional().describe("A list of marketplace identifiers"),
      issueLocale: z.string().optional().describe("A locale for localization of issues"),
      productType: z.string().describe("The Amazon product type of the listings item"),
      patches: z.array(z.any()).describe("JSON patch operations for listing attributes")
    },
    handler: async ({ sellerId, sku, marketplaceIds, issueLocale, productType, patches }) => {
      try {
        const queryParams = {
          marketplaceIds: marketplaceIds || [process.env.SP_API_MARKETPLACE_ID]
        };

        if (issueLocale) {
          queryParams.issueLocale = issueLocale;
        }

        const payload = {
          productType,
          patches
        };

        const data = await makeSpApiRequest(
          'PATCH',
          `/listings/2021-08-01/items/${sellerId}/${sku}`,
          payload,
          queryParams
        );

        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error patching listings item: ${error.message}` }],
          isError: true
        };
      }
    },
    description: "Patches a listings item for a selling partner"
  },
  
  putListingsItem: {
        schema: {
          sellerId: z.string().describe("The seller identifier"),
          sku: z.string().describe("The seller SKU of the listings item"),
          marketplaceIds: z.array(z.string()).optional().describe("A list of marketplace identifiers"),
          issueLocale: z.string().optional().describe("A locale for localization of issues"),
          productType: z.string().describe("The Amazon product type of the listings item"),
          requirements: z.string().optional().describe("The name of the requirements set for the provided data"),
          attributes: z.record(z.any()).describe("JSON object containing structured listings item attribute data")
        },
        handler: async ({ sellerId, sku, marketplaceIds, issueLocale, productType, requirements, attributes }) => {
          try {
            const queryParams = {
              marketplaceIds: marketplaceIds || [process.env.SP_API_MARKETPLACE_ID]
            };
            
            if (issueLocale) {
              queryParams.issueLocale = issueLocale;
            }
            
            if (requirements) {
              queryParams.requirements = requirements;
            }
            
            const payload = {
              productType,
              attributes
            };
            
            const data = await makeSpApiRequest(
              'PUT',
              `/listings/2021-08-01/items/${sellerId}/${sku}`,
              payload,
              queryParams
            );
            
            return {
              content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: `Error updating listings item: ${error.message}` }],
              isError: true
            };
          }
        },
        description: "Creates or updates a listings item for a selling partner"
      },
      
      deleteListingsItem: {
        schema: {
          sellerId: z.string().describe("The seller identifier"),
          sku: z.string().describe("The seller SKU of the listings item"),
          marketplaceIds: z.array(z.string()).optional().describe("A list of marketplace identifiers"),
          issueLocale: z.string().optional().describe("A locale for localization of issues")
        },
        handler: async ({ sellerId, sku, marketplaceIds, issueLocale }) => {
          try {
            const queryParams = {
              marketplaceIds: marketplaceIds || [process.env.SP_API_MARKETPLACE_ID]
            };
            
            if (issueLocale) {
              queryParams.issueLocale = issueLocale;
            }
            
            const data = await makeSpApiRequest(
              'DELETE',
              `/listings/2021-08-01/items/${sellerId}/${sku}`,
              null,
              queryParams
            );
            
            return {
              content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
            };
          } catch (error) {
            return {
              content: [{ type: "text", text: `Error deleting listings item: ${error.message}` }],
              isError: true
            };
          }
        },
        description: "Deletes a listings item for a selling partner"
      }
    };
