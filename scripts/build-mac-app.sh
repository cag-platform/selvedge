#!/bin/sh
set -eu

root_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
build_root="$(mktemp -d)"
trap 'rm -rf "$build_root"' EXIT
app_dir="$build_root/Selvedge.app"
contents="$app_dir/Contents"
node_version="v22.23.0"
node_cache="$root_dir/.build/node-runtime"

ensure_node() {
  arch="$1"
  archive="node-$node_version-darwin-$arch.tar.gz"
  runtime_dir="$node_cache/node-$node_version-darwin-$arch"
  if [ -x "$runtime_dir/bin/node" ]; then return; fi
  curl -fsSL "https://nodejs.org/dist/$node_version/$archive" -o "$node_cache/$archive"
  if [ ! -f "$node_cache/SHASUMS256.txt" ]; then
    curl -fsSL "https://nodejs.org/dist/$node_version/SHASUMS256.txt" -o "$node_cache/SHASUMS256.txt"
  fi
  expected="$(awk -v file="$archive" '$2 == file { print $1 }' "$node_cache/SHASUMS256.txt")"
  actual="$(shasum -a 256 "$node_cache/$archive" | awk '{ print $1 }')"
  if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
    echo "The official Node runtime checksum did not match for $arch." >&2
    exit 1
  fi
  tar -xzf "$node_cache/$archive" -C "$node_cache"
}

cd "$root_dir"
npm run build:companion
mkdir -p "$node_cache"
ensure_node arm64
ensure_node x64
node --experimental-sea-config mac/SelvedgeMac/sea-config.json
mkdir -p "$contents/MacOS" "$contents/Resources"
mkdir -p "$root_dir/.build/swift-module-cache"
for arch in arm64 x86_64; do
  xcrun swiftc -parse-as-library -O -target "$arch-apple-macos13.0" \
    -module-cache-path "$root_dir/.build/swift-module-cache-$arch" \
    -framework SwiftUI -framework AppKit -framework Security -framework ServiceManagement \
    mac/SelvedgeMac/SelvedgeMac.swift -o "$build_root/Selvedge-$arch"
done
lipo -create "$build_root/Selvedge-arm64" "$build_root/Selvedge-x86_64" -output "$contents/MacOS/Selvedge"
cp mac/SelvedgeMac/Info.plist "$contents/Info.plist"
for node_arch in arm64 x64; do
  cp "$node_cache/node-$node_version-darwin-$node_arch/bin/node" "$build_root/selvedge-runtime-$node_arch"
  codesign --remove-signature "$build_root/selvedge-runtime-$node_arch" 2>/dev/null || true
  npx postject "$build_root/selvedge-runtime-$node_arch" NODE_SEA_BLOB dist/mac/selvedge-companion.blob \
    --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 --macho-segment-name NODE_SEA
done
lipo -create "$build_root/selvedge-runtime-arm64" "$build_root/selvedge-runtime-x64" -output "$contents/Resources/selvedge-runtime"
xattr -cr "$app_dir"
codesign --force --sign - "$contents/Resources/selvedge-runtime"
codesign --force --deep --sign - "$app_dir"
codesign --verify --deep --strict "$app_dir"
mkdir -p "$root_dir/dist/mac"
ditto -c -k --keepParent --norsrc --noextattr --noqtn --noacl "$app_dir" "$root_dir/dist/mac/Selvedge-for-Mac.zip"
echo "$root_dir/dist/mac/Selvedge-for-Mac.zip"
