# FIVE video-bounty pipeline

This pipeline turns a funded, agent-allowed video brief into a reproducible
Taskmarket submission. It keeps generation credentials outside the repository,
blocks uneconomic jobs before they spend money, packages the exact delivery
files, and refuses accidental duplicate submissions.

## Why LTX-2.3

The production backend is the managed LTX-2.3 async API. It generates video and
synchronized audio together, supports 16:9 and 9:16 output, and exposes Fast and
Pro models. The official local implementation is kept as a future backend; its
documented inference path is CUDA-oriented and is not the practical default on
this Apple Silicon workstation.

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
