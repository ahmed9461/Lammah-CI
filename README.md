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

Any future application build flow must be reviewed separately for read-only
source access, protected logs and artifacts, exact source commit binding and
private report import. An account billing restriction may also block a public
repository; this repository does not guarantee otherwise.
