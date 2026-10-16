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

The workflow needs a `RELEASE_TOKEN` secret — a PAT with `Contents: read and write`
(plus `Issues` / `Pull requests: read and write` if release comments matter).
`semantic-release` also pushes release metadata to `refs/notes/*`, and the Actions
`GITHUB_TOKEN` is not allowed to write that namespace.

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

## Translations

Agent definitions and process documents ship per locale under `agents/<locale>/`
and `docs/<locale>/`. `ru` is the reference locale; every other locale must
mirror it. After editing either side, run:

```sh
npm run check:locales   # ru → en parity for every shipped file (tools/locale-check.ts)
npm test                # translation.test.ts enforces the same contract
```

The contract (see `test/support/locales.ts`): same markdown shape, same
frontmatter, same SGR templates, identical schema-bound enum tokens, no
Cyrillic left behind, no forbidden ids. Inside JSON, never introduce a new `|`.
