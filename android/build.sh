#!/bin/bash
# Builds TripTrack.apk with plain Android SDK tools (no Gradle).
set -euo pipefail
cd "$(dirname "$0")"

SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
BT="$SDK/build-tools/34.0.0"
PLATFORM="$SDK/platforms/android-34/android.jar"
OUT=build

rm -rf "$OUT"
mkdir -p "$OUT/obj"

# 1. Compile res/ (e.g. the network security config) and link it + the manifest into a base APK.
"$BT/aapt2" compile --dir res -o "$OUT/res.zip"
"$BT/aapt2" link -o "$OUT/app.unaligned.apk" -I "$PLATFORM" --manifest AndroidManifest.xml -R "$OUT/res.zip" --auto-add-overlay

# 2. Compile Java against the Android platform.
javac -source 8 -target 8 -bootclasspath "$PLATFORM" -classpath "$PLATFORM" -nowarn \
  -d "$OUT/obj" src/com/triptrack/app/MainActivity.java

# 3. Dex the classes and add them to the APK.
"$BT/d8" --lib "$PLATFORM" --release --output "$OUT" $(find "$OUT/obj" -name '*.class')
(cd "$OUT" && zip -qu app.unaligned.apk classes.dex)

# 4. Align and sign with the standard debug keystore.
KEYSTORE="$HOME/.android/debug.keystore"
if [ ! -f "$KEYSTORE" ]; then
  keytool -genkeypair -keystore "$KEYSTORE" -storepass android -keypass android \
    -alias androiddebugkey -dname "CN=Android Debug,O=Android,C=US" \
    -keyalg RSA -keysize 2048 -validity 10000
fi
"$BT/zipalign" -f 4 "$OUT/app.unaligned.apk" "$OUT/TripTrack.apk"
"$BT/apksigner" sign --ks "$KEYSTORE" --ks-pass pass:android --key-pass pass:android "$OUT/TripTrack.apk"

echo "Built: $(pwd)/$OUT/TripTrack.apk"
