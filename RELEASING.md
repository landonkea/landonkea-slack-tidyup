# Releasing

This is a script you run locally, not a hosted service, so there's no "deploy to production" step. "Releases" here just means tagging a specific, tested version of `delete.sh` / `delete.js` so you (or anyone else who clones this) can point at a known-good snapshot instead of whatever `main` happens to look like today.

## Branches

- **`main`** is the only branch that matters day to day. It should always be in a state you'd be comfortable running against a real Slack channel.
- For anything bigger than a one-line fix, work on a `feature/<short-name>` branch and open a PR into `main`. The CI workflow (syntax checks) and the AI-attribution check both run on every PR.
- `dev` and `staging` branch names are already recognized by the AI-attribution check workflow if you ever want an intermediate integration branch, but for a repo this size, going straight to `feature/* -> main` is normal and expected.

## Version numbers

Tags follow `vMAJOR.MINOR.PATCH`, for example `v1.2.0`. Bump PATCH for bug fixes, MINOR for new options/behavior that don't break existing usage, MAJOR for anything that changes how the existing flags or `.env` setup work.

## Pre-releases (release candidates)

Before committing to a real version number, you can tag a release candidate to get a proper GitHub release out of it for testing:

```bash
git tag v1.2.0-rc.1
git push origin v1.2.0-rc.1
```

Pushing a tag matching `v*.*.*-rc.*` triggers `.github/workflows/prerelease.yml`, which runs the syntax checks and publishes a GitHub **pre-release** (marked as such, won't show up as "latest"). You can cut `-rc.2`, `-rc.3`, and so on from the same or later commits until it's solid.

## Stable releases

Once an `-rc` build has been tried out and looks good, tag the real version **from `main`**:

```bash
git checkout main
git pull
git tag v1.2.0
git push origin v1.2.0
```

Pushing a tag matching `v*.*.*` (and not containing `-rc.`) triggers `.github/workflows/release.yml`. That workflow does one thing the pre-release workflow doesn't: it checks that the tagged commit is actually reachable from `main` before publishing anything. If you tag a commit that isn't on `main`, the workflow fails on purpose instead of quietly publishing a release built from a stray branch.

On success it creates a proper GitHub Release with auto-generated notes (from commits since the last tag) and attaches `delete.sh` and `delete.js` as downloadable release assets.

## Quick reference

| Tag pattern | Workflow | Result |
|---|---|---|
| `v1.2.0-rc.1`, `v1.2.0-rc.2`, ... | `prerelease.yml` | GitHub pre-release, any branch |
| `v1.2.0` | `release.yml` | GitHub release, main only, fails otherwise |
