import type { OAuth2AuthDefinition } from "../core/types.ts";
import type { OAuthClientConfig } from "./oauth-client-config-service.ts";
import type { OAuthTokenResult, ProviderOAuthRuntime } from "./oauth-token.ts";

import { providerFetch, withProviderHttpDispatchResult } from "../providers/provider-runtime.ts";
import { requestAuthorizationCodeToken } from "./oauth-token.ts";

interface CodeExchangeInput {
  service: string;
  state: string;
  pkceCodeVerifier?: string;
  connectionId?: string;
  auth: OAuth2AuthDefinition;
  config: OAuthClientConfig;
  redirectUri: string;
  tokenUrl: string;
  createError: (message: string) => Error;
  providerOAuth?: ProviderOAuthRuntime;
  code: string;
  callbackParameters?: Record<string, string>;
  callbackQuery?: string;
  signal?: AbortSignal;
}
export async function exchangeOAuthCode(input: CodeExchangeInput): Promise<OAuthTokenResult> {
  const { auth, redirectUri, tokenUrl, createError, providerOAuth } = input;
  const tokenResponse = await withProviderHttpDispatchResult(
    {
      operation: "oauth",
      service: input.service,
      connectionId: input.connectionId,
    },
    async () => {
      if (providerOAuth?.exchangeCode) {
        return providerOAuth.exchangeCode({
          code: input.code,
          codeVerifier: input.pkceCodeVerifier,
          state: input.state,
          callbackQuery: input.callbackQuery,
          callbackParameters: input.callbackParameters,
          clientConfig: input.config,
          redirectUri,
          tokenUrl,
          fetcher: providerFetch,
          signal: input.signal,
          createError,
        });
      } else {
        return requestAuthorizationCodeToken({
          code: input.code,
          state: input.state,
          clientId: input.config.clientId,
          clientSecret: input.config.clientSecret,
          redirectUri,
          responseEnvelope: auth.tokenResponseEnvelope,
          tokenRequestFields: auth.tokenRequestFields,
          tokenEndpointAuthMethod: auth.tokenEndpointAuthMethod,
          tokenRequestFormat: auth.tokenRequestFormat,
          tokenUrl,
          extraFields: createTokenExtraFields(
            input,
            auth.tokenRequestCallbackParameters,
            input.callbackParameters,
            auth.resource,
          ),
          signal: input.signal,
          createError,
        });
      }
    },
  );
  const parameters = readCallbackParameters(auth.tokenRequestCallbackParameters, input.callbackParameters);
  return { ...tokenResponse, providerSecret: mergeOAuthProviderSecret(tokenResponse.providerSecret, parameters) };
}

function mergeOAuthProviderSecret(
  providerSecret: Record<string, unknown> | undefined,
  refreshParameters: Record<string, string>,
): Record<string, unknown> | undefined {
  if (Object.keys(refreshParameters).length === 0) {
    return providerSecret;
  }
  return {
    ...providerSecret,
    oauthRefreshParameters: refreshParameters,
  };
}

function createTokenExtraFields(
  state: { pkceCodeVerifier?: string },
  parameterNames: readonly string[] | undefined,
  callbackParameters: Record<string, string> | undefined,
  resource?: string,
): Record<string, string> | undefined {
  const fields = readCallbackParameters(parameterNames, callbackParameters);
  if (resource) fields.resource = resource;
  if (state.pkceCodeVerifier) fields.code_verifier = state.pkceCodeVerifier;
  return Object.keys(fields).length > 0 ? fields : undefined;
}

function readCallbackParameters(
  parameterNames: readonly string[] | undefined,
  values: Record<string, string> | undefined,
): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const name of parameterNames ?? []) {
    const value = values?.[name];
    if (value) fields[name] = value;
  }
  return fields;
}
