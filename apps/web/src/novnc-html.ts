import type { IncomingHttpHeaders } from "node:http";
import type { Readable } from "node:stream";

export const MAX_NOVNC_HTML_BYTES = 1024 * 1024;

/**
 * The noVNC document is the only HTML the screen proxy serves for every provider, and it is
 * always sandboxed without `allow-same-origin`, so the rewrite below applies to all of them.
 */
export function isProxiedHtmlDocument(headers: IncomingHttpHeaders) {
  if (headers["content-encoding"]) return false;
  const contentType = String(headers["content-type"] ?? "").toLowerCase();
  return contentType.includes("text/html") || contentType.includes("application/xhtml+xml");
}

/**
 * noVNC reads and writes its own UI settings through `localStorage`. In a document sandboxed
 * without `allow-same-origin` (see `safeScreenProxyResponseHeaders`) that getter throws, and
 * noVNC's error handler stops the session instead of connecting. Give the page an ephemeral
 * store: its settings fall back to their defaults, and neither app data nor a persisted
 * preference is reachable from the screen.
 */
export function injectNovncStorageShim(html: string) {
  const shim = `<script>
Object.defineProperty(window, "localStorage", {
  configurable: true,
  value: {
    getItem() { return null; },
    setItem() {},
    removeItem() {},
    clear() {},
  },
});
</script>`;
  return html.includes("<head>")
    ? html.replace("<head>", `<head>${shim}`)
    : html.replace(/<script\b/i, `${shim}<script`);
}

/** Read a noVNC document with a hard cap, and fail if the upstream ends without `end`. */
export function collectNovncHtml(incoming: Readable, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      incoming.destroy();
      reject(error);
    };
    incoming.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > maxBytes) {
        fail(new Error(`noVNC document exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(buf);
    });
    incoming.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    incoming.on("error", (error: unknown) => {
      fail(error instanceof Error ? error : new Error("noVNC upstream failed"));
    });
    incoming.on("aborted", () => {
      fail(new Error("noVNC upstream aborted"));
    });
    incoming.on("close", () => {
      if (!settled) fail(new Error("noVNC upstream closed"));
    });
  });
}
