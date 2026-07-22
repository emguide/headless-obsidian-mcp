#!/bin/bash
set -euo pipefail

# Change to the project directory
cd "$(dirname "$0")"

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
  npm install
fi

# Build if the compiled output is missing
if [ ! -f "dist/index.js" ]; then
  npm run build
fi

# Start the MCP server
exec node dist/index.js
