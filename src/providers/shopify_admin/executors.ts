import type {
  CredentialValidators,
  ExecutionContext,
  ProviderExecutors,
  ProviderProxyExecutor,
  ResolvedCredential,
} from "../../core/types.ts";

import { optionalRecord, optionalString } from "../../core/cast.ts";
import { defineProviderExecutors, defineProviderProxy, ProviderRequestError } from "../provider-runtime.ts";
import { buildShopifyAdminApiBaseUrl, shopifyAdminActionHandlers, validateShopifyAdminCredential } from "./runtime.ts";
import { normalizeShopDomain } from "./shop-domain.ts";

const service = "shopify_admin";

export const executors: ProviderExecutors = defineProviderExecutors({
  service,
  handlers: shopifyAdminActionHandlers,
  async createContext(context: ExecutionContext, fetcher: typeof fetch) {
    const credential = await requireShopifyAdminCredential(context);
    return {
      accessToken: shopifyAdminAccessToken(credential),
      shopDomain: shopifyAdminCredentialDomain(credential),
      fetcher,
      transitFiles: context.transitFiles,
      signal: context.signal,
    };
  },
  fallbackMessage: "shopify_admin request failed",
});

export const proxy: ProviderProxyExecutor = defineProviderProxy({
  service,
  baseUrl: async (context) =>
    buildShopifyAdminApiBaseUrl(shopifyAdminCredentialDomain(await requireShopifyAdminCredential(context))),
  auth: { type: "none" },
  async customizeRequest({ context, headers }) {
    headers.set("x-shopify-access-token", shopifyAdminAccessToken(await requireShopifyAdminCredential(context)));
  },
});

export const credentialValidators: CredentialValidators = {
  async apiKey(input, { fetcher, signal }) {
    const shopDomain = optionalString(input.values.shopDomain);
    if (!shopDomain) {
      throw new ProviderRequestError(400, "shopDomain is required");
    }
    return validateShopifyAdminCredential(input.apiKey, shopDomain, fetcher, signal);
  },
  oauth2(input, { fetcher, signal }) {
    return validateShopifyAdminCredential(
      input.accessToken,
      shopifyAdminCredentialDomain(input),
      fetcher,
      signal,
      parseShopifyScopes(input.metadata.scope),
    );
  },
};

type ShopifyAdminCredential = Exclude<ResolvedCredential, { authType: "no_auth" | "custom_credential" }>;

async function requireShopifyAdminCredential(context: ExecutionContext): Promise<ShopifyAdminCredential> {
  const credential = await context.getCredential(service);
  if (credential?.authType === "api_key" || credential?.authType === "oauth2") {
    return credential;
  }
  throw new ProviderRequestError(401, "Configure Shopify Admin credentials first.");
}

function shopifyAdminAccessToken(credential: ShopifyAdminCredential): string {
  return credential.authType === "api_key" ? credential.apiKey : credential.accessToken;
}

function shopifyAdminCredentialDomain(credential: ShopifyAdminCredential): string {
  if (credential.authType === "api_key") {
    return normalizeShopDomain(optionalString(credential.values.shopDomain));
  }
  const authorizationValues = optionalRecord(credential.metadata.oauthAuthorizationValues);
  return normalizeShopDomain(
    optionalString(credential.metadata.shopDomain) ?? optionalString(authorizationValues?.shopDomain),
  );
}

function parseShopifyScopes(value: unknown): string[] {
  return (optionalString(value) ?? "")
    .split(/[ ,]+/u)
    .map((scope) => scope.trim())
    .filter(Boolean);
}
