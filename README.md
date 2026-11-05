# Lammah CI controller

This public repository contains CI controller files only. The Lammah application
source, project history, owner data and detailed private reports are kept in the
separate private repository.

## Current scope

The manually dispatched `Runner availability probe` checks whether a standard
GitHub-hosted runner can start for this account. It does not check out application
code, read repository secrets, contact WhatsApp or call a paid AI provider.
Passing this probe is **not** application or Android acceptance.

Only the repository owner may dispatch this probe. It has read-only token
permissions, no pull-request trigger and no self-hosted runner access.

## Private application checks

The owner-only `Private application checks` workflow accepts an exact source
commit and one reviewed suite: core, mobile, P01, or Android QA builds. It reads
the application through a dedicated **read-only deploy key**. That key is removed
before dependency installation and tests; no owner password, recovery code,
WhatsApp session or AI API key is provided.

Detailed output and APK files are encrypted with AES-256-GCM and an RSA-OAEP
recipient key before the only artifact is uploaded. The report decryption key
is not held by this repository or its runner. Public job status remains visible.
The private operator validates run, attempt, suite and both source/controller
commits, then imports authenticated results into the private project.

The controller has no token that can write to the private repository. There are
no pull-request or push triggers, no shared dependency caches, and no production
deployment, WhatsApp connection or paid AI test. GitHub still hosts the checked
out source transiently, as with normal private CI; encryption is for reports and
artifacts, not a claim that the runner cannot read its build inputs.

An account billing restriction may also block a public repository. A successful
availability probe does not prove any application suite or Android device test.
