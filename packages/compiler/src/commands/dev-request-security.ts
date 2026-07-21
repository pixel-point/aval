import type { IncomingMessage } from "node:http";

export type DevBrowserEndpoint = "document" | "script" | "style" | "worker-entry" | "worker-module" | "browser-fetch";

export interface DevRequestAuthority {
  readonly hostHeader: string;
  readonly origin: string;
}

export type DevRequestAuthorization =
  | Readonly<{ allowed: true }>
  | Readonly<{ allowed: false; status: 403 | 421; code: "cross-origin-request" | "fetch-metadata-rejected" | "host-authority-rejected" }>;

type DenialCode = Extract<DevRequestAuthorization, { readonly allowed: false }>["code"];

export function authorizeHost(request: IncomingMessage, authority: DevRequestAuthority): DevRequestAuthorization {
  const hosts = rawHeaderValues(request, "host");
  return hosts.length === 1 && hosts[0] === authority.hostHeader
    ? Object.freeze({ allowed: true })
    : denied(421, "host-authority-rejected");
}

export function authorizeBrowserRequest(
  request: IncomingMessage,
  authority: DevRequestAuthority,
  endpoint: DevBrowserEndpoint
): DevRequestAuthorization {
  const origins = rawHeaderValues(request, "origin");
  if (origins.length > 1 || (origins.length === 1 && origins[0] !== authority.origin)) return denied(403, "cross-origin-request");
  const site = singletonMetadata(request, "sec-fetch-site");
  const mode = singletonMetadata(request, "sec-fetch-mode");
  const destination = singletonMetadata(request, "sec-fetch-dest");
  if (site === false || mode === false || destination === false) return denied(403, "fetch-metadata-rejected");
  if (origins.length === 0 && site === null && destination === null && (mode === null || mode === "cors")) return Object.freeze({ allowed: true });
  const metadataPresent = site !== null || mode !== null || destination !== null;
  if (!metadataPresent) return Object.freeze({ allowed: true });
  if (site === null || mode === null || destination === null) return denied(403, "fetch-metadata-rejected");
  if (endpoint === "document") {
    return (site === "none" || site === "same-origin") && mode === "navigate" && destination === "document"
      ? Object.freeze({ allowed: true })
      : denied(403, "fetch-metadata-rejected");
  }
  if (site !== "same-origin") return denied(403, "fetch-metadata-rejected");
  if (endpoint === "script") {
    return mode === "cors" && destination === "script"
      ? Object.freeze({ allowed: true })
      : denied(403, "fetch-metadata-rejected");
  }
  if (endpoint === "style") {
    return mode === "no-cors" && destination === "style"
      ? Object.freeze({ allowed: true })
      : denied(403, "fetch-metadata-rejected");
  }
  if (endpoint === "worker-entry") {
    return mode === "same-origin" && destination === "worker"
      ? Object.freeze({ allowed: true })
      : denied(403, "fetch-metadata-rejected");
  }
  if (endpoint === "worker-module") {
    return origins.length === 1 && mode === "cors" && destination === "worker"
      ? Object.freeze({ allowed: true })
      : denied(403, "fetch-metadata-rejected");
  }
  return mode === "cors" && destination === "empty"
    ? Object.freeze({ allowed: true })
    : denied(403, "fetch-metadata-rejected");
}

export function rawHeaderValues(request: IncomingMessage, name: string): readonly string[] {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) values.push(request.rawHeaders[index + 1] ?? "");
  }
  return Object.freeze(values);
}

function singletonMetadata(request: IncomingMessage, name: string): string | null | false {
  const values = rawHeaderValues(request, name);
  return values.length === 0 ? null : values.length === 1 ? values[0]! : false;
}

function denied(status: 403 | 421, code: DenialCode): DevRequestAuthorization {
  return Object.freeze({ allowed: false, status, code });
}
