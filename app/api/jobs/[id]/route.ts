import { getJob } from "../../../../lib/jobs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      return Response.json({ error: "Request not found." }, { status: 404 });
    }

    const job = await getJob(id);
    if (!job) return Response.json({ error: "Request not found." }, { status: 404 });
    return Response.json({ job });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The request could not be loaded.";
    return Response.json({ error: message }, { status: 503 });
  }
}
