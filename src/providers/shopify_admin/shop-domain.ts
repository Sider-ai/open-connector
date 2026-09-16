export class ShopifyDomainError extends Error {
  override readonly name = "ShopifyDomainError";
}

/** Normalize a Shopify Admin URL or permanent myshopify.com shop domain. */
export function normalizeShopDomain(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new ShopifyDomainError("shopDomain is required");
  }

  let host = trimmed;
  if (trimmed.includes("://")) {
    try {
      host = new URL(trimmed).hostname;
    } catch {
      throw new ShopifyDomainError("shopDomain must be a myshopify.com domain or URL");
    }
  } else {
    host = trimmed.split("/")[0] ?? "";
  }

  const normalized = host.toLowerCase();
  const suffix = ".myshopify.com";
  const shopName = normalized.endsWith(suffix) ? normalized.slice(0, -suffix.length) : "";
  if (!isDnsLabel(shopName)) {
    throw new ShopifyDomainError("shopDomain must be a myshopify.com domain or URL");
  }
  return normalized;
}

function isDnsLabel(value: string): boolean {
  if (!value || value.startsWith("-") || value.endsWith("-") || value.length > 63) {
    return false;
  }
  for (const char of value) {
    const code = char.charCodeAt(0);
    const isDigit = code >= 48 && code <= 57;
    const isLowercaseLetter = code >= 97 && code <= 122;
    if (!isDigit && !isLowercaseLetter && char !== "-") {
      return false;
    }
  }
  return true;
}
