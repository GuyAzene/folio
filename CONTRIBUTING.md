# Contributing to Folio

Folio is made by one developer and isn't accepting outside code yet. Bug reports and ideas are
welcome.

## Reporting a bug or an idea

Open an issue with the **Bug report** or **Idea or request** form. Issues are public, so leave
out anything private: course material, notes, chats, keys, or names and paths that identify you.

Report a security problem privately instead, as [SECURITY.md](SECURITY.md) describes.

## How changes are made

- A feature or a change in several steps is a pull request from its own branch. Small fixes may
  go straight to `main`.
- Pull requests are squash-merged, so the title becomes the commit on `main`. Write it as a plain
  sentence about what changes for the student, like the existing history ("Keep study notes to
  what the slides teach, not how they look"). "Fixes #12" in the description closes the issue.
- The **CI** check must pass. It covers formatting, lint and types, the Svelte checks, the unit
  tests and the builds on Linux, and, when the app or its checks change, Folio in a real window
  on a fresh build and as the packaged app on macOS.
- Before opening a pull request, run `vp check`, `vp run check:ui` and `vp test`. Check interface
  changes in the browser preview (`vp dev`), and in a real window (`vp run test:electron`) when
  they cross the Electron bridge.

[AGENTS.md](AGENTS.md) has the engineering conventions and
[docs/architecture.md](docs/architecture.md) how the pieces fit together.

## Releases

Versions are `0.MINOR.PATCH` while Folio is early: the minor number for new features, the patch
number for fixes only. Each upcoming version has a milestone, and a version ships when its
milestone is done.

1. On an up-to-date `main`, run `vp run release 0.2.0`. It sets the version, commits
   "Release 0.2.0" and tags it `v0.2.0`.
2. Push `main` and the tag. The release workflow runs every check on that commit, builds the disk
   image, and drafts the release with a checksum and a build attestation.
3. Read the draft: its notes list the pull requests merged since the last release, grouped as
   New, Improved and Fixed by their labels. Add anything merged without a pull request, then
   publish it.

The [nightly build](https://github.com/GuyAzene/folio/releases/tag/nightly) is rebuilt from `main`
after every change, for anyone who wants the newest Folio.
