#!/bin/bash
# Setup Android emulator + Frida for Hik-Connect protocol capture
#
# Prerequisites: Android SDK cmdline-tools installed at ~/android-sdk
# Usage: bash scripts/frida/setup-emulator.sh

set -euo pipefail

SDK="$HOME/android-sdk"
export ANDROID_HOME="$SDK"
export PATH="$SDK/cmdline-tools/latest/bin:$SDK/platform-tools:$SDK/emulator:$PATH"

echo "=== Step 1: Create AVD ==="
echo "no" | avdmanager create avd \
    --name hiktest \
    --package "system-images;android-34;google_apis;x86_64" \
    --device "pixel_6" \
    --force

echo "=== Step 2: Start emulator (headless) ==="
emulator -avd hiktest -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect &
EMULATOR_PID=$!
echo "Emulator PID: $EMULATOR_PID"

echo "=== Step 3: Wait for boot ==="
adb wait-for-device
adb shell 'while [[ -z $(getprop sys.boot_completed) ]]; do sleep 1; done'
echo "Emulator booted!"

echo "=== Step 4: Install Frida server ==="
FRIDA_VERSION=$(frida --version 2>/dev/null || echo "16.7.19")
ARCH="x86_64"
FRIDA_SERVER="frida-server-${FRIDA_VERSION}-android-${ARCH}"
if [ ! -f "/tmp/${FRIDA_SERVER}" ]; then
    echo "Downloading Frida server ${FRIDA_VERSION} for ${ARCH}..."
    curl -sL "https://github.com/frida/frida/releases/download/${FRIDA_VERSION}/${FRIDA_SERVER}.xz" -o "/tmp/${FRIDA_SERVER}.xz"
    xz -d "/tmp/${FRIDA_SERVER}.xz"
fi
adb push "/tmp/${FRIDA_SERVER}" /data/local/tmp/frida-server
adb shell "chmod 755 /data/local/tmp/frida-server"

echo "=== Step 5: Start Frida server ==="
adb shell "/data/local/tmp/frida-server &" &

echo "=== Step 6: Install Hik-Connect APK ==="
XAPK_DIR="/tmp/hikconnect-re/xapk"
if [ -f "$XAPK_DIR/com.connect.enduser.apk" ]; then
    echo "Installing base APK..."
    adb install "$XAPK_DIR/com.connect.enduser.apk"
    echo "Installing config APKs..."
    adb install "$XAPK_DIR/config.en.apk" 2>/dev/null || true
    adb install "$XAPK_DIR/config.xxhdpi.apk" 2>/dev/null || true
else
    echo "ERROR: APK not found at $XAPK_DIR/com.connect.enduser.apk"
    echo "Extract the XAPK first."
    exit 1
fi

echo ""
echo "=== READY ==="
echo "Emulator running, Frida server started, Hik-Connect installed."
echo ""
echo "Next steps:"
echo "  1. Open Hik-Connect in emulator: adb shell am start -n com.connect.enduser/.main.MainActivity"
echo "  2. Login to your account in the app"
echo "  3. Run Frida hook: frida -U -f com.connect.enduser -l scripts/frida/hook-stream.js --no-pause"
echo "  4. Open a camera live view in the app"
echo "  5. Capture protocol data from Frida output"
echo ""
echo "To stop: kill $EMULATOR_PID"
