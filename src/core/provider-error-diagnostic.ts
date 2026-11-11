const maxProviderDiagnosticLength = 512;

export interface ProviderFailureDiagnostic {
  providerHttpStatus: number;
  providerErrorMessage: string;
  providerErrorCode?: string;
}

export interface ProviderErrorDetails {
  upstreamStatus: number;
  upstreamMessage: string;
  upstreamCode?: string;
}

/** Keep provider error diagnostics useful without retaining credentials or response bodies. */
export function sanitizeProviderDiagnosticMessage(value: string): string {
  return value
    .replace(/\bhttps?:\/\/[^\s<>"']+/giu, "[redacted-url]")
    .replace(/\bauthorization\s*[:=]\s*(?:Bearer|Basic)\s+\S+/giu, "authorization=[redacted]")
    .replace(
      /["']?\b((?:(?:access|refresh|id)[_-]?)?token|api[_-]?key|client[_-]?secret|password|authorization|cookie|signature)["']?\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}&]+)/giu,
      "$1=[redacted]",
    )
    .replace(/\b(?:Bearer|Basic)\s+[^\s"',;}]+/giu, "[redacted credential]")
    .replace(/\b(?:gh[pousr]_|github_pat_|xox[baprs]-|sk_live_|sk_test_)[A-Za-z0-9_-]+\b/gu, "[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){2}\b/gu, "[redacted]")
    .replace(/\b[A-Za-z0-9_-]{48,}\b/gu, "[redacted]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maxProviderDiagnosticLength);
}

/** Preserve only explicit upstream diagnostics, never the full response payload. */
export function createProviderErrorDetails(status: number, message: string, code?: unknown): ProviderErrorDetails {
  const details: ProviderErrorDetails = {
    upstreamStatus: status,
    upstreamMessage: sanitizeProviderDiagnosticMessage(message) || `HTTP ${status}`,
  };
  if (
    typeof code === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u.test(code) &&
    sanitizeProviderDiagnosticMessage(code) === code
  ) {
    details.upstreamCode = code;
  }
  return details;
}

export function createProviderFailureDiagnostic(
  status: number,
  message: string,
  code?: unknown,
): ProviderFailureDiagnostic | undefined {
  if (!Number.isInteger(status) || status < 400 || status > 599) {
    return undefined;
  }
  if (!message.trim()) {
    return undefined;
  }
  const details = createProviderErrorDetails(status, message, code);
  const diagnostic: ProviderFailureDiagnostic = {
    providerHttpStatus: status,
    providerErrorMessage: details.upstreamMessage,
  };
  if (details.upstreamCode !== undefined) {
    diagnostic.providerErrorCode = details.upstreamCode;
  }
  return diagnostic;
}
