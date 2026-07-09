import {
  createJob,
  isPayoutMethod,
  validateDestination,
} from "../../../lib/jobs";

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as {
      payoutMethod?: string;
      destination?: string;
    };
    const payoutMethod = payload.payoutMethod?.trim().toLowerCase() ?? "";
    const destination = payload.destination ?? "";

    if (!isPayoutMethod(payoutMethod)) {
      return Response.json({ error: "Choose a supported payout method." }, { status: 400 });
    }

    const destinationError = validateDestination(payoutMethod, destination);
    if (destinationError) {
      return Response.json({ error: destinationError }, { status: 400 });
    }

    const job = await createJob(payoutMethod, destination);
    return Response.json({ job }, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The request could not be started.";
    return Response.json({ error: message }, { status: 503 });
  }
}
