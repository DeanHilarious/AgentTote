// Retain retired secrets for the lifetime of the process, so late child output is safe too.
const secrets = new Set<string>();

export function rememberSecret(secret: string): void {
  if (secret) secrets.add(secret);
}

export function redactSecrets(message: string): string {
  let safe = message;
  for (const secret of secrets) {
    for (const literal of [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)]) {
      safe = safe.split(literal).join('[redacted]');
    }
  }
  return safe;
}
