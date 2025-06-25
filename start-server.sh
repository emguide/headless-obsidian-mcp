#!/bin/bash
set -euo pipefail

# Change to the project directory
cd "$(dirname "$0")"

# Execute mise with the start task
exec mise run start