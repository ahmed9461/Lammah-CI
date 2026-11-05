import { spawn } from "node:child_process";
import {
  appendFile,
  copyFile,
  lstat,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { digest, sealBundle, validateContext } from "./report.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const context = validateContext({
  sourceCommit: process.env.SOURCE_SHA,
  controllerCommit: process.env.GITHUB_SHA,
  runId: process.env.GITHUB_RUN_ID,
  attempt: process.env.GITHUB_RUN_ATTEMPT,
  suite: process.env.CI_SUITE,
});
if (
  process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
  process.env.GITHUB_REPOSITORY !== "ahmed9461/Lammah-CI" ||
  process.env.GITHUB_ACTOR !== "ahmed9461"
)
  throw Error("owner_dispatch_required");
const parent = resolve(process.env.RUNNER_TEMP),
  root = join(parent, `lammah-private-${context.runId}-${context.attempt}`),
  source = join(root, "source"),
  reports = join(root, "reports"),
  cleanEnv = { ...process.env };
delete cleanEnv.SOURCE_SSH_KEY;
delete process.env.SOURCE_SSH_KEY;
cleanEnv.GITHUB_SHA = context.sourceCommit;
cleanEnv.GITHUB_WORKSPACE = source;
const commands = [];
let sealed = false;
let ownedRoot = false;
async function command(label, exe, args, cwd = source, extra = {}) {
  const start = Date.now(),
    file = join(
      reports,
      `${String(commands.length).padStart(2, "0")}-${label}.log`,
    ),
    handle = await import("node:fs").then((fs) =>
      fs.openSync(file, "wx", 0o600),
    );
  let code;
  try {
    const child = spawn(exe, args, {
      cwd,
      env: { ...cleanEnv, EXPO_NO_TELEMETRY: "1", ...extra },
      stdio: ["ignore", handle, handle],
    });
    code = await new Promise((done, reject) => {
      child.once("error", reject);
      child.once("exit", (c) => done(c ?? 1));
    });
  } finally {
    (await import("node:fs")).closeSync(handle);
  }
  commands.push({
    label,
    code,
    elapsedMs: Date.now() - start,
    log: file.split("/").at(-1),
  });
  if (code) throw Error("private_command_failed");
}
async function run() {
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw Error("invalid_checkout_directory");
  const checkout = JSON.parse(
    await readFile(join(root, "checkout.json"), "utf8"),
  );
  if (
    JSON.stringify(validateContext(checkout.context)) !==
    JSON.stringify(context)
  )
    throw Error("checkout_context_mismatch");
  ownedRoot = true;
  commands.push(...checkout.commands);
  if (
    !checkout.successful ||
    process.env.SOURCE_SSH_KEY ||
    [
      "OPENAI_API_KEY",
      "OPENROUTER_API_KEY",
      "DEEPSEEK_API_KEY",
      "DATABASE_URL",
      "LAMMAH_PRIVATE_CONFIG",
    ].some((k) => cleanEnv[k])
  )
    throw Error("private_check_inputs_rejected");
  if (
    (await readFile(join(source, ".git/HEAD"), "utf8")).trim() !==
    context.sourceCommit
  )
    throw Error("source_commit_mismatch");
  const install = ["ci", "--ignore-scripts", "--no-fund", "--no-audit"];
  if (context.suite === "core") {
    await command("root-install", "npm", [...install, "--omit=peer"]);
    await command("core-check", "npm", ["run", "check"], source, {
      LAMMAH_STORAGE_TESTS: "1",
      LAMMAH_TEST_DATABASE_URL:
        "postgresql://lammah_test:lammah-test-only@127.0.0.1:5432/postgres",
      LAMMAH_TEST_POSTGRES_CONTAINER: process.env.TEST_POSTGRES_CONTAINER ?? "",
    });
    await command("root-audit", "npm", ["audit", "--audit-level=low"]);
    await command("docs-check", "python3", ["scripts/check_project_docs.py"]);
    await command("docs-tests", "python3", [
      "-m",
      "unittest",
      "discover",
      "-s",
      "scripts/tests",
      "-v",
    ]);
  } else if (context.suite === "mobile") {
    const cwd = join(source, "apps/mobile"),
      env = {
        LAMMAH_MOBILE_WEB_DIR: join(cwd, "dist/web"),
        LAMMAH_MOBILE_OUTPUT: join(root, "mobile-output"),
      };
    await command("root-install", "npm", [...install, "--omit=peer"]);
    await command("mobile-install", "npm", install, cwd);
    for (const task of ["lint", "typecheck", "test"])
      await command(`mobile-${task}`, "npm", ["run", task], cwd);
    await command("mobile-audit", "npm", ["audit", "--audit-level=low"], cwd);
    await command("android-bundle", "npm", ["run", "export:android"], cwd);
    await command(
      "web-bundle",
      "npx",
      ["expo", "export", "--platform", "web", "--output-dir", "dist/web"],
      cwd,
      { EXPO_PUBLIC_LAMMAH_PREVIEW: "1" },
    );
    await command(
      "browser-install",
      "npx",
      ["playwright", "install", "--with-deps", "chromium"],
      cwd,
    );
    await command("web-check", "npm", ["run", "test:ui"], cwd, env);
  } else if (context.suite === "p01") {
    const cwd = join(source, "spikes/p01");
    await command("p01-install", "npm", [...install, "--omit=peer"], cwd);
    await command("p01-test", "npm", ["test"], cwd);
    await command(
      "browser-install",
      "npx",
      ["playwright", "install", "--with-deps", "chromium"],
      cwd,
    );
    await command("p01-ui", "npm", ["run", "test:ui"], cwd);
    await command("p01-live-ui", "npm", ["run", "test:live-ui"], cwd);
    await command(
      "p01-audit",
      "npm",
      ["audit", "--omit=dev", "--audit-level=low"],
      cwd,
    );
  } else {
    const preview = context.suite.includes("preview"),
      arm = context.suite.endsWith("arm64"),
      cwd = join(source, "apps/mobile"),
      abi = arm ? "arm64-v8a" : "x86_64",
      env = {
        EXPO_PUBLIC_LAMMAH_PREVIEW: preview ? "1" : "0",
        EXPO_PUBLIC_LAMMAH_OWNER_QA: preview ? "0" : "1",
        EXPO_PUBLIC_LAMMAH_NATIVE_PROBE: "0",
        EXPO_PUBLIC_LAMMAH_QA_SCENARIO: "",
        ANDROID_NATIVE_ABI: abi,
        LAMMAH_BUILD_PROFILE: preview ? "preview" : "owner-qa",
        LAMMAH_ANDROID_ABI: abi,
      };
    await command("mobile-install", "npm", install, cwd);
    await command(
      "android-prebuild",
      "npx",
      ["expo", "prebuild", "--platform", "android", "--no-install"],
      cwd,
      env,
    );
    await command(
      "android-build",
      "bash",
      [
        "./gradlew",
        ":app:assembleRelease",
        `-PreactNativeArchitectures=${abi}`,
        "-Pkotlin.compiler.execution.strategy=in-process",
        "-Dorg.gradle.jvmargs=-Xmx4096m -XX:MaxMetaspaceSize=2048m",
        "--max-workers=2",
        "--console=plain",
      ],
      join(cwd, "android"),
      env,
    );
    await command(
      "apk-evidence",
      "node",
      ["scripts/apk-evidence.mjs"],
      cwd,
      env,
    );
    for (const name of await readdir(join(cwd, "dist/android-review"))) {
      if (!/^[\w.-]+\.(apk|json)$/.test(name))
        throw Error("unexpected_build_file");
      const file = join(cwd, "dist/android-review", name),
        info = await lstat(file);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size > 100 * 1024 * 1024
      )
        throw Error("invalid_build_file");
      await copyFile(file, join(reports, name));
    }
  }
}
async function sealReport() {
  const files = [];
  for (const name of await readdir(reports)) {
    const path = join(reports, name),
      info = await lstat(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size > 100 * 1024 * 1024
    )
      throw Error("invalid_report_file");
    const bytes = await readFile(path);
    files.push({
      name,
      data: bytes.toString("base64"),
      sha256: digest(bytes),
    });
  }
  const bundle = {
      result: { context, successful: process.exitCode !== 1, commands },
      files,
    },
    packet = sealBundle(
      bundle,
      await readFile(join(directory, "recipient.pub")),
      context,
    ),
    output = join(process.env.GITHUB_WORKSPACE, "sealed-report.lci");
  await writeFile(output, packet, { mode: 0o600, flag: "wx" });
  await appendFile(process.env.GITHUB_OUTPUT, "sealed=true\n");
  sealed = true;
}
try {
  await run();
} catch {
  process.exitCode = 1;
} finally {
  try {
    await sealReport();
  } catch {
    process.exitCode = 1;
  }
  // All recursive cleanup targets are created below the fixed runner temp root.
  if (
    ownedRoot &&
    dirname(root) === parent &&
    /^lammah-private-\d+-\d+$/.test(basename(root))
  )
    await rm(root, { recursive: true, force: true });
  process.stdout.write(
    sealed
      ? "Encrypted private report prepared.\n"
      : "Private CI stopped without publishing unencrypted output.\n",
  );
}
