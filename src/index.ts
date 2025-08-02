import fastify from 'fastify';
import { registerSwagger } from './plugins/swagger';
import { loadConfig } from './config';
import * as os from 'os';
import axios from 'axios';

async function buildServer() {
  const config = loadConfig();
  const app = fastify({ logger: true });

  // Register plugins
  await app.register(registerSwagger);
  await app.register((await import('./plugins/shopware')).registerShopware);

  // Register routes
  await app.register((await import('./routes/products')).default);
  await app.register((await import('./routes/orders')).default);

  // LanceDB plugin (vector store)
  await app.register((await import('./plugins/lancedb')).registerLanceDB);

  // MCP plugin (streamable HTTP)
  await app.register((await import('./plugins/mcp')).registerMcp);

  // Dynamic favicon route
  app.get('/favicon.ico', async (request, reply) => {
    // Check service statuses for favicon color
    let lancedbStatus = 'error';
    let shopwareStatus = 'error';
    let mcpStatus = 'error';

    // Test LanceDB connection
    try {
      const table = app.lance?.productsTable;
      if (table) {
        await table.countRows();
        lancedbStatus = 'connected';
      }
    } catch (error) {
      lancedbStatus = 'error';
    }

    // Test Shopware connection
    try {
      if (app.shopware) {
        await app.shopware.get('/_info/version');
        shopwareStatus = 'connected';
      }
    } catch (error) {
      shopwareStatus = 'error';
    }

    // Test MCP tools (lightweight test)
    try {
      if (app.shopware) {
        // Test the same functionality that MCP tools rely on
        await app.shopware.searchProductsByNumber('JA-000001', true);
        mcpStatus = 'connected';
      }
    } catch (error) {
      mcpStatus = 'error';
    }

    // Determine favicon color based on all service statuses
    const connectedServices = [lancedbStatus, shopwareStatus, mcpStatus].filter(s => s === 'connected').length;
    const totalServices = 3;
    
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
    const startTime = process.hrtime.bigint();
    const memoryUsage = process.memoryUsage();
    const uptime = process.uptime();
    
    const healthData = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: Math.floor(uptime),
      version: process.env.npm_package_version || '1.0.0',
      environment: process.env.NODE_ENV || 'development',
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
      processId: process.pid,
      startTime: new Date(Date.now() - uptime * 1000).toISOString(),
      cpuUsage: Math.round((process.cpuUsage().user + process.cpuUsage().system) / 1000) / 1000,
      memory: {
        rss: Math.round(memoryUsage.rss / 1024 / 1024),
        heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024),
        heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024),
        external: Math.round(memoryUsage.external / 1024 / 1024),
        buffers: Math.round((memoryUsage as any).buffers / 1024 / 1024) || 0,
        heapUtilization: Math.round((memoryUsage.heapUsed / memoryUsage.heapTotal) * 100),
        totalSystemMemory: Math.round(os.totalmem() / 1024 / 1024 / 1024 * 100) / 100,
        freeSystemMemory: Math.round(os.freemem() / 1024 / 1024 / 1024 * 100) / 100,
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
      services: {} as Record<string, any>,
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
      } else {
        healthData.services.lancedb = {
          status: 'not_initialized',
          error: 'LanceDB table not found'
        };
      }
    } catch (error) {
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
        
        const versionData = versionResponse.data as any;
        healthData.services.shopware = {
          status: 'connected',
          apiUrl: config.SHOPWARE_API_URL,
          version: versionData?.version || 'unknown',
          versionRevision: versionData?.versionRevision || 'unknown',
          responseTime: versionResponse.headers?.['x-response-time'] || 'unknown'
        };
      } else {
        healthData.services.shopware = {
          status: 'not_initialized',
          error: 'Shopware client not found'
        };
      }
    } catch (error) {
      healthData.services.shopware = {
        status: 'error',
        error: error instanceof Error ? error.message : 'Connection failed',
        apiUrl: config.SHOPWARE_API_URL,
        details: error instanceof Error && 'response' in error 
          ? `HTTP ${(error as any).response?.status} - ${(error as any).response?.statusText}`
          : 'Network or configuration error'
      };
    }

    // Test MCP tools by making actual HTTP call to the MCP endpoint
    try {
      const testProductNumber = 'JA-000001';
      
      // Make a real MCP tool call via HTTP JSON-RPC
      const mcpRequest = {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "get-stock-level",
          arguments: {
            productNumber: testProductNumber
          }
        },
        id: 1
      };

      const mcpResponse = await axios.post(`http://localhost:${config.PORT}/mcp`, mcpRequest, {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream'
        },
        timeout: 5000,
        validateStatus: () => true // Don't throw on HTTP error codes
      });

      if (mcpResponse.status === 200) {
        const responseBody = mcpResponse.data;
        
        if (responseBody.error) {
          healthData.services.mcp = {
            status: 'error',
            testTool: 'get-stock-level',
            testProductNumber: testProductNumber,
            error: `JSON-RPC error: ${responseBody.error.message}`,
            errorCode: responseBody.error.code
          };
        } else {
          // MCP tool call succeeded
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
          error: `HTTP ${mcpResponse.status}: ${mcpResponse.statusText}`,
          responseBody: typeof mcpResponse.data === 'string' ? mcpResponse.data.substring(0, 200) : JSON.stringify(mcpResponse.data).substring(0, 200)
        };
      }
    } catch (error) {
      let errorMessage = 'Unknown error';
      let isNetworkError = false;
      
      if (axios.isAxiosError(error)) {
        if (error.code === 'ECONNREFUSED') {
          errorMessage = 'Connection refused - MCP endpoint not available';
          isNetworkError = true;
        } else if (error.code === 'ETIMEDOUT') {
          errorMessage = 'Request timeout - MCP endpoint not responding';
          isNetworkError = true;
        } else if (error.response) {
          errorMessage = `HTTP ${error.response.status}: ${error.response.statusText}`;
        } else {
          errorMessage = error.message;
          isNetworkError = true;
        }
      } else if (error instanceof Error) {
        errorMessage = error.message;
      }
      
      healthData.services.mcp = {
        status: 'error',
        testTool: 'get-stock-level',
        testProductNumber: testProductNumber,
        error: errorMessage,
        errorType: isNetworkError ? 'network' : 'unknown'
      };
    }

    // Calculate response time
    const endTime = process.hrtime.bigint();
    const responseTimeMs = Number(endTime - startTime) / 1000000;
    healthData.responseTime = Math.round(responseTimeMs * 100) / 100;

    // Determine overall health status
    const hasErrors = Object.values(healthData.services).some(
      service => service.status === 'error'
    );
    
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

  return { app, config } as const;
}

function generateFaviconSVG(color: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
  <circle cx="16" cy="16" r="14" fill="${color}" stroke="white" stroke-width="2"/>
</svg>`;
}

function generateHealthHTML(healthData: any): string {

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
        .memory-chart-section {
            margin: 16px 0;
            display: flex;
            align-items: center;
            gap: 24px;
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
                    <div class="info-item">
                        <div class="info-label">CPU Usage</div>
                        <div class="info-value">${healthData.cpuUsage}ms</div>
                    </div>
                    <div class="info-item">
                        <div class="info-label">Node.js</div>
                        <div class="info-value">${healthData.nodeVersion}</div>
                    </div>
                    <div class="info-item">
                        <div class="info-label">Platform</div>
                        <div class="info-value">${healthData.platform}</div>
                    </div>
                    <div class="info-item">
                        <div class="info-label">Process ID</div>
                        <div class="info-value">${healthData.processId}</div>
                    </div>
                    <div class="info-item">
                        <div class="info-label">Start Date</div>
                        <div class="info-value">${new Date(healthData.startTime).toLocaleDateString('en-GB')}</div>
                    </div>
                    <div class="info-item">
                        <div class="info-label">Start Time</div>
                        <div class="info-value">${new Date(healthData.startTime).toLocaleTimeString('en-GB', { hour12: false })}</div>
                    </div>
                </div>
            </div>

            <!-- Memory Usage Card -->
            <div class="card">
                <h3>Memory Usage</h3>
                <div class="memory-section">
                    <div class="memory-header">
                        <span>Heap Memory (${healthData.memory.heapUtilization}%)</span>
                        <span>${healthData.memory.heapUsed}MB / ${healthData.memory.heapTotal}MB</span>
                    </div>
                    <div class="memory-bar">
                        <div class="memory-fill" style="width: ${healthData.memory.heapUtilization}%;"></div>
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
                            <span>Process (${healthData.memory.systemMemoryChart.processPercent}%) - ${healthData.memory.systemMemoryChart.processMB}MB</span>
                        </div>
                        <div class="legend-item">
                            <div class="legend-color legend-free"></div>
                            <span>Available (${healthData.memory.systemMemoryChart.freePercent}%) - ${healthData.memory.systemMemoryChart.freeMB}MB</span>
                        </div>
                        <div class="legend-item">
                            <div class="legend-color legend-other"></div>
                            <span>Other Processes (${healthData.memory.systemMemoryChart.otherPercent}%) - ${healthData.memory.systemMemoryChart.otherMB}MB</span>
                        </div>
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
                    <div class="info-item">
                        <div class="info-label">Buffer Memory</div>
                        <div class="info-value">${healthData.memory.buffers}MB</div>
                    </div>
                    <div class="info-item">
                        <div class="info-label">System Memory</div>
                        <div class="info-value">${healthData.memory.totalSystemMemory}GB</div>
                    </div>
                </div>
            </div>

            <!-- Services Card -->
            <div class="card">
                <h3>Services Status</h3>
                ${Object.entries(healthData.services).map(([name, service]: [string, any]) => `
                    <div class="service-status">
                        <div class="service-icon service-${service.status}"></div>
                        <div class="service-info">
                            <div class="service-name">${name === 'lancedb' ? 'LanceDB' : name === 'mcp' ? 'MCP' : name.charAt(0).toUpperCase() + name.slice(1)}</div>
                            <div class="service-details">
                                ${service.status === 'connected' 
                                  ? name === 'lancedb' 
                                    ? `${service.recordCount.toLocaleString()} records in ${service.tableName} table`
                                    : name === 'mcp'
                                    ? `test: ${service.testResult}`
                                    : `Version ${service.version} • ${service.apiUrl}`
                                  : name === 'mcp' && service.errorCode
                                  ? `${service.error}<br>Product: ${service.testProductNumber || 'n/a'}${service.errorCode ? `<br>Code: ${service.errorCode}` : ''}`
                                  : service.error || 'Unknown error'
                                }
                            </div>
                        </div>
                    </div>
                `).join('')}
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

async function start() {
  const { app, config } = await buildServer();

  try {
    await app.listen({ port: config.PORT, host: '0.0.0.0' });
    app.log.info(`Server listening on port ${config.PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void start(); 