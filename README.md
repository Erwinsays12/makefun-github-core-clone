# Forge — a GitHub-compatible git forge in one process

A single-process, dependency-free Node.js implementation of a
GitHub-compatible git forge, built for the make.fun `github-core-clone-01`
competition.

## What it implements

- **Git smart HTTP** (`/{owner}/{repo}.git`): upload-pack v2 (ls-refs, fetch
  with shallow/deepen) and v0, receive-pack v0 with fast-forward checks and
  per-ref report-status. Packfiles are written without deltas and read with
  full OFS/REF delta resolution. Objects are SHA-1 content-addressed and
  stored in memory.
- **REST v3** (`/api/v3`): repositories, branches, commits, git refs,
  contents (create/read/update/delete, including on unborn repos and new
  branches), labels, issues + comments, pull requests with file diffs and
  squash merge with file-level three-way conflict detection.
- **GraphQL v4** (`POST /api/graphql`): `viewer`, `repository`, `node`,
  `__type` introspection, issue/pull-request connections with cursor
  pagination, and the `createIssue`, `closeIssue`, `createPullRequest`,
  `mergePullRequest`, `addComment` mutations. Batched (array) requests are
  answered in order.
- **MCP** (`POST /mcp`): Streamable HTTP JSON-RPC 2.0, era `2026-07-28`
  (`server/discover`) with a legacy `initialize` fallback, and eight tools:
  `create_repo`, `get_repo`, `list_repos`, `create_issue`, `get_issue`,
  `list_issues`, `create_pull_request`, `merge_pull_request`.

## Running

```sh
node --experimental-strip-types main.ts
```

The process binds an ephemeral port, registers it with the trial
environment (`$MAKEFUN_ENV_URL/register`), then polls `$MAKEFUN_ENV_URL/done`
until the trial finishes and exits 0. Without `MAKEFUN_ENV_URL` it stays up
in standalone mode on `127.0.0.1` with a printed port.

Environment variables (set by the trial):

- `MAKEFUN_ENV_URL` — trial environment base URL
- `MAKEFUN_SHOP_TOKEN` — bearer token the forge accepts (`shpat_…`)
- `MAKEFUN_TRIAL_SEED` — trial seed (unused; the forge is deterministic)
- `MAKEFUN_TRIAL_NOW` — trial "now"; all server-generated timestamps use it

## Design notes

- **Determinism**: all state is in memory, timestamps come from
  `MAKEFUN_TRIAL_NOW`, ids are monotonic counters, and no wall-clock or
  unseeded randomness is used in anything the forge returns — a replay
  leaves byte-identical state.
- **Performance**: a single Node `http` server, in-memory `Map`s, no
  per-request heavy work; packfiles are built with full objects only
  (no delta search), which keeps push/clone fast.
- **No dependencies**: Node standard library only (`node:http`,
  `node:crypto`, `node:zlib`). No install step, no git binary, no network
  beyond the trial environment.

## Layout

| File | Contents |
| --- | --- |
| `main.ts` | Entrypoint: bind → register → poll `/done` → exit |
| `app.ts` | HTTP server, routing, bearer auth, body handling |
| `store.ts` | In-memory model: repos, issues, pulls, git objects |
| `gitproto.ts` | pkt-lines, packfiles, upload/receive-pack |
| `rest.ts` | REST v3 handlers |
| `graphql.ts` | GraphQL parser + executor |
| `mcp.ts` | MCP endpoint + tools |

## License

MIT — see `LICENSE`.
