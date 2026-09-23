const maxProviderDiagnosticLength = 512;

export interface ProviderFailureDiagnostic {
  providerHttpStatus: number;
  providerErrorMessage: string;
}

/** Keep provider error diagnostics useful without retaining credentials or response bodies. */
export function sanitizeProviderDiagnosticMessage(value: string): string {
  return value
    .replace(/\bauthorization\s*[:=]\s*(?:Bearer|Basic)\s+\S+/giu, "authorization=[redacted]")
    .replace(/\b(?:Bearer|Basic)\s+\S+/giu, "[redacted credential]")
    .replace(
      /\b((?:access|refresh)[_-]?token|api[_-]?key|client[_-]?secret|password|authorization)\s*[:=]\s*\S+/giu,
      "$1=[redacted]",
    )
    .replace(/\b[A-Za-z0-9_-]{48,}\b/gu, "[redacted]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maxProviderDiagnosticLength);
}

export function createProviderFailureDiagnostic(
  status: number,
  message: string,
): ProviderFailureDiagnostic | undefined {
  if (!Number.isInteger(status) || status < 400 || status > 599) {
    return undefined;
  }
  const providerErrorMessage = sanitizeProviderDiagnosticMessage(message);
  return providerErrorMessage ? { providerHttpStatus: status, providerErrorMessage } : undefined;
}
