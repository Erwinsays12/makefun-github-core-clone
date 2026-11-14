// rest.ts — GitHub REST v3 surface (/api/v3). Written fresh in this session.
import { Store, VIEWER_LOGIN, VIEWER_ID, VIEWER_NAME, VIEWER_EMAIL, ZERO_OID, parseCommit, parseTree, buildTreeFromFiles } from './store.ts';
import type { Repo, Issue, Pull, Label } from './store.ts';

export interface Ctx {
  store: Store;
  reqId: string;
  origin: string;
}

export interface RouteResult {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export function json(status: number, body: unknown, headers?: Record<string, string>): RouteResult {
  return { status, body, headers };
}

export function err(status: number, message: string): RouteResult {
  return { status, body: { message } };
}

export function gqid(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  const openIssues = repo.issues.filter((i) => i.state === 'open').length;
  return {
    id: repo.dbId,
    node_id: gqid('R', String(repo.dbId)),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.isPrivate,
    description: repo.description || null,
    default_branch: repo.defaultBranch,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: store.now.iso,
    updated_at: store.now.iso,
    pushed_at: store.now.iso,
    fork: false,
    has_issues: true,
    has_pull_requests: true,
    has_projects: false,
    has_wiki: false,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    open_issues_count: openIssues,
    watchers: 0,
    stargazers_count: 0,
    forks_count: 0,
  };
}

export function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: gqid('I', `${repo.dbId}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const l = repo.labels.get(name);
      return { id: name, name, color: l?.color ?? 'ededed', description: l?.description ?? '' };
    }),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: store.now.iso,
    updated_at: store.now.iso,
    closed_at: issue.closedAt,
    comments: (repo.comments.get(issue.number) ?? []).length,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  const headTip = store.refTip(repo, `refs/heads/${pull.head}`);
  const baseTip = store.refTip(repo, `refs/heads/${pull.base}`);
  return {
    id: pull.id,
    node_id: gqid('PR', `${repo.dbId}:${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: {
      ref: pull.head,
      sha: headTip ?? pull.headSha,
      label: `${repo.owner}:${pull.head}`,
      repo: { name: repo.name, full_name: `${repo.owner}/${repo.name}` },
    },
    base: {
      ref: pull.base,
      sha: baseTip ?? pull.baseSha,
      label: `${repo.owner}:${pull.base}`,
      repo: { name: repo.name, full_name: `${repo.owner}/${repo.name}` },
    },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: store.now.iso,
    updated_at: store.now.iso,
    closed_at: pull.mergedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

export function commitJson(store: Store, oid: string): Record<string, unknown> | null {
  const obj = store.getObject(oid);
  if (!obj || obj.type !== 'commit') return null;
  const c = parseCommit(obj.data);
  const parseIdent = (line: string) => {
    const m = /^(.+) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
    if (!m) return { name: VIEWER_NAME, email: VIEWER_EMAIL, date: store.now.iso };
    return { name: m[1], email: m[2], date: new Date(Number(m[3]) * 1000).toISOString() };
  };
  const author = parseIdent(c.author);
  const committer = parseIdent(c.committer);
  return {
    sha: oid,
    commit: {
      message: c.message,
      author,
      committer,
      tree: { sha: c.tree },
    },
    author: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    committer: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    parents: c.parents.map((p) => ({ sha: p })),
    html_url: '',
    url: '',
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getRepoOr404(ctx: Ctx, owner: string, name: string): Repo | RouteResult {
  if (owner !== VIEWER_LOGIN) return err(404, 'Not Found');
  const repo = ctx.store.getRepo(name);
  if (!repo) return err(404, 'Not Found');
  return repo;
}

function isRepo(r: Repo | RouteResult): r is Repo {
  return (r as Repo).refs !== undefined;
}

function parseQuery(url: URL): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of url.searchParams) out[k] = v;
  return out;
}

function pageParams(q: Record<string, string>): { perPage: number; page: number } {
  const perPage = Math.max(1, Math.min(100, parseInt(q.per_page ?? '30', 10) || 30));
  const page = Math.max(1, parseInt(q.page ?? '1', 10) || 1);
  return { perPage, page };
}

function paginate<T>(ctx: Ctx, url: URL, items: T[], q: Record<string, string>): RouteResult {
  const { perPage, page } = pageParams(q);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    const next = new URL(url.toString());
    next.searchParams.set('page', String(page + 1));
    next.searchParams.set('per_page', String(perPage));
    headers.Link = `<${next.toString()}>; rel="next"`;
  }
  return json(200, slice, headers);
}

function resolveRef(store: Store, repo: Repo, ref?: string): string | undefined {
  if (!ref) return store.headTip(repo);
  if (/^[0-9a-f]{40}$/.test(ref)) {
    const obj = store.getObject(ref);
    return obj && obj.type === 'commit' ? ref : undefined;
  }
  if (ref.startsWith('refs/')) return store.refTip(repo, ref);
  return store.refTip(repo, `refs/heads/${ref}`);
}

function lineCount(data: Buffer): number {
  const text = data.toString('utf8');
  if (text === '') return 0;
  const lines = text.split('\n');
  return lines.length - (text.endsWith('\n') ? 1 : 0);
}

export interface DiffEntry {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

export function diffTrees(
  store: Store,
  baseMap: Map<string, { mode: string; oid: string }>,
  headMap: Map<string, { mode: string; oid: string }>,
): DiffEntry[] {
  const out: DiffEntry[] = [];
  const paths = new Set([...baseMap.keys(), ...headMap.keys()]);
  for (const path of [...paths].sort()) {
    const b = baseMap.get(path);
    const h = headMap.get(path);
    if (!b && h) {
      const data = store.getObject(h.oid)?.data ?? Buffer.alloc(0);
      const additions = lineCount(data);
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (b && !h) {
      const data = store.getObject(b.oid)?.data ?? Buffer.alloc(0);
      const deletions = lineCount(data);
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (b && h && b.oid !== h.oid) {
      const oldData = store.getObject(b.oid)?.data ?? Buffer.alloc(0);
      const newData = store.getObject(h.oid)?.data ?? Buffer.alloc(0);
      const additions = lineCount(newData);
      const deletions = lineCount(oldData);
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Contents
// ---------------------------------------------------------------------------

function contentsGet(ctx: Ctx, repo: Repo, path: string, ref?: string): RouteResult {
  const tip = resolveRef(ctx.store, repo, ref);
  if (!tip) return err(404, 'Not Found');
  const files = ctx.store.flattenTree(tip);
  const clean = path.replace(/^\/+|\/+$/g, '');
  if (clean === '') {
    // Root listing.
    const entries = listDir(ctx.store, tip, '');
    return json(200, entries);
  }
  const file = files.get(clean);
  if (file) {
    const obj = ctx.store.getObject(file.oid);
    const data = obj?.data ?? Buffer.alloc(0);
    return json(200, {
      type: 'file',
      encoding: 'base64',
      size: data.length,
      name: clean.split('/').pop(),
      path: clean,
      content: data.toString('base64'),
      sha: file.oid,
    });
  }
  // Directory?
  const prefix = clean + '/';
  let isDir = false;
  for (const p of files.keys()) if (p.startsWith(prefix)) { isDir = true; break; }
  if (isDir) return json(200, listDir(ctx.store, tip, clean));
  return err(404, 'Not Found');
}

function listDir(store: Store, tip: string, dir: string): Record<string, unknown>[] {
  const files = store.flattenTree(tip);
  const prefix = dir === '' ? '' : dir + '/';
  const entries = new Map<string, { type: string; oid: string }>();
  for (const [path, e] of files) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      entries.set(rest, { type: 'file', oid: e.oid });
    } else {
      const name = rest.slice(0, slash);
      if (!entries.has(name)) entries.set(name, { type: 'dir', oid: '' });
    }
  }
  const out: Record<string, unknown>[] = [];
  for (const name of [...entries.keys()].sort()) {
    const e = entries.get(name)!;
    out.push({
      type: e.type,
      name,
      path: prefix + name,
      sha: e.oid || undefined,
      size: e.type === 'file' ? (store.getObject(e.oid)?.data.length ?? 0) : undefined,
    });
  }
  return out;
}

function contentsPut(ctx: Ctx, repo: Repo, path: string, body: Record<string, unknown>): RouteResult {
  const clean = path.replace(/^\/+|\/+$/g, '');
  if (!clean) return err(400, 'Invalid path');
  const message = typeof body.message === 'string' ? body.message : 'Update file';
  const contentB64 = typeof body.content === 'string' ? body.content : null;
  if (contentB64 === null) return err(400, 'content is required');
  const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
  const refName = `refs/heads/${branch}`;
  let baseTip = ctx.store.refTip(repo, refName);
  if (!baseTip && branch !== repo.defaultBranch) {
    // GitHub branches a new branch off the default branch.
    baseTip = ctx.store.headTip(repo);
  }
  const files = baseTip ? ctx.store.flattenTree(baseTip) : new Map<string, { mode: string; oid: string }>();
  const existing = files.get(clean);
  if (typeof body.sha === 'string' && existing && body.sha !== existing.oid) {
    return err(409, 'sha does not match the current file');
  }
  let content: Buffer;
  try {
    content = Buffer.from(contentB64, 'base64');
  } catch {
    return err(400, 'content is not valid base64');
  }
  const blobOid = ctx.store.putObject('blob', content);
  files.set(clean, { mode: '100644', oid: blobOid });
  const treeOid = buildTreeFromFiles(files, (t, d) => ctx.store.putObject(t, d));
  const commitOid = ctx.store.makeCommit({
    tree: treeOid,
    parents: baseTip ? [baseTip] : [],
    message,
  });
  ctx.store.repos.get(repo.name)!.refs.set(refName, commitOid);
  return json(existing ? 200 : 201, {
    content: { name: clean.split('/').pop(), path: clean, sha: blobOid, size: content.length, encoding: 'base64' },
    commit: { sha: commitOid, message },
  });
}

function contentsDelete(ctx: Ctx, repo: Repo, path: string, body: Record<string, unknown>): RouteResult {
  const clean = path.replace(/^\/+|\/+$/g, '');
  if (!clean) return err(400, 'Invalid path');
  const message = typeof body.message === 'string' ? body.message : 'Delete file';
  const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
  const refName = `refs/heads/${branch}`;
  const baseTip = ctx.store.refTip(repo, refName);
  if (!baseTip) return err(404, 'Not Found');
  const files = ctx.store.flattenTree(baseTip);
  const existing = files.get(clean);
  if (!existing) return err(404, 'Not Found');
  if (typeof body.sha === 'string' && body.sha !== existing.oid) {
    return err(409, 'sha does not match the current file');
  }
  files.delete(clean);
  const treeOid = buildTreeFromFiles(files, (t, d) => ctx.store.putObject(t, d));
  const commitOid = ctx.store.makeCommit({ tree: treeOid, parents: [baseTip], message });
  ctx.store.repos.get(repo.name)!.refs.set(refName, commitOid);
  return json(200, { commit: { sha: commitOid, message } });
}

// ---------------------------------------------------------------------------
// Pull-request merge
// ---------------------------------------------------------------------------

export function mergePull(
  ctx: Ctx,
  repo: Repo,
  pull: Pull,
): { status: number; body: unknown } {
  const baseTip = ctx.store.refTip(repo, `refs/heads/${pull.base}`);
  const headTip = ctx.store.refTip(repo, `refs/heads/${pull.head}`) ?? pull.headSha;
  if (!baseTip || !headTip) return { status: 405, body: { message: 'Merge conflict' } };
  const mergeBase = ctx.store.mergeBase(headTip, baseTip);
  if (!mergeBase) return { status: 405, body: { message: 'Merge conflict' } };
  const baseMap = ctx.store.flattenTree(mergeBase);
  const headMap = ctx.store.flattenTree(headTip);
  const tipMap = ctx.store.flattenTree(baseTip);
  const changed = diffTrees(ctx.store, baseMap, headMap);
  // Conflict: a file changed in the PR AND changed on the base tip since
  // the merge base, with a different result.
  for (const c of changed) {
    const baseEntry = baseMap.get(c.filename);
    const headEntry = headMap.get(c.filename);
    const tipEntry = tipMap.get(c.filename);
    const tipChanged = (tipEntry?.oid ?? null) !== (baseEntry?.oid ?? null);
    const headResult = headEntry?.oid ?? null;
    const tipResult = tipEntry?.oid ?? null;
    if (tipChanged && tipResult !== headResult) {
      return { status: 405, body: { message: 'Merge conflict' } };
    }
  }
  // Apply the PR's changes onto the current base tip.
  const merged = new Map(tipMap);
  for (const c of changed) {
    if (c.status === 'removed') merged.delete(c.filename);
    else {
      const e = headMap.get(c.filename)!;
      merged.set(c.filename, e);
    }
  }
  const treeOid = buildTreeFromFiles(merged, (t, d) => ctx.store.putObject(t, d));
  const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.head}\n\n${pull.title}`;
  const commitOid = ctx.store.makeCommit({ tree: treeOid, parents: [baseTip], message });
  ctx.store.repos.get(repo.name)!.refs.set(`refs/heads/${pull.base}`, commitOid);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = ctx.store.now.iso;
  pull.mergeCommitSha = commitOid;
  return { status: 200, body: { merged: true, sha: commitOid, message: 'Pull request successfully merged' } };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function handleRest(ctx: Ctx, method: string, url: URL, body: unknown): RouteResult {
  const q = parseQuery(url);
  const path = url.pathname;
  const segments = path.split('/').filter((s) => s !== '');
  // segments[0..1] === 'api', 'v3'
  const rest = segments.slice(2);
  const b = (body ?? {}) as Record<string, unknown>;

  // GET /api/v3/
  if (rest.length === 0) {
    if (method !== 'GET') return err(404, 'Not Found');
    return json(200, {
      current_user_url: '/api/v3/user',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      meta: {},
    }, { 'X-OAuth-Scopes': 'repo, read:org' });
  }

  // GET /api/v3/meta
  if (rest.length === 1 && rest[0] === 'meta') {
    if (method !== 'GET') return err(404, 'Not Found');
    return json(200, { installed_version: '1.0.0', verifiable_password_authentication: true });
  }

  // GET /api/v3/user ; POST /api/v3/user/repos ; GET /api/v3/user/repos
  if (rest[0] === 'user') {
    if (rest.length === 1 && method === 'GET') {
      return json(200, {
        login: VIEWER_LOGIN,
        id: VIEWER_ID,
        name: VIEWER_NAME,
        email: VIEWER_EMAIL,
        type: 'User',
        html_url: `https://github.com/${VIEWER_LOGIN}`,
      });
    }
    if (rest.length === 2 && rest[1] === 'repos') {
      if (method === 'GET') {
        const repos = [...ctx.store.repos.values()].sort((a, c) => a.createdSeq - c.createdSeq);
        const items = repos.map((r) => repoJson(ctx.store, r));
        return paginate(ctx, url, items, q);
      }
      if (method === 'POST') {
        const name = typeof b.name === 'string' ? b.name : '';
        if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) return err(422, 'Invalid repository name');
        if (ctx.store.getRepo(name)) return err(422, 'Repository already exists');
        const repo = ctx.store.createRepo(
          name,
          typeof b.description === 'string' ? b.description : '',
          b.private === true,
        );
        return json(201, repoJson(ctx.store, repo));
      }
    }
    return err(404, 'Not Found');
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (rest[0] === 'repos' && rest.length >= 3) {
    const owner = decodeURIComponentSafe(rest[1]);
    const name = decodeURIComponentSafe(rest[2]);
    const tail = rest.slice(3);
    const repoOrErr = getRepoOr404(ctx, owner, name);
    if (!isRepo(repoOrErr)) return repoOrErr;
    const repo = repoOrErr;

    // GET/PATCH/DELETE /repos/{owner}/{repo}
    if (tail.length === 0) {
      if (method === 'GET') return json(200, repoJson(ctx.store, repo));
      if (method === 'PATCH') {
        if (typeof b.description === 'string') repo.description = b.description;
        if (typeof b.private === 'boolean') repo.isPrivate = b.private;
        return json(200, repoJson(ctx.store, repo));
      }
      if (method === 'DELETE') {
        ctx.store.repos.delete(repo.name);
        return { status: 204 };
      }
      return err(404, 'Not Found');
    }

    // branches
    if (tail[0] === 'branches') {
      if (method === 'GET' && tail.length === 1) {
        const names = [...repo.refs.keys()].filter((r) => r.startsWith('refs/heads/')).sort();
        return json(200, names.map((r) => ({
          name: r.slice('refs/heads/'.length),
          commit: { sha: repo.refs.get(r) },
          protected: false,
        })));
      }
      if (method === 'GET' && tail.length === 2) {
        const branch = decodeURIComponentSafe(tail[1]);
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (!sha) return err(404, 'Not Found');
        return json(200, { name: branch, commit: { sha }, protected: false });
      }
      return err(404, 'Not Found');
    }

    // commits
    if (tail[0] === 'commits' && tail.length === 1 && method === 'GET') {
      const tip = resolveRef(ctx.store, repo, q.sha);
      if (!tip) return err(404, 'Not Found');
      const chain = ctx.store.commitChain(tip);
      const items = chain.map((oid) => commitJson(ctx.store, oid)).filter((c) => c !== null);
      return paginate(ctx, url, items, q);
    }

    // git/refs
    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (method === 'POST' && tail.length === 2) {
        const ref = typeof b.ref === 'string' ? b.ref : '';
        const sha = typeof b.sha === 'string' ? b.sha : '';
        if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) return err(422, 'Invalid ref');
        const obj = ctx.store.getObject(sha);
        if (!obj || obj.type !== 'commit') return err(422, 'Object does not exist');
        if (repo.refs.has(ref)) return err(422, 'Reference already exists');
        repo.refs.set(ref, sha);
        return json(201, { ref, object: { sha, type: 'commit' } });
      }
      if (method === 'GET' && tail.length === 4 && tail[2] === 'heads') {
        const branch = decodeURIComponentSafe(tail[3]);
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (!sha) return err(404, 'Not Found');
        return json(200, { ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } });
      }
      return err(404, 'Not Found');
    }

    // contents
    if (tail[0] === 'contents') {
      const contentPath = tail.slice(1).map(decodeURIComponentSafe).join('/');
      if (method === 'GET') return contentsGet(ctx, repo, contentPath, q.ref);
      if (method === 'PUT') return contentsPut(ctx, repo, contentPath, b);
      if (method === 'DELETE') return contentsDelete(ctx, repo, contentPath, b);
      return err(404, 'Not Found');
    }

    // labels
    if (tail[0] === 'labels') {
      if (method === 'GET' && tail.length === 1) {
        return json(200, [...repo.labels.values()]);
      }
      if (method === 'POST' && tail.length === 1) {
        const name = typeof b.name === 'string' ? b.name : '';
        if (!name) return err(422, 'Label name is required');
        const color = typeof b.color === 'string' ? b.color.replace(/^#/, '') : 'ededed';
        const label: Label = {
          name,
          color,
          description: typeof b.description === 'string' ? b.description : '',
        };
        repo.labels.set(name, label);
        return json(201, label);
      }
      return err(404, 'Not Found');
    }

    // issues
    if (tail[0] === 'issues') {
      if (tail.length === 1) {
        if (method === 'GET') {
          const state = q.state ?? 'open';
          let items = repo.issues.filter((i) => state === 'all' || i.state === state);
          const dir = (q.direction ?? 'desc') === 'asc' ? 1 : -1;
          items = [...items].sort((a, c) => (a.createdSeq - c.createdSeq) * dir || (a.number - c.number) * dir);
          return paginate(ctx, url, items.map((i) => issueJson(ctx.store, repo, i)), q);
        }
        if (method === 'POST') {
          const title = typeof b.title === 'string' ? b.title : '';
          if (!title) return err(422, 'Title is required');
          const labels: string[] = [];
          if (Array.isArray(b.labels)) {
            for (const l of b.labels) {
              const name = typeof l === 'string' ? l : (l as Record<string, unknown>)?.name;
              if (typeof name !== 'string') continue;
              if (!repo.labels.has(name)) return err(422, `Label does not exist: ${name}`);
              labels.push(name);
            }
          }
          const issue: Issue = {
            id: ctx.store.nextIssueId++,
            number: repo.nextIssue++,
            title,
            body: typeof b.body === 'string' ? b.body : '',
            state: 'open',
            labels,
            createdSeq: ctx.store.nextSeq(),
            closedAt: null,
          };
          repo.issues.push(issue);
          return json(201, issueJson(ctx.store, repo, issue));
        }
        return err(404, 'Not Found');
      }
      const num = parseInt(tail[1], 10);
      const issue = repo.issues.find((i) => i.number === num);
      if (tail.length === 2) {
        if (!issue) return err(404, 'Not Found');
        if (method === 'GET') return json(200, issueJson(ctx.store, repo, issue));
        if (method === 'PATCH') {
          if (b.state === 'open' || b.state === 'closed') {
            issue.state = b.state;
            issue.closedAt = b.state === 'closed' ? ctx.store.now.iso : null;
          }
          if (typeof b.title === 'string') issue.title = b.title;
          if (typeof b.body === 'string') issue.body = b.body;
          return json(200, issueJson(ctx.store, repo, issue));
        }
        return err(404, 'Not Found');
      }
      if (tail.length === 3 && tail[2] === 'comments') {
        if (!issue) return err(404, 'Not Found');
        if (method === 'GET') {
          const list = (repo.comments.get(num) ?? []).map((c) => ({
            id: c.id,
            body: c.body,
            user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
            created_at: ctx.store.now.iso,
            updated_at: ctx.store.now.iso,
          }));
          return json(200, list);
        }
        if (method === 'POST') {
          const bodyText = typeof b.body === 'string' ? b.body : '';
          const comment = { id: ctx.store.nextCommentId++, body: bodyText, createdSeq: ctx.store.nextSeq() };
          const list = repo.comments.get(num) ?? [];
          list.push(comment);
          repo.comments.set(num, list);
          return json(201, {
            id: comment.id,
            body: comment.body,
            user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
            created_at: ctx.store.now.iso,
            updated_at: ctx.store.now.iso,
          });
        }
        return err(404, 'Not Found');
      }
      return err(404, 'Not Found');
    }

    // pulls
    if (tail[0] === 'pulls') {
      if (tail.length === 1) {
        if (method === 'GET') {
          const state = q.state ?? 'open';
          const items = repo.pulls.filter((p) => state === 'all' || p.state === state);
          return paginate(ctx, url, items.map((p) => pullJson(ctx.store, repo, p)), q);
        }
        if (method === 'POST') {
          const title = typeof b.title === 'string' ? b.title : '';
          const headRaw = typeof b.head === 'string' ? b.head : '';
          const baseRaw = typeof b.base === 'string' ? b.base : '';
          if (!title || !headRaw || !baseRaw) return err(422, 'title, head and base are required');
          const head = headRaw.includes(':') ? headRaw.split(':').pop()! : headRaw;
          const base = baseRaw.includes(':') ? baseRaw.split(':').pop()! : baseRaw;
          const headSha = repo.refs.get(`refs/heads/${head}`);
          const baseSha = repo.refs.get(`refs/heads/${base}`);
          if (!headSha || !baseSha) return err(422, 'Head or base branch does not exist');
          const dupe = repo.pulls.find((p) => p.state === 'open' && p.head === head && p.base === base);
          if (dupe) return err(422, 'A pull request already exists for this head and base');
          const pull: Pull = {
            id: ctx.store.nextPullId++,
            number: repo.nextPull++,
            title,
            body: typeof b.body === 'string' ? b.body : '',
            state: 'open',
            merged: false,
            mergedAt: null,
            mergeCommitSha: null,
            head,
            base,
            headSha,
            baseSha,
            createdSeq: ctx.store.nextSeq(),
          };
          repo.pulls.push(pull);
          return json(201, pullJson(ctx.store, repo, pull));
        }
        return err(404, 'Not Found');
      }
      const num = parseInt(tail[1], 10);
      const pull = repo.pulls.find((p) => p.number === num);
      if (tail.length === 2) {
        if (!pull) return err(404, 'Not Found');
        if (method === 'GET') return json(200, pullJson(ctx.store, repo, pull));
        return err(404, 'Not Found');
      }
      if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
        if (!pull) return err(404, 'Not Found');
        const headTip = ctx.store.refTip(repo, `refs/heads/${pull.head}`) ?? pull.headSha;
        const baseTip = ctx.store.refTip(repo, `refs/heads/${pull.base}`) ?? pull.baseSha;
        const mergeBase = ctx.store.mergeBase(headTip, baseTip) ?? pull.baseSha;
        const files = diffTrees(
          ctx.store,
          ctx.store.flattenTree(mergeBase),
          ctx.store.flattenTree(headTip),
        );
        return json(200, files);
      }
      if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
        if (!pull) return err(404, 'Not Found');
        if (pull.state !== 'open') return err(405, 'Pull request is already closed');
        const r = mergePull(ctx, repo, pull);
        return json(r.status, r.body);
      }
      return err(404, 'Not Found');
    }

    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
