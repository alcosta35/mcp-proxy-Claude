#!/usr/bin/env node

const https = require('https');
const fs = require('fs');
const path = require('path');

// Configuration for your Render server
const SERVER_URL = 'https://csv-query-mcp.onrender.com/mcp';
const AUTH_TOKEN = 'Bearer mcp24d91738b41c192e8498715c086acd16c7e9d84124590b1d5562881d5d4f7';

// Logging setup - create log file in the same directory as the script
const logFile = path.join(__dirname, 'mcp-proxy.log');

function log(message) {
    const timestamp = new Date().toISOString();
    const logMessage = `${timestamp}: ${message}\n`;
    
    // Write to both file and console for debugging
    try {
        fs.appendFileSync(logFile, logMessage);
        console.error(logMessage.trim()); // Use stderr to avoid interfering with stdout
    } catch (error) {
        console.error(`Logging error: ${error.message}`);
    }
}

log('=== MCP Proxy starting ===');
log(`Log file location: ${logFile}`);

// Buffer for handling multiple JSON objects
let buffer = '';

// Read JSON-RPC requests from Claude Desktop via stdin
process.stdin.on('data', async (data) => {
    try {
        // Add new data to buffer
        buffer += data.toString();
        
        // Process all complete JSON objects in the buffer
        let lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer
        
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            
            try {
                log(`RAW INPUT: ${trimmed}`);
                
                const request = JSON.parse(trimmed);
                log(`PARSED REQUEST: ${JSON.stringify(request, null, 2)}`);
                
                await processRequest(request);
                
            } catch (parseError) {
                log(`JSON PARSE ERROR for line: ${trimmed}`);
                log(`Parse error: ${parseError.message}`);
                
                // Try to extract a valid request ID for error response
                let requestId = null;
                try {
                    const partial = JSON.parse(trimmed.split('}{')[0] + '}');
                    requestId = partial.id;
                } catch (e) {
                    // Can't extract ID, use null
                }
                
                const errorResponse = {
                    jsonrpc: "2.0",
                    id: requestId,
                    error: {
                        code: -32700,
                        message: "Parse error",
                        data: parseError.message
                    }
                };
                const responseStr = JSON.stringify(errorResponse);
                log(`SENDING PARSE ERROR: ${responseStr}`);
                process.stdout.write(responseStr + '\n');
            }
        }
        
    } catch (error) {
        log(`BUFFER PROCESSING ERROR: ${error.message}`);
        log(`BUFFER CONTENT: ${buffer}`);
    }
});

async function processRequest(request) {
    try {
        // Validate JSON-RPC request format
        if (!isValidJsonRpcRequest(request)) {
            log(`INVALID REQUEST: ${JSON.stringify(request)}`);
            const errorResponse = {
                jsonrpc: "2.0",
                id: request.id || null,
                error: {
                    code: -32600,
                    message: "Invalid Request",
                    data: "Malformed JSON-RPC request"
                }
            };
            const responseStr = JSON.stringify(errorResponse);
            log(`SENDING ERROR: ${responseStr}`);
            process.stdout.write(responseStr + '\n');
            return;
        }
        
        // Handle initialize method locally to avoid server error
        if (request.method === 'initialize') {
            const initResponse = {
                jsonrpc: "2.0",
                id: request.id,
                result: {
                    protocolVersion: "2024-11-05",
                    serverInfo: {
                        name: "csv-query-mcp-http",
                        version: "1.0.0"
                    },
                    capabilities: {
                        tools: {}
                    }
                }
            };
            const responseStr = JSON.stringify(initResponse);
            log(`SENDING INIT RESPONSE: ${responseStr}`);
            process.stdout.write(responseStr + '\n');
            return;
        }
        
        // For notifications, don't send a response
        if (request.method.startsWith('notifications/')) {
            log(`NOTIFICATION: ${request.method} - no response needed`);
            return;
        }
        
        // Forward other requests to your Render MCP server
        log(`FORWARDING TO SERVER: ${request.method}`);
        const response = await forwardToServer(request);
        
        log(`SERVER RESPONSE: ${JSON.stringify(response, null, 2)}`);
        
        // Ensure response has proper JSON-RPC format
        const validResponse = ensureValidJsonRpc(response, request.id);
        const responseStr = JSON.stringify(validResponse);
        log(`SENDING FINAL RESPONSE: ${responseStr}`);
        
        // Send response back to Claude Desktop via stdout
        process.stdout.write(responseStr + '\n');
        
    } catch (error) {
        log(`ERROR PROCESSING REQUEST: ${error.message}`);
        log(`ERROR STACK: ${error.stack}`);
        
        // Send proper JSON-RPC error response
        const errorResponse = {
            jsonrpc: "2.0",
            id: request.id || null,
            error: {
                code: -32603,
                message: "Internal error",
                data: error.message
            }
        };
        const responseStr = JSON.stringify(errorResponse);
        log(`SENDING ERROR RESPONSE: ${responseStr}`);
        process.stdout.write(responseStr + '\n');
    }
}

function isValidJsonRpcRequest(request) {
    // Check if it's a valid JSON-RPC 2.0 request
    if (!request || typeof request !== 'object') {
        log('VALIDATION FAILED: Not an object');
        return false;
    }
    if (request.jsonrpc !== "2.0") {
        log(`VALIDATION FAILED: Invalid jsonrpc version: ${request.jsonrpc}`);
        return false;
    }
    if (typeof request.method !== 'string') {
        log(`VALIDATION FAILED: Invalid method: ${request.method}`);
        return false;
    }
    
    // For notifications, ID should not be present
    if (request.method.startsWith('notifications/')) {
        if (request.id !== undefined) {
            log('VALIDATION FAILED: Notification should not have ID');
            return false;
        }
        return true;
    }
    
    // For requests, ID is required and can be string, number, or null
    if (request.id === undefined) {
        log('VALIDATION FAILED: Request missing ID');
        return false;
    }
    
    log('VALIDATION PASSED');
    return true;
}

function forwardToServer(requestData) {
    return new Promise((resolve, reject) => {
        // Ensure the request is properly formatted before sending
        const cleanRequest = {
            jsonrpc: "2.0",
            method: requestData.method
        };
        
        // Add ID only for non-notification requests
        if (!requestData.method.startsWith('notifications/')) {
            cleanRequest.id = requestData.id;
        }
        
        // Add params if they exist
        if (requestData.params !== undefined) {
            cleanRequest.params = requestData.params;
        }
        
        const postData = JSON.stringify(cleanRequest);
        log(`FORWARDING TO SERVER: ${postData}`);
        
        const options = {
            hostname: 'csv-query-mcp.onrender.com',
            port: 443,
            path: '/mcp',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': AUTH_TOKEN,
                'Content-Length': Buffer.byteLength(postData)
            },
            timeout: 30000 // 30 second timeout
        };

        const req = https.request(options, (res) => {
            let responseData = '';
            
            res.on('data', (chunk) => {
                responseData += chunk;
            });
            
            res.on('end', () => {
                log(`RAW SERVER RESPONSE: ${responseData}`);
                
                try {
                    if (responseData.trim() === '') {
                        reject(new Error('Empty response from server'));
                        return;
                    }
                    
                    const jsonResponse = JSON.parse(responseData);
                    log(`PARSED SERVER RESPONSE: ${JSON.stringify(jsonResponse, null, 2)}`);
                    resolve(jsonResponse);
                } catch (error) {
                    log(`JSON PARSE ERROR: ${error.message}`);
                    log(`RESPONSE DATA: ${responseData}`);
                    reject(new Error(`Invalid JSON response from server: ${error.message}`));
                }
            });
        });

        req.on('error', (error) => {
            log(`REQUEST ERROR: ${error.message}`);
            reject(error);
        });

        req.on('timeout', () => {
            log('REQUEST TIMEOUT');
            req.destroy();
            reject(new Error('Request timeout'));
        });

        req.write(postData);
        req.end();
    });
}

function ensureValidJsonRpc(response, requestId) {
    // Ensure we have a valid ID
    const validId = requestId !== undefined ? requestId : null;
    
    // If response is already valid JSON-RPC, just ensure proper ID
    if (response && response.jsonrpc === "2.0" && (response.result !== undefined || response.error !== undefined)) {
        const validResponse = {
            ...response,
            id: validId
        };
        log(`RESPONSE ALREADY VALID: ${JSON.stringify(validResponse)}`);
        return validResponse;
    }
    
    // If response has an error field that's not properly formatted
    if (response && response.error && typeof response.error === 'string') {
        const errorResponse = {
            jsonrpc: "2.0",
            id: validId,
            error: {
                code: -32000,
                message: response.error,
                data: null
            }
        };
        log(`REFORMATTED ERROR RESPONSE: ${JSON.stringify(errorResponse)}`);
        return errorResponse;
    }
    
    // If response is missing jsonrpc field but has valid content
    if (response && !response.jsonrpc) {
        const validResponse = {
            jsonrpc: "2.0",
            id: validId,
            result: response
        };
        log(`ADDED JSONRPC TO RESPONSE: ${JSON.stringify(validResponse)}`);
        return validResponse;
    }
    
    // If response is completely invalid, create a proper success response
    const defaultResponse = {
        jsonrpc: "2.0",
        id: validId,
        result: response || {}
    };
    log(`CREATED DEFAULT RESPONSE: ${JSON.stringify(defaultResponse)}`);
    return defaultResponse;
}

// Handle process termination gracefully
process.on('SIGINT', () => {
    log('MCP Proxy stopping (SIGINT)...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    log('MCP Proxy stopping (SIGTERM)...');
    process.exit(0);
});

process.on('uncaughtException', (error) => {
    log(`UNCAUGHT EXCEPTION: ${error.message}`);
    log(`STACK: ${error.stack}`);
});

process.on('unhandledRejection', (reason, promise) => {
    log(`UNHANDLED REJECTION: ${reason}`);
});

log('=== MCP Proxy ready and listening ===');