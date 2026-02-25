import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const AMAZON_REQUIRED_ENV_KEYS = [
    "SP_API_CLIENT_ID",
    "SP_API_CLIENT_SECRET",
    "SP_API_REFRESH_TOKEN",
    "SP_API_REGION",
    "SP_API_AWS_ACCESS_KEY",
    "SP_API_AWS_SECRET_KEY",
    "SP_API_SELLER_ID",
    "SP_API_MARKETPLACE_ID",
];

function getAmazonEnv() {
    const env = {};
    const missing = [];

    for (const key of AMAZON_REQUIRED_ENV_KEYS) {
        const value = process.env[key];
        if (value && value.trim()) {
            env[key] = value;
            continue;
        }
        missing.push(key);
    }

    if (missing.length > 0) {
        throw new Error(`Missing required Amazon env vars: ${missing.join(", ")}`);
    }

    return env;
}

async function testMcp(name, command, args, env = {}) {
    console.log("\n================================");
    console.log(`Testing MCP Server: ${name}`);
    console.log("================================");

    const transport = new StdioClientTransport({
        command,
        args,
        env: { ...process.env, ...env },
    });

    const client = new Client(
        { name: "verify-client", version: "1.0.0" },
        { capabilities: {} }
    );

    try {
        await client.connect(transport);
        console.log(`Connected to ${name} via stdio transport`);

        const tools = await client.listTools();
        console.log(`Retrieved ${tools.tools.length} available tools:`);
        console.log(
            tools.tools
                .map((tool) => `  - ${tool.name}: ${tool.description.substring(0, 60)}...`)
                .join("\n")
        );

        let result;
        if (name === "Shopify") {
            console.log("\nExecuting tool: shopify_search_products");
            result = await client.callTool({
                name: "shopify_search_products",
                arguments: { query: "fountain", first: 1 },
            });
        } else if (name === "Amazon SP-API") {
            console.log("\nExecuting tool: get_marketplace_participations");
            result = await client.callTool({
                name: "get_marketplace_participations",
                arguments: {},
            });
        }

        console.log("\nTool Execution Response:");
        console.log(`${JSON.stringify(result, null, 2).substring(0, 1000)}\n...[truncated]`);
    } catch (error) {
        console.error(`Error testing ${name}:`, error.message);
    } finally {
        await client.close();
    }
}

async function run() {
    await testMcp(
        "Amazon SP-API",
        "node",
        [path.join(__dirname, "src", "index.js")],
        getAmazonEnv()
    );
}

run();