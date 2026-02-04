# Shopware MCP Server

A Model Context Protocol (MCP) server for Shopware 6, designed for AI-powered customer support. Built for integration with voice agents (ElevenLabs) and LLM-based assistants.

## Features

- **Shopware 6 Integration**: Full Admin API integration for orders, products, and customers
- **MCP Protocol**: Streamable HTTP transport for AI model integration
- **Customer Support Tools**: Order status, payment status, shipping tracking
- **Product Search**: Vehicle-specific parts lookup by brand, model, and variant
- **Stock Checks**: Real-time inventory availability
- **Customer Lookup**: Find customers by phone, email, or name

## Architecture

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│  Voice Agent    │    │   MCP Server     │    │   Shopware 6    │
│  (ElevenLabs)   │───▶│   (Fastify)      │───▶│   Admin API     │
└─────────────────┘    └──────────────────┘    └─────────────────┘
                              │
                              ▼
                       ┌─────────────────┐
                       │  Product CSV    │
                       │  (in-memory)    │
                       └─────────────────┘
```

## MCP Tools

### Order Support
| Tool | Description |
|------|-------------|
| `check-order-status` | Shipping status and delivery estimates |
| `check-payment-status` | Payment status and method |
| `get-order-items` | List items in an order |
| `search-orders` | Find orders by number |

### Customer Support
| Tool | Description |
|------|-------------|
| `search-customer` | Find by phone, email, name, or customer number |
| `get-customer-orders` | Order history for a customer |

### Product Support
| Tool | Description |
|------|-------------|
| `search-product-catalog` | Search by name with vehicle filtering (brand/model/variant) |
| `search-product-number` | Lookup by SKU/product number |
| `get-stock-level` | Check inventory availability |

## Installation

1. **Clone and install**:
   ```bash
   git clone <repository-url>
   cd shopware-mcp
   npm install
   ```

2. **Configure environment** - create `.env`:
   ```env
   # Server
   PORT=3000
   SERVER_HOST=127.0.0.1
   NODE_ENV=production

   # Shopware 6 API
   SHOPWARE_API_URL=https://your-shop.com/api
   SHOPWARE_ACCESS_KEY_ID=your-access-key
   SHOPWARE_SECRET_ACCESS_KEY=your-secret-key

   # Security (required in production)
   MCP_API_KEY=your-secure-api-key

   # Optional
   CORS_ORIGIN=*
   RATE_LIMIT_WINDOW_MS=60000
   RATE_LIMIT_MAX_REQUESTS=100
   ```

3. **Add product catalog** - place CSV at `data/weltmannproducts.csv`:
   ```csv
   productNumber,productName,vehicleBrand,vehicleModel,vehicleVariant
   JA-000401,JAEGER automotive 7P Elektrosatz,BMW,5er,"Typ G30, Limousine"
   ```

4. **Build and start**:
   ```bash
   npm run build
   npm start
   ```

## Shopware API Setup

1. Log into Shopware 6 admin panel
2. Go to **Settings → System → Integrations**
3. Create new integration with permissions:
   - `product:read`
   - `order:read`
   - `customer:read`
4. Copy Access Key ID and Secret to `.env`

## Production Deployment

### Using PM2 (recommended)

```bash
npm install -g pm2
npm run build
npm run pm2:start

# Auto-start on reboot
pm2 save
pm2 startup
```

### PM2 Commands

```bash
npm run pm2:status   # Check status
npm run pm2:logs     # View logs
npm run pm2:restart  # Restart
npm run pm2:stop     # Stop
```

### Deploy Script

```bash
chmod +x deploy.sh
./deploy.sh
```

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `POST /mcp` | MCP protocol endpoint (for AI agents) |
| `GET /health` | Health check with service status |
| `GET /docs` | Swagger API documentation |

## Example MCP Request

```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-api-key" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": {
      "name": "check-order-status",
      "arguments": { "orderNumber": "10001" }
    },
    "id": 1
  }'
```

## Project Structure

```
shopware-mcp/
├── src/
│   ├── index.ts              # Server entry point
│   ├── config.ts             # Environment configuration
│   ├── plugins/
│   │   ├── mcp.ts            # MCP tools and endpoint
│   │   ├── shopware.ts       # Shopware client plugin
│   │   ├── csv.ts            # Product catalog loader
│   │   ├── security.ts       # API key auth & rate limiting
│   │   └── swagger.ts        # API documentation
│   ├── routes/
│   │   ├── products.ts       # Product endpoints
│   │   └── orders.ts         # Order endpoints
│   ├── shopware/
│   │   └── adminClient.ts    # Shopware Admin API client
│   └── utils/                # Utility functions
├── data/
│   └── weltmannproducts.csv  # Product catalog
└── dist/                     # Compiled output
```

## Troubleshooting

**Shopware API connection fails**
- Verify API URL ends with `/api`
- Check integration credentials
- Ensure integration has required permissions

**MCP endpoint returns 401**
- Set `MCP_API_KEY` in `.env`
- Include `X-API-Key` header in requests

**Products not found**
- Check `data/weltmannproducts.csv` exists
- Verify CSV has correct headers

## License

ISC License
