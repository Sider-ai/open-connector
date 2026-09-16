import type { CredentialDefinition, ResolvedCredential } from "../core/types.ts";
import type {
  OAuthClientConfig,
  OAuthClientConfigInput,
  OAuthClientConfigService,
} from "./oauth-client-config-service.ts";

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { normalizeCredentialValues } from "../core/credential-fields.ts";
import {
  normalizeShopifyAuthorizationValues,
  ShopifyOAuthValidationError,
  verifyShopifyOAuthCallback,
} from "../providers/shopify_admin/oauth.ts";
import { normalizeSlackAuthorizationCredential } from "../providers/slack/oauth.ts";
import { requestAuthorizationCodeToken } from "./oauth-token.ts";

type OAuthCredential = Extract<ResolvedCredential, { authType: "oauth2" }>;

/**
 * Sensitive, serializable context needed to finish an OAuth authorization.
 *
 * A multi-user host must bind this value to its authenticated principal, encrypt
 * it at rest, expire it, and consume it atomically. The Runtime does none of
 * those lifecycle operations on behalf of the host.
 */
export interface OAuthAuthorizationState {
  service: string;
  connectionName?: string;
  state: string;
  createdAt: string;
  pkceCodeVerifier?: string;
  authorizationValues?: Record<string, string>;
  clientConfig?: OAuthClientConfig;
}

export interface PrepareOAuthAuthorizationInput {
  service: string;
  connectionName?: string;
  authorizationValues?: Record<string, unknown>;
  clientConfig?: OAuthClientConfigInput;
}

/**
 * Authorization request plus the pending context that its host must persist.
 */
export interface PreparedOAuthAuthorization {
  authorizationUrl: string;
  pending: OAuthAuthorizationState;
}

export interface ExchangeOAuthAuthorizationCodeInput {
  pending: OAuthAuthorizationState;
  code: string;
  callbackParameters?: readonly (readonly [name: string, value: string])[];
}

/**
 * Normalized credential returned to the host without persisting it.
 */
export interface ExchangedOAuthCredential {
  service: string;
  connectionName?: string;
  credential: OAuthCredential;
}

export interface OAuthAuthorizationServiceOptions {
  clientConfigs: OAuthClientConfigService;
  isCustomClientConfigAllowed?: (service: string) => boolean;
}

/**
 * Stateless OAuth protocol primitives for hosts that own state and credentials.
 */
export class OAuthAuthorizationService {
  private readonly clientConfigs: OAuthClientConfigService;
  private readonly isCustomClientConfigAllowed: (service: string) => boolean;

  constructor(input: OAuthAuthorizationServiceOptions) {
    this.clientConfigs = input.clientConfigs;
    this.isCustomClientConfigAllowed = input.isCustomClientConfigAllowed ?? (() => false);
  }

  async prepareAuthorization(input: PrepareOAuthAuthorizationInput): Promise<PreparedOAuthAuthorization> {
    const { service, connectionName } = input;
    const auth = this.clientConfigs.getOAuthDefinition(service);
    const config = input.clientConfig
      ? this.resolveCustomClientConfig(service, input.clientConfig)
      : await this.clientConfigs.getConfig(service);
    if (!config) {
      throw new OAuthFlowError("oauth_client_config_required", `Configure an OAuth client for ${service} first.`);
    }

    const state = randomUUID();
    const pkceCodeVerifier = auth.pkce ? createPkceCodeVerifier() : undefined;
    const authorizationValues = normalizeAuthorizationValues(
      service,
      auth.authorizationFields ?? [],
      input.authorizationValues ?? {},
    );
    const pending: OAuthAuthorizationState = {
      service,
      connectionName,
      state,
      createdAt: new Date().toISOString(),
      pkceCodeVerifier,
      ...(Object.keys(authorizationValues).length === 0 ? {} : { authorizationValues }),
      clientConfig: input.clientConfig ? config : undefined,
    };

    const authorizationUrl = new URL(
      this.clientConfigs.resolveEndpointUrl(service, auth.authorizationUrl, config, authorizationValues),
    );
    for (const [key, value] of Object.entries(auth.authorizationParams ?? {})) {
      authorizationUrl.searchParams.set(key, value);
    }
    setAuthorizationParam(authorizationUrl, auth.authorizationRequestFields?.clientId, "client_id", config.clientId);
    setAuthorizationParam(
      authorizationUrl,
      auth.authorizationRequestFields?.redirectUri,
      "redirect_uri",
      this.clientConfigs.expectedRedirectUri(service),
    );
    setAuthorizationParam(authorizationUrl, auth.authorizationRequestFields?.responseType, "response_type", "code");
    setAuthorizationParam(authorizationUrl, auth.authorizationRequestFields?.state, "state", state);
    const effectiveScopes = this.clientConfigs.getEffectiveScopes(service, config);
    if (effectiveScopes.length > 0 && auth.authorizationRequestFields?.scope !== false) {
      authorizationUrl.searchParams.set(
        auth.authorizationRequestFields?.scope ?? "scope",
        effectiveScopes.join(auth.scopeSeparator ?? " "),
      );
    }
    if (pkceCodeVerifier) {
      authorizationUrl.searchParams.set("code_challenge", createPkceCodeChallenge(pkceCodeVerifier));
      authorizationUrl.searchParams.set("code_challenge_method", auth.pkce?.method ?? "S256");
    }

    return {
      authorizationUrl: authorizationUrl.toString(),
      pending,
    };
  }

  async exchangeAuthorizationCode(input: ExchangeOAuthAuthorizationCodeInput): Promise<ExchangedOAuthCredential> {
    const { pending } = input;
    const auth = this.clientConfigs.getOAuthDefinition(pending.service);
    const config = pending.clientConfig ?? (await this.clientConfigs.getConfig(pending.service));
    if (!config) {
      throw new OAuthFlowError(
        "oauth_client_config_required",
        `Configure an OAuth client for ${pending.service} first.`,
      );
    }

    if (pending.service === "shopify_admin") {
      try {
        verifyShopifyOAuthCallback({
          parameters: input.callbackParameters ?? [],
          clientSecret: config.clientSecret,
          expectedCode: input.code,
          expectedShopDomain: pending.authorizationValues?.shopDomain,
          expectedState: pending.state,
        });
      } catch (error) {
        if (error instanceof ShopifyOAuthValidationError) {
          throw new OAuthFlowError("oauth_callback_validation_failed", error.message);
        }
        throw error;
      }
    }

    let tokenResponse = await requestAuthorizationCodeToken({
      code: input.code,
      state: pending.state,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      redirectUri: this.clientConfigs.expectedRedirectUri(pending.service),
      responseEnvelope: auth.tokenResponseEnvelope,
      tokenRequestFields: auth.tokenRequestFields,
      tokenEndpointAuthMethod: auth.tokenEndpointAuthMethod,
      tokenRequestFormat: auth.tokenRequestFormat,
      tokenUrl: this.clientConfigs.resolveEndpointUrl(
        pending.service,
        auth.tokenUrl,
        config,
        pending.authorizationValues,
      ),
      extraFields: createTokenExtraFields(auth.tokenRequestParams?.authorizationCode, pending),
      createError: (message) => new OAuthFlowError("oauth_token_exchange_failed", message),
    });
    if (pending.service === "slack") {
      // Slack returns a separately rotated user grant in `authed_user`.
      // Move it out of non-secret metadata before returning the credential.
      tokenResponse = normalizeSlackAuthorizationCredential(tokenResponse);
    }

    return {
      service: pending.service,
      connectionName: pending.connectionName,
      credential: {
        ...tokenResponse,
        metadata: {
          ...tokenResponse.metadata,
          oauthClientId: config.clientId,
          oauthClientExtra: config.extra,
          oauthClientSecretExtra: config.secretExtra,
          ...(pending.authorizationValues === undefined
            ? {}
            : { oauthAuthorizationValues: pending.authorizationValues }),
          oauthClientConfig: pending.clientConfig ? config : undefined,
        },
      },
    };
  }

  private resolveCustomClientConfig(service: string, input: OAuthClientConfigInput): OAuthClientConfig {
    if (!this.isCustomClientConfigAllowed(service)) {
      throw new OAuthFlowError(
        "oauth_custom_app_not_allowed",
        `Custom OAuth apps are not enabled for ${service} on this runtime.`,
      );
    }
    return this.clientConfigs.normalizeConfig(service, input);
  }
}

function setAuthorizationParam(
  url: URL,
  fieldName: string | false | undefined,
  defaultFieldName: string,
  value: string,
): void {
  if (fieldName !== false) {
    url.searchParams.set(fieldName ?? defaultFieldName, value);
  }
}

function createTokenExtraFields(
  configured: Record<string, string> | undefined,
  state: OAuthAuthorizationState,
): Record<string, string> | undefined {
  if (!state.pkceCodeVerifier && configured === undefined) {
    return undefined;
  }

  return {
    ...(configured ?? {}),
    ...(state.pkceCodeVerifier === undefined ? {} : { code_verifier: state.pkceCodeVerifier }),
  };
}

function normalizeAuthorizationValues(
  service: string,
  fields: CredentialDefinition[],
  input: Record<string, unknown>,
): Record<string, string> {
  const values = normalizeCredentialValues({
    fields,
    values: input,
    createError: (message) => new OAuthFlowError("invalid_authorization_values", message),
  });
  if (service !== "shopify_admin") {
    return values;
  }
  try {
    return normalizeShopifyAuthorizationValues(values);
  } catch (error) {
    if (error instanceof ShopifyOAuthValidationError) {
      throw new OAuthFlowError("invalid_authorization_values", error.message);
    }
    throw error;
  }
}

function createPkceCodeVerifier(): string {
  return encodeBase64Url(randomBytes(48));
}

function createPkceCodeChallenge(codeVerifier: string): string {
  return encodeBase64Url(createHash("sha256").update(codeVerifier).digest());
}

function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/**
 * Error with a stable code suitable for HTTP responses.
 */
export class OAuthFlowError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
