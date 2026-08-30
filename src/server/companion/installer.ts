export function companionInstaller(origin: string): string {
  const download = `${origin.replace(/\/+$/, '')}/selvedge-companion.mjs`;
  return `#!/bin/sh
set -eu

if ! command -v node >/dev/null 2>&1; then
  echo "Selvedge needs Node 22 or newer. Install it from https://nodejs.org, then run this again." >&2
  exit 1
fi

major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$major" -lt 22 ]; then
  echo "Selvedge needs Node 22 or newer. This Mac has Node $(node --version)." >&2
  exit 1
fi

install_dir="$HOME/.local/bin"
mkdir -p "$install_dir"
curl -fsSL ${JSON.stringify(download)} -o "$install_dir/selvedge"
chmod 0755 "$install_dir/selvedge"

echo "Selvedge companion installed."
echo "Next: $install_dir/selvedge login --token YOUR_KEY"
`;
}
