#!/bin/bash

# Weltmann Shopware MCP Deployment Script
# Usage: ./deploy.sh

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${BLUE}[DEPLOY]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Start deployment
print_status "Starting deployment for weltmann-shopware-mcp..."
echo "----------------------------------------"

# Check if we're in the right directory
if [ ! -f "package.json" ]; then
    print_error "package.json not found. Are you in the project root directory?"
    exit 1
fi

# Step 1: Pull latest changes
print_status "Step 1: Pulling latest changes from git..."
if git pull; then
    print_success "Git pull completed successfully"
else
    print_error "Git pull failed"
    exit 1
fi

# Step 2: Install/update dependencies (in case package.json changed)
print_status "Step 2: Installing/updating dependencies..."
if npm install; then
    print_success "Dependencies updated successfully"
else
    print_error "npm install failed"
    exit 1
fi

# Step 3: Build the project
print_status "Step 3: Building the project..."
if npm run build; then
    print_success "Build completed successfully"
else
    print_error "Build failed"
    exit 1
fi

# Step 4: Check if PM2 process exists
print_status "Step 4: Checking PM2 process status..."
if pm2 describe weltmann-shopware-mcp > /dev/null 2>&1; then
    print_status "PM2 process found. Restarting..."
    if npm run pm2:restart; then
        print_success "PM2 restart completed successfully"
    else
        print_error "PM2 restart failed"
        exit 1
    fi
else
    print_warning "PM2 process not found. Starting new process..."
    if npm run pm2:start; then
        print_success "PM2 start completed successfully"
    else
        print_error "PM2 start failed"
        exit 1
    fi
fi

# Step 5: Save PM2 configuration
print_status "Step 5: Saving PM2 configuration..."
if pm2 save; then
    print_success "PM2 configuration saved"
else
    print_warning "PM2 save failed (non-critical)"
fi

# Step 6: Show final status
print_status "Step 6: Checking final status..."
echo "----------------------------------------"
npm run pm2:status

echo "----------------------------------------"
print_success "Deployment completed successfully!"
print_status "Your application is now running with the latest changes."

# Show some useful information
echo ""
print_status "Useful commands:"
echo "  View logs: npm run pm2:logs"
echo "  Check status: npm run pm2:status"
echo "  Monitor: npm run pm2:monit"

# Check if server is responding
echo ""
print_status "Testing server health..."
sleep 2  # Give server a moment to start

if curl -s -f http://localhost:3000/healthz > /dev/null; then
    print_success "Server is responding to health check"
else
    print_warning "Server health check failed (may still be starting up)"
    print_status "Check logs with: npm run pm2:logs"
fi

echo ""
print_success "Deployment script completed!"