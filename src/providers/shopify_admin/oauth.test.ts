import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ShopifyOAuthValidationError, verifyShopifyOAuthCallback } from "./oauth.ts";

const clientSecret = "shopify-client-secret";
const code = "authorization-code";
const shopDomain = "example-shop.myshopify.com";
const state = "oauth-state";

describe("Shopify OAuth callback verification", () => {
  it("accepts a callback signed by Shopify for the pending shop", () => {
    expect(() => verifyShopifyOAuthCallback(validCallback())).not.toThrow();
  });

  it.each([
    ["shop", "other-shop.myshopify.com"],
    ["code", "other-code"],
    ["state", "other-state"],
    ["hmac", "0".repeat(64)],
  ])("rejects a callback with a tampered %s", (key, value) => {
    const input = validCallback();
    const parameters = input.parameters.map(([name, current]) => [name, name === key ? value : current] as const);

    expect(() => verifyShopifyOAuthCallback({ ...input, parameters })).toThrow(ShopifyOAuthValidationError);
  });

  it("rejects duplicate callback parameters", () => {
    const input = validCallback();

    expect(() =>
      verifyShopifyOAuthCallback({
        ...input,
        parameters: [...input.parameters, ["shop", shopDomain]],
      }),
    ).toThrow(ShopifyOAuthValidationError);
  });
});

function validCallback() {
  const unsigned = [
    ["code", code],
    ["host", "ZXhhbXBsZS5teXNob3BpZnkuY29tL2FkbWlu"],
    ["shop", shopDomain],
    ["state", state],
    ["timestamp", "1789545600"],
  ] as const;
  const message = unsigned.map(([key, value]) => `${key}=${value}`).join("&");
  const hmac = createHmac("sha256", clientSecret).update(message).digest("hex");
  return {
    parameters: [...unsigned, ["hmac", hmac] as const],
    clientSecret,
    expectedCode: code,
    expectedShopDomain: shopDomain,
    expectedState: state,
  };
}
