import {
  constants,
  createCipheriv,
  createDecipheriv,
  createHash,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
} from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
export const suites = [
  "core",
  "mobile",
  "p01",
  "android-preview-arm64",
  "android-owner-arm64",
  "android-preview-x86",
  "android-owner-x86",
];
const magic = Buffer.from("LAMMAHCI1\n");
export const digest = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
export function validateContext(c) {
  if (
    !c ||
    !/^[a-f0-9]{40}$/.test(c.sourceCommit ?? "") ||
    !/^[a-f0-9]{40}$/.test(c.controllerCommit ?? "") ||
    !/^[1-9]\d{0,19}$/.test(c.runId ?? "") ||
    !/^[1-9]\d{0,5}$/.test(c.attempt ?? "") ||
    !suites.includes(c.suite)
  )
    throw Error("invalid_ci_context");
  return Object.fromEntries(
    ["sourceCommit", "controllerCommit", "runId", "attempt", "suite"].map(
      (k) => [k, c[k]],
    ),
  );
}
export function validateBundle(b, context) {
  if (
    !b ||
    JSON.stringify(validateContext(b.result?.context)) !==
      JSON.stringify(validateContext(context)) ||
    !Array.isArray(b.result.commands) ||
    b.result.commands.length > 30 ||
    !Array.isArray(b.files) ||
    b.files.length > 80
  )
    throw Error("invalid_ci_bundle");
  if (
    typeof b.result.successful !== "boolean" ||
    (b.result.successful &&
      (!b.result.commands.length ||
        b.result.commands.some((c) => c.code !== 0)))
  )
    throw Error("invalid_ci_outcome");
  let bytes = 0;
  const names = new Set();
  for (const f of b.files) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,180}\.(log|json|apk)$/.test(
        f.name ?? "",
      ) ||
      names.has(f.name) ||
      typeof f.data !== "string" ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(f.data) ||
      !/^[a-f0-9]{64}$/.test(f.sha256 ?? "")
    )
      throw Error("invalid_ci_file");
    names.add(f.name);
    const data = Buffer.from(f.data, "base64");
    bytes += data.length;
    if (
      data.toString("base64") !== f.data ||
      digest(data) !== f.sha256 ||
      data.length > 100 * 1024 * 1024 ||
      bytes > 160 * 1024 * 1024
    )
      throw Error("invalid_ci_file");
  }
  for (const r of b.result.commands)
    if (
      !/^[a-z0-9-]{1,80}$/.test(r.label ?? "") ||
      !Number.isSafeInteger(r.code) ||
      r.code < 0 ||
      r.code > 255 ||
      !Number.isFinite(r.elapsedMs) ||
      r.elapsedMs < 0
    )
      throw Error("invalid_ci_command");
  return b;
}
export function sealBundle(bundle, recipient, context) {
  const c = validateContext(context);
  validateBundle(bundle, c);
  const key = randomBytes(32),
    iv = randomBytes(12);
  try {
    const header = Buffer.from(
      JSON.stringify({
        v: 1,
        context: c,
        key: publicEncrypt(
          {
            key: recipient,
            oaepHash: "sha256",
            padding: constants.RSA_PKCS1_OAEP_PADDING,
          },
          key,
        ).toString("base64"),
        iv: iv.toString("base64"),
      }),
    );
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(header);
    const encrypted = Buffer.concat([
      cipher.update(gzipSync(Buffer.from(JSON.stringify(bundle)))),
      cipher.final(),
    ]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(header.length);
    return Buffer.concat([
      magic,
      length,
      header,
      encrypted,
      cipher.getAuthTag(),
    ]);
  } finally {
    key.fill(0);
  }
}
export function openBundle(packet, recipient, expectedContext) {
  try {
    if (
      packet.length > 180 * 1024 * 1024 ||
      !packet.subarray(0, magic.length).equals(magic)
    )
      throw Error();
    const length = packet.readUInt32BE(magic.length),
      at = magic.length + 4;
    if (length > 4096 || length < 1 || at + length + 16 >= packet.length)
      throw Error();
    const header = packet.subarray(at, at + length),
      h = JSON.parse(header.toString());
    if (
      h.v !== 1 ||
      JSON.stringify(validateContext(h.context)) !==
        JSON.stringify(validateContext(expectedContext))
    )
      throw Error();
    const key = privateDecrypt(
      {
        key: recipient,
        oaepHash: "sha256",
        padding: constants.RSA_PKCS1_OAEP_PADDING,
      },
      Buffer.from(h.key, "base64"),
    );
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(h.iv, "base64"),
      );
      decipher.setAAD(header);
      decipher.setAuthTag(packet.subarray(-16));
      const plain = Buffer.concat([
        decipher.update(packet.subarray(at + length, -16)),
        decipher.final(),
      ]);
      return validateBundle(
        JSON.parse(
          gunzipSync(plain, { maxOutputLength: 240 * 1024 * 1024 }).toString(),
        ),
        expectedContext,
      );
    } finally {
      key.fill(0);
    }
  } catch {
    throw Error("ci_report_authentication_failed");
  }
}
