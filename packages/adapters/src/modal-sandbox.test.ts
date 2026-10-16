import { AlreadyExistsError, NotFoundError } from "modal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SANDBOX_IDLE_MS } from "./computer-idle.js";
import { isSandboxGoneError } from "./e2b-sandbox.js";
import { desktopCommandResponder } from "./linux-desktop.test-support.js";
import { ModalSandboxProvider, type ModalSandboxSdk, modalComputerName } from "./modal-sandbox.js";

/** The shared command timeout and the provider's idle margin, with the deployment's values kept out. */
const COMMAND_TIMEOUT_MS = 5 * 60_000;
const IDLE_MARGIN_MS = 5 * 60_000;

const context = {
  operationId: "modal-test",
  traceId: "modal-test",
  spaceId: "workspace",
  userId: "user",
  signal: new AbortController().signal,
};

/** Team computers key on the space, which is what makes the Modal name a hash. */
const HOME_KEY = "team:space-a";
const WORKSPACE = "/root/rakazo-home";

describe("ModalSandboxProvider", () => {
  beforeEach(() => {
    vi.stubEnv("SANDBOX_COMMAND_TIMEOUT_MS", "");
    vi.stubEnv("SANDBOX_IDLE_MS", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("creates a sandbox named after the computer from a shared image and its Volume", async () => {
    const fixture = modalFixture();
    const provider = new ModalSandboxProvider({ tokenId: "test-token-id" }, fixture.client);
    const computer = await provider.provision({ botId: HOME_KEY, homePath: "/unused" }, context);

    const name = modalComputerName(HOME_KEY);
    expect(name).toMatch(/^rakazo-[0-9a-f]{32}$/);
    expect(computer).toEqual({
      id: name,
      botId: HOME_KEY,
      kind: "modal",
      providerRef: name,
      fresh: true,
      started: true,
    });
    expect(fixture.appFromName).toHaveBeenCalledWith("rakazo-computers", {
      createIfMissing: true,
      environment: undefined,
    });
    expect(fixture.volumeFromName).toHaveBeenCalledWith(name, {
      createIfMissing: true,
      environment: undefined,
    });
    expect(fixture.sandboxCreate).toHaveBeenCalledTimes(1);
    const [app, image, params] = fixture.sandboxCreate.mock.calls[0]!;
    expect(app).toBe(fixture.app);
    expect(image).toBe(fixture.image);
    expect(params).toMatchObject({
      name,
      cpu: 2,
      memoryMiB: 4096,
      timeoutMs: 24 * 60 * 60 * 1000,
      workdir: WORKSPACE,
      pty: true,
      env: { LANG: "C.UTF-8" },
      volumes: { [WORKSPACE]: fixture.volume },
      encryptedPorts: [6100],
    });
    expect(params?.idleTimeoutMs).toBe(DEFAULT_SANDBOX_IDLE_MS + IDLE_MARGIN_MS);
    expect(fixture.fromRegistry).toHaveBeenCalledWith("debian:bookworm-slim");
    expect(fixture.dockerfileCommands).toHaveBeenCalledWith([expect.stringContaining("chromium")]);
    // Fluxbox needs both desktop shims, or the streamed desktop shows an "fbsetbg not found" dialog.
    const imageCommands = (fixture.dockerfileCommands.mock.calls[0]![0] as string[]).join(" ");
    expect(imageCommands).toContain("printf '%s\\n'");
    expect(imageCommands).toContain("exec xsetroot -solid");
    expect(imageCommands).toContain("ln -sfn /bin/true /usr/bin/xmessage");
    expect(provider.describe()).toMatchObject({
      id: "modal",
      capabilities: {
        graphical: true,
        pty: true,
        snapshots: true,
        takeover: true,
        persistentHome: true,
        multiScreen: true,
      },
    });
    expect(provider.pageBrowser).toBeUndefined();
  });

  it("leaves the idle timeout unset when the deployment sleeps computers itself", async () => {
    vi.stubEnv("SANDBOX_IDLE_MS", "0");
    const fixture = modalFixture();
    const provider = new ModalSandboxProvider({ tokenId: "test-token-id" }, fixture.client);
    await provider.provision({ botId: HOME_KEY, homePath: "/unused" }, context);

    expect(fixture.sandboxCreate.mock.calls[0]?.[2]).not.toHaveProperty("idleTimeoutMs");
  });

  it("reuses a running sandbox by name without touching its Volume", async () => {
    const fixture = modalFixture({ running: true, volume: true });
    const provider = new ModalSandboxProvider({ tokenId: "test-token-id" }, fixture.client);
    const computer = await provider.provision(
      {
        botId: HOME_KEY,
        homePath: "/unused",
        providerRef: "rakazo-existing",
        providerKind: "modal",
      },
      context,
    );

    expect(computer).toEqual({
      id: "rakazo-existing",
      botId: HOME_KEY,
      kind: "modal",
      providerRef: "rakazo-existing",
      fresh: false,
    });
    expect(fixture.sandboxCreate).not.toHaveBeenCalled();
    expect(fixture.volumeFromName).not.toHaveBeenCalled();
  });

  it("boots a computer whose sandbox is gone on the Volume it already had", async () => {
    const fixture = modalFixture({ volume: true });
    const provider = new ModalSandboxProvider({ tokenId: "test-token-id" }, fixture.client);
    const computer = await provider.provision(
      {
        botId: HOME_KEY,
        homePath: "/unused",
        providerRef: "rakazo-existing",
        providerKind: "modal",
      },
      context,
    );

    expect(computer).toEqual({
      id: "rakazo-existing",
      botId: HOME_KEY,
      kind: "modal",
      providerRef: "rakazo-existing",
      fresh: false,
      started: true,
    });
    expect(fixture.volumeFromName).toHaveBeenCalledTimes(1);
    expect(fixture.volumeFromName.mock.calls[0]?.[1]).not.toHaveProperty("createIfMissing");
    expect(fixture.sandboxCreate).toHaveBeenCalledTimes(1);
  });

  it("recreates the Volume when the computer lost it", async () => {
    const fixture = modalFixture();
    const provider = new ModalSandboxProvider({ tokenId: "test-token-id" }, fixture.client);
    const computer = await provider.provision(
      {
        botId: HOME_KEY,
        homePath: "/unused",
        providerRef: "rakazo-existing",
        providerKind: "modal",
      },
      context,
    );

    expect(computer).toMatchObject({ providerRef: "rakazo-existing", fresh: true, started: true });
    expect(fixture.volumeFromName).toHaveBeenLastCalledWith("rakazo-existing", {
      createIfMissing: true,
      environment: undefined,
    });
  });

  it("adopts the sandbox a racing boot already created under the same name", async () => {
    const fixture = modalFixture();
    fixture.sandboxCreate.mockImplementationOnce(async () => {
      // The racing boot won: its sandbox is live by the time we look the name up again.
      fixture.state.running = true;
      throw new AlreadyExistsError("Sandbox with name 'rakazo-existing' already exists");
    });
    const provider = new ModalSandboxProvider({ tokenId: "test-token-id" }, fixture.client);
    const computer = await provider.provision(
      {
        botId: HOME_KEY,
        homePath: "/unused",
        providerRef: "rakazo-existing",
        providerKind: "modal",
      },
      context,
    );

    expect(computer).toMatchObject({ providerRef: "rakazo-existing", fresh: true });
    expect(fixture.sandboxFromName).toHaveBeenCalledTimes(2);
  });

  it("runs commands in the workspace under an in-sandbox timeout", async () => {
    const fixture = modalFixture();
    const provider = new ModalSandboxProvider({ tokenId: "test-token-id" }, fixture.client);
    const computer = await provider.provision({ botId: HOME_KEY, homePath: "/unused" }, context);

    const events = [];
    for await (const event of provider.execute(
      computer,
      {
        argv: ["echo", "hello"],
        cwd: "notes",
        env: { TEST_VALUE: "works" },
        unsetEnv: ["FAILED"],
      },
      context,
    )) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: "stdout", data: "hello\n" },
      { type: "exit", code: 0 },
    ]);

    const call = fixture.exec.mock.calls.find(([argv]) => argv[0] === "timeout");
    expect(call?.[0].slice(0, 5)).toEqual(["timeout", "--kill-after=1s", "300s", "bash", "-lc"]);
    expect(call?.[0][6]).toMatch(/^\/tmp\/rakazo-command-.*\.completed-124$/);
    expect(call?.[0].slice(7)).toEqual(["env", "-u", "FAILED", "--", "echo", "hello"]);
    expect(call?.[1]).toEqual({
      env: { TEST_VALUE: "works" },
      workdir: `${WORKSPACE}/notes`,
      timeoutMs: COMMAND_TIMEOUT_MS + 10_000,
    });
  });

  it("reports a timed-out command as exit 124 with the timeout explanation", async () => {
    const fixture = modalFixture();
    const provider = new ModalSandboxProvider({ tokenId: "test-token-id" }, fixture.client);
    const computer = await provider.provision({ botId: HOME_KEY, homePath: "/unused" }, context);

    const events = [];
    for await (const event of provider.execute(
      computer,
      { argv: ["sleep", "30"], timeoutMs: 40 },
      context,
    )) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "stderr", data: "command timed out after 40 ms\n" },
      { type: "exit", code: 124 },
    ]);
    const call = fixture.exec.mock.calls.find(([argv]) => argv[0] === "timeout");
    expect(call?.[0][2]).toBe("0.04s");
    expect(call?.[1]).toMatchObject({ timeoutMs: 40 + 10_000 });
    // The marker that tells a killed command apart from one that exited 124 itself is consumed.
    expect(fixture.markers.size).toBe(0);
  });

  it("moves portable files in and out of the workspace", async () => {
    const fixture = modalFixture();
    const provider = new ModalSandboxProvider({ tokenId: "test-token-id" }, fixture.client);
    const computer = await provider.provision({ botId: HOME_KEY, homePath: "/unused" }, context);
    const binary = Uint8Array.from([0, 255, 1, 128]);

    await provider.writeFile(computer, { path: "bin/tool", content: binary }, context);
    expect(await provider.readFile(computer, "bin/tool", context)).toEqual(binary);
    await provider.writeFile(
      computer,
      { path: "bin/tool", content: binary, executable: true },
      context,
    );
    expect(fixture.executables.has(`${WORKSPACE}/bin/tool`)).toBe(true);
    expect(await provider.listFiles(computer, "bin", context)).toEqual([
      { path: "bin/tool", kind: "file", size: 4, executable: true },
    ]);
    await expect(provider.readFile(computer, "bin/tool", context, { maxBytes: 3 })).rejects.toThrow(
      "computer file exceeds 3 bytes",
    );
    expect(await provider.readFile(computer, "bin/tool", context, { maxBytes: 4 })).toEqual(binary);

    fixture.files.set(
      `${WORKSPACE}/.browser-profiles/chromium/Cache/data.db`,
      Uint8Array.from([9]),
    );
    const exported = [];
    for await (const file of provider.exportWorkspace(computer, context)) exported.push(file);
    expect(exported).toEqual([{ path: "bin/tool", content: binary, executable: true }]);

    await provider.importWorkspace(
      computer,
      portableFiles([
        { path: "notes/result.txt", content: new TextEncoder().encode("portable") },
        { path: "bin/tool", content: binary, executable: true },
      ]),
      context,
    );
    expect(new TextDecoder().decode(fixture.files.get(`${WORKSPACE}/notes/result.txt`))).toBe(
      "portable",
    );

    await expect(provider.readFile(computer, "missing.bin", context)).rejects.toThrow(
      "No such file or directory",
    );
  });

  it("streams each screen over the sandbox tunnel and keeps its token in the URL", async () => {
    const fixture = modalFixture();
    const provider = new ModalSandboxProvider({ tokenId: "test-token-id" }, fixture.client);
    const computer = await provider.provision({ botId: HOME_KEY, homePath: "/unused" }, context);
    await provider.prepare(computer, context);

    const observation = await provider.observe(computer, context);
    expect(observation).toMatchObject({
      mimeType: "image/png",
      width: 1280,
      height: 800,
      cursor: { x: 10, y: 20 },
    });
    expect(observation.image).toEqual(Uint8Array.from([1, 2, 3]));

    const screen = await provider.connectScreen(
      computer,
      { view: "stream", interactive: false },
      context,
    );
    expect(screen.url).toContain("https://sb-rakazo--6100.modal.host/vnc.html");
    expect(new URL(screen.url!).searchParams.get("path")).toMatch(/^websockify\?token=view-/);
    expect(fixture.tunnels).toHaveBeenCalledWith(60_000);

    await provider.act(
      computer,
      { actions: [{ kind: "pointer", type: "click", x: 100, y: 200 }], observe: false },
      context,
    );
    expect(
      fixture.exec.mock.calls.some(([argv]) =>
        String(argv[2]).includes("xdotool mousemove 100 200 click 1"),
      ),
    ).toBe(true);
    expect(await provider.snapshot(computer, context)).toMatchObject({ id: observation.frameId });
  });

  it("keeps the Volume on stop and deletes it on destroy, both idempotently", async () => {
    const fixture = modalFixture();
    const provider = new ModalSandboxProvider({ tokenId: "test-token-id" }, fixture.client);
    const computer = await provider.provision({ botId: HOME_KEY, homePath: "/unused" }, context);
    const name = modalComputerName(HOME_KEY);

    await provider.stop(computer, context);
    await provider.stop(computer, context);
    expect(fixture.sandbox.terminate).toHaveBeenCalledTimes(1);
    expect(fixture.volumeDelete).not.toHaveBeenCalled();
    expect(fixture.volumeFromName).toHaveBeenCalledTimes(1);
    expect(fixture.sandboxFromName).toHaveBeenCalledTimes(2);

    await provider.destroy(computer, context);
    await provider.destroy(computer, context);
    expect(fixture.volumeDelete).toHaveBeenCalledTimes(2);
    expect(fixture.volumeDelete).toHaveBeenCalledWith(name, {
      environment: undefined,
      allowMissing: true,
    });
  });

  it("refreshes Modal's idle timer and recovers when the sandbox is gone", async () => {
    const fixture = modalFixture();
    const provider = new ModalSandboxProvider({ tokenId: "test-token-id" }, fixture.client);
    const computer = await provider.provision({ botId: HOME_KEY, homePath: "/unused" }, context);

    await provider.keepAlive(computer);
    expect(fixture.exec).toHaveBeenLastCalledWith(["true"], { timeoutMs: 30_000 });

    fixture.exec.mockRejectedValueOnce(new Error("Sandbox sb-rakazo has already completed"));
    await expect(provider.keepAlive(computer)).resolves.toBeUndefined();
    // The cached handle swallowed the rejection, so nothing has reconnected yet.
    expect(fixture.sandboxFromName).toHaveBeenCalledTimes(1);

    await provider.keepAlive(computer);
    expect(fixture.sandboxFromName).toHaveBeenCalledTimes(2);
    expect(fixture.exec).toHaveBeenLastCalledWith(["true"], { timeoutMs: 30_000 });
  });

  it("prepares the workspace once for concurrent callers", async () => {
    const fixture = modalFixture();
    const provider = new ModalSandboxProvider({ tokenId: "test-token-id" }, fixture.client);
    const computer = await provider.provision({ botId: HOME_KEY, homePath: "/unused" }, context);

    await Promise.all([
      provider.prepare(computer, context),
      provider.prepare(computer, context),
      provider.prepare(computer, context),
    ]);
    expect(
      fixture.exec.mock.calls.filter(([argv]) =>
        String(argv[2]).includes(`mkdir -p '${WORKSPACE}/.browser-profiles'`),
      ),
    ).toHaveLength(1);
  });
});

describe("Modal sandbox-gone detection", () => {
  // Wordings taken from modal 0.9.0: a name lookup miss, and a task that already finished.
  it("treats a missing sandbox or App and a completed task as gone", () => {
    expect(
      isSandboxGoneError(
        new NotFoundError("Sandbox with name 'rakazo-abc' not found in App 'rakazo-computers'"),
      ),
    ).toBe(true);
    expect(isSandboxGoneError(new NotFoundError("App 'rakazo-computers' not found"))).toBe(true);
    expect(isSandboxGoneError(new Error("Sandbox sb-rakazo has already completed"))).toBe(true);
    expect(
      isSandboxGoneError(
        new NotFoundError("The Sandbox is unavailable. This Sandbox may have already shut down."),
      ),
    ).toBe(true);
  });

  it("never reads a live Modal sandbox as gone", () => {
    expect(isSandboxGoneError(new Error("bash: chromium: command not found"))).toBe(false);
    expect(isSandboxGoneError(new Error("cat: /root/rakazo-home/notes.md: No such file"))).toBe(
      false,
    );
    expect(isSandboxGoneError(new Error("fetch failed"))).toBe(false);
  });
});

type ExecParams = { mode?: "text" | "binary"; workdir?: string; timeoutMs?: number };

function modalFixture(
  options: {
    running?: boolean;
    volume?: boolean;
    hangs?: (argv: readonly string[]) => boolean;
  } = {},
) {
  const files = new Map<string, Uint8Array>();
  const executables = new Set<string>();
  const markers = new Set<string>();
  const respond = desktopCommandResponder();
  const state = { running: options.running ?? false, volume: options.volume ?? false };
  const hangs = options.hangs ?? ((argv: readonly string[]) => argv[0] === "sleep");

  const dockerfileCommands = vi.fn();
  const image = { imageId: "im-rakazo", dockerfileCommands };
  dockerfileCommands.mockReturnValue(image);
  const fromRegistry = vi.fn((_reference: string) => image);
  const app = { appId: "ap-rakazo" };
  const appFromName = vi.fn(async (name: string) => {
    void name;
    return app;
  });
  const volume = { volumeId: "vo-rakazo" };
  const volumeFromName = vi.fn(async (name: string, params?: { createIfMissing?: boolean }) => {
    if (state.volume) return volume;
    if (params?.createIfMissing) {
      state.volume = true;
      return volume;
    }
    throw new NotFoundError(`Volume with name '${name}' not found`);
  });
  const volumeDelete = vi.fn(async (name: string) => {
    void name;
    state.volume = false;
  });

  const exec = vi.fn(async (argv: string[], params?: ExecParams) => {
    const command = argv[0] === "bash" && argv[1] === "-lc" ? (argv[2] ?? "") : "";

    // Every portable write streams its bytes into `cat > <path>` on stdin.
    const streamed = command.match(/&& cat > (\S+)$/);
    if (streamed) {
      const target = unquote(streamed[1]!);
      return fakeProcess({
        onClose: (bytes) => {
          files.set(target, bytes);
        },
      });
    }
    if (argv[0] === "cat") {
      const target = argv[2] ?? "";
      const content = files.get(target);
      if (!content) {
        return fakeProcess({
          code: 1,
          stderr: `cat: ${target}: No such file or directory`,
        });
      }
      return fakeProcess({ stdout: content });
    }
    if (argv[0] === "timeout") {
      const marker = argv[6] ?? "";
      const inner = argv.slice(7);
      if (hangs(inner)) {
        markers.add(marker);
        return fakeProcess({ code: 124 });
      }
      return fakeProcess(shellResponse(inner));
    }
    const desktop = respond(command);
    if (desktop) {
      return fakeProcess({
        code: desktop.exitCode,
        stdout: desktop.stdout,
        stderr: desktop.stderr,
      });
    }
    if (command.startsWith("test -f ")) {
      const marker = unquote(command.slice("test -f ".length).split(" && ")[0]!);
      return fakeProcess({ code: markers.delete(marker) ? 0 : 1 });
    }
    if (command.startsWith("stat -c %s -- ")) {
      const target = unquote(command.slice("stat -c %s -- ".length));
      const content = files.get(target);
      if (!content) {
        return fakeProcess({
          code: 1,
          stderr: `stat: cannot statx '${target}': No such file or directory`,
        });
      }
      return fakeProcess({ stdout: `${content.byteLength}\n` });
    }
    if (command.startsWith("chmod 700 -- ")) {
      for (const match of command.slice("chmod 700 -- ".length).matchAll(/'([^']*)'/g)) {
        executables.add(match[1]!);
      }
      return fakeProcess({});
    }
    if (command.includes("-maxdepth 1")) {
      const directory = unquote(command.match(/directory=(\S+)/)![1]!);
      return fakeProcess({ stdout: listingLines(childEntries(files, executables, directory)) });
    }
    if (command.includes("-type f")) {
      const root = unquote(command.match(/find (\S+) -type f/)![1]!);
      return fakeProcess({ stdout: listingLines(fileEntries(files, executables, root)) });
    }
    void params;
    return fakeProcess({});
  });

  const sandbox = {
    sandboxId: "sb-rakazo",
    exec,
    tunnels: vi.fn(async (_timeoutMs?: number) => ({
      6100: { url: "https://sb-rakazo--6100.modal.host" },
    })),
    terminate: vi.fn(async () => {
      state.running = false;
    }),
  };
  const sandboxCreate = vi.fn(
    async (_app: unknown, _image: unknown, _params?: Record<string, unknown>) => {
      state.running = true;
      return sandbox;
    },
  );
  const sandboxFromName = vi.fn(async (appName: string, name: string) => {
    if (!state.running) {
      throw new NotFoundError(`Sandbox with name '${name}' not found in App '${appName}'`);
    }
    return sandbox;
  });

  return {
    client: {
      apps: { fromName: appFromName },
      images: { fromRegistry },
      sandboxes: { create: sandboxCreate, fromName: sandboxFromName },
      volumes: { delete: volumeDelete, fromName: volumeFromName },
    } as unknown as ModalSandboxSdk,
    app,
    image,
    volume,
    sandbox,
    state,
    files,
    executables,
    markers,
    dockerfileCommands,
    fromRegistry,
    appFromName,
    volumeFromName,
    volumeDelete,
    sandboxCreate,
    sandboxFromName,
    exec,
    tunnels: sandbox.tunnels,
  };
}

function fakeProcess(handler: {
  stdout?: Uint8Array | string;
  stderr?: Uint8Array | string;
  code?: number;
  onClose?: (bytes: Uint8Array) => void;
}) {
  const stream = (value: Uint8Array | string | undefined) =>
    typeof value === "string" ? new TextEncoder().encode(value) : (value ?? new Uint8Array());
  const stdout = stream(handler.stdout);
  const stderr = stream(handler.stderr);
  const written: Uint8Array[] = [];
  const read = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
  return {
    stdin: {
      writeBytes: async (chunk: Uint8Array) => {
        written.push(chunk);
      },
      close: async () => {
        handler.onClose?.(concat(written));
      },
    },
    stdout: { readBytes: async () => stdout, readText: async () => read(stdout) },
    stderr: { readBytes: async () => stderr, readText: async () => read(stderr) },
    wait: async () => handler.code ?? 0,
    closeStdin: async () => undefined,
  };
}

function shellResponse(argv: readonly string[]): { stdout?: string; code?: number } {
  const separator = argv.indexOf("--");
  const effective = argv[0] === "env" && separator >= 0 ? argv.slice(separator + 1) : argv;
  if (effective[0] === "echo") return { stdout: `${effective.slice(1).join(" ")}\n` };
  return {};
}

/** Immediate children of `root`, as `find -mindepth 1 -maxdepth 1` reports them. */
function childEntries(files: Map<string, Uint8Array>, executables: Set<string>, root: string) {
  const prefix = root.endsWith("/") ? root : `${root}/`;
  const entries = new Map<string, { kind: "file" | "dir"; size: number; executable?: boolean }>();
  for (const [target, content] of files) {
    if (!target.startsWith(prefix)) continue;
    const [name, ...rest] = target.slice(prefix.length).split("/");
    if (!name) continue;
    entries.set(
      name,
      rest.length
        ? { kind: "dir", size: 0 }
        : {
            kind: "file",
            size: content.byteLength,
            ...(executables.has(target) ? { executable: true } : {}),
          },
    );
  }
  return [...entries.entries()].map(([name, entry]) => ({ path: `${root}/${name}`, ...entry }));
}

/** Every file under `root`, at any depth, as the workspace export lists them. */
function fileEntries(files: Map<string, Uint8Array>, executables: Set<string>, root: string) {
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return [...files.entries()]
    .filter(([target]) => target.startsWith(prefix))
    .map(([target, content]) => ({
      path: target,
      kind: "file" as const,
      size: content.byteLength,
      ...(executables.has(target) ? { executable: true } : {}),
    }));
}

function listingLines(
  entries: Array<{ path: string; kind: "file" | "dir"; size: number; executable?: boolean }>,
) {
  return entries
    .map(
      (entry) =>
        `${Buffer.from(entry.path).toString("base64")}\t${entry.kind}\t${entry.size}\t${
          entry.executable ? "1" : "0"
        }\n`,
    )
    .join("");
}

function unquote(value: string) {
  return value.replace(/^'/, "").replace(/'$/, "").replaceAll(`'"'"'`, "'");
}

function concat(chunks: readonly Uint8Array[]) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

async function* portableFiles(
  files: Array<{ path: string; content: Uint8Array; executable?: boolean }>,
) {
  yield* files;
}
