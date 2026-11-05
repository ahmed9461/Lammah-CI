// This short-lived process alone receives the read-only source key. It never
// executes dependency installers or application tests and removes the key file.
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateContext } from "./report.mjs";

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
const root = join(
    resolve(process.env.RUNNER_TEMP),
    `lammah-private-${context.runId}-${context.attempt}`,
  ),
  source = join(root, "source"),
  reports = join(root, "reports"),
  keyFile = join(root, "source-key"),
  directory = dirname(fileURLToPath(import.meta.url)),
  env = { ...process.env };
delete env.SOURCE_SSH_KEY;
const commands = [];
let created = false,
  keyWritten = false,
  successful = false;
async function git(label, args, extra = {}) {
  const start = Date.now(),
    log = `${commands.length}-source-${label}.log`,
    fd = openSync(join(reports, log), "wx", 0o600);
  let code;
  try {
    const child = spawn("git", args, {
      cwd: source,
      env: { ...env, ...extra },
      stdio: ["ignore", fd, fd],
    });
    code = await new Promise((done, reject) => {
      child.once("error", reject);
      child.once("exit", (n) => done(n ?? 1));
    });
  } finally {
    closeSync(fd);
  }
  commands.push({
    label: `source-${label}`,
    code,
    elapsedMs: Date.now() - start,
    log,
  });
  if (code) throw Error("source_checkout_failed");
}
try {
  await mkdir(root, { mode: 0o700 });
  created = true;
  await mkdir(source, { mode: 0o700 });
  await mkdir(reports, { mode: 0o700 });
  if (
    !process.env.SOURCE_SSH_KEY?.startsWith(
      "-----BEGIN OPENSSH PRIVATE KEY-----",
    )
  )
    throw Error("read_only_source_key_required");
  await writeFile(keyFile, process.env.SOURCE_SSH_KEY, {
    flag: "wx",
    mode: 0o600,
  });
  keyWritten = true;
  const ssh = {
    GIT_SSH_COMMAND: `ssh -i ${keyFile} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${join(directory, "github_known_hosts")}`,
  };
  await git("init", ["init", "--quiet"]);
  await git(
    "fetch",
    [
      "fetch",
      "--quiet",
      "--no-tags",
      "--depth=1",
      "git@github.com:ahmed9461/Lammah.git",
      context.sourceCommit,
    ],
    ssh,
  );
  await git("checkout", ["checkout", "--quiet", "--detach", "FETCH_HEAD"]);
  if (
    (await readFile(join(source, ".git/HEAD"), "utf8")).trim() !==
    context.sourceCommit
  )
    throw Error("source_commit_mismatch");
  successful = true;
} catch {
  process.exitCode = 1;
} finally {
  if (keyWritten) await unlink(keyFile);
  if (created)
    await writeFile(
      join(root, "checkout.json"),
      JSON.stringify({ context, commands, successful }),
      { flag: "wx", mode: 0o600 },
    );
  process.stdout.write(
    successful
      ? "Private source checkout complete.\n"
      : "Private source checkout failed; encrypted diagnostics follow.\n",
  );
}
