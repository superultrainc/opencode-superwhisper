#!/bin/bash
set -e

PLUGIN="@superwhisper/opencode"

# Prints "major minor patch" from `<cli> --version`, or nothing.
cli_version() {
    local v
    v="$("$1" --version </dev/null 2>/dev/null | head -n 1)"
    v="${v##* }"
    v="${v#v}"
    [[ "$v" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+) ]] || return 0
    echo "${BASH_REMATCH[1]} ${BASH_REMATCH[2]} ${BASH_REMATCH[3]}"
}

# OpenCode 2 ships as @opencode-ai/cli (linked as `opencode2`) and uses `plugin add`.
is_v2() {
    local bin major
    [[ "$1" == "opencode2" ]] && return 0
    bin="$(command -v "$1")" || return 1
    [[ "$(readlink "$bin" 2>/dev/null)" == *"@opencode-ai/cli"* ]] && return 0
    read -r major _ <<<"$(cli_version "$1")"
    [[ -n "$major" && "$major" -ge 2 ]]
}

# `opencode plugin` exists from 1.3.4; older 1.x reads the config file directly.
has_plugin_command() {
    local major minor patch
    read -r major minor patch <<<"$(cli_version "$1")"
    [[ -n "$major" ]] || return 1
    (( major > 1 || (major == 1 && (minor > 3 || (minor == 3 && patch >= 4))) ))
}

add_to_config() {
    python3 - "$HOME/.config/opencode/opencode.json" "$PLUGIN" <<'PY'
import json, os, sys
path, plugin = sys.argv[1], sys.argv[2]
config = {"$schema": "https://opencode.ai/config.json"}
if os.path.exists(path):
    try:
        with open(path) as f:
            config = json.load(f)
    except ValueError:
        sys.exit(f"Couldn't parse {path}. Add \"{plugin}\" to its \"plugin\" list manually.")
plugins = config.setdefault("plugin", [])
if not any(p == plugin or str(p).startswith(plugin + "@") for p in plugins):
    plugins.append(plugin)
os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, "w") as f:
    json.dump(config, f, indent=2)
PY
}

install_for() {
    if is_v2 "$1"; then
        echo "Installing for OpenCode 2 ($1)..."
        "$1" plugin add "$PLUGIN" </dev/null
    elif has_plugin_command "$1"; then
        echo "Installing for OpenCode 1 ($1)..."
        "$1" plugin -g -f "$PLUGIN" </dev/null
    else
        echo "Installing for OpenCode 1 ($1, config file)..."
        add_to_config
    fi
}

installed=0
failed=0
seen=""
for cli in opencode opencode2; do
    command -v "$cli" &>/dev/null || continue
    kind=v1
    is_v2 "$cli" && kind=v2
    [[ "$seen" == *"$kind"* ]] && continue
    seen="$seen $kind"
    if install_for "$cli"; then
        installed=1
    else
        echo "Install for $cli failed." >&2
        failed=1
    fi
done

if [[ "$installed" == 0 ]]; then
    [[ "$failed" == 0 ]] && echo "opencode CLI not found. Install from https://opencode.ai first." >&2
    exit 1
fi

open "superwhisper://agent-installed?agent=opencode"
