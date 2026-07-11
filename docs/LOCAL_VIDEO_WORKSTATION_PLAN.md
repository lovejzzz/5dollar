# FIVE local video workstation plan

## Decision

Move high-volume video generation to a separate workstation and keep the current
Mac as the control plane for bounty discovery, profitability checks, creative
review, packaging, submission, and payout verification.

The new machine should run local generation without a paid video API. Do not
start by modifying model weights. First establish a reproducible backend,
benchmark prompt adherence, and connect it to the existing guarded pipeline.
Fine-tuning is justified only after repeated failures reveal a narrow pattern
that prompting and conditioning cannot solve.

## Current verified baseline

As of 2026-07-11:

- Branch: `codex/gift-card-delivery`
- Local-video implementation commit: `766b4f6`
- Draft PR: <https://github.com/lovejzzz/5dollar/pull/1>
- Managed LTX-2.3 canary: 10 seconds, 1080p, synchronized audio, technically
  valid, `$0.80` API cost
- Official local proof: pinned `Lightricks/LTX-Video` commit
  `4b2d053057623ddd4d0a1d3e9cd28890e9ef487f`, 2B distilled, Apple MPS,
  offline production execution
- Local proof result: six seconds at 768x432, normalized to 1920x1080 at
  24 fps with disclosed procedural ambience in 120 seconds
- Local proof technical QA: passed; 93.1% retained-motion frames
- Local proof creative QA: failed because the requested prism became an oval
  lens. The artifact was correctly blocked from submission.
- Current local model cache: approximately 24.4 GB, including an approximately
  18 GB PixArt text encoder

This proves that the pipeline works locally. It does not prove that the older 2B
model can consistently win complex creative bounties.

## Economics

For an 8 USDC Taskmarket bounty with a 7.5% platform fee, the worker receives
7.4 USDC.

- Ten Pro API renders at `$0.80` cost `$8.00`.
- One win from those ten returns `7.4 USDC`, a `$0.60` generation loss before
  electricity or time.
- The API-only break-even win rate is `0.8 / 7.4 = 10.81%`.
- A local render has `$0` API cost. Electricity, hardware depreciation, and
  operator time still count, but repeated generation no longer consumes cash.

The production policy is therefore local-first. Managed generation is an
exception for a high-confidence task whose exact cost is already funded by an
approved budget or complimentary credit.

## Workstation choice

### Option A: officially supported NVIDIA workstation — preferred

Choose this when buying or dedicating a machine specifically for reliable local
LTX work.

Minimum procurement target:

- Windows 11 or Ubuntu 22.04+
- NVIDIA CUDA GPU with at least 16 GB VRAM; more VRAM is strongly preferred
- 32 GB system RAM or more
- 1 TB SSD with at least 200 GB free before installation
- Current NVIDIA driver

Lightricks officially supports local LTX Desktop generation on Windows and Linux
with a CUDA GPU of at least 16 GB VRAM. Its Windows guidance calls for at least
160 GB of free disk. macOS LTX Desktop builds remain API-only.

Official source: <https://github.com/Lightricks/LTX-Desktop>

### Option B: Apple Silicon MLX workstation — experimental

Choose this only if the other laptop is already a high-memory Apple Silicon
machine and accepting a community backend is reasonable.

Recommended target:

- Apple Silicon with at least 64 GB unified memory
- 1 TB SSD with at least 100 GB free before installation
- macOS 14+
- Python 3.12 in an isolated environment

The community `ltx-video-mac` project advertises an approximately 22 GB
LTX-2.3 Q4 audio-video model, 32 GB minimum memory, and 64 GB recommended. It is
not an official Lightricks runtime. Audit and pin its application code, Python
package graph, and model revision before execution.

Community source: <https://github.com/james-see/ltx-video-mac>

### Do not use the full official checkpoint on a constrained laptop

LTX-2.3 is a 22B synchronized audio-video model. Its full local path is valuable,
but the memory, checkpoint, text-encoder, upscaler, environment, and output
footprint make it a poor fit for a 48 GB machine with limited free disk.

Official model card: <https://huggingface.co/Lightricks/LTX-2.3>

## Migration phases

### Phase 0 — prepare the machine

- [ ] Record OS, CPU, GPU, VRAM or unified memory, RAM, and free disk.
- [ ] Reserve a dedicated model/cache volume or directory.
- [ ] Install Git, FFmpeg, Node.js 22+, Python 3.12, and the relevant GPU tools.
- [ ] Clone `lovejzzz/5dollar` and check out `codex/gift-card-delivery`.
- [ ] Run `npm install`, `npm run lint`, and `npm test` before adding models.
- [ ] Confirm that `.context/` is ignored and has at least 100 GB available.

Stop if the machine does not satisfy the chosen backend's memory or disk floor.

### Phase 1 — audit and pin the backend

- [ ] Prefer the official LTX Desktop or official LTX-2 codebase on NVIDIA.
- [ ] If using MLX, audit `ltx-video-mac`, `mlx-video-with-audio`, and every
  package that can execute code or download models.
- [ ] Pin repository commits, Python versions, dependency versions, model
  revisions, and SHA-256 hashes.
- [ ] Use `safetensors` model files where available.
- [ ] Keep credentials in the operating-system keychain, never `.env` files in
  the repository.
- [ ] Disable prompt enhancers, music APIs, telemetry, and automatic downloads
  until each is explicitly reviewed.

No generation command becomes production-eligible until it can run offline
after the one-time model download.

### Phase 2 — implement a backend adapter

Keep the Taskmarket workflow provider-independent. A backend must accept:

- prompt
- negative prompt
- width and height
- duration or frame count
- frame rate
- seed
- optional image/video conditioning
- output directory

It must return one video path and machine-readable evidence containing:

- backend and model revision
- generation resolution and delivery resolution
- seed and prompt hash
- wall time and peak memory when available
- whether audio was model-generated, locally synthesized, or absent
- `$0` API generation cost

Never invoke a backend through an interpolated shell string. Pass arguments as
an array, pin the executable, and force production jobs offline.

### Phase 3 — run the benchmark matrix

Use the same five briefs for every backend and revision:

1. physically accurate hardware in sunlight
2. one human with stable identity and natural motion
3. one product shot with reflective materials
4. a looping environmental shot
5. synchronized ambient sound with no speech

For each brief:

- render three seeds at 512x320 or the closest supported draft size
- promote the best seed to 768x432 or the backend's recommended working size
- normalize a copy to 1920x1080/24 fps
- record time, memory, disk delta, motion retention, and audio properties
- inspect the poster frame and five-frame contact sheet
- score brief adherence, realism, motion truth, poster frame, sound, and wow

Do not compare backends using different prompts or undisclosed manual fixes.

### Phase 4 — qualify creative output

A technically valid video is not automatically useful. Promotion requires:

- every existing pipeline QA check passes
- every creative score is at least 7/10
- zero blockers
- no duplicated objects, broken geometry, fake text, clip-art constellations,
  static pans, or brief substitutions
- the approval hash matches the exact artifact manifest

Target before production use:

- at least 20 benchmark renders
- at least 70% of selected renders clear the creative gate
- zero accidental network calls during offline runs
- zero duplicate submissions
- zero secrets or model files committed to Git

If a backend cannot reach this threshold, keep it as a draft generator.

### Phase 5 — decide whether to fine-tune

Fine-tune only when the benchmark log shows a repeated, narrow failure such as:

- one hardware family repeatedly losing geometry
- a consistent motion style required by several funded briefs
- a stable visual identity that prompting cannot maintain
- a specific synchronized sound/appearance pairing

Prefer a small LoRA or conditioning workflow over changing the base model. Keep
training data licensed, attributable, free of personal data, and separate from
wallets or credentials. Re-run the full benchmark after every trained revision.

### Phase 6 — production bounty loop

For every candidate:

1. Verify it is current, public, agent-allowed, and pre-funded.
2. Confirm the net reward remains at least `$5` after marketplace fees and all
   non-local costs.
3. Freeze the brief and acceptance criteria before rendering.
4. Generate locally in a new immutable workspace.
5. Package `final.mp4`, `poster-frame.png`, `contact-sheet.png`, disclosure,
   QA, manifest, and creative approval.
6. Re-fetch task state and follow the current Taskmarket side-effect gates.
7. Submit exactly once.
8. Monitor acceptance and finalized payout with public transaction evidence.

Never self-fund, buy fake demand, trade, gamble, spam, or count the user's money
as revenue.

## Definition of done

The new laptop pipeline is ready only when:

- [ ] the clean repository passes lint, build, and all tests
- [ ] the backend and models are pinned and can run offline
- [ ] one six-second and one ten-second render finish without memory pressure
- [ ] outputs are normalized to exact delivery specifications
- [ ] audio provenance and AI use are disclosed
- [ ] deterministic QA and hash-bound creative QA both pass
- [ ] a dry-run submission stops before the network write
- [ ] duplicate generation and duplicate submission guards are verified
- [ ] the first real submission targets a legitimate pre-funded task
- [ ] any earned payout is verified onchain and is independent of user funding

## Repository boundaries

Commit:

- source code and tests
- pinned configuration
- setup and benchmark scripts
- small JSON benchmark summaries without secrets
- documentation

Never commit:

- model weights or Hugging Face caches
- generated bounty videos unless a task explicitly requires a public artifact
- wallet keystores, private keys, API keys, cookies, or account exports
- raw requester files before they are reviewed
- personal data or payout destinations beyond already-public wallet addresses
