import {
  claimNotification,
  markNotificationRetry,
  markNotificationSent,
  notificationRecipient,
  notificationStillCurrent,
} from "./live-jobs";
import {
  NotificationApiError,
  sendPayoutArrivalNotification,
} from "./notifications/resend";
import {
  generateTremendousRewardLink,
  TremendousApiError,
} from "./rewards/tremendous";
import {
  getRuntimeEnv,
  requireActiveLiveEnv,
  type RuntimeEnv,
} from "./runtime-env";

type NotificationDependencies = {
  send?: typeof sendPayoutArrivalNotification;
  generateRewardLink?: typeof generateTremendousRewardLink;
};

export async function processNotification(options: {
  runtime?: RuntimeEnv;
  dependencies?: NotificationDependencies;
} = {}) {
  const runtime = requireActiveLiveEnv(options.runtime ?? getRuntimeEnv());
  const notification = await claimNotification(runtime);
  if (!notification) return { processed: false as const, reason: "no_work" as const };

  if (!(await notificationStillCurrent({ notification, runtime }))) {
    return {
      processed: true as const,
      notificationId: notification.id,
      status: "canceled" as const,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const send = options.dependencies?.send ?? sendPayoutArrivalNotification;
    let redemptionLink: string | undefined;
    if (notification.kind === "gift_card_ready") {
      if (runtime.REWARD_PROVIDER !== "tremendous") {
        throw new Error("Gift-card notification provider configuration is unavailable.");
      }
      const generateLink =
        options.dependencies?.generateRewardLink ?? generateTremendousRewardLink;
      const generated = await generateLink({
        apiKey: runtime.TREMENDOUS_API_KEY,
        rewardId: notification.payout_reference,
        signal: controller.signal,
        ...(runtime.TREMENDOUS_API_BASE_URL
          ? { baseUrl: runtime.TREMENDOUS_API_BASE_URL }
          : { environment: runtime.TREMENDOUS_MODE }),
      });
      redemptionLink = generated.link;
    }
    const result = await send({
      apiKey: runtime.RESEND_API_KEY,
      from: runtime.NOTIFICATION_FROM_EMAIL,
      to: await notificationRecipient(notification, runtime),
      requestCode: `FIVE-${notification.job_id.slice(0, 6).toUpperCase()}`,
      payoutReference: notification.payout_reference,
      idempotencyKey: notification.event_key,
      kind: notification.kind,
      redemptionLink,
      baseUrl: runtime.RESEND_API_BASE_URL,
      signal: controller.signal,
    });
    await markNotificationSent({
      notification,
      providerMessageId: result.messageId,
      runtime,
    });
    return {
      processed: true as const,
      notificationId: notification.id,
      status: "sent" as const,
    };
  } catch (error) {
    const retryable =
      error instanceof TypeError ||
      (error instanceof DOMException && error.name === "AbortError") ||
      (error instanceof TremendousApiError &&
        (error.status === 408 || error.status === 429 || error.status >= 500)) ||
      (error instanceof NotificationApiError &&
        ((error.status >= 200 && error.status < 300) ||
          (error.status === 409 &&
            error.providerCode === "concurrent_idempotent_requests") ||
          error.status === 408 ||
          error.status === 429 ||
          error.status >= 500));
    await markNotificationRetry({
      notification,
      message:
        error instanceof Error
          ? error.message
          : "The arrival notification could not be delivered.",
      retryable,
      runtime,
    });
    return {
      processed: true as const,
      notificationId: notification.id,
      status: retryable && notification.attempts < 6 ? "retry_wait" as const : "failed" as const,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function drainNotifications(
  limit = 1,
  options: { runtime?: RuntimeEnv; dependencies?: NotificationDependencies } = {},
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 5) {
    throw new Error("Notification drain limit must be an integer from 1 to 5.");
  }
  const results = [];
  for (let index = 0; index < limit; index += 1) {
    const result = await processNotification(options);
    results.push(result);
    if (!result.processed) break;
  }
  return results;
}
