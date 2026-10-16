import { describe, expect, it } from "vitest";
import { NO_SANDBOX_MESSAGE } from "./none-sandbox.js";
import { createSandboxProvider } from "./sandbox-factory.js";

const ctx = {
  operationId: "op",
  traceId: "tr",
  spaceId: "ws",
  userId: "user",
  signal: new AbortController().signal,
};

describe("createSandboxProvider", () => {
  it("returns fake sandbox when explicitly requested", () => {
    const sandbox = createSandboxProvider("fake", {});
    expect(sandbox.describe().id).toBe("fake");
  });

  it("returns none when requested or when the kind is empty", async () => {
    expect(createSandboxProvider("none", {}).describe().id).toBe("none");
    expect(createSandboxProvider("", {}).describe().id).toBe("none");
    await expect(
      createSandboxProvider("none", {}).provision({ botId: "b", homePath: "/tmp" }, ctx),
    ).rejects.toThrow(NO_SANDBOX_MESSAGE);
  });

  it("returns provider-specific managed sandbox emulators", () => {
    expect(createSandboxProvider("e2b-emulator", {}).describe().id).toBe("e2b-emulator");
    expect(createSandboxProvider("daytona-emulator", {}).describe().id).toBe("daytona-emulator");
    expect(createSandboxProvider("box-emulator", {}).describe()).toMatchObject({
      id: "box-emulator",
      capabilities: { multiScreen: true },
    });
    expect(createSandboxProvider("modal-emulator", {}).describe()).toMatchObject({
      id: "modal-emulator",
      capabilities: { multiScreen: true },
    });
  });

  it("boots without a remote key and keeps computers unavailable", async () => {
    expect(createSandboxProvider("e2b", {}).describe().id).toBe("none");
    expect(createSandboxProvider("daytona", {}).describe().id).toBe("none");
    expect(createSandboxProvider("createos", {}).describe().id).toBe("none");
    expect(createSandboxProvider("box", {}).describe().id).toBe("none");
    expect(createSandboxProvider("modal", {}).describe().id).toBe("none");
    await expect(
      createSandboxProvider("e2b", {}).provision({ botId: "b", homePath: "/tmp" }, ctx),
    ).rejects.toThrow(/E2B_API_KEY/);
    await expect(
      createSandboxProvider("modal", {}).provision({ botId: "b", homePath: "/tmp" }, ctx),
    ).rejects.toThrow(/MODAL_TOKEN_ID/);
    await expect(
      createSandboxProvider("createos", {}).provision({ botId: "b", homePath: "/tmp" }, ctx),
    ).rejects.toThrow(/CREATEOS_SANDBOX_API_KEY/);
    expect(
      createSandboxProvider("createos", { createosApiKey: "test-createos-key" }).describe().id,
    ).toBe("createos");
    expect(createSandboxProvider("box", { boxApiKey: "test-box-key" }).describe().id).toBe("box");
    expect(
      createSandboxProvider("modal", { modalTokenId: "test-modal-token-id" }).describe().id,
    ).toBe("modal");
  });

  it("throws on unknown provider", () => {
    expect(() => createSandboxProvider("bogus", {})).toThrow(
      'Unknown SANDBOX_PROVIDER "bogus". Use none | docker | e2b | daytona | createos | box | railway | modal | e2b-emulator | daytona-emulator | box-emulator | modal-emulator | desktop | fake.',
    );
  });
});
