// WebAuthn JSON helpers for the Squawk ceremonies (auth-service-33): Squawk
// speaks the WebAuthn JSON convention (base64url fields). Newer browsers
// parse/serialize natively; the fallbacks cover the rest.

const toBuf = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '='));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const toB64 = (buf: ArrayBuffer | null): string | undefined =>
  buf ? btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : undefined;

interface PkCredParam { type: string; alg: number }
interface PkDescriptor { type: string; id: string; transports?: string[] }

export interface AssertionOptionsJSON {
  challenge: string;
  rpId?: string;
  timeout?: number;
  userVerification?: string;
  allowCredentials?: PkDescriptor[];
  extensions?: Record<string, unknown>;
}

export interface CreationOptionsJSON {
  challenge: string;
  rp: { id?: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: PkCredParam[];
  timeout?: number;
  attestation?: string;
  authenticatorSelection?: AuthenticatorSelectionCriteria;
  excludeCredentials?: PkDescriptor[];
  extensions?: Record<string, unknown>;
}

type PKC = typeof PublicKeyCredential & {
  parseRequestOptionsFromJSON?: (o: unknown) => PublicKeyCredentialRequestOptions;
  parseCreationOptionsFromJSON?: (o: unknown) => PublicKeyCredentialCreationOptions;
};

export function decodeAssertionOptions(pk: AssertionOptionsJSON): PublicKeyCredentialRequestOptions {
  const P = PublicKeyCredential as PKC;
  if (typeof P.parseRequestOptionsFromJSON === 'function') return P.parseRequestOptionsFromJSON(pk);
  return {
    challenge: toBuf(pk.challenge),
    rpId: pk.rpId,
    timeout: pk.timeout,
    userVerification: pk.userVerification as UserVerificationRequirement | undefined,
    allowCredentials: (pk.allowCredentials ?? []).map((c) => ({
      type: c.type as PublicKeyCredentialType,
      id: toBuf(c.id),
      transports: c.transports as AuthenticatorTransport[] | undefined,
    })),
    extensions: pk.extensions as AuthenticationExtensionsClientInputs | undefined,
  };
}

export function decodeCreationOptions(pk: CreationOptionsJSON): PublicKeyCredentialCreationOptions {
  const P = PublicKeyCredential as PKC;
  if (typeof P.parseCreationOptionsFromJSON === 'function') return P.parseCreationOptionsFromJSON(pk);
  return {
    challenge: toBuf(pk.challenge),
    rp: pk.rp,
    user: { ...pk.user, id: toBuf(pk.user.id) },
    pubKeyCredParams: pk.pubKeyCredParams.map((p) => ({ type: p.type as PublicKeyCredentialType, alg: p.alg })),
    timeout: pk.timeout,
    attestation: pk.attestation as AttestationConveyancePreference | undefined,
    authenticatorSelection: pk.authenticatorSelection,
    excludeCredentials: (pk.excludeCredentials ?? []).map((c) => ({
      type: c.type as PublicKeyCredentialType,
      id: toBuf(c.id),
      transports: c.transports as AuthenticatorTransport[] | undefined,
    })),
    extensions: pk.extensions as AuthenticationExtensionsClientInputs | undefined,
  };
}

type WithJSON = PublicKeyCredential & { toJSON?: () => unknown };

export function encodeAssertion(cred: PublicKeyCredential): unknown {
  const c = cred as WithJSON;
  if (typeof c.toJSON === 'function') return c.toJSON();
  const r = cred.response as AuthenticatorAssertionResponse;
  return {
    id: cred.id,
    rawId: toB64(cred.rawId),
    type: cred.type,
    authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
    clientExtensionResults: cred.getClientExtensionResults(),
    response: {
      clientDataJSON: toB64(r.clientDataJSON),
      authenticatorData: toB64(r.authenticatorData),
      signature: toB64(r.signature),
      userHandle: toB64(r.userHandle),
    },
  };
}

export function encodeAttestation(cred: PublicKeyCredential): unknown {
  const c = cred as WithJSON;
  if (typeof c.toJSON === 'function') return c.toJSON();
  const r = cred.response as AuthenticatorAttestationResponse;
  return {
    id: cred.id,
    rawId: toB64(cred.rawId),
    type: cred.type,
    authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
    clientExtensionResults: cred.getClientExtensionResults(),
    response: {
      clientDataJSON: toB64(r.clientDataJSON),
      attestationObject: toB64(r.attestationObject),
      transports: typeof r.getTransports === 'function' ? r.getTransports() : undefined,
    },
  };
}

/** A human label for a new passkey, editable later in the Squawk console. */
export const deviceName = (): string => (navigator.platform || 'This device').slice(0, 60);

export const passkeysSupported = (): boolean => typeof window !== 'undefined' && 'PublicKeyCredential' in window;

/** True when the user dismissed or timed out the authenticator prompt. */
export const isCancelled = (err: unknown): boolean =>
  err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'AbortError');
