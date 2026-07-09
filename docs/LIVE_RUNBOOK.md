# FIVE live-mode runbook

Live mode moves money. Activate it only after the funding, provider, security,
and compliance prerequisites below are complete.

## 1. Establish the real funding source

FIVE does not create money. A sponsor or the platform must pre-fund each task
before it enters `funded_tasks`.

The initial task contract is intentionally narrow:

- a FIVE-owned PayPal Checkout/order flow captures the sponsor payment and sets
  `custom_id` to the precommitted sponsor reference;
- the verified capture has status `COMPLETED`, currency `USD`, and net proceeds
  at least equal to the declared task reward;
- one capture funds only one task and cannot be replayed;
- exactly `$5.00` is reserved for the user reward;
- the remaining amount covers model and payout costs;
- the sponsor explicitly permits automated completion;
- the first live task type is `dataset_summary`, and every required evidence ID
  must exist in the supplied input and appear in the agent submission;
- the work cannot involve spam, impersonation, fake reviews, gambling,
  financial trading, purchases, credentials, ad manipulation, harassment,
  political manipulation, or private-data collection.

The internal task endpoint is an operator control plane, not a payment-collection
endpoint. It reads the PayPal capture with FIVE's merchant credentials and
atomically records one receipt plus one task. The same capture cannot create a
second task. The capture is checked again before model execution.

## 2. Configure providers

Create an OpenAI API project for task execution.

For PayPal:

1. Use a verified PayPal Business account.
2. Request and receive PayPal Payouts access.
3. Fund the PayPal balance for rewards and fees.
4. Create an app and record its client ID and secret.
5. Register `https://<site-host>/api/webhooks/paypal`.
6. Subscribe to all `PAYMENT.PAYOUTS-ITEM.*` events, especially `SUCCEEDED`,
   `FAILED`, `UNCLAIMED`, `HELD`, `BLOCKED`, `RETURNED`, `REFUNDED`, and
   `CANCELED`.
7. Record the webhook ID.

For arrival email, verify a sending domain with Resend and choose the exact
`NOTIFICATION_FROM_EMAIL` value for transactional messages.

FIVE never treats a batch-level success as proof that a recipient was paid.

## 3. Create hosted secrets

Generate independent values for `PAYOUT_ENCRYPTION_KEY` and
`PAYOUT_FINGERPRINT_KEY`. Each must be an unpadded base64url encoding of at
least 32 random bytes; the encryption key must be exactly 32 bytes.

Example key generator:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Configure these hosted runtime values through Sites:

```text
PAYOUT_ENCRYPTION_KEY
PAYOUT_FINGERPRINT_KEY
PROCESSOR_SECRET
TASK_ADMIN_SECRET
OPENAI_API_KEY
OPENAI_MODEL=gpt-5.4-mini
PAYPAL_CLIENT_ID
PAYPAL_CLIENT_SECRET
PAYPAL_WEBHOOK_ID
RESEND_API_KEY
NOTIFICATION_FROM_EMAIL=Five <payouts@your-verified-domain.example>
```

Leave the optional provider base-URL overrides unset in production. They are
accepted only with `PROVIDER_TEST_MODE=loopback`, and even then may target only
`localhost`, `127.0.0.1`, or `::1` for local integration testing.

## 4. Apply and verify the D1 migrations

Back up the target D1 database, apply every checked-in migration in order, and
confirm that `funded_tasks.funding_receipt_id` and
`funding_receipts.net_cents` are `NOT NULL`. Do not set `FIVE_MODE=live` if a
migration fails. Keep the prior sandbox version available as the rollback path;
never hand-edit a live money row to force a migration through.

## 5. Add a recovery scheduler

The Worker exports a scheduled handler, but the hosting control plane must still
attach a cron trigger. Until that trigger is configured, use an external
scheduler to call this endpoint at least once per minute:

```text
POST /api/internal/jobs/drain
Authorization: Bearer <PROCESSOR_SECRET>
Content-Type: application/json

{"limit":1}
```

The endpoint drains both agent jobs and notification outbox rows. Both use
leases and backoff. PayPal identifiers derive from the job ID, and notification
requests use stable idempotency keys.

## 6. Add funded inventory

After sponsor funds are present, submit the approved task:

```text
POST /api/internal/tasks
Authorization: Bearer <TASK_ADMIN_SECRET>
Content-Type: application/json

{
  "taskType": "dataset_summary",
  "title": "Summarize supplied product feedback",
  "instructions": "Using only the supplied rows, produce a concise theme summary and list the supporting row identifiers.",
  "input": {"rows":[{"id":"r1","feedback":"The setup was fast."}]},
  "rewardCents": 700,
  "sponsorReference": "sponsor:feedback:001",
  "fundingCaptureId": "PAYPALCAPTUREID",
  "automationAllowed": true,
  "autoAccept": true,
  "acceptance": {"requiredEvidenceIds":["r1"],"minEvidenceCount":1},
  "minAnswerChars": 120
}
```

Sponsor task content is treated as untrusted data. The OpenAI adapter has no
tools, cannot contact anyone, and must return the fixed submission schema.
Caller-provided booleans never establish funding; only the PayPal capture read
does.

## 7. Activate live mode last

Set both values only after every previous step is verified:

```text
FIVE_MODE=live
PAYPAL_MODE=live
```

In live mode the user still enters only a PayPal destination and clicks
**Get me $5**. Sites-provided ChatGPT identity owns the request, the raw payout
destination is encrypted, and only a masked hint returns to the browser.

Before enabling public access, verify that the hosting edge—not client traffic—
owns and strips/reinjects `oai-authenticated-user-email`. Add rate limits and
fraud/Sybil controls appropriate to a one-reward-per-person beta; the database's
one-owner and one-destination constraints are a backstop, not identity proof.

## 8. Verify before public access

- Confirm an unauthenticated request is rejected.
- Confirm one verified owner and one payout fingerprint cannot claim twice.
- Run one low-risk funded task end to end.
- Confirm the job stops at `payout_pending` after PayPal accepts the batch.
- Confirm only a verified `PAYMENT.PAYOUTS-ITEM.SUCCEEDED` event changes it to
  `paid`.
- Replay the same webhook and confirm it is deduplicated.
- Send an older `HELD` event after `SUCCEEDED` and confirm it cannot downgrade
  the job.
- Send a later `RETURNED` or `REFUNDED` event and confirm it becomes `reversed`.
- Test `UNCLAIMED`, `FAILED`, provider timeout, and expired-lease recovery paths.
- Confirm the Resend arrival email is delivered once and its outbox row is
  marked `sent`; PayPal's own notification is supplemental.
- Review logs to ensure they contain no raw payout destination or provider
  secret.
