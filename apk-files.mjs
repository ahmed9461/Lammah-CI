import { copyFile, lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { digest } from "./report.mjs";
export function productionVersion(version, code) {
  const match = /^0\.8\.(0|[1-9]\d{0,3})$/u.exec(version ?? "");
  if (!match || code !== 800 + Number(match[1]))
    throw Error("invalid_apk_evidence");
  return version;
}
// Contract with apps/mobile/scripts/apk-evidence.mjs. Informational files are
// recognized, but only the validated APK and build manifest enter the report.
export async function collectApkFiles(folder, output, expected) {
  const production = expected.profile === "production-candidate";
  if (
    !["preview", "owner-qa", "production-candidate"].includes(expected.profile)
  )
    throw Error("invalid_apk_evidence");
  const names = await readdir(folder),
    bytes = await readFile(join(folder, "build.json")),
    m = JSON.parse(bytes),
    version = production
      ? productionVersion(m.versionName, m.versionCode)
      : "0.6.0";
  if (
    m.sourceCommit !== expected.sourceCommit ||
    m.profile !== expected.profile ||
    m.package !==
      (production
        ? "app.lammah.owner"
        : `app.lammah.owner.${expected.profile === "preview" ? "preview" : "qa"}`) ||
    m.versionName !== version ||
    (!production && m.versionCode !== 600) ||
    JSON.stringify(m.supportedAbis) !== JSON.stringify([expected.abi]) ||
    m.file !== `Lammah-${version}-${expected.profile}-${expected.abi}.apk` ||
    m.requiresMetro !== false ||
    m.nativeProbe !== false
  )
    throw Error("invalid_apk_evidence");
  if (
    !names.includes(m.file) ||
    names.some(
      (n) => ![m.file, "build.json", "READ_ME.txt", "SHA256SUMS"].includes(n),
    )
  )
    throw Error("unexpected_build_file");
  for (const name of names) {
    const info = await lstat(join(folder, name));
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size > 100 * 1024 * 1024
    )
      throw Error("invalid_build_file");
  }
  const apk = await readFile(join(folder, m.file));
  if (digest(apk) !== m.sha256 || apk.length !== m.bytes)
    throw Error("invalid_apk_evidence");
  if (
    names.includes("SHA256SUMS") &&
    (await readFile(join(folder, "SHA256SUMS"), "utf8")).trim() !==
      `${m.sha256}  ${m.file}`
  )
    throw Error("invalid_apk_evidence");
  await copyFile(join(folder, m.file), join(output, m.file));
  await copyFile(join(folder, "build.json"), join(output, "build.json"));
  return m;
}
