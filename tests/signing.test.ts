import { describe, expect, it } from "vitest";
import { signing, unsetEmpty } from "../scripts/signing.ts";

const certificate = { CSC_LINK: "base64 of a .p12" };
const apiKey = {
  APPLE_API_KEY: "/tmp/AuthKey_TEST.p8",
  APPLE_API_KEY_ID: "TESTKEYID",
  APPLE_API_ISSUER: "00000000-0000-0000-0000-000000000000",
};
const missingKey = "APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER";

describe("Signing a build", () => {
  it("signs ad-hoc and notarizes nothing without a Developer ID", () => {
    expect(signing({}, "darwin")).toEqual({ developerId: false, notaryAuth: undefined });
    expect(signing(apiKey, "darwin")).toEqual({ developerId: false, notaryAuth: undefined });
  });

  it("signs with a Developer ID without notarizing when Apple's key is missing", () => {
    expect(signing({ CSC_NAME: "Developer ID Application" }, "darwin")).toEqual({
      developerId: true,
      notaryAuth: undefined,
    });
  });

  it("notarizes with the API key, or else a keychain profile", () => {
    expect(signing({ ...certificate, ...apiKey }, "darwin").notaryAuth).toEqual([
      "--key",
      "/tmp/AuthKey_TEST.p8",
      "--key-id",
      "TESTKEYID",
      "--issuer",
      "00000000-0000-0000-0000-000000000000",
    ]);
    const profile = { APPLE_KEYCHAIN_PROFILE: "folio-notary" };
    expect(signing({ ...certificate, ...profile }, "darwin").notaryAuth).toEqual([
      "--keychain-profile",
      "folio-notary",
    ]);
    expect(signing({ ...certificate, ...apiKey, ...profile }, "darwin").notaryAuth?.[0]).toBe(
      "--key",
    );
  });

  it("notarizes nothing on Windows", () => {
    expect(signing({ ...certificate, ...apiKey }, "win32").notaryAuth).toBeUndefined();
  });

  it("with FOLIO_NOTARIZE=1, refuses to build without every secret and names what is missing", () => {
    const notarize = { FOLIO_NOTARIZE: "1" };
    expect(() => signing(notarize, "darwin")).toThrow(
      `missing CSC_LINK or CSC_NAME and ${missingKey}.`,
    );
    expect(() => signing({ ...notarize, ...apiKey }, "darwin")).toThrow(
      /missing CSC_LINK or CSC_NAME\.$/,
    );
    expect(() =>
      signing({ ...notarize, ...certificate, ...apiKey, APPLE_API_ISSUER: undefined }, "darwin"),
    ).toThrow(new RegExp(`missing ${missingKey}\\.$`));
    expect(signing({ ...notarize, ...certificate, ...apiKey }, "darwin").notaryAuth).toHaveLength(
      6,
    );
  });

  it("counts an empty variable, as GitHub passes a secret that isn't set, as missing", () => {
    const unset = {
      FOLIO_NOTARIZE: "1",
      CSC_LINK: "",
      CSC_KEY_PASSWORD: "",
      APPLE_API_KEY_ID: "",
      APPLE_API_ISSUER: "",
    };
    expect(() => signing(unset, "darwin")).toThrow(
      `missing CSC_LINK or CSC_NAME and ${missingKey}.`,
    );
  });

  it("unsets the empty signing variables GitHub passes for secrets that aren't set", () => {
    const env = { CSC_LINK: "", CSC_KEY_PASSWORD: "", APPLE_API_KEY_ID: "", PATH: "", HOME: "/x" };
    unsetEmpty(env);
    expect(env).toEqual({ PATH: "", HOME: "/x" });
    const set = { ...certificate, ...apiKey };
    unsetEmpty(set);
    expect(set).toEqual({ ...certificate, ...apiKey });
  });

  it("with FOLIO_NOTARIZE=1, refuses a Windows build", () => {
    expect(() => signing({ FOLIO_NOTARIZE: "1", ...certificate, ...apiKey }, "win32")).toThrow(
      "FOLIO_NOTARIZE=1 is for a Mac build.",
    );
  });
});
