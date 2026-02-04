import * as os from 'os';

import axios from 'axios';
import fastify from 'fastify';

import { loadConfig, getConfig } from './config';
import { registerSwagger } from './plugins/swagger';
import { escapeHtml, maskSensitiveUrl } from './utils';

// Handle unhandled rejections and exceptions
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  process.exit(1);
});

async function buildServer() {
  const config = loadConfig();
  const app = fastify({ logger: true });

  try {
    // Register plugins
    await app.register(registerSwagger);
    await app.register((await import('./plugins/shopware')).registerShopware);

    // Register routes
    await app.register((await import('./routes/products')).default);
    await app.register((await import('./routes/orders')).default);

    // CORS plugin (optional, based on config)
    if (config.CORS_ORIGIN) {
      await app.register(import('@fastify/cors'), {
        origin: config.CORS_ORIGIN === '*' ? true : config.CORS_ORIGIN,
        methods: ['GET', 'POST', 'OPTIONS']
      });
    }

    // CSV plugin (product catalog)
    await app.register((await import('./plugins/csv')).registerCSV);

    // Security plugin (rate limiting & optional API key auth)
    await app.register((await import('./plugins/security')).registerSecurity, {
      rateLimit: {
        windowMs: config.RATE_LIMIT_WINDOW_MS,
        maxRequests: config.RATE_LIMIT_MAX_REQUESTS
      },
      apiKey: config.MCP_API_KEY
    });

    // MCP plugin (streamable HTTP)
    await app.register((await import('./plugins/mcp')).registerMcp);
  } catch (error) {
    app.log.error({ error }, 'Failed to register plugins');
    throw error;
  }

  // Dynamic favicon route
  app.get('/favicon.ico', async (request, reply) => {
    const config = getConfig();

    // Check service statuses for favicon color
    let shopwareStatus = 'error';
    let mcpStatus = 'error';

    // Test Shopware connection
    try {
      if (app.shopware) {
        await app.shopware.get('/_info/version');
        shopwareStatus = 'connected';
      }
    } catch (error) {
      app.log.warn({ error }, 'Favicon Shopware check failed');
      shopwareStatus = 'error';
    }

    // Test MCP tools (lightweight test)
    try {
      if (app.shopware) {
        await app.shopware.searchProductsByNumber(config.HEALTH_CHECK_PRODUCT_NUMBER, true);
        mcpStatus = 'connected';
      }
    } catch (error) {
      app.log.warn({ error }, 'Favicon MCP check failed');
      mcpStatus = 'error';
    }

    // Determine favicon color based on all service statuses
    const connectedServices = [shopwareStatus, mcpStatus].filter(
      (s) => s === 'connected'
    ).length;
    const totalServices = 2;

    let color: string;
    if (connectedServices === totalServices) {
      color = '#10b981'; // Green - all systems operational
    } else if (connectedServices === 0) {
      color = '#ef4444'; // Red - all systems down
    } else {
      color = '#f59e0b'; // Yellow - some systems down
    }

    const svg = generateFaviconSVG(color);

    reply
      .type('image/svg+xml')
      .header('Cache-Control', 'no-cache, no-store, must-revalidate')
      .header('Pragma', 'no-cache')
      .header('Expires', '0')
      .send(svg);
  });

  // Health check route with comprehensive system status
  app.get('/health', async (request, reply) => {
    const config = getConfig();
    const startTime = process.hrtime.bigint();
    const memoryUsage = process.memoryUsage();
    const uptime = process.uptime();

    const healthData: HealthData = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: Math.floor(uptime),
      version: process.env.npm_package_version || '1.0.0',
      environment: config.NODE_ENV,
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
      processId: process.pid,
      startTime: new Date(Date.now() - uptime * 1000).toISOString(),
      cpuUsage:
        Math.round((process.cpuUsage().user + process.cpuUsage().system) / 1000) / 1000,
      memory: {
        rss: Math.round(memoryUsage.rss / 1024 / 1024),
        heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024),
        heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024),
        external: Math.round(memoryUsage.external / 1024 / 1024),
        buffers:
          Math.round(
            ((memoryUsage as NodeJS.MemoryUsage & { arrayBuffers?: number }).arrayBuffers ?? 0) /
              1024 /
              1024
          ) || 0,
        heapUtilization: Math.round((memoryUsage.heapUsed / memoryUsage.heapTotal) * 100),
        totalSystemMemory: Math.round((os.totalmem() / 1024 / 1024 / 1024) * 100) / 100,
        freeSystemMemory: Math.round((os.freemem() / 1024 / 1024 / 1024) * 100) / 100,
        systemMemoryChart: (() => {
          const totalMB = Math.round(os.totalmem() / 1024 / 1024);
          const freeMB = Math.round(os.freemem() / 1024 / 1024);
          const processMB = Math.round(memoryUsage.rss / 1024 / 1024);
          const otherMB = totalMB - freeMB - processMB;

          const processPercent = Math.round((processMB / totalMB) * 100);
          const freePercent = Math.round((freeMB / totalMB) * 100);
          const otherPercent = 100 - processPercent - freePercent;

          return {
            processPercent,
            freePercent,
            otherPercent,
            processMB,
            freeMB,
            otherMB
          };
        })()
      },
      services: {},
      responseTime: 0
    };

    // Test Shopware connection
    try {
      if (app.shopware) {
        const versionResponse = await app.shopware.get('/_info/version');

        const versionData = versionResponse.data as { version?: string; versionRevision?: string };
        healthData.services.shopware = {
          status: 'connected',
          apiUrl: maskSensitiveUrl(config.SHOPWARE_API_URL),
          version: versionData?.version || 'unknown',
          versionRevision: versionData?.versionRevision || 'unknown',
          responseTime: (versionResponse.headers?.['x-response-time'] as string) || 'unknown'
        };
      } else {
        healthData.services.shopware = {
          status: 'not_initialized',
          error: 'Shopware client not found'
        };
      }
    } catch (error) {
      app.log.warn({ error }, 'Shopware health check failed');
      healthData.services.shopware = {
        status: 'error',
        error: 'Connection failed', // Don't expose internal error details
        details: 'Unable to connect to Shopware API'
      };
    }

    // Test MCP tools by making actual HTTP call to the MCP endpoint
    const testProductNumber = config.HEALTH_CHECK_PRODUCT_NUMBER;
    try {
      const mcpRequest = {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
          name: 'get-stock-level',
          arguments: {
            productNumber: testProductNumber
          }
        },
        id: 1
      };

      const mcpResponse = await axios.post(
        `http://localhost:${config.PORT}/mcp`,
        mcpRequest,
        {
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream'
          },
          timeout: 5000,
          validateStatus: () => true
        }
      );

      if (mcpResponse.status === 200) {
        const responseBody = mcpResponse.data as {
          error?: { message: string; code: number };
          result?: { content?: unknown[] };
        };

        if (responseBody.error) {
          healthData.services.mcp = {
            status: 'error',
            testTool: 'get-stock-level',
            testProductNumber: testProductNumber,
            error: 'Tool call failed',
            errorCode: responseBody.error.code
          };
        } else {
          const toolResult = responseBody.result;
          healthData.services.mcp = {
            status: 'connected',
            testTool: 'get-stock-level',
            testProductNumber: testProductNumber,
            testResult: toolResult ? 'tool_responded' : 'empty_response',
            hasContent: !!(toolResult?.content && toolResult.content.length > 0)
          };
        }
      } else {
        healthData.services.mcp = {
          status: 'error',
          testTool: 'get-stock-level',
          testProductNumber: testProductNumber,
          error: `HTTP ${mcpResponse.status}`
        };
      }
    } catch (error) {
      let errorMessage = 'Unknown error';

      if (axios.isAxiosError(error)) {
        if (error.code === 'ECONNREFUSED') {
          errorMessage = 'MCP endpoint not available';
        } else if (error.code === 'ETIMEDOUT') {
          errorMessage = 'MCP endpoint timeout';
        } else {
          errorMessage = 'Connection failed';
        }
      }

      healthData.services.mcp = {
        status: 'error',
        testTool: 'get-stock-level',
        testProductNumber: testProductNumber,
        error: errorMessage
      };
    }

    // Calculate response time
    const endTime = process.hrtime.bigint();
    const responseTimeMs = Number(endTime - startTime) / 1000000;
    healthData.responseTime = Math.round(responseTimeMs * 100) / 100;

    // Determine overall health status
    const hasErrors = Object.values(healthData.services).some(
      (service) => service.status === 'error'
    );

    if (hasErrors) {
      healthData.status = 'degraded';
      reply.code(503);
    }

    // Content negotiation: return HTML for browsers, JSON for API clients
    const acceptHeader = request.headers.accept || '';
    const userAgent = request.headers['user-agent'] || '';
    const wantsHtml =
      acceptHeader.includes('text/html') ||
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

  return { app, config } as const;
}

interface HealthData {
  status: string;
  timestamp: string;
  uptime: number;
  version: string;
  environment: string;
  nodeVersion: string;
  platform: string;
  architecture: string;
  processId: number;
  startTime: string;
  cpuUsage: number;
  memory: {
    rss: number;
    heapUsed: number;
    heapTotal: number;
    external: number;
    buffers: number;
    heapUtilization: number;
    totalSystemMemory: number;
    freeSystemMemory: number;
    systemMemoryChart: {
      processPercent: number;
      freePercent: number;
      otherPercent: number;
      processMB: number;
      freeMB: number;
      otherMB: number;
    };
  };
  services: Record<
    string,
    {
      status: string;
      error?: string;
      errorCode?: number;
      recordCount?: number;
      tableName?: string;
      apiUrl?: string;
      version?: string;
      versionRevision?: string;
      responseTime?: string;
      details?: string;
      testTool?: string;
      testProductNumber?: string;
      testResult?: string;
      hasContent?: boolean;
    }
  >;
  responseTime: number;
}

function generateFaviconSVG(color: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
  <circle cx="16" cy="16" r="14" fill="${escapeHtml(color)}" stroke="white" stroke-width="2"/>
</svg>`;
}

function generateHealthHTML(healthData: HealthData): string {
  const formatUptime = (seconds: number) => {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    if (days > 0) return `${days}d ${hours}h ${mins}m`;
    if (hours > 0) return `${hours}h ${mins}m ${secs}s`;
    if (mins > 0) return `${mins}m ${secs}s`;
    return `${secs}s`;
  };

  // Validate status is one of expected values to prevent XSS
  const validStatuses = ['ok', 'degraded', 'error'];
  const safeStatus = validStatuses.includes(healthData.status) ? healthData.status : 'error';

  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Weltmann Shopware MCP - Health Dashboard</title>
    <link rel="icon" href="/favicon.ico" type="image/svg+xml">
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
            padding: 20px;
        }
        .container {
            max-width: 1200px;
            margin: 0 auto;
        }
        .header {
            background: white;
            border: 1px solid #e5e7eb;
            border-radius: 8px;
            padding: 20px;
            margin-bottom: 20px;
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
            gap: 20px;
            margin-bottom: 20px;
        }
        .card {
            background: white;
            border: 1px solid #e5e7eb;
            border-radius: 8px;
            padding: 20px;
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
        .memory-chart-section {
            margin: 16px 0;
            display: flex;
            align-items: center;
            gap: 20px;
        }
        .pie-chart {
            width: 120px;
            height: 120px;
            border-radius: 50%;
            background: conic-gradient(
                #3b82f6 0deg,
                #3b82f6 var(--process-angle, 0deg),
                #10b981 var(--process-angle, 0deg),
                #10b981 var(--free-angle, 0deg),
                #6b7280 var(--free-angle, 0deg),
                #6b7280 360deg
            );
            position: relative;
            flex-shrink: 0;
        }
        .chart-legend {
            flex: 1;
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        .legend-item {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 0.875rem;
        }
        .legend-color {
            width: 12px;
            height: 12px;
            border-radius: 2px;
            flex-shrink: 0;
        }
        .legend-process { background-color: #3b82f6; }
        .legend-free { background-color: #10b981; }
        .legend-other { background-color: #6b7280; }
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
            right: 16px;
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
        Auto-refresh: 30s
    </div>

    <div class="container">
        <div class="header">
            <h1>Weltmann Shopware MCP</h1>
            <div class="status-badge status-${safeStatus}">
                System Status: ${escapeHtml(safeStatus.toUpperCase())}
            </div>
        </div>

        <div class="cards">
            <!-- System Info Card -->
            <div class="card">
                <h3>System Information</h3>
                <div class="info-grid">
                    <div class="info-item">
                        <div class="info-label">Uptime</div>
                        <div class="info-value">${escapeHtml(formatUptime(healthData.uptime))}</div>
                    </div>
                    <div class="info-item">
                        <div class="info-label">Version</div>
                        <div class="info-value">${escapeHtml(healthData.version)}</div>
                    </div>
                    <div class="info-item">
                        <div class="info-label">Environment</div>
                        <div class="info-value">${escapeHtml(healthData.environment)}</div>
                    </div>
                    <div class="info-item">
                        <div class="info-label">Response Time</div>
                        <div class="info-value">${escapeHtml(String(healthData.responseTime))}ms</div>
                    </div>
                    <div class="info-item">
                        <div class="info-label">CPU Usage</div>
                        <div class="info-value">${escapeHtml(String(healthData.cpuUsage))}ms</div>
                    </div>
                    <div class="info-item">
                        <div class="info-label">Node.js</div>
                        <div class="info-value">${escapeHtml(healthData.nodeVersion)}</div>
                    </div>
                    <div class="info-item">
                        <div class="info-label">Platform</div>
                        <div class="info-value">${escapeHtml(healthData.platform)}</div>
                    </div>
                    <div class="info-item">
                        <div class="info-label">Process ID</div>
                        <div class="info-value">${escapeHtml(String(healthData.processId))}</div>
                    </div>
                    <div class="info-item">
                        <div class="info-label">Start Date</div>
                        <div class="info-value">${escapeHtml(new Date(healthData.startTime).toLocaleDateString('en-GB'))}</div>
                    </div>
                    <div class="info-item">
                        <div class="info-label">Start Time</div>
                        <div class="info-value">${escapeHtml(new Date(healthData.startTime).toLocaleTimeString('en-GB', { hour12: false }))}</div>
                    </div>
                </div>
            </div>

            <!-- Memory Usage Card -->
            <div class="card">
                <h3>Memory Usage</h3>
                <div class="memory-section">
                    <div class="memory-header">
                        <span>Heap Memory (${escapeHtml(String(healthData.memory.heapUtilization))}%)</span>
                        <span>${escapeHtml(String(healthData.memory.heapUsed))}MB / ${escapeHtml(String(healthData.memory.heapTotal))}MB</span>
                    </div>
                    <div class="memory-bar">
                        <div class="memory-fill" style="width: ${Math.min(Math.max(healthData.memory.heapUtilization, 0), 100)}%;"></div>
                    </div>
                </div>
                <div class="memory-chart-section">
                    <div class="pie-chart" style="
                        --process-angle: ${healthData.memory.systemMemoryChart.processPercent * 3.6}deg;
                        --free-angle: ${(healthData.memory.systemMemoryChart.processPercent + healthData.memory.systemMemoryChart.freePercent) * 3.6}deg;
                    "></div>
                    <div class="chart-legend">
                        <div class="legend-item">
                            <div class="legend-color legend-process"></div>
                            <span>Process (${escapeHtml(String(healthData.memory.systemMemoryChart.processPercent))}%) - ${escapeHtml(String(healthData.memory.systemMemoryChart.processMB))}MB</span>
                        </div>
                        <div class="legend-item">
                            <div class="legend-color legend-free"></div>
                            <span>Available (${escapeHtml(String(healthData.memory.systemMemoryChart.freePercent))}%) - ${escapeHtml(String(healthData.memory.systemMemoryChart.freeMB))}MB</span>
                        </div>
                        <div class="legend-item">
                            <div class="legend-color legend-other"></div>
                            <span>Other Processes (${escapeHtml(String(healthData.memory.systemMemoryChart.otherPercent))}%) - ${escapeHtml(String(healthData.memory.systemMemoryChart.otherMB))}MB</span>
                        </div>
                    </div>
                </div>
                <div class="info-grid">
                    <div class="info-item">
                        <div class="info-label">RSS Memory</div>
                        <div class="info-value">${escapeHtml(String(healthData.memory.rss))}MB</div>
                    </div>
                    <div class="info-item">
                        <div class="info-label">External Memory</div>
                        <div class="info-value">${escapeHtml(String(healthData.memory.external))}MB</div>
                    </div>
                    <div class="info-item">
                        <div class="info-label">Buffer Memory</div>
                        <div class="info-value">${escapeHtml(String(healthData.memory.buffers))}MB</div>
                    </div>
                    <div class="info-item">
                        <div class="info-label">System Memory</div>
                        <div class="info-value">${escapeHtml(String(healthData.memory.totalSystemMemory))}GB</div>
                    </div>
                </div>
            </div>

            <!-- Services Card -->
            <div class="card">
                <h3>Services Status</h3>
                ${Object.entries(healthData.services)
                  .map(([name, service]) => {
                    const validServiceStatuses = ['connected', 'error', 'not_initialized', 'warning'];
                    const safeServiceStatus = validServiceStatuses.includes(service.status)
                      ? service.status
                      : 'error';

                    const displayName =
                      name === 'mcp'
                        ? 'MCP'
                        : name.charAt(0).toUpperCase() + name.slice(1);

                    let details = '';
                    if (service.status === 'connected') {
                      if (name === 'mcp') {
                        details = `test: ${escapeHtml(service.testResult ?? 'unknown')}`;
                      } else {
                        details = `Version ${escapeHtml(service.version ?? 'unknown')} - ${escapeHtml(service.apiUrl ?? '(configured)')}`;
                      }
                    } else {
                      details = escapeHtml(service.error || 'Unknown error');
                    }

                    return `
                    <div class="service-status">
                        <div class="service-icon service-${safeServiceStatus === 'connected' ? 'connected' : 'error'}"></div>
                        <div class="service-info">
                            <div class="service-name">${escapeHtml(displayName)}</div>
                            <div class="service-details">${details}</div>
                        </div>
                    </div>
                `;
                  })
                  .join('')}
            </div>
        </div>

    </div>

    <script>
        let countdown = 30;
        const refreshIndicator = document.getElementById('refresh-indicator');

        const updateCountdown = () => {
            refreshIndicator.textContent = \`Auto-refresh: \${countdown}s\`;
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

let app: Awaited<ReturnType<typeof buildServer>>['app'] | null = null;

async function start() {
  const { app: server, config } = await buildServer();
  app = server;

  try {
    await server.listen({ port: config.PORT, host: config.SERVER_HOST });
    server.log.info(`Server listening on ${config.SERVER_HOST}:${config.PORT}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

// Graceful shutdown
const gracefulShutdown = async (signal: string) => {
  console.log(`Received ${signal}, shutting down gracefully...`);
  try {
    if (app) {
      await app.close();
    }
    process.exit(0);
  } catch (err) {
    console.error('Error during shutdown:', err);
    process.exit(1);
  }
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Start the server with proper error handling
start().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
