# Scripts

One-off maintenance scripts. Not part of the runtime app and not deployed.

## generate-demo-avatars.mjs

Generates the bundled stock-face pool that Demo Mode uses as replacements for
real technician profile photos.

### Setup (one time)

```powershell
cd scripts
npm install
```

### Generate

```powershell
$env:GEMINI_API_KEY = "your-key-here"
npm run generate-demo-avatars
```

Output goes to `frontend/public/demo-avatars/avatar-001.png` ... `avatar-050.png`
plus a `manifest.json`. Cost is roughly $0.039 per image with Gemini 2.5/3.1
Flash Image (Nano Banana), so the full 50-image pool runs about $2.

### Re-run / resume

If a few prompts fail (transient rate limit or content-policy refusal), re-run
with `--resume` to skip files that already exist:

```powershell
node generate-demo-avatars.mjs --resume
```

### Reshuffle the pool later

To replace the entire pool with a new set of faces, delete the folder and
re-run the script:

```powershell
Remove-Item -Recurse -Force ../frontend/public/demo-avatars
npm run generate-demo-avatars
```

The runtime auto-detects the new manifest on next page load, so no app code
changes are needed.
