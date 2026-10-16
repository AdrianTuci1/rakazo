import { createHash, randomUUID } from "node:crypto";
import type {
  AdapterContext,
  CommandRequest,
  ComputerActionRequest,
  ComputerFileEntry,
  ComputerInput,
  ComputerObservation,
  ComputerRef,
  ControlLeaseRef,
  PortableFile,
  ProcessEvent,
  SandboxProvider,
  ScreenRequest,
  ScreenSession,
  TerminalRequest,
} from "@rakazo/adapter-kit";
import { boundedSandboxCommandTimeoutMs } from "@rakazo/core";
import {
  AlreadyExistsError,
  type App,
  ModalClient,
  type Image as ModalImage,
  type Sandbox as ModalSandbox,
  NotFoundError,
  type SandboxCreateParams,
  type Volume,
} from "modal";
import { computerIdleSleepEnabled, sandboxIdleMs } from "./computer-idle.js";
import { normalizeWorkspacePath, shellQuote, workspacePath } from "./computer-support.js";
import {
  PORTABLE_TRANSFER_BATCH_BYTES,
  shouldSkipPortableWorkspaceFile,
} from "./computer-workspace.js";
import { isSandboxGoneError } from "./e2b-sandbox.js";
import { LinuxDesktop, PREPARE_LINUX_DESKTOP } from "./linux-desktop.js";
import { sandboxCommandArgv } from "./sandbox-command-environment.js";

/** Names the Modal App that owns every Rakazo computer in one environment. */
const MODAL_APP_NAME = "rakazo-computers";
/** Bare Debian plus the desktop tools, so the shared runtime has no install work to do. */
const MODAL_BASE_IMAGE = "debian:bookworm-slim";
const MODAL_HOME_DIR = "/root";
const MODAL_WORKSPACE = "/root/rakazo-home";
const MODAL_BROWSER_PROFILES = `${MODAL_WORKSPACE}/.browser-profiles`;
const MODAL_PORT_START = 6100;
/** A desktop with Chromium needs more than Modal's 0.125 CPU / 128 MiB default. */
const MODAL_CPU = 2;
const MODAL_MEMORY_MIB = 4096;
/** Modal caps a sandbox at 24 hours and cannot extend the deadline through the API. */
const MODAL_MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;
/** The sandbox may idle for the deployment's window plus this, refreshed by keepAlive. */
const MODAL_IDLE_MARGIN_MS = 5 * 60_000;
const MODAL_KEEPALIVE_TIMEOUT_MS = 30_000;
const MODAL_SETUP_TIMEOUT_MS = 180_000;
const MODAL_FILE_TIMEOUT_MS = 60_000;
/** Modal's exec deadline only stops us waiting; it never kills the process. */
const MODAL_COMMAND_SETTLE_MS = 10_000;
const MODAL_TUNNEL_TIMEOUT_MS = 60_000;
/** Matches the chunk the SDK itself uses to stream a local file into a sandbox. */
const MODAL_STDIN_CHUNK_BYTES = 256 * 1024;
const MODAL_EXPORT_CONCURRENCY = 8;

const MODAL_IMAGE_COMMANDS = [
  [
    "RUN apt-get update && apt-get install -y --no-install-recommends",
    "xvfb x11vnc fluxbox xterm xdotool wmctrl x11-utils x11-xserver-utils",
    "imagemagick scrot novnc websockify python3 ca-certificates procps bash",
    "chromium fonts-liberation fonts-dejavu-core dbus-x11 xdg-utils curl git jq",
    "openssh-client unzip xclip xsel",
    "&& rm -rf /var/lib/apt/lists/*",
    // Fluxbox paints the root window through fbsetbg and pops a modal xmessage error over
    // the desktop when it is missing. The computer image ships the same two shims.
    `&& printf '%s\\n' '#!/bin/sh' 'exec xsetroot -solid "#111113" "$@"' > /usr/bin/fbsetbg`,
    "&& chmod +x /usr/bin/fbsetbg",
    "&& ln -sfn /bin/true /usr/bin/xmessage",
  ].join(" "),
];

/** Runs the command under `timeout` inside the sandbox, marking a command that exits 124 itself. */
const MODAL_TIMEOUT_SCRIPT =
  '"$@"; status=$?; if [ "$status" -eq 124 ]; then : > "$0"; fi; exit "$status"';

export type ModalSandboxSdk = {
  readonly apps: Pick<ModalClient["apps"], "fromName">;
  readonly images: Pick<ModalClient["images"], "fromRegistry">;
  readonly sandboxes: Pick<ModalClient["sandboxes"], "create" | "fromName">;
  readonly volumes: Pick<ModalClient["volumes"], "fromName" | "delete">;
};

export interface ModalSandboxConfig {
  tokenId: string;
  tokenSecret?: string;
  environment?: string;
}

/**
 * A Modal-safe name for one computer, shared by its sandbox and its Volume. The home key looks
 * like `team:<spaceId>`, and a colon is not a legal Modal object name, so it is hashed.
 */
export function modalComputerName(homeKey: string): string {
  return `rakazo-${createHash("sha256").update(homeKey).digest("hex").slice(0, 32)}`;
}

export class ModalSandboxProvider implements SandboxProvider {
  private readonly client: ModalSandboxSdk;
  private readonly environment: string | undefined;
  private readonly sandboxes = new Map<string, ModalSandbox>();
  private readonly connections = new Map<string, Promise<ModalSandbox>>();
  private readonly pendingProvisions = new Map<string, Promise<ComputerRef>>();
  private readonly prepared = new Set<string>();
  private readonly preparations = new Map<string, Promise<void>>();
  private builtImage: ModalImage | undefined;
  private readonly desktops = new LinuxDesktop({
    environment: async () => ({
      homeDir: MODAL_HOME_DIR,
      workspaceDir: MODAL_WORKSPACE,
      browserProfilesDir: MODAL_BROWSER_PROFILES,
      displayStart: 20,
      portStart: MODAL_PORT_START,
    }),
    run: async (computer, command, context) => {
      const sandbox = await this.sandbox(computer);
      return this.runShell(sandbox, command, MODAL_SETUP_TIMEOUT_MS);
    },
    screenUrl: async (computer, port) => {
      const sandbox = await this.sandbox(computer);
      const tunnels = await sandbox.tunnels(MODAL_TUNNEL_TIMEOUT_MS);
      const tunnel = tunnels[port];
      if (!tunnel) throw new Error(`Modal did not publish desktop port ${port}`);
      // Rakazo's per-screen token, not the tunnel URL, is the access control.
      const url = new URL(tunnel.url);
      url.pathname = "/vnc.html";
      return url.toString();
    },
  });

  constructor(config: ModalSandboxConfig, client: ModalSandboxSdk = createModalSdk(config)) {
    this.client = client;
    this.environment = config.environment?.trim() || undefined;
  }

  describe() {
    return {
      id: "modal",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        graphical: true,
        pty: true,
        snapshots: true,
        takeover: true,
        persistentHome: true,
        multiScreen: true,
      },
    };
  }

  async provision(
    request: {
      botId: string;
      homePath: string;
      providerRef?: string;
      providerKind?: ComputerRef["kind"];
    },
    context: AdapterContext,
  ): Promise<ComputerRef> {
    const reconnecting = Boolean(request.providerRef) && request.providerKind === "modal";
    const name = reconnecting ? request.providerRef! : modalComputerName(request.botId);
    const pending = this.pendingProvisions.get(name);
    if (pending) return pending;
    let provision!: Promise<ComputerRef>;
    provision = this.provisionOnce(request, name, reconnecting, context).finally(() => {
      if (this.pendingProvisions.get(name) === provision) this.pendingProvisions.delete(name);
    });
    this.pendingProvisions.set(name, provision);
    return provision;
  }

  private async provisionOnce(
    request: { botId: string; providerRef?: string; providerKind?: ComputerRef["kind"] },
    name: string,
    reconnecting: boolean,
    context: AdapterContext,
  ): Promise<ComputerRef> {
    // The whole point of the stable name: a sandbox still running is the same computer, and the
    // Volume it mounts already holds the workspace.
    const running = await this.client.sandboxes
      .fromName(MODAL_APP_NAME, name, { environment: this.environment })
      .then(
        (sandbox) => sandbox,
        (error: unknown) => {
          if (isNotFound(error)) return undefined;
          throw error;
        },
      );
    if (running) {
      this.sandboxes.set(name, running);
      return this.ref(name, request.botId, { fresh: false });
    }

    const volume = await this.volume(name, reconnecting);
    const app = await this.client.apps.fromName(MODAL_APP_NAME, {
      createIfMissing: true,
      environment: this.environment,
    });
    const sandbox = await this.createSandbox(app, name, volume.volume);
    this.sandboxes.set(name, sandbox);
    if (context.signal.aborted) context.signal.throwIfAborted();
    // A computer that lost its Volume has nothing left on the server, so it boots fresh and the
    // lifecycle restores the last host checkpoint.
    return this.ref(name, request.botId, { fresh: volume.fresh || !reconnecting, started: true });
  }

  private async volume(
    name: string,
    reconnecting: boolean,
  ): Promise<{ volume: Volume; fresh: boolean }> {
    if (reconnecting) {
      const existing = await this.client.volumes
        .fromName(name, { environment: this.environment })
        .then(
          (volume) => volume,
          (error: unknown) => {
            if (isNotFound(error)) return undefined;
            throw error;
          },
        );
      if (existing) return { volume: existing, fresh: false };
    }
    const created = await this.client.volumes.fromName(name, {
      createIfMissing: true,
      environment: this.environment,
    });
    return { volume: created, fresh: true };
  }

  private async createSandbox(app: App, name: string, volume: Volume): Promise<ModalSandbox> {
    try {
      return await this.client.sandboxes.create(app, this.image(), modalCreateParams(name, volume));
    } catch (error) {
      // A sandbox of this name is already running: an earlier stop lost its race, or another
      // boot started it. Reconnecting by name adopts that computer instead of replacing it.
      if (!isAlreadyExists(error)) throw error;
      return this.client.sandboxes.fromName(MODAL_APP_NAME, name, {
        environment: this.environment,
      });
    }
  }

  private image(): ModalImage {
    // Built once for this provider; Modal caches the resulting layers.
    this.builtImage ??= this.client.images
      .fromRegistry(MODAL_BASE_IMAGE)
      .dockerfileCommands(MODAL_IMAGE_COMMANDS);
    return this.builtImage;
  }

  async prepare(computer: ComputerRef, context: AdapterContext): Promise<void> {
    const name = this.name(computer);
    if (this.prepared.has(name)) return;
    const pending = this.preparations.get(name);
    if (pending) return pending;
    let preparation!: Promise<void>;
    preparation = (async () => {
      const sandbox = await this.sandbox(computer);
      const workspace = await this.runShell(
        sandbox,
        `mkdir -p ${shellQuote(MODAL_BROWSER_PROFILES)}`,
        MODAL_FILE_TIMEOUT_MS,
      );
      if (workspace.code !== 0) {
        throw new Error(
          workspace.stderr || workspace.stdout || "could not prepare Modal workspace",
        );
      }
      // The image already carries the desktop tools; this stays the idempotent safety net.
      const runtime = await this.runShell(sandbox, PREPARE_LINUX_DESKTOP, MODAL_SETUP_TIMEOUT_MS);
      if (runtime.code !== 0) throw new Error("could not prepare computer desktop tools");
      if (this.preparations.get(name) !== preparation) {
        throw new Error("Modal workspace preparation was invalidated during teardown");
      }
      this.prepared.add(name);
    })().finally(() => {
      if (this.preparations.get(name) === preparation) this.preparations.delete(name);
    });
    this.preparations.set(name, preparation);
    return preparation;
  }

  async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    if (context.signal.aborted) {
      yield { type: "stderr", data: "command aborted\n" };
      yield { type: "exit", code: 130 };
      return;
    }
    const timeoutMs = boundedSandboxCommandTimeoutMs(request.timeoutMs);
    const sandbox = await this.sandbox(computer);
    const argv = sandboxCommandArgv({
      ...request,
      argv: request.argv.length ? request.argv : ["true"],
    });
    try {
      const result = await this.runCommand(sandbox, argv, request, timeoutMs);
      if (context.signal.aborted) {
        yield { type: "stderr", data: "command aborted\n" };
        yield { type: "exit", code: 130 };
        return;
      }
      if (result.stdout) yield { type: "stdout", data: result.stdout };
      if (result.timedOut) {
        yield { type: "stderr", data: `command timed out after ${timeoutMs} ms\n` };
        yield { type: "exit", code: 124 };
        return;
      }
      if (result.stderr) yield { type: "stderr", data: result.stderr };
      yield { type: "exit", code: result.code };
    } catch (error) {
      if (context.signal.aborted || isAbortError(error)) {
        yield { type: "stderr", data: "command aborted\n" };
        yield { type: "exit", code: 130 };
        return;
      }
      throw error;
    }
  }

  private async runCommand(
    sandbox: ModalSandbox,
    argv: readonly string[],
    request: CommandRequest,
    timeoutMs: number,
  ): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
    const marker = `/tmp/rakazo-command-${randomUUID()}.completed-124`;
    const wrapped = [
      "timeout",
      "--kill-after=1s",
      `${Math.max(timeoutMs / 1_000, 0.001)}s`,
      "bash",
      "-lc",
      MODAL_TIMEOUT_SCRIPT,
      marker,
      ...argv,
    ];
    const env = request.env && Object.keys(request.env).length ? request.env : undefined;
    try {
      const process = await sandbox.exec(wrapped, {
        ...(env ? { env } : {}),
        workdir: modalCwd(request.cwd),
        // A backstop only: the in-sandbox timeout above kills the process and reports 124.
        timeoutMs: timeoutMs + MODAL_COMMAND_SETTLE_MS,
      });
      const stdout = process.stdout.readText();
      const stderr = process.stderr.readText();
      const code = await process.wait();
      const [out, err] = await Promise.all([stdout, stderr]);
      if (code !== 124 || !(await this.markerExists(sandbox, marker))) {
        return { code, stdout: out, stderr: err, timedOut: false };
      }
      return { code, stdout: out, stderr: err, timedOut: true };
    } catch (error) {
      if (!isExecDeadline(error)) throw error;
      return { code: 124, stdout: "", stderr: errorMessage(error), timedOut: true };
    }
  }

  /** Reads the wrapper's marker, which means the command itself exited 124 within its timeout. */
  private async markerExists(sandbox: ModalSandbox, marker: string): Promise<boolean> {
    const result = await this.runShell(
      sandbox,
      `test -f ${shellQuote(marker)} && rm -f -- ${shellQuote(marker)}`,
      10_000,
    );
    return result.code === 0;
  }

  async connectScreen(
    computer: ComputerRef,
    request: ScreenRequest,
    context: AdapterContext,
  ): Promise<ScreenSession> {
    return this.desktops.connectScreen(computer, request, context);
  }
  async connectTerminal(computer: ComputerRef, request: TerminalRequest, context: AdapterContext) {
    return this.desktops.connectTerminal(computer, request, context);
  }
  async setScreenControl(
    computer: ComputerRef,
    interactive: boolean,
    context: AdapterContext,
    controlToken?: string,
  ): Promise<void> {
    return this.desktops.setScreenControl(computer, interactive, context, controlToken);
  }
  async sendInput(
    computer: ComputerRef,
    input: ComputerInput,
    _lease: ControlLeaseRef,
    context: AdapterContext,
  ): Promise<void> {
    return this.desktops.sendInput(computer, input, context);
  }
  async observe(computer: ComputerRef, context: AdapterContext): Promise<ComputerObservation> {
    return this.desktops.observe(computer, context);
  }
  async act(computer: ComputerRef, request: ComputerActionRequest, context: AdapterContext) {
    return this.desktops.act(computer, request, context);
  }

  async listFiles(
    computer: ComputerRef,
    directory: string,
    _context: AdapterContext,
  ): Promise<ComputerFileEntry[]> {
    const sandbox = await this.sandbox(computer);
    const relative = normalizeWorkspacePath(directory);
    const result = await this.runShell(
      sandbox,
      listFilesCommand(MODAL_WORKSPACE, relative),
      MODAL_FILE_TIMEOUT_MS,
    );
    if (result.code !== 0) {
      throw new Error(result.stderr || result.stdout || "could not list the computer workspace");
    }
    return parseFileEntries(result.stdout, MODAL_WORKSPACE);
  }

  async readFile(
    computer: ComputerRef,
    filePath: string,
    _context: AdapterContext,
    options?: { maxBytes?: number },
  ): Promise<Uint8Array> {
    const sandbox = await this.sandbox(computer);
    const target = workspacePath(MODAL_WORKSPACE, filePath);
    if (options?.maxBytes !== undefined) {
      const size = await this.runShell(
        sandbox,
        `stat -c %s -- ${shellQuote(target)}`,
        MODAL_FILE_TIMEOUT_MS,
      );
      if (size.code !== 0) {
        throw new Error(size.stderr || size.stdout || "computer file not found");
      }
      if (Number(size.stdout.trim()) > options.maxBytes) {
        throw new Error(`computer file exceeds ${options.maxBytes} bytes`);
      }
    }
    const read = await sandbox.exec(["cat", "--", target], {
      mode: "binary",
      timeoutMs: MODAL_FILE_TIMEOUT_MS,
    });
    const stderr = read.stderr
      .readBytes()
      .then(decodeText)
      .catch(() => "");
    const content = read.stdout.readBytes();
    const code = await read.wait();
    const [bytes, error] = await Promise.all([content, stderr]);
    if (code !== 0) throw new Error(error || "could not read computer file");
    return bytes;
  }

  async writeFile(computer: ComputerRef, file: PortableFile, context: AdapterContext) {
    await this.writeFiles(await this.sandbox(computer), [file], context);
  }

  async *exportWorkspace(
    computer: ComputerRef,
    context: AdapterContext,
  ): AsyncIterable<PortableFile> {
    const sandbox = await this.sandbox(computer);
    await this.desktops.stopBrowsers(computer, context);
    const entries = await this.exportableFiles(sandbox);
    for (let index = 0; index < entries.length; index += MODAL_EXPORT_CONCURRENCY) {
      const files = await Promise.all(
        entries.slice(index, index + MODAL_EXPORT_CONCURRENCY).map(async (entry) => ({
          path: entry.path,
          content: await this.readFile(computer, entry.path, context),
          executable: entry.executable,
        })),
      );
      yield* files;
    }
  }

  async importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ): Promise<void> {
    const sandbox = await this.sandbox(computer);
    await this.desktops.stopBrowsers(computer, context);
    let batch: PortableFile[] = [];
    let batchBytes = 0;
    const flush = async () => {
      if (!batch.length) return;
      await this.writeFiles(sandbox, batch, context);
      batch = [];
      batchBytes = 0;
    };
    for await (const file of files) {
      if (context.signal.aborted) throw context.signal.reason ?? new Error("import aborted");
      if (
        batch.length >= 8 ||
        batchBytes + file.content.byteLength > PORTABLE_TRANSFER_BATCH_BYTES
      ) {
        await flush();
      }
      batch.push(file);
      batchBytes += file.content.byteLength;
    }
    await flush();
    // Browser profiles are imported without opening a shared browser.
  }

  async snapshot(computer: ComputerRef, context: AdapterContext) {
    const observation = await this.observe(computer, context);
    return { id: observation.frameId, createdAt: observation.capturedAt };
  }

  async keepAlive(computer: ComputerRef): Promise<void> {
    const name = this.name(computer);
    try {
      const sandbox = await this.sandbox(computer);
      // Modal's idle timer counts sandbox activity and its deadline cannot be extended through
      // the API, so a cheap exec is the only way to tell it the computer is still wanted.
      await sandbox.exec(["true"], { timeoutMs: MODAL_KEEPALIVE_TIMEOUT_MS });
    } catch (error) {
      if (isSandboxGoneError(error)) {
        this.forget(name);
        return;
      }
      throw error;
    }
  }

  async releaseScreen(computer: ComputerRef, context: AdapterContext): Promise<void> {
    return this.desktops.releaseScreen(computer, context);
  }

  /** Sleeps the computer, keeping its Volume: the workspace is the reason it can come back. */
  async stop(computer: ComputerRef, _context: AdapterContext): Promise<void> {
    const name = this.name(computer);
    try {
      const sandbox = await this.sandbox(computer);
      await sandbox.terminate();
    } catch (error) {
      if (!isSandboxGoneError(error)) throw error;
    } finally {
      this.forget(name);
    }
  }

  /** Deletes the computer and its Volume, so a replacement really starts empty. */
  async destroy(computer: ComputerRef, _context: AdapterContext): Promise<void> {
    const name = this.name(computer);
    try {
      const sandbox = await this.sandbox(computer).catch((error: unknown) => {
        if (isSandboxGoneError(error)) return undefined;
        throw error;
      });
      if (sandbox) {
        await sandbox.terminate().catch((error: unknown) => {
          if (!isSandboxGoneError(error)) throw error;
        });
      }
    } finally {
      this.forget(name);
    }
    await this.client.volumes.delete(name, {
      environment: this.environment,
      allowMissing: true,
    });
  }

  private async sandbox(computer: ComputerRef): Promise<ModalSandbox> {
    const name = this.name(computer);
    const cached = this.sandboxes.get(name);
    if (cached) return cached;
    const pending = this.connections.get(name);
    if (pending) return pending;
    let connection!: Promise<ModalSandbox>;
    connection = this.client.sandboxes
      .fromName(MODAL_APP_NAME, name, { environment: this.environment })
      .then((sandbox) => {
        if (this.connections.get(name) !== connection) {
          throw new Error("computer connection stopped during teardown");
        }
        this.sandboxes.set(name, sandbox);
        return sandbox;
      })
      .finally(() => {
        if (this.connections.get(name) === connection) this.connections.delete(name);
      });
    this.connections.set(name, connection);
    return connection;
  }

  private async runShell(
    sandbox: ModalSandbox,
    command: string,
    timeoutMs: number,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    try {
      const process = await sandbox.exec(["bash", "-lc", command], { timeoutMs });
      const stdout = process.stdout.readText();
      const stderr = process.stderr.readText();
      const code = await process.wait();
      const [out, err] = await Promise.all([stdout, stderr]);
      return { code, stdout: out, stderr: err };
    } catch (error) {
      if (!isExecDeadline(error)) throw error;
      return { code: 124, stdout: "", stderr: errorMessage(error) };
    }
  }

  private async writeFiles(
    sandbox: ModalSandbox,
    files: readonly PortableFile[],
    _context: AdapterContext,
  ): Promise<void> {
    const executable: string[] = [];
    for (const file of files) {
      const target = workspacePath(MODAL_WORKSPACE, file.path);
      const process = await sandbox.exec(
        [
          "bash",
          "-lc",
          `mkdir -p "$(dirname ${shellQuote(target)})" && cat > ${shellQuote(target)}`,
        ],
        { mode: "binary", timeoutMs: MODAL_FILE_TIMEOUT_MS },
      );
      const stderr = process.stderr
        .readBytes()
        .then(decodeText)
        .catch(() => "");
      const stdout = process.stdout
        .readBytes()
        .then(decodeText)
        .catch(() => "");
      try {
        for (let offset = 0; offset < file.content.byteLength; offset += MODAL_STDIN_CHUNK_BYTES) {
          await process.stdin.writeBytes(
            file.content.subarray(offset, offset + MODAL_STDIN_CHUNK_BYTES),
          );
        }
        await process.stdin.close();
      } catch (error) {
        await process.closeStdin().catch(() => undefined);
        throw error;
      }
      const code = await process.wait();
      const [out, err] = await Promise.all([stdout, stderr]);
      if (code !== 0) throw new Error(err || out || "could not write computer file");
      if (file.executable) executable.push(target);
    }
    if (executable.length) {
      const chmod = await this.runShell(
        sandbox,
        `chmod 700 -- ${executable.map(shellQuote).join(" ")}`,
        MODAL_FILE_TIMEOUT_MS,
      );
      if (chmod.code !== 0) {
        throw new Error(chmod.stderr || chmod.stdout || "could not set computer file permissions");
      }
    }
  }

  private async exportableFiles(sandbox: ModalSandbox): Promise<ComputerFileEntry[]> {
    const result = await this.runShell(
      sandbox,
      listWorkspaceCommand(MODAL_WORKSPACE),
      MODAL_FILE_TIMEOUT_MS,
    );
    if (result.code !== 0) {
      throw new Error(
        result.stderr || result.stdout || "could not enumerate the computer workspace",
      );
    }
    return parseFileEntries(result.stdout, MODAL_WORKSPACE).filter(
      (entry) => entry.kind === "file" && !shouldSkipPortableWorkspaceFile(entry.path),
    );
  }

  private ref(
    name: string,
    botId: string,
    extra: { fresh: boolean; started?: boolean },
  ): ComputerRef {
    return {
      id: name,
      botId,
      kind: "modal",
      providerRef: name,
      fresh: extra.fresh,
      ...(extra.started ? { started: true } : {}),
    };
  }

  private name(computer: ComputerRef): string {
    return computer.providerRef || computer.id;
  }

  private forget(name: string): void {
    this.sandboxes.delete(name);
    this.connections.delete(name);
    this.pendingProvisions.delete(name);
    this.prepared.delete(name);
    this.preparations.delete(name);
  }
}

function createModalSdk(config: ModalSandboxConfig): ModalSandboxSdk {
  const client = new ModalClient({
    tokenId: config.tokenId,
    ...(config.tokenSecret ? { tokenSecret: config.tokenSecret } : {}),
    ...(config.environment?.trim() ? { environment: config.environment.trim() } : {}),
  });
  return {
    apps: client.apps,
    images: client.images,
    sandboxes: client.sandboxes,
    volumes: client.volumes,
  };
}

function modalCreateParams(name: string, volume: Volume): SandboxCreateParams {
  return {
    name,
    cpu: MODAL_CPU,
    memoryMiB: MODAL_MEMORY_MIB,
    timeoutMs: MODAL_MAX_TIMEOUT_MS,
    ...(computerIdleSleepEnabled()
      ? { idleTimeoutMs: sandboxIdleMs() + MODAL_IDLE_MARGIN_MS }
      : {}),
    workdir: MODAL_WORKSPACE,
    // Sandboxes run as root, so the shared runtime's Chromium --no-sandbox flag stays correct.
    pty: true,
    env: { LANG: "C.UTF-8" },
    volumes: { [MODAL_WORKSPACE]: volume },
    encryptedPorts: [MODAL_PORT_START],
  };
}

function modalCwd(cwd: string | undefined): string {
  if (
    !cwd ||
    cwd === "." ||
    cwd === "/" ||
    cwd === "/home/rakazo" ||
    cwd === MODAL_HOME_DIR ||
    cwd === MODAL_WORKSPACE
  ) {
    return MODAL_WORKSPACE;
  }
  const relative = cwd.startsWith(`${MODAL_WORKSPACE}/`)
    ? cwd.slice(MODAL_WORKSPACE.length + 1)
    : cwd;
  return workspacePath(MODAL_WORKSPACE, relative);
}

function listFilesCommand(root: string, relative: string): string {
  const directory = workspacePath(root, relative);
  return [
    "set -o pipefail",
    `directory=${shellQuote(directory)}`,
    'test -d "$directory"',
    'find "$directory" -mindepth 1 -maxdepth 1 -print0 | sort -z | while IFS= read -r -d "" entry; do',
    '  if [ -d "$entry" ]; then kind=dir; elif [ -f "$entry" ]; then kind=file; else continue; fi',
    '  encoded=$(printf %s "$entry" | base64 -w0)',
    '  size=$(stat -c %s "$entry")',
    '  if [ "$kind" = file ] && [ -x "$entry" ]; then executable=1; else executable=0; fi',
    '  printf \'%s\\t%s\\t%s\\t%s\\n\' "$encoded" "$kind" "$size" "$executable"',
    "done",
  ].join("\n");
}

function listWorkspaceCommand(root: string): string {
  return [
    "set -o pipefail",
    `find ${shellQuote(root)} -type f -print0 | sort -z | while IFS= read -r -d "" entry; do`,
    '  encoded=$(printf %s "$entry" | base64 -w0)',
    '  size=$(stat -c %s "$entry")',
    '  if [ -x "$entry" ]; then executable=1; else executable=0; fi',
    '  printf \'%s\\tfile\\t%s\\t%s\\n\' "$encoded" "$size" "$executable"',
    "done",
  ].join("\n");
}

function parseFileEntries(output: string, root: string): ComputerFileEntry[] {
  return output
    .split("\n")
    .filter(Boolean)
    .flatMap((line): ComputerFileEntry[] => {
      const [encoded, kind, size, executable] = line.split("\t");
      if (!encoded || (kind !== "file" && kind !== "dir")) return [];
      const absolute = Buffer.from(encoded, "base64").toString("utf8");
      if (!absolute.startsWith(`${root}/`)) return [];
      const child = normalizeWorkspacePath(absolute.slice(root.length + 1));
      return [
        {
          path: child,
          kind,
          size: Number(size) || 0,
          ...(kind === "file" && executable === "1" ? { executable: true } : {}),
        },
      ];
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** Modal reports a missing App, Sandbox, or Volume as its own NotFoundError. */
function isNotFound(error: unknown): boolean {
  if (error instanceof NotFoundError) return true;
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if (current.name === "NotFoundError") return true;
  }
  return false;
}

function isAlreadyExists(error: unknown): boolean {
  if (error instanceof AlreadyExistsError) return true;
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if (current.name === "AlreadyExistsError") return true;
  }
  return false;
}

/** The SDK gives up waiting on an exec after its timeout; the process itself keeps running. */
function isExecDeadline(error: unknown): boolean {
  return error instanceof Error && /deadline exceeded/i.test(error.message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /aborted/i.test(error.message));
}
