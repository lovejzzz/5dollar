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
Live mode refuses to start unless every required earning, payout, encryption,
and email secret is present. No real provider credentials or sponsor funds are
included in this repository.

## Product contract

A live version should be inventory-backed, not magical:

1. A sponsor funds a task through a unique settled PayPal capture.
2. The agent rechecks the net funds, matches the task, and completes it.
3. A deterministic source-evidence contract quality-checks the deliverable.
4. Exactly $5 is released through a supported payout provider.
5. The job is marked paid only after the provider confirms the individual
   payout succeeded.
6. A durable outbox sends an idempotent arrival email and retries failures.

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
and a D1 state-machine exercise for replay, lease fencing, stale webhooks,
reversals, and one-time notification creation.

See [docs/LIVE_RUNBOOK.md](docs/LIVE_RUNBOOK.md) for the external setup required
to turn on real earning and payouts.

## What external production setup still needs

- a sponsor Checkout/order flow that creates the PayPal capture consumed by the
  internal task endpoint;
- real sponsor funding and lawful, automation-approved dataset-summary tasks;
- an approved and funded PayPal Business Payouts account;
- hosted secrets for OpenAI, encryption, PayPal, Resend, and the processor;
- a configured scheduled trigger (or external scheduler) for the idempotent
  job and notification drains;
- operational monitoring and an appeal/support path;
- terms, tax, sanctions, fraud, privacy, and worker-classification review.

Zelle is preview-only. It should not be offered as a live self-serve rail
without an approved treasury-bank integration. PayPal is the practical first
provider for a real MVP, subject to business approval and funding.
