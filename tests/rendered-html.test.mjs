import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("defines the complete FIVE product experience", async () => {
  const [page, layout, app, css, hosting] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/layout.tsx", root), "utf8"),
    readFile(new URL("app/FiveApp.tsx", root), "utf8"),
    readFile(new URL("app/globals.css", root), "utf8"),
    readFile(new URL(".openai/hosting.json", root), "utf8"),
  ]);

  assert.match(page, /FIVE — Your next \$5 gift card, handled/);
  assert.match(app, /Your next \$5 gift card,/);
  assert.match(app, /Get me a \$5 gift card/);
  assert.match(app, /Email for delivery/);
  assert.match(app, /Reward method: digital gift card/);
  assert.match(app, /JSON\.stringify\(\{ payoutMethod: "gift_card", destination \}\)/);
  assert.doesNotMatch(app, /id="payout-method"/);
  assert.doesNotMatch(app, /type="checkbox"/);
  assert.match(app, /SANDBOX PREVIEW/);
  assert.match(app, /No real task or gift card is created/);
  assert.match(app, /GIFT CARD DELIVERED/);
  assert.match(app, /funded task inventory/i);
  assert.match(app, /What Five will/);
  assert.match(app, /aria-live/);
  assert.match(css, /@media \(max-width: 620px\)/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(hosting, /"d1": "DB"/);
  assert.doesNotMatch(page + layout + app, /codex-preview|Your site is taking shape/i);
});

test("ships the durable sandbox and live-money routes and migrations", async () => {
  const migrationNames = (await readdir(new URL("drizzle/", root)))
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort();
  const migrations = (
    await Promise.all(
      migrationNames.map((name) => readFile(new URL(`drizzle/${name}`, root), "utf8")),
    )
  ).join("\n");
  const [
    createRoute,
    statusRoute,
    jobs,
    processor,
    webhook,
    sponsorPage,
    sponsorCreate,
    sponsorCapture,
    sponsorProcessor,
    canaryRoute,
    canaryProof,
    canaryScript,
    resendWebhook,
    resendProof,
  ] = await Promise.all([
    readFile(new URL("app/api/jobs/route.ts", root), "utf8"),
    readFile(new URL("app/api/jobs/[id]/route.ts", root), "utf8"),
    readFile(new URL("lib/jobs.ts", root), "utf8"),
    readFile(new URL("lib/process-live-job.ts", root), "utf8"),
    readFile(new URL("app/api/webhooks/paypal/route.ts", root), "utf8"),
    readFile(new URL("app/sponsor/SponsorForm.tsx", root), "utf8"),
    readFile(new URL("app/api/sponsor/orders/route.ts", root), "utf8"),
    readFile(new URL("app/api/sponsor/orders/[id]/capture/route.ts", root), "utf8"),
    readFile(new URL("lib/process-sponsor-order.ts", root), "utf8"),
    readFile(new URL("app/api/internal/canary/[id]/route.ts", root), "utf8"),
    readFile(new URL("lib/live-canary.ts", root), "utf8"),
    readFile(new URL("scripts/verify-live-canary.mjs", root), "utf8"),
    readFile(new URL("app/api/webhooks/resend/route.ts", root), "utf8"),
    readFile(new URL("lib/resend-webhooks.ts", root), "utf8"),
  ]);

  assert.match(createRoute, /export async function POST/);
  assert.match(statusRoute, /export async function GET/);
  assert.match(jobs, /crypto\.subtle\.digest/);
  assert.match(jobs, /maskDestination/);
  assert.match(jobs, /No task or gift card was created/);
  assert.match(migrations, /CREATE TABLE `jobs`/);
  assert.match(migrations, /CREATE TABLE `job_events`/);
  assert.match(migrations, /CREATE TABLE `funded_tasks`/);
  assert.match(migrations, /CREATE TABLE `live_jobs`/);
  assert.match(migrations, /CREATE TABLE `payouts`/);
  assert.match(migrations, /CREATE TABLE `funding_receipts`/);
  assert.match(migrations, /CREATE TABLE `notification_outbox`/);
  assert.match(migrations, /CREATE TABLE `paypal_webhook_events`/);
  assert.match(migrations, /CREATE TABLE `paypal_funding_webhook_events`/);
  assert.match(migrations, /CREATE TABLE `resend_webhook_events`/);
  assert.match(migrations, /CREATE TABLE `sponsor_task_orders`/);
  assert.match(migrations, /CREATE TABLE `gift_card_rewards`/);
  assert.match(processor, /earned_cents < 500/);
  assert.match(processor, /createPayPalFiveDollarPayout/);
  assert.match(webhook, /verifyPayPalWebhookSignature/);
  assert.match(webhook, /applyPayPalWebhook/);
  assert.match(sponsorPage, /Continue to PayPal/);
  assert.match(sponsorPage, /rightsAttested/);
  assert.match(sponsorCreate, /prepareSponsorFundingOrder/);
  assert.match(sponsorCapture, /processSponsorCapture/);
  assert.match(sponsorProcessor, /capturePayPalFundingOrder/);
  assert.match(sponsorProcessor, /drainSponsorCaptures/);
  assert.match(canaryRoute, /constantTimeSecretEqual/);
  assert.match(canaryRoute, /private, no-store/);
  assert.match(canaryProof, /individualPayoutSucceeded/);
  assert.match(canaryProof, /arrivalNotificationDelivered/);
  assert.match(canaryProof, /noFundingReversal/);
  assert.match(canaryScript, /PROCESSOR_SECRET/);
  assert.match(resendWebhook, /verifyResendWebhook/);
  assert.match(resendWebhook, /applyResendDeliveryEvent/);
  assert.match(resendWebhook, /request\.text\(\)/);
  assert.match(resendProof, /new Webhook\(secret\)\.verify/);
  assert.match(resendProof, /svix-id/);
  await assert.rejects(access(new URL("app/_sites-preview/SkeletonPreview.tsx", root)));
});
