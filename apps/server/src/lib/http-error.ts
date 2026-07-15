export function jsonError(error: unknown, status = 500): Response {
	const message = error instanceof Error ? error.message : String(error);
	const errorStatus =
		typeof error === "object" &&
		error !== null &&
		"status" in error &&
		typeof (error as { status?: unknown }).status === "number"
			? (error as { status: number }).status
			: status;
	return Response.json({ error: { message } }, { status: errorStatus });
}
