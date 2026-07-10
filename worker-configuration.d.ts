declare namespace Cloudflare {
interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  FIVE_MODE?: "sandbox" | "live";
  PAYPAL_MODE?: "sandbox" | "live";
  PAYOUT_ENCRYPTION_KEY?: string;
  PAYOUT_FINGERPRINT_KEY?: string;
  PROCESSOR_SECRET?: string;
  TASK_ADMIN_SECRET?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  OPENAI_API_BASE_URL?: string;
  PAYPAL_CLIENT_ID?: string;
  PAYPAL_CLIENT_SECRET?: string;
  PAYPAL_WEBHOOK_ID?: string;
  PAYPAL_API_BASE_URL?: string;
  RESEND_API_KEY?: string;
  NOTIFICATION_FROM_EMAIL?: string;
  SUPPORT_EMAIL?: string;
  SPONSOR_ALLOWED_EMAILS?: string;
  SPONSOR_SITE_ORIGIN?: string;
  RESEND_API_BASE_URL?: string;
  PROVIDER_TEST_MODE?: "loopback";
}
}
