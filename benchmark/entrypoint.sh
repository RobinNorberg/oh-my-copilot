#!/bin/bash
set -e

echo "=== SWE-bench Evaluation Environment ==="
echo "Run Mode: ${RUN_MODE:-vanilla}"
echo "Copilot CLI version: $(copilot --version 2>/dev/null || echo 'not installed')"

# Configure Copilot CLI if auth token is provided
if [ -n "$ANTHROPIC_AUTH_TOKEN" ]; then
    echo "Anthropic auth token configured"
    export ANTHROPIC_AUTH_TOKEN="$ANTHROPIC_AUTH_TOKEN"
else
    echo "WARNING: ANTHROPIC_AUTH_TOKEN not set"
fi

# Configure custom base URL if provided
if [ -n "$ANTHROPIC_BASE_URL" ]; then
    echo "Using custom Anthropic base URL: $ANTHROPIC_BASE_URL"
    export ANTHROPIC_BASE_URL="$ANTHROPIC_BASE_URL"
fi

# Install OMP if in omp mode
if [ "$RUN_MODE" = "omp" ]; then
    echo "Installing oh-my-copilot for enhanced mode..."

    # Check if OMP source is mounted
    if [ -d "/workspace/omp-source" ]; then
        echo "Installing OMP from mounted source..."
        cd /workspace/omp-source && npm install && npm link
    else
        echo "Installing OMP from npm..."
        npm install -g oh-my-copilot
    fi

    # Initialize OMP configuration
    mkdir -p ~/.copilot

    echo "OMP installation complete"
fi

# Execute the command passed to the container
exec "$@"
