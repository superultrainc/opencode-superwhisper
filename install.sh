#!/bin/bash
set -e

if ! command -v opencode &>/dev/null; then
    echo "opencode CLI not found. Install from https://opencode.ai first." >&2
    exit 1
fi

opencode plugin -g -f @superwhisper/opencode </dev/null

open "superwhisper://agent-installed?agent=opencode"
