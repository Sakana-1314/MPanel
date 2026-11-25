/**
 * Shared at-rest secret cipher contract. Implementations live in core and
 * worker (AES-256-GCM is mandatory); this interface prevents the two
 * implementations from drifting and lets either side satisfy the contract
 * without importing the other deployable.
 */
export interface SecretCipher {
  /** Returns an opaque envelope, currently "v1:<iv>:<tag>:<ciphertext>" (base64url fields). */
  encrypt(plain: string): string;
  /** Throws PanelError(INTERNAL) for a malformed/undecryptable envelope. */
  decrypt(payload: string): string;
}

export const SECRET_CIPHER_VERSION = 'v1' as const;
