# Nilsagor Live — Build APK/AAB from phone with GitHub Actions

## Phone-only workflow
1. Create a GitHub repository.
2. Upload the **contents** of this `Nilsagor-Live-Android` folder (not the outer folder itself if you want the repository root to contain `app/`).
3. Open **Actions** in GitHub.
4. Select **Build Nilsagor Live Android**.
5. Tap **Run workflow**.
6. Wait for the green check.
7. Open the workflow run and scroll to **Artifacts**.
8. Download `Nilsagor-Live-Android-build`.

The artifact contains:
- Debug APK: installable directly on an Android phone for testing.
- Release AAB: suitable as a build artifact for Google Play; for Play Store publishing it should be signed with your own release keystore.

## Important
- GitHub Actions availability depends on your repository/account plan and whether the repository is public or private.
- Never commit a release keystore or passwords to GitHub.
- This workflow does not contain signing credentials.
