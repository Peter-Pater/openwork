import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { resolveOpenworkDataDir } from "../../data-dir.js";

/**
 * On-disk store for a session's gathered intermediate artifacts -- the images
 * an agent fetched and the rendered snapshots of webpages it visited, shown as
 * two piles beside the avatar in XR.
 *
 * Named session-artifact-store to keep clear of the kitchen's world
 * artifact-store (core/world/artifact-store.ts), which is an unrelated system.
 *
 * Follows room-store.ts's one-owner-module convention: the watcher writes
 * through here and the HTTP routes read through here, so the directory layout
 * and naming can never drift apart. Layout:
 *
 *   <dataDir>/environments/session-artifacts/<sessionId>/
 *       <sha256>.<ext>      the bytes (png/jpg/gif/webp/avif)
 *       index.json          ordered list of SessionArtifactEntry, oldest first
 *
 * The sha256 doubles as the artifact id AND the filename stem, which is what
 * makes the dedupe honest: identical bytes can never appear twice no matter
 * which URL produced them, and the bytes route can validate its :artifactId
 * as pure hex with no path-traversal surface at all.
 */

export type SessionArtifactKind = "image" | "page";

export type SessionArtifactEntry = {
  /** sha256 of the bytes; also the filename stem and the route's :artifactId. */
  id: string;
  kind: SessionArtifactKind;
  /** URL as the agent requested it. */
  url: string;
  /** URL after redirects (what was actually captured). */
  finalUrl: string;
  /** Page <title> for snapshots; null for direct images. */
  title: string | null;
  /** Filename within the session directory. */
  file: string;
  mime: string;
  width: number | null;
  height: number | null;
  capturedAt: string;
};

/**
 * Hard per-session cap. A runaway research loop must not fill the disk; at a
 * few hundred KB per artifact this bounds a session to some tens of MB.
 */
export const MAX_ARTIFACTS_PER_SESSION = 200;

/**
 * Magic-byte sniff. THE routing authority for what counts as an image --
 * deliberately not the Content-Type header, which image hosts get wrong and
 * content negotiation can flip. Anything this returns null for is a "page"
 * and goes to the renderer; anything it recognizes must NEVER reach the
 * renderer (a browser renders a bare .jpg as an HTML document, which would
 * put a snapshot OF the image in the page pile beside the image itself --
 * the exact duplication failure this function exists to prevent).
 *
 * SVG is deliberately absent: it is text, browsers treat it as a document,
 * and a rendered snapshot of it is the more useful artifact anyway.
 */
export function sniffImage(bytes: Uint8Array): { mime: string; ext: string } | null {
  if (bytes.length < 12) return null;
  if (
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return { mime: "image/png", ext: "png" };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mime: "image/jpeg", ext: "jpg" };
  }
  const ascii = (start: number, len: number) => String.fromCharCode(...bytes.subarray(start, start + len));
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") {
    return { mime: "image/gif", ext: "gif" };
  }
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    return { mime: "image/webp", ext: "webp" };
  }
  // ISO-BMFF: size box then 'ftyp' at offset 4, brand at 8.
  if (ascii(4, 4) === "ftyp" && (ascii(8, 4) === "avif" || ascii(8, 4) === "avis")) {
    return { mime: "image/avif", ext: "avif" };
  }
  return null;
}

/**
 * Session ids come off the network (SSE parts, route params) and end up in
 * filesystem paths, so they are validated rather than trusted. Opencode ids
 * are ses_<alnum>; anything outside this alphabet is rejected outright.
 */
export function isSafeSessionId(sessionId: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(sessionId);
}

/** Artifact ids are sha256 hex, nothing else. */
export function isSafeArtifactId(artifactId: string): boolean {
  return /^[0-9a-f]{64}$/.test(artifactId);
}

export function sessionArtifactsRoot(): string {
  return join(resolveOpenworkDataDir(), "environments", "session-artifacts");
}

export function sessionArtifactsDir(sessionId: string): string {
  if (!isSafeSessionId(sessionId)) throw new Error(`unsafe session id: ${sessionId}`);
  return join(sessionArtifactsRoot(), sessionId);
}

function indexPath(sessionId: string): string {
  return join(sessionArtifactsDir(sessionId), "index.json");
}

/** The session's artifacts, oldest first. Missing/corrupt index reads as empty. */
export function readIndex(sessionId: string): SessionArtifactEntry[] {
  if (!isSafeSessionId(sessionId)) return [];
  const path = indexPath(sessionId);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Whether this session already captured this URL (as requested OR as the
 * post-redirect final URL). The watcher checks this BEFORE commanding a
 * capture, so a re-fetch of a page the agent already visited is a no-op
 * rather than a second render.
 */
export function hasUrl(sessionId: string, url: string): boolean {
  return readIndex(sessionId).some((entry) => entry.url === url || entry.finalUrl === url);
}

/** Absolute path of a stored artifact's bytes, or null when unknown. */
export function artifactFilePath(sessionId: string, artifactId: string): string | null {
  if (!isSafeSessionId(sessionId) || !isSafeArtifactId(artifactId)) return null;
  const entry = readIndex(sessionId).find((candidate) => candidate.id === artifactId);
  if (!entry) return null;
  const path = join(sessionArtifactsDir(sessionId), entry.file);
  return existsSync(path) ? path : null;
}

export type AddArtifactInput = {
  kind: SessionArtifactKind;
  url: string;
  finalUrl: string;
  title: string | null;
  bytes: Buffer;
  width: number | null;
  height: number | null;
};

/**
 * Store one artifact. Returns the new index entry, or null when nothing was
 * added: byte-identical content already stored (the sha256 dedupe), an image
 * payload whose bytes do not actually sniff as an image (the kind is
 * re-verified here rather than trusted from the capture side), or the
 * per-session cap reached.
 */
export function addArtifact(sessionId: string, input: AddArtifactInput): SessionArtifactEntry | null {
  if (!isSafeSessionId(sessionId)) return null;

  // Page snapshots are PNGs we produced ourselves, so both kinds must sniff
  // as an image here -- this is the server-side re-verification of the
  // routing decision made in Electron, and it also pins the true extension.
  const sniffed = sniffImage(input.bytes);
  if (!sniffed) return null;

  const entries = readIndex(sessionId);
  if (entries.length >= MAX_ARTIFACTS_PER_SESSION) return null;

  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  if (entries.some((entry) => entry.id === sha256)) return null;

  const dir = sessionArtifactsDir(sessionId);
  mkdirSync(dir, { recursive: true });

  const file = `${sha256}.${sniffed.ext}`;
  writeFileSync(join(dir, file), input.bytes);

  const entry: SessionArtifactEntry = {
    id: sha256,
    kind: input.kind,
    url: input.url,
    finalUrl: input.finalUrl || input.url,
    title: input.title,
    file,
    mime: sniffed.mime,
    width: input.width,
    height: input.height,
    capturedAt: new Date().toISOString(),
  };
  entries.push(entry);
  writeFileSync(indexPath(sessionId), JSON.stringify(entries, null, 2), "utf8");
  return entry;
}
