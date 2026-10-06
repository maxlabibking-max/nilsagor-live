# Nilsagor Live — Android Studio Project

This project packages the Nilsagor Live web app from `Nilsagor-Live-Radio-Studio-FUNCTIONAL.zip` into an Android WebView shell.

## Open in Android Studio
1. Open this folder in Android Studio.
2. Let Gradle sync.
3. Run on an Android device/emulator.
4. Build > Generate Signed Bundle / APK for a release AAB/APK.

## Important
- Firebase Web config is bundled from the supplied Nilsagor Live project.
- Camera and microphone permissions are declared and requested.
- WebView file picker is enabled for Tracks uploads.
- JavaScript, DOM storage, media playback and cookies are enabled.
- Public TV/radio playback still depends on the remote stream source being available and browser-compatible.
- This is a build-ready Android Studio project. A signed production APK/AAB requires an Android SDK/Gradle environment and your release keystore.

## Recommended release
Use **AAB** for Google Play. Use a signed **APK** for direct installation/testing.
