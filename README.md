# Shopware MCP Integration

A comprehensive Model Context Protocol (MCP) integration for Shopware 6, providing AI-powered product search, order management, and customer service capabilities through a modern API server.

##  Features

- **Shopware 6 Integration**: Full Admin API integration for product and order management
- **Vector Search**: LanceDB-powered fuzzy product search with semantic understanding
- **MCP Protocol**: Streamable HTTP transport for AI model integration
- **Real-time Product Search**: Multiple search methods including SKU, name, and vector similarity
- **Order Management**: Complete order tracking, status updates, and customer service tools
- **Vehicle-Specific Search**: Automotive parts filtering by brand, model, and variant
- **Stock Management**: Real-time inventory tracking and availability checks
- **Payment & Shipping**: Comprehensive order status and delivery tracking
- **RESTful API**: Fastify-based server with Swagger documentation
- **TypeScript**: Full type safety and modern development experience

##  Architecture

The system is built with a modular plugin architecture:

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   Fastify API   │────│   Shopware 6     │────│   LanceDB       │
│   Server        │    │   Admin API      │    │   Vector Store  │
└─────────────────┘    └──────────────────┘    └─────────────────┘
         │                        │                        │
         ├── Swagger UI           ├── Products API         ├── Product Embeddings
         ├── MCP Endpoint         ├── Orders API           └── Semantic Search
         ├── CORS Support         └── Stock Management
         └── Health Checks
```

### Core Components

- **Plugins**: Shopware client, LanceDB integration, MCP server, Swagger docs
- **Routes**: Product search, order management endpoints
- **Utils**: Text embedding and data processing utilities
- **Tools**: MCP tool definitions for AI model integration

##  Prerequisites

- **Node.js**: Version 18+ with npm/yarn
- **TypeScript**: For development and compilation
- **Shopware 6**: Running instance with Admin API access
- **OpenAI API**: For text embeddings (optional, for vector search)

##  Installation

1. **Clone the repository**:
   ```bash
   git clone <repository-url>
   cd shopware-mcp
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Configure environment variables** (see Configuration section below)

4. **Build the project**:
   ```bash
   npm run build
   ```

5. **Start the server**:
   ```bash
   # Development mode with hot reload
   npm run dev
   
   # Production mode
   npm start
   
   # Production with PM2 (recommended for deployment)
   npm run pm2:start
   ```

##  Configuration

Create a `.env` file in the project root with the following variables:

```env
# Server Configuration
PORT=3000

# Shopware 6 Configuration
SHOPWARE_API_URL=https://your-shopware-instance.com/api
SHOPWARE_ACCESS_KEY_ID=your-access-key-id
SHOPWARE_SECRET_ACCESS_KEY=your-secret-access-key

# OpenAI Configuration (for vector search)
OPENAI_API_KEY=your-openai-api-key
```

### Shopware API Credentials

1. Log into your Shopware 6 admin panel
2. Go to Settings → System → Integrations
3. Create a new integration with the following permissions:
   - `product:read`
   - `order:read`
   - `customer:read`
4. Copy the Access Key ID and Secret Access Key to your `.env` file


### Starting the Server

```bash
# Development with auto-reload
npm run dev

# Production build and start
npm run build && npm start

# Production with PM2 process manager (recommended for deployment)
npm run build && npm run pm2:start
```

The server will start on `http://localhost:3000` (or your configured PORT).

### PM2 Production Deployment

For production deployments, especially on cloud servers like EC2, use PM2 for process management:

```bash
# First, install PM2 globally
npm install -g pm2

# Build and start with PM2
npm run build
npm run pm2:start

# Monitor your application
npm run pm2:status
npm run pm2:logs

# Setup auto-start on server reboot
pm2 save
pm2 startup
# Follow the command output to setup startup script

# Other PM2 commands
npm run pm2:restart  # Restart the application
npm run pm2:stop     # Stop the application
npm run pm2:monit    # Real-time monitoring dashboard
```

**PM2 Benefits:**
- Auto-restart on crashes
- Memory leak protection (auto-restart on memory limit)
- Zero-downtime deployments
- Built-in load balancing
- Process monitoring and logging
- Startup script generation for server reboots

### Automated Deployment

For easy deployments, use the provided deployment script:

```bash
# Make the script executable (first time only)
chmod +x deploy.sh

# Deploy latest changes
./deploy.sh
```

**What the deployment script does:**
1. Pulls latest changes from git
2. Updates dependencies (`npm install`)
3. Builds the project (`npm run build`)
4. Restarts/starts PM2 process
5. Saves PM2 configuration
6. Shows final status and runs health check

**Manual deployment** (if you prefer step-by-step):
```bash
git pull
npm install
npm run build
npm run pm2:restart
npm run pm2:status
```

### API Endpoints

- **Health Check**: `GET /health`
- **Swagger Documentation**: `GET /docs`
- **Product Search**: `GET /v1/products/search?term=keyword&limit=10`
- **MCP Endpoint**: `POST /mcp` (for AI model integration)

### Using the Vector Search

The system includes a powerful vector-based product search that understands semantic meaning:

```bash
# Search for brake pads
curl "http://localhost:3000/v1/products/search?term=brake%20pads&limit=5"

# Search with vehicle filtering (via MCP)
# This requires using the MCP endpoint with appropriate tool calls
```

##  MCP Tools

The system provides several MCP tools for AI integration:

### Product Tools

- **`search-product-number`**: Find products by exact SKU/product number
- **`search-product-vector`**: Semantic search with vehicle filtering
- **`get-stock-level`**: Check inventory levels for specific products

### Order Tools

- **`search-orders`**: Find orders by number or list recent orders
- **`check-order-status`**: Get customer-friendly order status
- **`check-payment-status`**: Check payment status and method
- **`get-order-items`**: List items in a specific order

### Example MCP Tool Usage

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "search-product-vector",
    "arguments": {
      "name": "brake disc",
      "vehicleBrand": "BMW",
      "vehicleModel": "3 Series",
      "vehicleVariant": "E90"
    }
  },
  "id": 1
}
```

##  Vector Database

The system uses LanceDB for semantic product search:

- **Storage**: `./lancedb/products.lance`
- **Embeddings**: OpenAI text-embedding-ada-002
- **Indexing**: Products are embedded with name and description
- **Filtering**: Supports vehicle-specific filtering (brand, model, variant)

### Product Data Ingestion

Use the provided script to import and embed product data:

```bash
# Run the product ingestion script
npx ts-node scripts/ingest-products.ts
```

This will:
1. Read product data from CSV files
2. Generate embeddings for product names
3. Store vectors in LanceDB for fast similarity search

##  Project Structure

```
shopware-mcp/
├── src/
│   ├── config.ts              # Environment configuration
│   ├── index.ts              # Main server entry point
│   ├── plugins/              # Fastify plugins
│   │   ├── shopware.ts       # Shopware API client
│   │   ├── lancedb.ts        # Vector database integration
│   │   ├── mcp.ts           # MCP server and tools
│   │   └── swagger.ts        # API documentation
│   ├── routes/               # API route handlers
│   │   ├── products.ts       # Product search endpoints
│   │   └── orders.ts         # Order management endpoints
│   ├── shopware/             # Shopware-specific logic
│   │   └── adminClient.ts    # Admin API client
│   └── utils/                # Utility functions
│       └── embed.ts          # Text embedding utilities
├── scripts/                  # Data processing scripts
│   └── ingest-products.ts    # Product data ingestion
├── tools/                    # MCP tool definitions
│   ├── productSearch.tool.json
│   └── search-product-vector.tool.json
├── data/                     # Sample data files
├── lancedb/                  # Vector database storage
└── dist/                     # Compiled JavaScript output
```

##  Development

### Available Scripts

```bash
# Development server with hot reload
npm run dev

# Type checking
npx tsc --noEmit

# Linting
npm run lint

# Testing
npm test

# Build for production
npm run build

# PM2 process management (production)
npm run pm2:start    # Start with PM2
npm run pm2:stop     # Stop the process
npm run pm2:restart  # Restart the process
npm run pm2:logs     # View logs
npm run pm2:status   # Check status
npm run pm2:monit    # Real-time monitoring
```

### Adding New MCP Tools

1. Define tool schema in `src/plugins/mcp.ts`
2. Implement tool handler with proper input/output validation
3. Register the tool with the MCP server
4. Add corresponding API endpoint if needed

### Debugging

Enable debug logging by setting the log level:

```bash
LOG_LEVEL=debug npm run dev
```

##  Troubleshooting

### Common Issues

**1. Shopware API Connection Fails**
- Verify your Shopware instance is accessible
- Check API credentials in `.env` file
- Ensure integration has proper permissions

**2. Vector Search Not Working**
- Verify OpenAI API key is set
- Check if products have been ingested: `ls -la lancedb/`
- Run product ingestion script if database is empty

**3. MCP Tools Return Errors**
- Check request format matches tool schema
- Verify all required parameters are provided
- Enable debug logging to see detailed error messages

**4. Port Already in Use**
- Change PORT in `.env` file
- Kill existing processes: `lsof -ti:3000 | xargs kill`

### Performance Optimization

- **Vector Search**: Adjust search parameters in LanceDB queries
- **API Caching**: Implement Redis for frequently accessed data
- **Database Indexing**: Ensure proper Shopware database indexes
- **Memory Usage**: Monitor Node.js heap for large product catalogs

##  Monitoring

The server includes built-in health checks and logging:

- **Health Endpoint**: `GET /health`
- **Structured Logging**: JSON format with request tracing
- **Error Handling**: Comprehensive error responses with context

##  Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/new-feature`
3. Make your changes and add tests
4. Ensure code passes linting: `npm run lint`
5. Submit a pull request

##  License

This project is licensed under the ISC License. See the `LICENSE` file for details.

##  Resources

- [Shopware 6 Admin API Documentation](https://shopware.stoplight.io/docs/admin-api)
- [Model Context Protocol Specification](https://modelcontextprotocol.io/)
- [LanceDB Documentation](https://lancedb.github.io/lancedb/)
- [Fastify Framework](https://www.fastify.io/)

---

For support and questions, please open an issue on the project repository.