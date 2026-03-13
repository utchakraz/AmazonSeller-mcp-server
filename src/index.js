#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import dotenv from 'dotenv';
import { server } from './server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Always resolve the Amazon MCP env file relative to this service.
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

console.log('Starting Amazon SP-API MCP server...');

// Start receiving messages on stdin and sending messages on stdout
const transport = new StdioServerTransport();
await server.connect(transport);
