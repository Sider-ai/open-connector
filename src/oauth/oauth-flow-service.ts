import type { ConnectionService } from "../connection-service.ts";
import type { ISecretCodec } from "../server/secrets/secret-codec-core.ts";
import type { OAuthAuthorizationState } from "./oauth-authorization-service.ts";
import type { OAuthClientConfigInput, OAuthClientConfigService } from "./oauth-client-config-service.ts";

import { OAuthAuthorizationService, OAuthFlowError } from "./oauth-authorization-service.ts";

export type { OAuthAuthorizationState } from "./oauth-authorization-service.ts";
export { OAuthFlowError } from "./oauth-authorization-service.ts";

/**
 * Started OAuth authorization flow returned to the local console.
 */
export type OAuthAuthorizationStart = {
  authorizationUrl: string;
  state: string;
};

export interface OAuthAuthorizationStartInput {
  service: string;
  connectionName?: string;
  clientConfig?: OAuthClientConfigInput;
}

export interface OAuthAuthorizationCompleteInput {
  state: string;
  code: string;
}

export interface OAuthFlowServiceOptions {
  clientConfigs: OAuthClientConfigService;
  connections: ConnectionService;
  states: IOAuthStateStore;
  stateMaxAgeMs?: number;
  secretCodec?: ISecretCodec;
  isCustomClientConfigAllowed?: (service: string) => boolean;
}

/**
 * Storage contract for pending OAuth authorization states.
 */
export interface IOAuthStateStore {
  set(state: OAuthAuthorizationState): Promise<void>;
  take(state: string): Promise<OAuthAuthorizationState | undefined>;
}

/**
 * Coordinates runtime OAuth authorization and token exchange.
 */
export class OAuthFlowService {
  private readonly authorizations: OAuthAuthorizationService;
  private readonly connections: ConnectionService;
  private readonly states: IOAuthStateStore;
  private readonly stateMaxAgeMs: number;
  private readonly secretCodec?: ISecretCodec;
  private readonly isCustomClientConfigAllowed: (service: string) => boolean;

  constructor(input: OAuthFlowServiceOptions) {
    this.authorizations = new OAuthAuthorizationService({
      clientConfigs: input.clientConfigs,
      isCustomClientConfigAllowed: input.isCustomClientConfigAllowed,
    });
    this.connections = input.connections;
    this.states = input.states;
    this.stateMaxAgeMs = input.stateMaxAgeMs ?? 15 * 60 * 1000;
    this.secretCodec = input.secretCodec;
    this.isCustomClientConfigAllowed = input.isCustomClientConfigAllowed ?? (() => false);
  }

  async startAuthorization(input: OAuthAuthorizationStartInput): Promise<OAuthAuthorizationStart> {
    this.connections.assertProviderAvailable(input.service);
    this.assertCustomClientConfigCanBeStored(input);
    const prepared = await this.authorizations.prepareAuthorization(input);
    await this.states.set(prepared.pending);

    return {
      authorizationUrl: prepared.authorizationUrl,
      state: prepared.pending.state,
    };
  }

  async completeAuthorization(input: OAuthAuthorizationCompleteInput): Promise<{ service: string; connected: true }> {
    const pending = await this.states.take(input.state);
    if (!pending) {
      throw new OAuthFlowError("invalid_oauth_state", "OAuth state is missing or expired.");
    }
    if (isExpiredOAuthState(pending, this.stateMaxAgeMs)) {
      throw new OAuthFlowError("invalid_oauth_state", "OAuth state is missing or expired.");
    }

    const exchanged = await this.authorizations.exchangeAuthorizationCode({ pending, code: input.code });
    await this.connections.setOAuthCredential(exchanged.service, exchanged.credential, exchanged.connectionName);
    return {
      service: exchanged.service,
      connected: true,
    };
  }

  private assertCustomClientConfigCanBeStored(input: OAuthAuthorizationStartInput): void {
    if (!input.clientConfig) {
      return;
    }
    if (!this.isCustomClientConfigAllowed(input.service)) {
      throw new OAuthFlowError(
        "oauth_custom_app_not_allowed",
        `Custom OAuth apps are not enabled for ${input.service} on this runtime.`,
      );
    }
    if (!this.secretCodec?.encrypted) {
      throw new OAuthFlowError(
        "oauth_custom_app_encryption_required",
        "Configure OOMOL_CONNECT_ENCRYPTION_KEY before using a custom OAuth app.",
      );
    }
  }
}

function isExpiredOAuthState(state: OAuthAuthorizationState, maxAgeMs: number): boolean {
  const createdAt = Date.parse(state.createdAt);
  return !Number.isFinite(createdAt) || Date.now() - createdAt > maxAgeMs;
}
