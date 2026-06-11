import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export function rawFrameDigest(rawFrames = []) {
  return crypto
    .createHash("sha256")
    .update(stableJson(rawFrames))
    .digest("hex");
}

export function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

export function rawFrameArchiveText(rawFrames = []) {
  return rawFrames.map(stableJson).join("\n") + (rawFrames.length ? "\n" : "");
}

export async function writeRawFrameArchive(file, rawFrames = []) {
  await fs.writeFile(file, rawFrameArchiveText(rawFrames), "utf8");
  return {
    path: path.basename(file),
    frames: rawFrames.length,
    sha256: rawFrameDigest(rawFrames)
  };
}

export async function inspectRawFrameArchive({ manifestFile, manifest }) {
  const archive = manifest.rawFrameArchive;
  if (!archive || typeof archive !== "object" || !archive.path) {
    return { present: false, verified: false, reason: "raw frame archive metadata missing" };
  }
  const archivePath = path.resolve(path.dirname(manifestFile), archive.path);
  try {
    const text = await fs.readFile(archivePath, "utf8");
    const frames = text.trim() ? text.trim().split(/\r?\n/).map(line => JSON.parse(line)) : [];
    const sha256 = rawFrameDigest(frames);
    const expectedSha = manifest.frameEvidence?.rawFrameSha256;
    const metadataSha = archive.sha256;
    const metadataFrames = archive.frames;
    const verified = sha256 === expectedSha &&
      sha256 === metadataSha &&
      frames.length === metadataFrames;
    return {
      present: true,
      verified,
      path: path.relative(process.cwd(), archivePath),
      frames: frames.length,
      sha256,
      expectedSha,
      metadataSha,
      metadataFrames,
      reason: verified ? null : "raw frame archive digest or frame count mismatch"
    };
  } catch (err) {
    return {
      present: false,
      verified: false,
      path: path.relative(process.cwd(), archivePath),
      reason: `raw frame archive unreadable: ${err.message}`
    };
  }
}
