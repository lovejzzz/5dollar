import { SponsorComplete } from "../SponsorComplete";
import { getFiveMode, getRuntimeEnv } from "../../../lib/runtime-env";

type QueryValue = string | string[] | undefined;

function first(value: QueryValue) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function SponsorCompletePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, QueryValue>>;
}) {
  const query = await searchParams;
  const runtime = getRuntimeEnv();
  const live = getFiveMode(runtime) === "live";
  const supportEmail =
    live && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(runtime.SUPPORT_EMAIL ?? "")
      ? runtime.SUPPORT_EMAIL ?? null
      : null;
  return (
    <SponsorComplete
      live={live}
      supportEmail={supportEmail}
      initialDraftId={first(query.draftId) || first(query.draft) || ""}
      paypalOrderId={first(query.token) || first(query.orderId) || ""}
      canceled={first(query.cancelled) === "true" || first(query.cancel) === "true"}
    />
  );
}
