#!/bin/sh
set -eu

root_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
build_root="$(mktemp -d)"
trap 'rm -rf "$build_root"' EXIT
app_dir="$build_root/Selvedge.app"
contents="$app_dir/Contents"

cd "$root_dir"
npm run build:companion
mkdir -p "$contents/MacOS" "$contents/Resources"
mkdir -p "$root_dir/.build/swift-module-cache"
xcrun swiftc -parse-as-library -O -target arm64-apple-macos13.0 \
  -module-cache-path "$root_dir/.build/swift-module-cache" \
  -framework SwiftUI -framework AppKit -framework Security -framework ServiceManagement \
  mac/SelvedgeMac/SelvedgeMac.swift -o "$contents/MacOS/Selvedge"
cp mac/SelvedgeMac/Info.plist "$contents/Info.plist"
cp dist/client/selvedge-companion.mjs "$contents/Resources/selvedge-companion.mjs"
xattr -cr "$app_dir"
codesign --force --deep --sign - "$app_dir"
codesign --verify --deep --strict "$app_dir"
mkdir -p "$root_dir/dist/mac"
ditto -c -k --keepParent --norsrc --noextattr --noqtn --noacl "$app_dir" "$root_dir/dist/mac/Selvedge-for-Mac.zip"
echo "$root_dir/dist/mac/Selvedge-for-Mac.zip"
