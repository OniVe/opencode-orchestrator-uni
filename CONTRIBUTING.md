# Contributing

## Commit messages

This project uses [Conventional Commits](https://www.conventionalcommits.org/).
The `commitlint` CI job enforces the format, and releases are automated with
[`semantic-release`](https://semantic-release.gitbook.io/) from the commits
merged to `main`.

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

| Type | Release |
| --- | --- |
| `fix:`, `perf:` | patch (`0.1.0` → `0.1.1`) |
| `feat:` | minor (`0.1.0` → `0.2.0`) |
| `feat!:` / `fix!:` / `BREAKING CHANGE:` footer | minor while `< 1.0.0` (see below), major afterwards |
| `chore:`, `ci:`, `docs:`, `refactor:`, `test:`, `build:` | no release |

While the version is below `1.0.0`, a breaking change bumps the **minor**
version instead of the major one (`release.config.cjs`). Remove that override
when releasing `1.0.0`.

## Releasing

Releases are automated once the repository lives on GitHub:

1. Merge Conventional Commits to `main`.
2. The **Release** workflow runs `semantic-release`, which computes the next
   version, publishes to npm via **trusted publishing (OIDC)** with provenance,
   creates the git tag, and opens a GitHub Release with generated notes.

Do not edit `package.json`'s `version` or tags by hand — `semantic-release`
owns them. Release notes are the source of truth and live on GitHub Releases.

## Local development

```sh
npm ci
npm run typecheck
npm run lint         # biome check .
npm test             # bun test ./test/
```

Tests run on [Bun](https://bun.sh); the release tooling needs Node.js 22.14+.
