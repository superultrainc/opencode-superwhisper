#!/bin/bash
set -e

CONFIG="$HOME/.config/opencode/opencode.json"
PLUGIN="@superwhisper/opencode"

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
if plugin in plugins:
    print(f"Superwhisper plugin already installed.")
    sys.exit(0)

plugins.append(plugin)
config["plugin"] = plugins

with open(config_path, "w") as f:
    json.dump(config, f, indent=2)

print("Superwhisper plugin installed. Restart opencode to activate.")
EOF
