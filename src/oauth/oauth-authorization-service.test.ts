import type { ProviderDefinition } from "../core/types.ts";
import type { IOAuthClientConfigStore, OAuthClientConfig } from "./oauth-client-config-service.ts";

import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCatalogStore } from "../catalog-store.ts";
import { OAuthAuthorizationService } from "./oauth-authorization-service.ts";
import { OAuthClientConfigService } from "./oauth-client-config-service.ts";

const pkceProvider: ProviderDefinition = {
  service: "hosted_oauth",
  displayName: "Hosted OAuth",
  categories: ["Developer Tools"],
  authTypes: ["oauth2"],
  auth: [
    {
      type: "oauth2",
      authorizationUrl: "https://provider.example.com/oauth/authorize",
      tokenUrl: "https://provider.example.com/oauth/token",
      scopes: ["read", "write"],
      tokenEndpointAuthMethod: "client_secret_post",
      pkce: { method: "S256" },
    },
  ],
  actions: [],
};

const shopifyAdminProvider: ProviderDefinition = {
  service: "shopify_admin",
  displayName: "Shopify Admin",
  categories: ["Data"],
  authTypes: ["oauth2"],
  auth: [
    {
      type: "oauth2",
      authorizationUrl: "https://{shopDomain}/admin/oauth/authorize",
      tokenUrl: "https://{shopDomain}/admin/oauth/access_token",
      scopes: ["read_products"],
      scopeSeparator: ",",
      tokenEndpointAuthMethod: "client_secret_post",
      tokenRequestFields: { authorizationCode: { grantType: false, redirectUri: false } },
      tokenRequestParams: { authorizationCode: { expiring: "1" } },
      authorizationFields: [
        {
          key: "shopDomain",
          label: "Shop domain",
          inputType: "text",
          required: true,
          secret: false,
        },
      ],
    },
  ],
  actions: [],
};

describe("OAuthAuthorizationService", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("returns serializable pending authorization state for its host to own", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T10:00:00.000Z"));
    const authorizations = await createAuthorizationService();

    const prepared = await authorizations.prepareAuthorization({
      service: "hosted_oauth",
      connectionName: "work",
    });
    const url = new URL(prepared.authorizationUrl);

    expect(prepared.pending).toMatchObject({
      service: "hosted_oauth",
      connectionName: "work",
      createdAt: "2026-08-24T10:00:00.000Z",
    });
    expect(prepared.pending.state).toMatch(/^[0-9a-f-]{36}$/);
    expect(prepared.pending.pkceCodeVerifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(JSON.parse(JSON.stringify(prepared.pending))).toEqual(prepared.pending);
    expect(url.searchParams.get("state")).toBe(prepared.pending.state);
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("returns a normalized credential without consuming state or persisting a connection", async () => {
    const authorizations = await createAuthorizationService();
    const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json({
        access_token: "access-token",
        refresh_token: "refresh-token",
        token_type: "Bearer",
        scope: "read write",
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    const prepared = await authorizations.prepareAuthorization({
      service: "hosted_oauth",
      connectionName: "work",
    });

    const exchanged = await authorizations.exchangeAuthorizationCode({
      pending: prepared.pending,
      code: "authorization-code",
    });

    expect(exchanged).toMatchObject({
      service: "hosted_oauth",
      connectionName: "work",
      credential: {
        authType: "oauth2",
        accessToken: "access-token",
        refreshToken: "refresh-token",
        metadata: {
          oauthClientId: "client-id",
        },
      },
    });
    const request = fetcher.mock.calls[0];
    expect(request?.[0]).toBe("https://provider.example.com/oauth/token");
    const body = request?.[1]?.body;
    expect(body).toBeInstanceOf(URLSearchParams);
    expect((body as URLSearchParams).get("code")).toBe("authorization-code");
    expect((body as URLSearchParams).get("code_verifier")).toBe(prepared.pending.pkceCodeVerifier);
  });

  it("leaves custom OAuth client state encryption to an explicitly opted-in host", async () => {
    const authorizations = await createAuthorizationService({
      isCustomClientConfigAllowed: (service) => service === "hosted_oauth",
    });

    const prepared = await authorizations.prepareAuthorization({
      service: "hosted_oauth",
      clientConfig: {
        clientId: "custom-client-id",
        clientSecret: "custom-client-secret",
      },
    });

    expect(prepared.pending.clientConfig).toMatchObject({
      clientId: "custom-client-id",
      clientSecret: "custom-client-secret",
    });
    expect(new URL(prepared.authorizationUrl).searchParams.get("client_id")).toBe("custom-client-id");
  });

  it("binds a normalized Shopify shop domain to its authorization URL and pending state", async () => {
    const authorizations = await createAuthorizationService({}, shopifyAdminProvider);

    const prepared = await authorizations.prepareAuthorization({
      service: "shopify_admin",
      connectionName: "store",
      authorizationValues: { shopDomain: " Example-Shop.MyShopify.com " },
    });
    const url = new URL(prepared.authorizationUrl);

    expect(url.origin + url.pathname).toBe("https://example-shop.myshopify.com/admin/oauth/authorize");
    expect(url.searchParams.get("scope")).toBe("read_products");
    expect(prepared.pending.authorizationValues).toEqual({ shopDomain: "example-shop.myshopify.com" });
  });

  it("rejects missing and non-Shopify authorization domains before creating an authorization URL", async () => {
    const authorizations = await createAuthorizationService({}, shopifyAdminProvider);

    await expect(
      authorizations.prepareAuthorization({ service: "shopify_admin", authorizationValues: {} }),
    ).rejects.toMatchObject({ code: "invalid_authorization_values" });
    await expect(
      authorizations.prepareAuthorization({
        service: "shopify_admin",
        authorizationValues: { shopDomain: "attacker.example" },
      }),
    ).rejects.toMatchObject({ code: "invalid_authorization_values" });
  });

  it("verifies Shopify's callback before exchanging an expiring shop-specific token", async () => {
    const authorizations = await createAuthorizationService({}, shopifyAdminProvider);
    const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json({
        access_token: "shopify-access-token",
        refresh_token: "shopify-refresh-token",
        expires_in: 86_399,
        scope: "read_products",
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    const prepared = await authorizations.prepareAuthorization({
      service: "shopify_admin",
      connectionName: "store",
      authorizationValues: { shopDomain: "example-shop.myshopify.com" },
    });
    const code = "shopify-authorization-code";
    const callbackParameters = signedShopifyCallback(code, prepared.pending.state);

    const exchanged = await authorizations.exchangeAuthorizationCode({
      pending: prepared.pending,
      code,
      callbackParameters,
    });

    expect(exchanged.credential).toMatchObject({
      accessToken: "shopify-access-token",
      refreshToken: "shopify-refresh-token",
      metadata: {
        scope: "read_products",
        oauthAuthorizationValues: { shopDomain: "example-shop.myshopify.com" },
      },
    });
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://example-shop.myshopify.com/admin/oauth/access_token");
    const body = fetcher.mock.calls[0]?.[1]?.body;
    expect(body).toBeInstanceOf(URLSearchParams);
    if (!(body instanceof URLSearchParams)) {
      throw new Error("Expected Shopify token exchange body to use URLSearchParams");
    }
    expect(body.get("expiring")).toBe("1");
    expect(body.has("grant_type")).toBe(false);
    expect(body.has("redirect_uri")).toBe(false);
  });
});

interface CreateAuthorizationServiceOptions {
  isCustomClientConfigAllowed?: (service: string) => boolean;
}

async function createAuthorizationService(
  options: CreateAuthorizationServiceOptions = {},
  provider: ProviderDefinition = pkceProvider,
): Promise<OAuthAuthorizationService> {
  const clientConfigs = new OAuthClientConfigService({
    catalog: createCatalogStore([provider]),
    origin: "https://integrations.example.com",
    store: new MemoryOAuthClientConfigStore(),
  });
  await clientConfigs.upsertConfig({
    service: provider.service,
    clientId: "client-id",
    clientSecret: "client-secret",
  });
  return new OAuthAuthorizationService({
    clientConfigs,
    isCustomClientConfigAllowed: options.isCustomClientConfigAllowed,
  });
}

class MemoryOAuthClientConfigStore implements IOAuthClientConfigStore {
  private readonly configs = new Map<string, OAuthClientConfig>();

  async get(service: string): Promise<OAuthClientConfig | undefined> {
    return this.configs.get(service);
  }

  async set(config: OAuthClientConfig): Promise<void> {
    this.configs.set(config.service, config);
  }

  async delete(service: string): Promise<void> {
    this.configs.delete(service);
  }

  async list(): Promise<OAuthClientConfig[]> {
    return [...this.configs.values()];
  }
}

function signedShopifyCallback(code: string, state: string): readonly (readonly [name: string, value: string])[] {
  const unsigned = [
    ["code", code],
    ["shop", "example-shop.myshopify.com"],
    ["state", state],
    ["timestamp", "1789545600"],
  ] as const;
  const message = unsigned.map(([key, value]) => `${key}=${value}`).join("&");
  const hmac = createHmac("sha256", "client-secret").update(message).digest("hex");
  return [...unsigned, ["hmac", hmac]];
}
