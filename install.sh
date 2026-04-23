#!/bin/bash
set -e

CONFIG="$HOME/.config/opencode/opencode.json"
PLUGIN="@superwhisper/opencode@latest"

mkdir -p "$(dirname "$CONFIG")"

python3 - "$CONFIG" "$PLUGIN" <<'EOF'
import sys, json, os

config_path = sys.argv[1]
plugin = sys.argv[2]

if os.path.exists(config_path):
    with open(config_path) as f:
        config = json.load(f)
else:
    config = {"$schema": "https://opencode.ai/config.json"}

plugins = config.get("plugin", [])
if plugin not in plugins:
    plugins.append(plugin)
    config["plugin"] = plugins
    with open(config_path, "w") as f:
        json.dump(config, f, indent=2)
    print("Superwhisper plugin installed.")
else:
    print("Superwhisper plugin already configured, checking for updates...")
print("Restart opencode to activate.")
EOF

OPENCODE_DIR="$HOME/.config/opencode"
PLUGIN_NAME="@superwhisper/opencode"
if command -v bun &>/dev/null; then
    bun pm cache rm "$PLUGIN_NAME" 2>/dev/null || true
    cd "$OPENCODE_DIR" && bun add "$PLUGIN"
elif command -v npm &>/dev/null; then
    npm --prefix "$OPENCODE_DIR" install "$PLUGIN"
fi

# Also sync to opencode's own plugin cache if it exists
OPENCODE_CACHE="$HOME/.cache/opencode/packages/@superwhisper/opencode@latest/node_modules/@superwhisper/opencode"
CONFIG_INSTALL="$HOME/.config/opencode/node_modules/@superwhisper/opencode"
if [ -d "$OPENCODE_CACHE" ] && [ -f "$CONFIG_INSTALL/dist/index.js" ]; then
    cp "$CONFIG_INSTALL/dist/index.js" "$OPENCODE_CACHE/dist/index.js"
    cp "$CONFIG_INSTALL/package.json" "$OPENCODE_CACHE/package.json"
fi

open "superwhisper://agent-installed?agent=opencode"
