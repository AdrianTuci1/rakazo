import { errorText } from "./user-error";

export interface ComputerScreenResult {
  url: string | null;
  error: string | null;
}

/** Only the latest request for the visible computer may replace its screen or error. */
export async function loadComputerScreen(options: {
  load: () => Promise<{ url: string | null }>;
  isCurrent: () => boolean;
  commit: (result: ComputerScreenResult) => void;
  fallbackError: string;
}): Promise<string | null> {
  let result: ComputerScreenResult;
  try {
    const screen = await options.load();
    result = { url: screen.url, error: null };
  } catch (error) {
    result = {
      url: null,
      error: errorText(error, options.fallbackError),
    };
  }
  if (!options.isCurrent()) return null;
  options.commit(result);
  return result.url;
}

export function embeddableScreenUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url, window.location.href);
    const page = new URL(window.location.href);
    const local = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
    const pagePort = page.port || (page.protocol === "https:" ? "443" : "80");
    if (local && parsed.port && parsed.port !== pagePort) {
      return null;
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

export function screenIframeSandbox(url: string | null) {
  if (!url) return undefined;
  try {
    return new URL(url, window.location.href).pathname.startsWith("/novnc/")
      ? "allow-scripts allow-pointer-lock"
      : undefined;
  } catch {
    return undefined;
  }
}

/** The API reuses a sealed capability while this much life remains. */
export const SCREEN_CAPABILITY_REUSE_MS = 10 * 60_000;

/**
 * How long until a viewer should reissue its screen capability, or null when the URL is not a
 * proxied capability. Asking inside the API's reuse window returns a new seal rather than the
 * one about to lapse: the proxy revokes an open stream the moment its seal expires.
 */
export function screenCapabilityRenewIn(url: string | null, now = Date.now()): number | null {
  const expiresAt = Number(
    url?.match(/\/novnc\/session\/(?:view|control)\/(\d+)\.[A-Za-z0-9_-]+/)?.[1],
  );
  if (!Number.isFinite(expiresAt)) return null;
  return Math.max(expiresAt - SCREEN_CAPABILITY_REUSE_MS - now, 0);
}
