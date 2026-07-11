# FIVE

FIVE is a private product preview for one simple request: enter an email, click
**Get me a $5 gift card**, and follow an agent from request to delivery.

The deployed app is deliberately a sandbox. It exercises the interface and a
durable D1 activity ledger, stores only a masked email and one-way fingerprint,
and simulates the agent workflow. It does not create a marketplace task, issue
a gift card, or send money.

The codebase also contains a credential-gated live contract:

1. An operator submits a narrow, automation-approved task.
2. FIVE creates and verifies one pre-issued `$5.00 USD` Tremendous link reward.
3. The task enters inventory only after that immutable provider record exists.
4. An authenticated user requests the reward with a delivery email.
5. The agent completes the task and a deterministic evidence contract accepts it.
6. FIVE generates a fresh provider-hosted redemption link just in time and
   sends it through the transactional email outbox.
7. The job becomes `paid` only after Resend reports that the recipient mail
   server accepted that gift-card email.

FIVE never stores the redemption link. Provider order/reward IDs, state
transitions, and delivery evidence are stored for audit and replay safety.

## Why gift cards

The claimant needs only an email address; they do not connect a PayPal account
to FIVE. This does **not** eliminate compliance for the sender. The operator
still needs a production-approved and funded reward-provider account, truthful
identity/business information requested by that provider, tax/legal review, and
fraud controls. The repository cannot guarantee that any particular operator
will be approved without an SSN.

The hardened PayPal funding and payout adapters remain in the repository as a
disabled future option. `REWARD_PROVIDER=tremendous` selects the gift-card path.

## Local development

```bash
npm install
npm run dev
```

The D1 binding is declared in `.openai/hosting.json`. Runtime tables are created
defensively and represented by checked-in Drizzle migrations.

## Verification

```bash
npm run lint
npm test
```

The suite covers the product copy, production build, migrations, forbidden and
underfunded tasks, structured AI output, Tremendous order/reward/link contracts,
PayPal adapter regression behavior, encrypted destinations, lease fencing,
idempotency, webhook replay, gift-card email delivery, and the rule that no
redemption link is persisted.

See [docs/LIVE_RUNBOOK.md](docs/LIVE_RUNBOOK.md) for the external gates and
activation sequence. Keep `FIVE_MODE=sandbox` until every production gate and a
real end-to-end canary pass.

## Funded video bounties

FIVE also includes a guarded LTX-2.3 production pipeline for legitimate,
pre-funded video bounties. It estimates generation cost before spending,
generates synchronized video and audio through the async API, runs deterministic
motion/audio/format checks, packages a credited poster frame and AI disclosure,
and can submit exactly once through Taskmarket. See
[docs/VIDEO_BOUNTY_PIPELINE.md](docs/VIDEO_BOUNTY_PIPELINE.md). The verified
local backend, separate-workstation choices, benchmark gates, and migration
sequence are tracked in
[docs/LOCAL_VIDEO_WORKSTATION_PLAN.md](docs/LOCAL_VIDEO_WORKSTATION_PLAN.md).

## Safety contract

The agent must never trade, gamble, spam, impersonate someone, require a user
deposit, make purchases, handle credentials, or automate work whose terms do
not permit automation. A funded task is not automatically a safe task.

The main app stays private during the first canary. The checked-in relay exposes
only signature-preserving webhook forwarding and a bounded recovery scheduler.
