import type { ProviderFailureDiagnostic } from "../../core/provider-error-diagnostic.ts";
import type { ActionDefinition, ExecutionResult } from "../../core/types.ts";

import { createProviderFailureDiagnostic } from "../../core/provider-error-diagnostic.ts";

const maxNodes = 256;
const maxBytes = 16 * 1024;
const maxDepth = 4;
const maxStringLength = 256;
const maxArrayLength = 20;
const maxObjectKeys = 50;
const sensitiveKeyPattern =
  /access[-_]?key|api[-_]?key|authorization|client[-_]?secret|cookie|credential|password|private[-_]?key|refresh[-_]?token|secret|session|signature|token/i;
const sensitiveContextPattern = /(^|\.)(cookies?|credentials?|headers?|secrets?)(\.|$)/i;
const credentialValuePattern = /^(?:Basic|Bearer)\s+\S+|^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/i;
const sensitiveUrlContextPattern = /callback|download|presigned|signed|temporary|webhook/i;
const urlWithAuthorityPattern = /^(?:[a-z][a-z0-9+.-]*:)?\/\//i;
const protocolRelativeBaseUrl = "relative://run-log.invalid";
const safeErrorMessages: Record<string, string> = {
  action_blocked: "The action was blocked by runtime policy.",
  authorization_failed: "The provider rejected authorization.",
  connection_not_found: "The requested connection was not found.",
  executor_unavailable: "The action executor is unavailable.",
  internal_error: "The action failed unexpectedly.",
  invalid_input: "The action input was invalid.",
  oauth_refresh_unavailable: "The OAuth credential could not be refreshed.",
  oauth_token_expired: "The OAuth credential has expired.",
  provider_error: "The provider request failed.",
  rate_limited: "The provider rate limit was reached.",
};

interface SummaryState {
  nodes: number;
}

export type { ProviderFailureDiagnostic } from "../../core/provider-error-diagnostic.ts";

/** Return a bounded, redacted value suitable for run audit storage. */
export function summarizeForRunLog(value: unknown): unknown {
  try {
    const summary = summarize(value, [], 0, { nodes: 0 });
    return new TextEncoder().encode(JSON.stringify(summary)).byteLength <= maxBytes ? summary : "[truncated]";
  } catch {
    return "[unavailable]";
  }
}

export function safeRunLogError(
  error: ExecutionResult["error"],
  action?: Pick<ActionDefinition, "inputSchema">,
): { errorCode?: string; errorMessage?: string } {
  if (!error) {
    return {};
  }
  const diagnostic = safeProviderFailureDiagnostic(error);
  return {
    errorCode: error.code,
    errorMessage: diagnostic
      ? diagnostic.providerErrorCode
        ? `${diagnostic.providerErrorCode}: ${diagnostic.providerErrorMessage}`
        : diagnostic.providerErrorMessage
      : (safeInputValidationMessage(error, action) ?? safeErrorMessages[error.code] ?? "Action execution failed."),
  };
}

/** Use only schema-owned field names and constraints, never rejected input values or unknown keys. */
function safeInputValidationMessage(
  error: NonNullable<ExecutionResult["error"]>,
  action: Pick<ActionDefinition, "inputSchema"> | undefined,
): string | undefined {
  if (error.code !== "invalid_input" || !Array.isArray(error.details) || !action) return undefined;
  const properties = action.inputSchema.properties;
  if (!properties || typeof properties !== "object") return undefined;
  const fields = Object.keys(properties);
  const hints = new Set<string>();
  for (const issue of error.details) {
    if (!issue || typeof issue !== "object") continue;
    if (issue.keyword === "required" && issue.keywordLocation === "#/required") {
      const field = fields.find((name) => issue.error === `Instance does not have required property "${name}".`);
      if (field) hints.add(`${field} is required`);
    } else if (issue.keyword === "additionalProperties") {
      hints.add("unexpected input field");
    } else if (
      typeof issue.instanceLocation === "string" &&
      ["type", "enum", "minimum", "maximum", "minLength", "maxLength", "pattern"].includes(issue.keyword)
    ) {
      const field = fields.find((name) => {
        const pointer = `#/${name.replace(/~/g, "~0").replace(/\//g, "~1")}`;
        return issue.instanceLocation === pointer || issue.instanceLocation.startsWith(`${pointer}/`);
      });
      if (field) hints.add(`${field} (${issue.keyword})`);
    } else if (issue.keyword === "anyOf" && issue.keywordLocation === "#/anyOf") {
      const alternatives = action.inputSchema.anyOf;
      if (!Array.isArray(alternatives) || alternatives.length === 0) continue;
      const required = alternatives.map((branch) => branch?.required);
      if (required.every((names) => Array.isArray(names) && names.length === 1 && fields.includes(names[0]))) {
        hints.add(`provide a valid ${required.map((names) => names[0]).join(" or ")}`);
      }
    }
  }
  return hints.size ? `Invalid action input: ${[...hints].slice(0, 5).join("; ")}.`.slice(0, 512) : undefined;
}

/** Only explicit, sanitized upstream messages are eligible for diagnostic logs. */
export function safeProviderFailureDiagnostic(error: ExecutionResult["error"]): ProviderFailureDiagnostic | undefined {
  const details = error?.details;
  if (details === null || typeof details !== "object") {
    return undefined;
  }
  const providerDetails = (details as Record<string, unknown>).details;
  if (providerDetails === null || typeof providerDetails !== "object") {
    return undefined;
  }
  const upstream = providerDetails as Record<string, unknown>;
  const status = upstream.upstreamStatus ?? (details as Record<string, unknown>).status;
  if (typeof status !== "number" || typeof upstream.upstreamMessage !== "string") {
    return undefined;
  }
  return createProviderFailureDiagnostic(status, upstream.upstreamMessage, upstream.upstreamCode);
}

function summarize(value: unknown, path: string[], depth: number, state: SummaryState): unknown {
  if (state.nodes >= maxNodes || depth > maxDepth) {
    return "[truncated]";
  }
  state.nodes += 1;

  if (typeof value === "string") {
    return summarizeString(value, path);
  }
  if (value == null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, maxArrayLength).map((item) => summarize(item, path, depth + 1, state));
  }
  if (typeof value === "object") {
    return summarizeObject(value, path, depth, state);
  }
  return String(value);
}

function summarizeObject(value: object, path: string[], depth: number, state: SummaryState): unknown {
  try {
    const prototype = Object.getPrototypeOf(value);
    if (ArrayBuffer.isView(value) || (prototype !== Object.prototype && prototype !== null)) {
      return "[unavailable]";
    }

    const entries: Array<[string, unknown]> = [];
    for (const key in value) {
      if (entries.length >= maxObjectKeys) break;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable) continue;
      const nextPath = [...path, key];
      if (sensitiveKeyPattern.test(key) || sensitiveContextPattern.test(nextPath.join("."))) {
        entries.push([key, "[redacted]"]);
      } else {
        entries.push([
          key,
          "value" in descriptor ? summarize(descriptor.value, nextPath, depth + 1, state) : "[unavailable]",
        ]);
      }
    }
    return Object.fromEntries(entries);
  } catch {
    return "[unavailable]";
  }
}

function summarizeString(value: string, path: string[]): string {
  if (credentialValuePattern.test(value)) {
    return "[redacted]";
  }
  if (urlWithAuthorityPattern.test(value)) {
    const urlSummary = summarizeUrl(value, path);
    if (urlSummary != null) {
      return urlSummary;
    }
  }
  return value.length > maxStringLength ? `${value.slice(0, maxStringLength)}[truncated]` : value;
}

function summarizeUrl(value: string, path: string[]): string | undefined {
  const protocolRelative = value.startsWith("//");
  try {
    const url = new URL(value, protocolRelative ? protocolRelativeBaseUrl : undefined);
    if (
      sensitiveUrlContextPattern.test(path.join(".")) ||
      [...url.searchParams.keys()].some((name) => sensitiveKeyPattern.test(name))
    ) {
      return "[redacted-url]";
    }
    if (protocolRelative) {
      return `//${url.host}`;
    }
    // Non-special schemes such as s3 have a null origin.
    return url.origin === "null" ? `${url.protocol}//${url.host}` : url.origin;
  } catch {
    // Preserve malformed values when their retained prefix has no known secret.
    if (sensitiveUrlContextPattern.test(path.join(".")) || hasUrlUserinfo(value) || hasSensitiveQueryKey(value)) {
      return "[redacted-url]";
    }
    return undefined;
  }
}

function hasUrlUserinfo(value: string): boolean {
  // Detects userinfo (user@ or user:pass@) inside the authority of a URL-like
  // string, even when the value as a whole cannot be parsed as a URL.
  const authorityStart = value.indexOf("://") + 3;
  for (let index = authorityStart; index < value.length; index += 1) {
    const character = value[index];
    if (character === "@") {
      return true;
    }
    if (character === "/" || character === "?" || character === "#") {
      return false;
    }
  }
  return false;
}

function hasSensitiveQueryKey(value: string): boolean {
  const visible = value.slice(0, maxStringLength);
  const queryStart = visible.indexOf("?");
  if (queryStart === -1) {
    return false;
  }
  for (const name of new URLSearchParams(visible.slice(queryStart + 1)).keys()) {
    if (sensitiveKeyPattern.test(name)) {
      return true;
    }
  }
  return false;
}
