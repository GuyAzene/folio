// How a build of Folio is signed and notarized, read from the environment. scripts/package.ts
// acts on it. It sits in a module of its own so the rule that keeps an unsigned build from being
// published can be tested without building anything.

export interface Signing {
  /** A Developer ID signs the Mac app and its disk image; without one the Mac build is ad-hoc. */
  developerId: boolean;
  /** How notarytool signs in to Apple, when this build is notarized. */
  notaryAuth: string[] | undefined;
}

/**
 * Signing for a build on `platform` from `env`. The App Store Connect API key's file and IDs come
 * first, then a keychain profile, in the order electron-builder tries them for the app. An empty
 * variable, as GitHub passes a secret that isn't set, counts as missing. With FOLIO_NOTARIZE=1 the
 * build must be signed and notarized, so anything missing throws, naming it.
 */
export function signing(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Signing {
  const developerId = !!(env.CSC_NAME || env.CSC_LINK);
  const { APPLE_API_KEY: key, APPLE_API_KEY_ID: keyId, APPLE_API_ISSUER: issuer } = env;
  const profile = env.APPLE_KEYCHAIN_PROFILE;
  const auth =
    key && keyId && issuer
      ? ["--key", key, "--key-id", keyId, "--issuer", issuer]
      : profile
        ? ["--keychain-profile", profile]
        : undefined;
  const mac = platform === "darwin";
  const notaryAuth = mac && developerId ? auth : undefined;
  if (env.FOLIO_NOTARIZE === "1" && !notaryAuth) {
    if (!mac) throw new Error("FOLIO_NOTARIZE=1 is for a Mac build.");
    const missing = [
      ...(developerId ? [] : ["CSC_LINK or CSC_NAME"]),
      ...(auth ? [] : ["APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER"]),
    ];
    throw new Error(
      `FOLIO_NOTARIZE=1 needs a Developer ID and Apple's notarization key; missing ${missing.join(" and ")}.`,
    );
  }
  return { developerId, notaryAuth };
}
