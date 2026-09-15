/** Strip LAN secrets from messages, logs, and serialized errors. */
export function redactSecrets(text: string, secrets: Array<string | undefined | null> = []): string {
  let out = String(text ?? "");
  for (const secret of secrets) {
    const value = secret?.trim();
    if (!value || value.length < 3) continue;
    out = out.split(value).join("[redacted]");
  }
  return out;
}

export function secretsFromUnknown(error: unknown): string[] {
  if (!error || typeof error !== "object") return [];
  const record = error as Record<string, unknown>;
  const found: string[] = [];
  for (const key of ["password", "accessCode", "access_code", "token"]) {
    const value = record[key];
    if (typeof value === "string") found.push(value);
  }
  return found;
}

export function safeErrorMessage(error: unknown, secrets: Array<string | undefined | null> = []): string {
  const extra = secretsFromUnknown(error);
  if (error instanceof Error) return redactSecrets(error.message, [...secrets, ...extra]);
  return redactSecrets(String(error), [...secrets, ...extra]);
}
