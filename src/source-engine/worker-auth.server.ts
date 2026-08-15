function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function assertWorkerRequest(request: Request): void {
  const expected = process.env['SOURCE_WORKER_TOKEN'];
  if (!expected) throw new Error("SOURCE_WORKER_TOKEN is not configured on the server");

  const authorization = request.headers.get("authorization") ?? "";
  const presented = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!presented || !safeEqual(presented, expected)) {
    const error = new Error("Unauthorized worker request");
    (error as Error & { status?: number }).status = 401;
    throw error;
  }
}

export function workerErrorResponse(error: unknown): Response {
  const status =
    typeof error === "object" && error && "status" in error
      ? Number((error as { status?: number }).status ?? 500)
      : 500;

  return Response.json(
    { ok: false, error: error instanceof Error ? error.message : String(error) },
    { status: Number.isFinite(status) ? status : 500 },
  );
}
