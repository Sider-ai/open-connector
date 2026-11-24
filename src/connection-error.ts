import type { ProviderFailureDiagnostic } from "./core/provider-error-diagnostic.ts";
/**
 * Error with a stable code suitable for HTTP responses.
 */
export class ConnectionError extends Error {
  readonly code: string;

  readonly providerFailure?: ProviderFailureDiagnostic;

  constructor(code: string, message: string, providerFailure?: ProviderFailureDiagnostic) {
    super(message);
    this.code = code;
    this.providerFailure = providerFailure;
  }
}
