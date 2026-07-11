# FIVE video-bounty pipeline

This pipeline turns a funded, agent-allowed video brief into a reproducible
Taskmarket submission. It keeps generation credentials outside the repository,
blocks uneconomic jobs before they spend money, packages the exact delivery
files, and refuses accidental duplicate submissions.

## Managed final renders and free local iterations

The managed LTX-2.3 API remains the highest-confidence final-render backend. It
generates video and synchronized audio together, supports 16:9 and 9:16 output,
and exposes Fast and Pro models. It costs money per second, so it should be used
only for a creatively approved final candidate.

For free iterations, the pipeline also supports the official open-source
LTX-Video 0.9.8 2B distilled checkpoint on Apple MPS. The checkpoint is much
smaller than LTX-2.3 and is useful for shot design, prompt selection, and some
finals. The local path renders at a configurable working resolution, upscales to
the delivery resolution, and can add a disclosed procedural ambience. It does
not provide LTX-2.3's unified synchronized audio and its quality ceiling is lower.

Pricing is snapshotted in `tools/video-bounty/pricing.ts` and every job carries
both a maximum generation cost and a minimum profit after generation. Refresh
the official pricing before relying on the snapshot for a later run:

- https://docs.ltx.video/pricing
- https://docs.ltx.video/models

## Credential

The CLI first reads `LTXV_API_KEY`. On macOS it falls back to Keychain service
`team.nexttask.five.ltx.api`, account `FIVE`:

```bash
security add-generic-password \
  -U \
  -s team.nexttask.five.ltx.api \
  -a FIVE \
  -w 'YOUR_LTX_API_KEY'
```

The key is never printed or written into job evidence.

## Workflow

Copy and edit `tools/video-bounty/example-job.json`. The manifest is the single
source of truth for reward, cost cap, model, duration, prompt, credit, disclosure,
poster frame, and research sources.

Estimate without spending:

```bash
npm run video:bounty -- estimate --job path/to/job.json
```

Compare the electricity-only local path:

```bash
npm run video:bounty -- local-estimate --job path/to/job.json
```

## One-time local setup on Apple Silicon

The local runtime is deliberately isolated under ignored `.context` paths. Use
Python 3.10-3.13 with a current MPS-enabled PyTorch. The official repository is
pinned by commit before production use; do not execute a community conversion
without a separate source audit.

```bash
mkdir -p .context/vendor .context/ltx-local
git clone --depth 1 https://github.com/Lightricks/LTX-Video.git \
  .context/vendor/LTX-Video
git -C .context/vendor/LTX-Video fetch --depth 1 origin \
  4b2d053057623ddd4d0a1d3e9cd28890e9ef487f
git -C .context/vendor/LTX-Video checkout --detach \
  4b2d053057623ddd4d0a1d3e9cd28890e9ef487f
python3 -m venv --system-site-packages .context/ltx-local/env
.context/ltx-local/env/bin/pip install -e \
  '.context/vendor/LTX-Video[inference]'
```

Download only the official 2B distilled checkpoint and its spatial upscaler by
performing one online smoke render. Production commands force Hugging Face and
Transformers into offline mode, so a missing model fails instead of silently
downloading during a bounty run. The actual cache observed on this Mac was about
6.4 GB for LTX plus 18 GB for the required PixArt text encoder; keep at least
30 GB free after setup. FIVE's local config disables the optional prompt enhancer
so it cannot pull two more models.

Run locally with no API credential or API charge:

```bash
npm run video:bounty -- local-run \
  --job path/to/job.json \
  --confirm-electricity-only
```

Optional `--local-width`, `--local-height`, and `--seed` arguments control the
working render. Defaults are 768x432 for landscape and 432x768 for portrait.
The final is normalized to the job's delivery resolution and frame rate.

The measured M4 Max proof rendered six seconds at 768x432, normalized it to
1920x1080/24 fps, synthesized ambience, and passed deterministic media QA in
120 seconds total. Peak process memory was about 8 GB RSS and about 30 GB peak
footprint. This proves operational feasibility, not creative acceptance: the 2B
result still requires the same hash-bound vision review and should be rejected
when it misses the brief.

Full LTX-2.3 is not the default local backend on this Mac: the official desktop
application is API-only on macOS, while the model repository is about 103 GB and
its main checkpoint alone is about 46 GB. A community MLX Q4 conversion is a
promising experimental backend, but it requires a separate trust and quality
benchmark before it can enter this submission pipeline.

Generate, package, and run deterministic QA:

```bash
npm run video:bounty -- run \
  --job path/to/job.json \
  --confirm-cost-usd 0.80
```

Packaging also creates `contact-sheet.png`. Before submission, FIVE must inspect
that sheet and `poster-frame.png`, then write `creative-approval.json` containing
the SHA-256 of the current artifact manifest, no blockers, and scores of at least
7/10 for brief adherence, realism, motion truth, poster frame, and wow. This
prevents technically valid but semantically weak generations from escaping.

Add `--submit` only after that vision review and for a freshly verified
Taskmarket task. The submit stage:

1. verifies the creative approval matches the exact artifact manifest;
2. re-fetches the task;
3. requires `status=open`, `submissionWindowOpen=true`, and the worker `submit`
   pending action;
4. uploads `final.mp4`, `poster-frame.png`, and `submission-note.txt` once;
5. verifies the count increased exactly once and the submission belongs to the
   current Taskmarket wallet;
6. writes immutable local evidence and refuses a second submission.

```bash
npm run video:bounty -- run \
  --job path/to/job.json \
  --confirm-cost-usd 0.80 \
  --submit
```

## Quality gates

The packaged output must match the requested resolution, duration, and frame
rate; contain an audio stream when required; exceed the audible-level floor;
and retain at least 35% of its frames after `mpdecimate`. This rejects static
slideshows and low-motion pans before they reach a bounty submission. The
pipeline also creates a credited poster frame, AI/model disclosure, SHA-256
artifact manifest, and JSON QA report.

`ffmpeg`, `ffprobe`, Python 3, Pillow, and the Taskmarket CLI are required for a
full production run. Unit tests do not spend credits or access credentials.
