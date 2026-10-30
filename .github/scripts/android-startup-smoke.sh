#!/usr/bin/env bash
set -euo pipefail
mkdir -p diagnostics
adb install apk/app-release.apk
adb logcat -c
adb shell am start -W -n ai.multica.mobile/.MainActivity
sleep 30
adb logcat -d > diagnostics/logcat.txt
adb shell dumpsys activity activities > diagnostics/activities.txt
adb exec-out screencap -p > diagnostics/screen.png
adb shell uiautomator dump /sdcard/window.xml || true
adb pull /sdcard/window.xml diagnostics/window.xml || true
adb shell pidof ai.multica.mobile
if grep -E 'FATAL EXCEPTION|Fatal signal|JavascriptException' diagnostics/logcat.txt; then
  exit 1
fi
grep -q 'ai.multica.mobile' diagnostics/window.xml
grep -q 'Sign in to Multica' diagnostics/window.xml
