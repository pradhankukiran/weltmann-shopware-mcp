"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fastify_1 = __importDefault(require("fastify"));
const swagger_1 = require("./plugins/swagger");
const config_1 = require("./config");
async function buildServer() {
    const config = (0, config_1.loadConfig)();
    const app = (0, fastify_1.default)({ logger: true });
    // Register plugins
    await app.register(swagger_1.registerSwagger);
    await app.register((await Promise.resolve().then(() => __importStar(require('./plugins/shopware')))).registerShopware);
    // Register routes
    await app.register((await Promise.resolve().then(() => __importStar(require('./routes/products')))).default);
    await app.register((await Promise.resolve().then(() => __importStar(require('./routes/orders')))).default);
    // LanceDB plugin (vector store)
    await app.register((await Promise.resolve().then(() => __importStar(require('./plugins/lancedb')))).registerLanceDB);
    // MCP plugin (streamable HTTP)
    await app.register((await Promise.resolve().then(() => __importStar(require('./plugins/mcp')))).registerMcp);
    // Health check route with comprehensive system status
    app.get('/health', async (request, reply) => {
        const startTime = process.hrtime.bigint();
        const memoryUsage = process.memoryUsage();
        const uptime = process.uptime();
        const healthData = {
            status: 'ok',
            timestamp: new Date().toISOString(),
            uptime: Math.floor(uptime),
            version: process.env.npm_package_version || '1.0.0',
            environment: process.env.NODE_ENV || 'development',
            memory: {
                rss: Math.round(memoryUsage.rss / 1024 / 1024),
                heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024),
                heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024),
                external: Math.round(memoryUsage.external / 1024 / 1024)
            },
            services: {},
            responseTime: 0
        };
        // Test LanceDB connection
        try {
            const table = app.lance?.productsTable;
            if (table) {
                const countResult = await table.countRows();
                healthData.services.lancedb = {
                    status: 'connected',
                    recordCount: countResult,
                    tableName: 'products'
                };
            }
            else {
                healthData.services.lancedb = {
                    status: 'not_initialized',
                    error: 'LanceDB table not found'
                };
            }
        }
        catch (error) {
            healthData.services.lancedb = {
                status: 'error',
                error: error instanceof Error ? error.message : 'Unknown error'
            };
        }
        // Test Shopware connection
        try {
            if (app.shopware) {
                // Use version endpoint for lightweight connectivity test
                const versionResponse = await app.shopware.get('/_info/version');
                const versionData = versionResponse.data;
                healthData.services.shopware = {
                    status: 'connected',
                    apiUrl: config.SHOPWARE_API_URL,
                    version: versionData?.version || 'unknown',
                    versionRevision: versionData?.versionRevision || 'unknown',
                    responseTime: versionResponse.headers?.['x-response-time'] || 'unknown'
                };
            }
            else {
                healthData.services.shopware = {
                    status: 'not_initialized',
                    error: 'Shopware client not found'
                };
            }
        }
        catch (error) {
            healthData.services.shopware = {
                status: 'error',
                error: error instanceof Error ? error.message : 'Connection failed',
                apiUrl: config.SHOPWARE_API_URL,
                details: error instanceof Error && 'response' in error
                    ? `HTTP ${error.response?.status} - ${error.response?.statusText}`
                    : 'Network or configuration error'
            };
        }
        // Calculate response time
        const endTime = process.hrtime.bigint();
        const responseTimeMs = Number(endTime - startTime) / 1000000;
        healthData.responseTime = Math.round(responseTimeMs * 100) / 100;
        // Determine overall health status
        const hasErrors = Object.values(healthData.services).some(service => service.status === 'error');
        if (hasErrors) {
            healthData.status = 'degraded';
            reply.code(503);
        }
        // Content negotiation: return HTML for browsers, JSON for API clients
        const acceptHeader = request.headers.accept || '';
        const userAgent = request.headers['user-agent'] || '';
        const wantsHtml = acceptHeader.includes('text/html') ||
            userAgent.includes('Mozilla') ||
            userAgent.includes('Chrome') ||
            userAgent.includes('Safari') ||
            userAgent.includes('Edge');
        if (wantsHtml) {
            reply.type('text/html');
            return generateHealthHTML(healthData);
        }
        return healthData;
    });
    return { app, config };
}
function generateHealthHTML(healthData) {
    const formatUptime = (seconds) => {
        const days = Math.floor(seconds / 86400);
        const hours = Math.floor((seconds % 86400) / 3600);
        const mins = Math.floor((seconds % 3600) / 60);
        const secs = seconds % 60;
        if (days > 0)
            return `${days}d ${hours}h ${mins}m`;
        if (hours > 0)
            return `${hours}h ${mins}m ${secs}s`;
        if (mins > 0)
            return `${mins}m ${secs}s`;
        return `${secs}s`;
    };
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Weltmann Shopware MCP - Health Dashboard</title>
    <style>
        * { 
            margin: 0; 
            padding: 0; 
            box-sizing: border-box; 
        }
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            background-color: #f8fafc;
            color: #374151;
            line-height: 1.6;
            min-height: 100vh;
            padding: 24px;
        }
        .container { 
            max-width: 1200px; 
            margin: 0 auto;
        }
        .header {
            background: white;
            border: 1px solid #e5e7eb;
            border-radius: 8px;
            padding: 24px;
            margin-bottom: 24px;
            text-align: center;
        }
        .header h1 {
            color: #1f2937;
            font-size: 1.875rem;
            font-weight: 700;
            margin-bottom: 8px;
        }
        .status-badge {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 8px 16px;
            border-radius: 6px;
            font-size: 0.875rem;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.05em;
        }
        .status-ok { background-color: #dcfce7; color: #166534; }
        .status-degraded { background-color: #fef3c7; color: #92400e; }
        .status-error { background-color: #fee2e2; color: #991b1b; }
        .cards {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
            gap: 24px;
            margin-bottom: 24px;
        }
        .card {
            background: white;
            border: 1px solid #e5e7eb;
            border-radius: 8px;
            padding: 24px;
            box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.1);
        }
        .card h3 {
            color: #1f2937;
            font-size: 1.125rem;
            font-weight: 600;
            margin-bottom: 16px;
            padding-bottom: 8px;
            border-bottom: 1px solid #f3f4f6;
        }
        .service-status {
            display: flex;
            align-items: flex-start;
            gap: 12px;
            padding: 12px;
            border: 1px solid #e5e7eb;
            border-radius: 6px;
            margin-bottom: 8px;
        }
        .service-status:last-child {
            margin-bottom: 0;
        }
        .service-icon {
            width: 16px;
            height: 16px;
            border-radius: 50%;
            flex-shrink: 0;
            margin-top: 2px;
        }
        .service-connected { background-color: #10b981; }
        .service-error { background-color: #ef4444; }
        .service-warning { background-color: #f59e0b; }
        .service-info {
            flex: 1;
            min-width: 0;
        }
        .service-name {
            font-weight: 600;
            color: #1f2937;
            margin-bottom: 4px;
        }
        .service-details {
            font-size: 0.875rem;
            color: #6b7280;
            word-wrap: break-word;
        }
        .memory-section {
            margin: 16px 0;
        }
        .memory-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 8px;
            font-size: 0.875rem;
            color: #374151;
        }
        .memory-bar {
            background-color: #f3f4f6;
            border-radius: 4px;
            height: 16px;
            overflow: hidden;
        }
        .memory-fill {
            background-color: #3b82f6;
            height: 100%;
            transition: width 0.3s ease;
        }
        .info-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
            gap: 16px;
        }
        .info-item {
            display: flex;
            flex-direction: column;
            gap: 4px;
        }
        .info-label {
            font-size: 0.75rem;
            color: #6b7280;
            text-transform: uppercase;
            font-weight: 500;
            letter-spacing: 0.05em;
        }
        .info-value {
            font-size: 0.875rem;
            color: #1f2937;
            font-weight: 600;
        }
        .timestamp {
            text-align: center;
            background: white;
            border: 1px solid #e5e7eb;
            border-radius: 8px;
            padding: 16px;
            color: #6b7280;
            font-size: 0.875rem;
        }
        .auto-refresh {
            position: fixed;
            top: 24px;
            right: 24px;
            background: white;
            border: 1px solid #e5e7eb;
            color: #374151;
            padding: 8px 12px;
            border-radius: 6px;
            font-size: 0.75rem;
            box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.1);
        }
    </style>
</head>
<body>
    <div class="auto-refresh" id="refresh-indicator">
        🔄 Auto-refresh: 30s
    </div>
    
    <div class="container">
        <div class="header">
            <h1>Weltmann Shopware MCP</h1>
            <div class="status-badge status-${healthData.status}">
                System Status: ${healthData.status.toUpperCase()}
            </div>
        </div>

        <div class="cards">
            <!-- System Info Card -->
            <div class="card">
                <h3>System Information</h3>
                <div class="info-grid">
                    <div class="info-item">
                        <div class="info-label">Uptime</div>
                        <div class="info-value">${formatUptime(healthData.uptime)}</div>
                    </div>
                    <div class="info-item">
                        <div class="info-label">Version</div>
                        <div class="info-value">${healthData.version}</div>
                    </div>
                    <div class="info-item">
                        <div class="info-label">Environment</div>
                        <div class="info-value">${healthData.environment}</div>
                    </div>
                    <div class="info-item">
                        <div class="info-label">Response Time</div>
                        <div class="info-value">${healthData.responseTime}ms</div>
                    </div>
                </div>
            </div>

            <!-- Memory Usage Card -->
            <div class="card">
                <h3>Memory Usage</h3>
                <div class="memory-section">
                    <div class="memory-header">
                        <span>Heap Memory</span>
                        <span>${healthData.memory.heapUsed}MB / ${healthData.memory.heapTotal}MB</span>
                    </div>
                    <div class="memory-bar">
                        <div class="memory-fill" style="width: ${(healthData.memory.heapUsed / healthData.memory.heapTotal) * 100}%;"></div>
                    </div>
                </div>
                <div class="info-grid">
                    <div class="info-item">
                        <div class="info-label">RSS Memory</div>
                        <div class="info-value">${healthData.memory.rss}MB</div>
                    </div>
                    <div class="info-item">
                        <div class="info-label">External Memory</div>
                        <div class="info-value">${healthData.memory.external}MB</div>
                    </div>
                </div>
            </div>

            <!-- Services Card -->
            <div class="card">
                <h3>Services Status</h3>
                ${Object.entries(healthData.services).map(([name, service]) => `
                    <div class="service-status">
                        <div class="service-icon service-${service.status}"></div>
                        <div class="service-info">
                            <div class="service-name">${name.charAt(0).toUpperCase() + name.slice(1)}</div>
                            <div class="service-details">
                                ${service.status === 'connected'
        ? name === 'lancedb'
            ? `${service.recordCount.toLocaleString()} records in ${service.tableName} table`
            : `Version ${service.version} • ${service.apiUrl}`
        : service.error || 'Unknown error'}
                            </div>
                        </div>
                    </div>
                `).join('')}
            </div>
        </div>

        <div class="timestamp">
            Last updated: ${new Date(healthData.timestamp).toLocaleString()}
        </div>
    </div>

    <script>
        let countdown = 30;
        const refreshIndicator = document.getElementById('refresh-indicator');
        
        const updateCountdown = () => {
            refreshIndicator.textContent = \`🔄 Auto-refresh: \${countdown}s\`;
            countdown--;
            
            if (countdown < 0) {
                location.reload();
            }
        };
        
        setInterval(updateCountdown, 1000);
    </script>
</body>
</html>`;
}
async function start() {
    const { app, config } = await buildServer();
    try {
        await app.listen({ port: config.PORT, host: '0.0.0.0' });
        app.log.info(`Server listening on port ${config.PORT}`);
    }
    catch (err) {
        app.log.error(err);
        process.exit(1);
    }
}
void start();
