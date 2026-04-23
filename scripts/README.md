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

## generate-brand-assets.mjs

Generates a curated set of brand mockups (logos, hero illustrations, dashboard
backgrounds, and UI icons) using the OpenAI Image API (`gpt-image-2` by
default, with multiple variants per concept). Outputs go to
`frontend/public/branding-mockups/<category>/<concept>-v<n>.png` with a
`manifest.json` and an `index.html` review viewer that groups variants by
concept.

Uses the built-in `fetch` in Node 20+ — **no npm install required** for this
script.

### Generate

```powershell
$env:OPENAI_API_KEY = "sk-..."
cd scripts
npm run generate-brand-assets
```

Default run: **16 concepts × 4 variants = 64 mockups** (4 logo concepts,
3 hero graphics, 3 backgrounds, 6 icons), `gpt-image-2`, medium quality,
~2 concurrent requests, roughly **$3** total cost.

Note: `gpt-image-2` doesn't support transparent backgrounds. Logos and icons
that need to be transparent are generated on a clean white background so they
can be keyed out later. To get true transparent PNGs out of the API directly,
pass `--model gpt-image-1`.

### Useful flags

```powershell
# Cheaper draft pass at low quality (~$1.50 total)
node generate-brand-assets.mjs --quality low

# Fewer variants per concept (cheaper, less mix-and-match)
node generate-brand-assets.mjs --variants 2

# Only regenerate logos (e.g., after tweaking the prompt)
node generate-brand-assets.mjs --only logo

# Only logos + icons
node generate-brand-assets.mjs --only logo --only icon

# Skip concepts whose v1 file already exists
node generate-brand-assets.mjs --resume

# Use gpt-image-1 instead (supports true transparent PNGs)
node generate-brand-assets.mjs --model gpt-image-1

# Print plan without spending any credits
node generate-brand-assets.mjs --dry-run
```

### Review the mockups

After generation, open in the browser:

```
http://localhost:5173/branding-mockups/
```

(while `npm run dev --prefix frontend` is running) to see all mockups with
download links and a "preview on light surface" toggle for transparent assets.

You can also open `frontend/public/branding-mockups/index.html` directly via
`file://` once images are generated.

### Iterate

To get fresh variants for a single concept, delete its files and re-run with
`--resume`:

```powershell
Remove-Item frontend/public/branding-mockups/logo/logo-02-icon-mark-pulse-ticket-v*.png
node generate-brand-assets.mjs --resume --only logo
```

To rewrite a prompt entirely, edit the `ASSETS` array in
`generate-brand-assets.mjs`, delete the matching file (or all files in that
category), and re-run.
