// store.ts — in-memory data model for the forge.
// Written fresh in this session. All state lives in memory; nothing is
// persisted across trials. Timestamps come from MAKEFUN_TRIAL_NOW, never
// from the wall clock, so a replay is byte-identical.
import { createHash } from 'node:crypto';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const ZERO_OID = '0000000000000000000000000000000000000000';

export function trialNow(): { epoch: number; iso: string } {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  let epoch = 1735689600; // 2025-01-01T00:00:00Z fallback
  if (raw) {
    const t = Date.parse(raw);
    if (Number.isFinite(t)) epoch = Math.floor(t / 1000);
  }
  return { epoch, iso: new Date(epoch * 1000).toISOString() };
}

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export function hashObject(type: ObjType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(head).update(data).digest('hex');
}

export function identLine(name: string, email: string, epoch: number): string {
  return `${name} <${email}> ${epoch} +0000`;
}

// ---------------------------------------------------------------------------
// Commits / trees / tags
// ---------------------------------------------------------------------------

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd === -1 ? text : text.slice(0, headEnd);
  const message = headEnd === -1 ? '' : text.slice(headEnd + 2);
  const out: ParsedCommit = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) out.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) out.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) out.author = line.slice(7);
    else if (line.startsWith('committer ')) out.committer = line.slice(10);
  }
  return out;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    const nul = data.indexOf(0x00, sp);
    const mode = data.subarray(i, sp).toString('ascii');
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    i = nul + 21;
  }
  return entries;
}

export interface ParsedTag {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): ParsedTag {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd === -1 ? text : text.slice(0, headEnd);
  const message = headEnd === -1 ? '' : text.slice(headEnd + 2);
  const out: ParsedTag = { object: '', type: '', tag: '', tagger: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) out.object = line.slice(7).trim();
    else if (line.startsWith('type ')) out.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) out.tag = line.slice(4);
    else if (line.startsWith('tagger ')) out.tagger = line.slice(7);
  }
  return out;
}

// git tree sort: directory names compare as if they had a trailing slash.
export function treeSortKey(mode: string, name: string): string {
  return mode === '40000' ? name + '/' : name;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a.mode, a.name);
    const kb = treeSortKey(b.mode, b.name);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// Build nested trees from a flat path -> {mode, oid} map. Returns root tree oid.
export function buildTreeFromFiles(
  files: Map<string, { mode: string; oid: string }>,
  put: (type: ObjType, data: Buffer) => string,
): string {
  // Group by directory depth.
  const dirs = new Map<string, Map<string, { mode: string; oid: string }>>();
  for (const [path, entry] of files) {
    const slash = path.lastIndexOf('/');
    const dir = slash === -1 ? '' : path.slice(0, slash);
    const name = slash === -1 ? path : path.slice(slash + 1);
    let d = dirs.get(dir);
    if (!d) {
      d = new Map();
      dirs.set(dir, d);
    }
    d.set(name, entry);
  }
  const build = (dir: string): string => {
    const entries: TreeEntry[] = [];
    const direct = dirs.get(dir);
    if (direct) {
      for (const [name, e] of direct) entries.push({ mode: e.mode, name, oid: e.oid });
    }
    // Subdirectories of `dir`.
    const prefix = dir === '' ? '' : dir + '/';
    const subdirs = new Set<string>();
    for (const d of dirs.keys()) {
      if (d.startsWith(prefix)) {
        const rest = d.slice(prefix.length);
        if (rest && !rest.includes('/')) subdirs.add(rest);
      }
    }
    for (const sub of subdirs) {
      const oid = build(prefix + sub);
      entries.push({ mode: '40000', name: sub, oid });
    }
    const data = buildTree(entries);
    return put('tree', data);
  };
  return build('');
}

// ---------------------------------------------------------------------------
// Repos / issues / pulls
// ---------------------------------------------------------------------------

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdSeq: number;
  closedAt: string | null;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  createdSeq: number;
}

export interface Comment {
  id: number;
  body: string;
  createdSeq: number;
}

export interface Repo {
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  dbId: number;
  createdSeq: number;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  nextIssue: number;
  nextPull: number;
  comments: Map<number, Comment[]>;
}

export class Store {
  objects = new Map<string, GitObject>();
  repos = new Map<string, Repo>();
  seq = 0;
  nextDbId = 5000;
  nextIssueId = 100000;
  nextPullId = 200000;
  nextCommentId = 300000;
  readonly now = trialNow();

  nextSeq(): number {
    return ++this.seq;
  }

  putObject(type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  // --- repos ---------------------------------------------------------------
  createRepo(name: string, description: string, isPrivate: boolean): Repo {
    const repo: Repo = {
      name,
      owner: VIEWER_LOGIN,
      description,
      isPrivate,
      defaultBranch: 'main',
      dbId: this.nextDbId++,
      createdSeq: this.nextSeq(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextIssue: 1,
      nextPull: 1,
      comments: new Map(),
    };
    this.repos.set(name, repo);
    return repo;
  }

  getRepo(name: string): Repo | undefined {
    return this.repos.get(name);
  }

  // --- git helpers -----------------------------------------------------------
  refTip(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  headRef(repo: Repo): string {
    return `refs/heads/${repo.defaultBranch}`;
  }

  headTip(repo: Repo): string | undefined {
    return repo.refs.get(this.headRef(repo));
  }

  /** All commit oids reachable from `tip`, newest-first (DFS pre-order). */
  commitChain(tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = this.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      out.push(oid);
      const c = parseCommit(obj.data);
      for (let i = c.parents.length - 1; i >= 0; i--) stack.push(c.parents[i]);
    }
    return out;
  }

  /** Set of object oids reachable from the given commit oids (commits,
   *  their trees/blobs, and peeled tags). */
  reachable(tips: string[]): Set<string> {
    const out = new Set<string>();
    const stack = [...tips];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (out.has(oid)) continue;
      const obj = this.objects.get(oid);
      if (!obj) continue;
      out.add(oid);
      if (obj.type === 'commit') {
        const c = parseCommit(obj.data);
        stack.push(c.tree);
        for (const p of c.parents) stack.push(p);
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) stack.push(e.oid);
      } else if (obj.type === 'tag') {
        stack.push(parseTag(obj.data).object);
      }
    }
    return out;
  }

  isAncestor(ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const stack = [descendant];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = this.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      const c = parseCommit(obj.data);
      for (const p of c.parents) {
        if (p === ancestor) return true;
        stack.push(p);
      }
    }
    return false;
  }

  /** Peel a tag (recursively) to the underlying commit oid, or the oid itself. */
  peelToCommit(oid: string): string {
    let cur = oid;
    for (let i = 0; i < 8; i++) {
      const obj = this.objects.get(cur);
      if (!obj || obj.type !== 'tag') return cur;
      cur = parseTag(obj.data).object;
    }
    return cur;
  }

  /** Flat path -> {mode, oid} map for the tree at a commit oid. */
  flattenTree(commitOid: string): Map<string, { mode: string; oid: string }> {
    const out = new Map<string, { mode: string; oid: string }>();
    const obj = this.objects.get(commitOid);
    if (!obj || obj.type !== 'commit') return out;
    const c = parseCommit(obj.data);
    const walk = (treeOid: string, prefix: string) => {
      const t = this.objects.get(treeOid);
      if (!t || t.type !== 'tree') return;
      for (const e of parseTree(t.data)) {
        const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
        if (e.mode === '40000') walk(e.oid, path);
        else out.set(path, { mode: e.mode, oid: e.oid });
      }
    };
    walk(c.tree, '');
    return out;
  }

  /** Build a commit object, store it, return its oid. */
  makeCommit(opts: {
    tree: string;
    parents: string[];
    message: string;
    authorName?: string;
    authorEmail?: string;
  }): string {
    const name = opts.authorName ?? VIEWER_NAME;
    const email = opts.authorEmail ?? VIEWER_EMAIL;
    const epoch = this.now.epoch;
    const lines = [`tree ${opts.tree}`];
    for (const p of opts.parents) lines.push(`parent ${p}`);
    lines.push(`author ${identLine(name, email, epoch)}`);
    lines.push(`committer ${identLine(name, email, epoch)}`);
    const data = Buffer.from(lines.join('\n') + '\n\n' + opts.message, 'utf8');
    return this.putObject('commit', data);
  }

  /** Find the merge base (first common ancestor) of two commits. */
  mergeBase(a: string, b: string): string | null {
    const aAnc = new Set(this.commitChain(a));
    const chainB = this.commitChain(b);
    for (const oid of chainB) {
      if (aAnc.has(oid)) return oid;
    }
    return null;
  }
}
