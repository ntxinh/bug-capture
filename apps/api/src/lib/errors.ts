// postgres.js surfaces `code` directly; drizzle wraps it in DrizzleQueryError.cause
export function isUniqueViolation(err: unknown): boolean {
  let cur: unknown = err;
  while (cur && typeof cur === "object") {
    if ("code" in cur && cur.code === "23505") return true;
    cur = "cause" in cur ? cur.cause : undefined;
  }
  return false;
}
