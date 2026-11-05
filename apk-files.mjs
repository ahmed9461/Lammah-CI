import { copyFile, lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { digest } from "./report.mjs";
// Contract with apps/mobile/scripts/apk-evidence.mjs. Informational files are
// recognized, but only the validated APK and build manifest enter the report.
export async function collectApkFiles(folder, output, expected) {
  const names = await readdir(folder),
    bytes = await readFile(join(folder, "build.json")),
    m = JSON.parse(bytes);
  if (
    m.sourceCommit !== expected.sourceCommit ||
    m.profile !== expected.profile ||
    m.package !==
      `app.lammah.owner.${expected.profile === "preview" ? "preview" : "qa"}` ||
    m.versionName !== "0.6.0" ||
    m.versionCode !== 600 ||
    JSON.stringify(m.supportedAbis) !== JSON.stringify([expected.abi]) ||
    m.file !== `Lammah-0.6.0-${expected.profile}-${expected.abi}.apk` ||
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
