# FIVE

FIVE is a working product preview for a simple promise: enter a payout
destination, click **Get me $5**, and follow an agent from request to payout.

The default deployment is deliberately a sandbox. It runs the full interface
and a durable D1-backed activity ledger, masks the payout destination, advances
the agent workflow, and can send a browser notification.

The same codebase now also contains a credential-gated live path: authenticated
ownership, encrypted payout destinations, pre-funded task inventory, structured
OpenAI task execution, an idempotent processor, PayPal Payouts, verified
webhooks, item-level reconciliation, and a transactional notification outbox.
It also includes a separate `/sponsor` Checkout flow that turns one verified
PayPal order into one immutable dataset-summary task and returns the accepted
result to its sponsor.
Live mode refuses to start unless every required earning, payout, encryption,
and email secret is present. No real provider credentials or sponsor funds are
included in this repository.

## Product contract

A live version should be inventory-backed, not magical:

1. A sponsor defines a bounded task and approves its fixed PayPal Checkout order.
2. FIVE verifies the immutable reference, exact USD amount, and settled net
   proceeds before creating task inventory.
3. The agent rechecks the funds, matches the task, and completes it.
4. A deterministic evidence contract quality-checks the deliverable and makes
   the accepted result available to the sponsor.
5. Exactly $5 is released through a supported payout provider.
6. The job is marked paid only after the provider confirms the individual
   payout succeeded.
7. A durable outbox sends an idempotent arrival email and retries failures.

The agent must never trade, gamble, spam, impersonate someone, require a user
deposit, or automate work whose terms prohibit automation.

## Local development

```bash
npm install
npm run dev
```

The local app uses the D1 binding declared in `.openai/hosting.json`. Tables are
created defensively by the API and are also represented by the checked-in
Drizzle migration.

## Verification

```bash
npm run lint
npm test
```

The tests cover the UI/product contract, production build, prohibited and
underfunded task rejection, settled-capture parsing, structured OpenAI requests,
exact $5 PayPal payout shape, stable payout idempotency, notification delivery,
PayPal Checkout order/capture recovery, sponsor ownership and sensitive-data
rejection, and D1 state-machine exercises for replay, lease fencing, stale
webhooks, reversals, one-time task funding, and one-time notification creation.

After a production canary runs, verify its complete sponsor → AI → individual
payout → mail-server-delivered arrival-email proof without exposing claimant or
provider identifiers:

```bash
PROCESSOR_SECRET=<hosted-secret> npm run verify:live-canary -- \
  https://your-site.example <live-job-uuid> --wait=300
```

See [docs/LIVE_RUNBOOK.md](docs/LIVE_RUNBOOK.md) for the external setup required
to turn on real earning and payouts.

## What external production setup still needs

- real sponsor funding and lawful, automation-approved dataset-summary tasks;
- an intentionally small sponsor allowlist and a data-loss-prevention review
  before opening task submission beyond the private beta;
- an approved and funded PayPal Business Payouts account;
- hosted secrets for OpenAI, encryption, PayPal, Resend, the processor, and a
  monitored sponsor-support mailbox;
- a configured scheduled trigger (or external scheduler) for the idempotent
  job and notification drains;
- operational monitoring and an appeal/support path;
- terms, tax, sanctions, fraud, privacy, and worker-classification review.

Zelle is preview-only. It should not be offered as a live self-serve rail
without an approved treasury-bank integration. PayPal is the practical first
provider for a real MVP, subject to business approval and funding.
