import type {
  CredentialValidators,
  ExecutionContext,
  ProviderExecutors,
  ProviderProxyExecutor,
} from "../../core/types.ts";
import type { TrelloActionContext } from "./runtime.ts";
import type { TrelloCredential } from "./runtime.ts";

import {
  createProviderFetch,
  createProviderProxyUrl,
  defineProviderExecutors,
  normalizeProviderProxyHeaders,
  ProviderRequestError,
  providerUserAgent,
  readProviderProxyErrorMessage,
  readProviderProxyResponse,
  toProviderProxyError,
} from "../provider-runtime.ts";
import {
  applyTrelloAuthentication,
  trelloActionHandlers,
  trelloApiBaseUrl,
  validateTrelloCredential,
  validateTrelloOAuthCredential,
} from "./runtime.ts";

const service = "trello";

const trelloFetch = createProviderFetch({ skipDnsValidation: true });

export const executors: ProviderExecutors = defineProviderExecutors<TrelloActionContext>({
  service,
  handlers: trelloActionHandlers,
  skipDnsValidation: true,
  async createContext(context: ExecutionContext, fetcher: typeof fetch): Promise<TrelloActionContext> {
    const credential = await requireTrelloCredential(context);
    return {
      ...credential,
      fetcher,
      signal: context.signal,
    };
  },
});

export const proxy: ProviderProxyExecutor = async (input, context) => {
  try {
    const credential = await requireTrelloCredential(context);
    const url = createProviderProxyUrl(trelloApiBaseUrl, input.endpoint, input.query);
    const headers = normalizeProviderProxyHeaders(input.headers);
    headers.set("user-agent", providerUserAgent);
    applyTrelloAuthentication(url, headers, credential);

    const init: RequestInit = {
      method: input.method,
      headers,
      signal: context.signal,
    };
    if (input.body !== undefined) {
      init.body = typeof input.body === "string" ? input.body : JSON.stringify(input.body);
      if (!headers.has("content-type") && typeof input.body !== "string") {
        headers.set("content-type", "application/json");
      }
    }

    const response = await trelloFetch(url, init);
    if (!response.ok) {
      const text = await readProviderProxyErrorMessage(response, "");
      throw new ProviderRequestError(response.status, text || `Trello request failed with HTTP ${response.status}`);
    }
    return { ok: true, response: await readProviderProxyResponse(response) };
  } catch (error) {
    return toProviderProxyError(error, "Trello request failed");
  }
};

export const credentialValidators: CredentialValidators = {
  customCredential: validateTrelloCredential,
  oauth2(input, options) {
    return validateTrelloOAuthCredential(input.accessToken, input.metadata.scope, options);
  },
};

async function requireTrelloCredential(context: ExecutionContext): Promise<TrelloCredential> {
  const credential = await context.getCredential(service);
  if (credential?.authType === "custom_credential") {
    return {
      authType: "custom_credential",
      apiKey: credential.values.apiKey,
      apiToken: credential.values.apiToken,
    };
  }
  if (credential?.authType === "oauth2") {
    return {
      authType: "oauth2",
      accessToken: credential.accessToken,
    };
  }
  throw new ProviderRequestError(401, "Configure Trello credentials first.");
}
