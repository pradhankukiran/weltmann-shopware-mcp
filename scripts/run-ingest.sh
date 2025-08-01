#!/bin/bash

# Run the ingest script with garbage collection enabled and memory monitoring
echo "Starting optimized ingest script..."
echo "Memory monitoring enabled, reduced batch size for better stability"

# Enable garbage collection for better memory management
node --expose-gc --max-old-space-size=2048 dist/scripts/ingest-products.js

echo "Ingest completed!"