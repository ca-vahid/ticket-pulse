#!/usr/bin/env node
/**
 * Generate the bundled stock-face pool used by Demo Mode.
 *
 * Calls Gemini "Nano Banana 2" (gemini-3.1-flash-image-preview) once per
 * prompt, saves each output to frontend/public/demo-avatars/avatar-NNN.jpg
 * and writes a manifest.json that the runtime reads to decide how many
 * photos are available.
 *
 * Usage:
 *   GEMINI_API_KEY=... node scripts/generate-demo-avatars.mjs
 *   GEMINI_API_KEY=... node scripts/generate-demo-avatars.mjs --count 50
 *   GEMINI_API_KEY=... node scripts/generate-demo-avatars.mjs --resume
 *
 * Flags:
 *   --count N      Generate the first N prompts only (default: all in PROMPTS).
 *   --resume       Skip indices that already have a file on disk.
 *   --model NAME   Override the Gemini model id.
 *   --concurrency  Parallel requests (default 2; Gemini rate limits cheaply).
 *
 * Cost: Gemini 3 Pro Image is in preview pricing (check current rates at
 * https://ai.google.dev/pricing). 50 images is still well under ~$10.
 *
 * Note: requires `npm i @google/genai` in the project root (or use `npx`
 * which will fetch on demand).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(REPO_ROOT, 'frontend', 'public', 'demo-avatars');

const args = parseArgs(process.argv.slice(2));

if (!process.env.GEMINI_API_KEY) {
  console.error('ERROR: GEMINI_API_KEY env var is required.');
  console.error('  PowerShell:  $env:GEMINI_API_KEY="..."; node scripts/generate-demo-avatars.mjs');
  console.error('  bash/zsh:    GEMINI_API_KEY=... node scripts/generate-demo-avatars.mjs');
  process.exit(1);
}

// Latest image model: Gemini 3 Pro Image ("Nano Banana Pro"), launched
// Nov 2025. Highest quality output and best at photorealistic faces. Use
// --model to override.
const MODEL = args.model || 'gemini-3-pro-image-preview';
const CONCURRENCY = Math.max(1, Number(args.concurrency || 2));

// 50 corporate-headshot prompts, varied across age, gender presentation,
// ethnicity, hair, and attire. Style block is consistent so the pool feels
// cohesive ("looks like the same company").
const STYLE = 'Professional corporate headshot, neutral light grey studio backdrop, soft three-point studio lighting, sharp focus on face, natural skin texture, high-resolution photorealistic, shoulders and head visible, looking at camera, friendly relaxed expression, business-casual attire, no logos, no text, no watermark.';

const SUBJECTS = [
  'a woman in her late 20s with shoulder-length dark brown hair, light olive skin, wearing a navy blazer over a white shirt',
  'a man in his early 30s with short black hair, fade haircut, brown skin, wearing a charcoal sweater over a collared shirt',
  'a woman in her mid 40s with a sleek silver bob cut, fair skin, wearing a soft mauve blouse',
  'a man in his late 50s with short greying hair, light brown skin, well-trimmed grey beard, wearing a denim button-up shirt',
  'a woman in her early 30s with long curly black hair, dark brown skin, gold hoop earrings, wearing a forest-green blouse',
  'a man in his mid 20s with messy brown hair, fair skin, light freckles, wearing a heather grey crewneck and rounded glasses',
  'a non-binary person in their 30s with a buzzcut, tan skin, small nose ring, wearing a slate blue button-up',
  'a woman in her late 40s with shoulder-length auburn hair, fair skin, subtle freckles, wearing a burgundy turtleneck',
  'a man in his early 40s with dark hair tied in a low man-bun, light brown skin, wearing a black quarter-zip pullover',
  'a woman in her mid 30s with straight long black hair, East Asian features, wearing a cream silk blouse',
  'a man in his late 30s with short reddish-brown hair, freckled fair skin, wearing a soft beige cardigan over a white tee',
  'a woman in her early 50s with shoulder-length grey-streaked hair, medium skin, wearing a deep teal blazer',
  'a man in his mid 30s with closely cropped dark hair, South Asian features, wearing a light blue dress shirt with rolled sleeves',
  'a woman in her late 20s with a short pixie cut dyed platinum blonde, fair skin, wearing a black mock-neck top',
  'a man in his early 60s with thick salt-and-pepper hair, fair skin, wearing rectangular tortoise-shell glasses and a navy sweater',
  'a woman in her early 40s with thick natural curls in a high ponytail, dark brown skin, wearing a mustard-yellow blouse',
  'a man in his late 20s with short brown hair, Mediterranean features, light stubble, wearing a heather charcoal henley',
  'a woman in her mid 30s with long wavy chestnut hair, fair skin, light makeup, wearing a soft pink cardigan',
  'a man in his early 50s with a short trimmed beard, balding crown, light brown skin, wearing a dark olive button-down',
  'a woman in her late 30s with shoulder-length straight black hair, Southeast Asian features, wearing a royal blue blouse',
  'a man in his mid 40s with thick dark hair side-parted, fair skin, square wire-frame glasses, wearing a navy sweater vest over a white shirt',
  'a woman in her early 30s with box braids past her shoulders, dark brown skin, wearing a soft white blouse',
  'a man in his late 30s with short blond hair, fair skin, light beard, wearing a sage green polo shirt',
  'a woman in her mid 50s with a chin-length silver bob, fair skin, wearing a deep purple blazer',
  'a man in his early 30s with short curly black hair, brown skin, wearing a maroon zip-up hoodie',
  'a woman in her late 20s with hair in two sleek low braids, Indigenous Canadian features, wearing a denim shirt over a white tee',
  'a man in his mid 60s with short white hair, fair weathered skin, friendly smile lines, wearing a beige zip cardigan',
  'a woman in her early 40s with a sleek high bun, East Asian features, small pearl earrings, wearing a black turtleneck',
  'a man in his late 40s with short greying hair, full beard, brown skin, wearing a heather grey blazer over a black shirt',
  'a woman in her mid 30s with shoulder-length wavy red hair, very fair freckled skin, wearing a soft sage cardigan',
  'a man in his early 30s with twists tied back, dark brown skin, wearing a rust-orange knit sweater',
  'a woman in her late 40s with long silver-streaked dark hair, medium skin, wearing a navy wrap blouse',
  'a non-binary person in their late 20s with shoulder-length wavy purple-tipped hair, fair skin, wearing a black tee under a denim jacket',
  'a man in his mid 50s with short greying brown hair, fair skin, rounded gold-frame glasses, wearing a soft heather blue sweater',
  'a woman in her early 30s with a chin-length sleek black bob, East Asian features, wearing a white silk blouse with a gold pendant necklace',
  'a man in his late 30s with shaved head, dark brown skin, well-trimmed beard, wearing a charcoal mock-neck sweater',
  'a woman in her mid 40s with shoulder-length blonde hair with darker roots, fair skin, wearing a soft coral blazer',
  'a man in his early 40s with thick black wavy hair, Latin American features, light stubble, wearing a navy quarter-zip',
  'a woman in her late 20s with afro-textured hair in a small natural fro, dark brown skin, wearing a tomato-red blouse',
  'a man in his mid 30s with short brown hair, fair skin, wearing minimalist round glasses and a dusty pink button-down',
  'a woman in her early 50s with chin-length brown hair, fair skin, gentle smile, wearing a forest green cowl-neck top',
  'a man in his late 20s with short curly auburn hair, fair freckled skin, wearing a heather grey hoodie',
  'a woman in her mid 30s with long straight dark brown hair, Middle Eastern features, gold hoop earrings, wearing a cream blazer',
  'a man in his early 50s with short black hair touched with grey, brown skin, wearing a soft lavender dress shirt',
  'a woman in her late 30s with shoulder-length wavy honey-blonde hair, fair skin, wearing a slate blue cardigan',
  'a man in his mid 40s with shaved head, fair skin, wearing tortoise-shell rectangular glasses and a black turtleneck',
  'a woman in her early 30s with long thick black hair pulled into a low side-braid, South Asian features, wearing an emerald green kurta-style blouse',
  'a man in his late 50s with short white hair, fair skin, kind smile, wearing a tan corduroy jacket over a checked shirt',
  'a woman in her mid 30s with twists pinned up loosely, brown skin, wearing a periwinkle blue silk blouse',
  'a man in his early 30s with side-swept dark hair, East Asian features, light stubble, wearing a beige cardigan over a white tee',
];

if (SUBJECTS.length < 50) {
  console.error(`SUBJECTS list has ${SUBJECTS.length} entries; expected at least 50.`);
  process.exit(1);
}

const COUNT = Math.min(Number(args.count || SUBJECTS.length), SUBJECTS.length);

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });

  const ai = new GoogleGenAI({});
  const tasks = [];
  for (let i = 0; i < COUNT; i++) {
    tasks.push({ index: i + 1, subject: SUBJECTS[i] });
  }

  console.log(`Generating ${tasks.length} avatars with ${MODEL}`);
  console.log(`Output: ${OUT_DIR}`);
  console.log(`Concurrency: ${CONCURRENCY}, resume: ${!!args.resume}`);

  const results = new Array(tasks.length);
  let nextIdx = 0;
  let completed = 0;
  let failed = 0;

  async function worker(workerId) {
    while (true) {
      const myIdx = nextIdx++;
      if (myIdx >= tasks.length) return;
      const { index, subject } = tasks[myIdx];
      const filename = `avatar-${String(index).padStart(3, '0')}.png`;
      const outPath = path.join(OUT_DIR, filename);

      if (args.resume) {
        try {
          await fs.access(outPath);
          results[myIdx] = filename;
          completed++;
          console.log(`[${completed}/${tasks.length}] (skip) ${filename}`);
          continue;
        } catch { /* not present, generate */ }
      }

      const prompt = `${STYLE} The subject is ${subject}. Centered headshot framing.`;
      try {
        const buf = await generateImage(ai, prompt);
        await fs.writeFile(outPath, buf);
        results[myIdx] = filename;
        completed++;
        console.log(`[${completed}/${tasks.length}] (worker ${workerId}) wrote ${filename}`);
      } catch (err) {
        failed++;
        console.error(`[fail] ${filename}: ${err.message || err}`);
      }
    }
  }

  await Promise.all(
    Array.from({ length: CONCURRENCY }, (_, i) => worker(i + 1)),
  );

  // Build the manifest from whatever ended up on disk so resume runs are safe.
  const onDisk = (await fs.readdir(OUT_DIR))
    .filter(f => /^avatar-\d{3}\.png$/.test(f))
    .sort();
  const manifest = {
    generatedAt: new Date().toISOString(),
    model: MODEL,
    count: onDisk.length,
    files: onDisk,
  };
  await fs.writeFile(
    path.join(OUT_DIR, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  );

  console.log('');
  console.log(`Done. ${onDisk.length} files in ${OUT_DIR}`);
  if (failed > 0) {
    console.log(`${failed} prompt(s) failed. Re-run with --resume to retry only the missing ones.`);
    process.exit(2);
  }
}

async function generateImage(ai, prompt) {
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
  });
  const parts = response?.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    if (part.inlineData?.data) {
      return Buffer.from(part.inlineData.data, 'base64');
    }
  }
  throw new Error('no inlineData in response');
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--resume') out.resume = true;
    else if (a === '--count') out.count = argv[++i];
    else if (a === '--model') out.model = argv[++i];
    else if (a === '--concurrency') out.concurrency = argv[++i];
  }
  return out;
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
