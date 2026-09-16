import { createHmac, timingSafeEqual } from "node:crypto";
import { optionalString } from "../../core/cast.ts";
import { normalizeShopDomain } from "./shop-domain.ts";

export type ShopifyOAuthCallbackParameter = readonly [name: string, value: string];

export interface VerifyShopifyOAuthCallbackInput {
  readonly parameters: readonly ShopifyOAuthCallbackParameter[];
  readonly clientSecret: string;
  readonly expectedCode: string;
  readonly expectedShopDomain: string | undefined;
  readonly expectedState: string;
}

export class ShopifyOAuthValidationError extends Error {
  override readonly name = "ShopifyOAuthValidationError";
}

/** Normalize the per-connection values used in Shopify's shop-specific OAuth endpoints. */
export function normalizeShopifyAuthorizationValues(values: Record<string, string>): Record<string, string> {
  try {
    return {
      ...values,
      shopDomain: normalizeShopDomain(optionalString(values.shopDomain)),
    };
  } catch {
    throw new ShopifyOAuthValidationError("shopDomain must be a myshopify.com domain or URL");
  }
}

/** Verify Shopify's signed OAuth callback and bind it to the shop that started the flow. */
export function verifyShopifyOAuthCallback(input: VerifyShopifyOAuthCallbackInput): void {
  const parameters = uniqueParameters(input.parameters);
  const hmac = requiredParameter(parameters, "hmac");
  const shopDomain = normalizeCallbackShop(requiredParameter(parameters, "shop"));

  if (
    requiredParameter(parameters, "code") !== input.expectedCode ||
    requiredParameter(parameters, "state") !== input.expectedState ||
    shopDomain !== normalizeExpectedShop(input.expectedShopDomain)
  ) {
    throw new ShopifyOAuthValidationError("Shopify OAuth callback does not match the pending authorization");
  }
  requiredParameter(parameters, "timestamp");

  if (!/^[0-9a-f]{64}$/iu.test(hmac)) {
    throw new ShopifyOAuthValidationError("Shopify OAuth callback HMAC is invalid");
  }

  const message = [...parameters.entries()]
    .filter(([key]) => key !== "hmac")
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const expected = createHmac("sha256", input.clientSecret).update(message).digest();
  const actual = Buffer.from(hmac, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new ShopifyOAuthValidationError("Shopify OAuth callback HMAC is invalid");
  }
}

function uniqueParameters(parameters: readonly ShopifyOAuthCallbackParameter[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const [key, value] of parameters) {
    if (result.has(key)) {
      throw new ShopifyOAuthValidationError("Shopify OAuth callback contains duplicate parameters");
    }
    result.set(key, value);
  }
  return result;
}

function requiredParameter(parameters: ReadonlyMap<string, string>, key: string): string {
  const value = parameters.get(key);
  if (!value) {
    throw new ShopifyOAuthValidationError(`Shopify OAuth callback is missing ${key}`);
  }
  return value;
}

function normalizeExpectedShop(value: string | undefined): string {
  try {
    return normalizeShopDomain(value);
  } catch {
    throw new ShopifyOAuthValidationError("Pending Shopify shop domain is invalid");
  }
}

function normalizeCallbackShop(value: string): string {
  try {
    return normalizeShopDomain(value);
  } catch {
    throw new ShopifyOAuthValidationError("Shopify OAuth callback shop domain is invalid");
  }
}
