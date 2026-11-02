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
