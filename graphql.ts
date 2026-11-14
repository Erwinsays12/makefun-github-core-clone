// graphql.ts — a small GraphQL executor for exactly the documents the
// suite sends (queries, mutations, batching, aliases, inline fragments,
// __type introspection). Written fresh in this session; not a general
// GraphQL implementation.
import { Store, VIEWER_LOGIN, VIEWER_ID, VIEWER_NAME } from './store.ts';
import type { Repo, Issue, Pull } from './store.ts';
import { mergePull, diffTrees } from './rest.ts';
import { gqid as restGqid } from './rest.ts';

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

type TokKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';
interface Tok {
  kind: TokKind;
  value: string;
}

function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i++;
      continue;
    }
    if (ch === '#') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '.' && src.slice(i, i + 3) === '...') {
      toks.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(ch)) {
      toks.push({ kind: 'punct', value: ch });
      i++;
      continue;
    }
    if (ch === '"') {
      if (src.slice(i, i + 3) === '"""') {
        const end = src.indexOf('"""', i + 3);
        const v = end === -1 ? src.slice(i + 3) : src.slice(i + 3, end);
        toks.push({ kind: 'string', value: v });
        i = end === -1 ? n : end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < n && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < n) {
          const e = src[j + 1];
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/' };
          out += map[e] ?? e;
          j += 2;
        } else {
          out += src[j];
          j++;
        }
      }
      toks.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (src[j] === '-') j++;
      while (j < n && /[0-9]/.test(src[j])) j++;
      let isFloat = false;
      if (src[j] === '.') {
        isFloat = true;
        j++;
        while (j < n && /[0-9]/.test(src[j])) j++;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true;
        j++;
        if (src[j] === '+' || src[j] === '-') j++;
        while (j < n && /[0-9]/.test(src[j])) j++;
      }
      toks.push({ kind: isFloat ? 'float' : 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
      toks.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  toks.push({ kind: 'eof', value: '' });
  return toks;
}

// ---------------------------------------------------------------------------
// AST + parser
// ---------------------------------------------------------------------------

export type ValueNode =
  | { kind: 'var'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

export interface FieldNode {
  kind: 'field';
  alias?: string;
  name: string;
  args: { name: string; value: ValueNode }[];
  selection?: SelectionNode[];
}

export interface FragmentSpreadNode {
  kind: 'spread';
  name: string;
}

export interface InlineFragmentNode {
  kind: 'inline';
  typeCondition?: string;
  selection: SelectionNode[];
}

export type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

export interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation';
  name?: string;
  variables: { name: string; type: string; default?: ValueNode }[];
  selection: SelectionNode[];
}

export interface FragmentNode {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selection: SelectionNode[];
}

export type DefinitionNode = OperationNode | FragmentNode;

class Parser {
  private pos = 0;
  private toks: Tok[];
  constructor(toks: Tok[]) {
    this.toks = toks;
  }

  peek(): Tok {
    return this.toks[this.pos];
  }
  next(): Tok {
    return this.toks[this.pos++];
  }
  expectPunct(v: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== v) throw new Error(`expected '${v}' got '${t.value}'`);
  }
  expectName(v?: string): string {
    const t = this.next();
    if (t.kind !== 'name' || (v !== undefined && t.value !== v)) {
      throw new Error(`expected name${v ? ` '${v}'` : ''} got '${t.value}'`);
    }
    return t.value;
  }

  parseDocument(): DefinitionNode[] {
    const defs: DefinitionNode[] = [];
    while (this.peek().kind !== 'eof') defs.push(this.parseDefinition());
    return defs;
  }

  parseDefinition(): DefinitionNode {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === '{') {
      return { kind: 'operation', operation: 'query', variables: [], selection: this.parseSelectionSet() };
    }
    if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
      const operation = this.next().value as 'query' | 'mutation';
      let name: string | undefined;
      if (this.peek().kind === 'name') name = this.next().value;
      let variables: OperationNode['variables'] = [];
      if (this.peek().kind === 'punct' && this.peek().value === '(') {
        variables = this.parseVariableDefinitions();
      }
      // directives (none used by the suite): skip @name(args)
      while (this.peek().kind === 'punct' && this.peek().value === '@') {
        this.next();
        this.expectName();
        if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
      }
      return { kind: 'operation', operation, name, variables, selection: this.parseSelectionSet() };
    }
    if (t.kind === 'name' && t.value === 'fragment') {
      this.next();
      const name = this.expectName();
      this.expectName('on');
      const typeCondition = this.expectName();
      return { kind: 'fragment', name, typeCondition, selection: this.parseSelectionSet() };
    }
    throw new Error(`unexpected token '${t.value}' in GraphQL document`);
  }

  parseVariableDefinitions(): OperationNode['variables'] {
    const out: OperationNode['variables'] = [];
    this.expectPunct('(');
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      let type = '';
      if (this.peek().kind === 'punct' && this.peek().value === '[') {
        this.next();
        type = '[' + this.parseTypeName() + ']';
        this.expectPunct(']');
      } else {
        type = this.parseTypeName();
      }
      if (this.peek().kind === 'punct' && this.peek().value === '!') {
        this.next();
        type += '!';
      }
      let def: ValueNode | undefined;
      if (this.peek().kind === 'punct' && this.peek().value === '=') {
        this.next();
        def = this.parseValue();
      }
      out.push({ name, type, default: def });
    }
    this.expectPunct(')');
    return out;
  }

  parseTypeName(): string {
    let t = this.expectName();
    while (this.peek().kind === 'punct' && this.peek().value === '!') {
      this.next();
      t += '!';
    }
    return t;
  }

  parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const out: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      out.push(this.parseSelection());
    }
    this.expectPunct('}');
    return out;
  }

  parseSelection(): SelectionNode {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === '...') {
      this.next();
      const n = this.peek();
      if (n.kind === 'name' && n.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'inline', typeCondition, selection: this.parseSelectionSet() };
      }
      if (n.kind === 'name') {
        return { kind: 'spread', name: this.next().value };
      }
      return { kind: 'inline', selection: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | undefined;
    let name = first;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    let args: FieldNode['args'] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      args = this.parseArguments();
    }
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
    let selection: SelectionNode[] | undefined;
    if (this.peek().kind === 'punct' && this.peek().value === '{') {
      selection = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selection };
  }

  parseArguments(): FieldNode['args'] {
    const out: FieldNode['args'] = [];
    this.expectPunct('(');
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      out.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return out;
  }

  parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') return { kind: 'var', name: this.expectName() };
    if (t.kind === 'punct' && t.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (t.kind === 'int') return { kind: 'int', value: parseInt(t.value, 10) };
    if (t.kind === 'float') return { kind: 'float', value: parseFloat(t.value) };
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    throw new Error(`unexpected value token '${t.value}'`);
  }
}

// ---------------------------------------------------------------------------
// Schema (field sets used for validation + introspection)
// ---------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url', 'createdAt', 'isPrivate'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'author', 'labels', 'comments'],
  PullRequest: ['id', 'number', 'title', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'body', 'url', 'createdAt', 'author'],
  User: ['login', 'id', 'name', 'email'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount', 'edges'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount', 'edges'],
  IssueCommentConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  Ref: ['name', 'target'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'],
  IssueCommentEdge: ['node', 'cursor'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  PullRequestFile: ['path', 'additions', 'deletions', 'changeType'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'type', 'description', 'args'],
  __EnumValue: ['name', 'description'],
  __InputValue: ['name', 'type', 'description'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  Node: ['id'],
};

const TYPE_KIND: Record<string, string> = {
  Issue: 'OBJECT',
  PullRequest: 'OBJECT',
  Repository: 'OBJECT',
  SearchType: 'ENUM',
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'MILESTONE', 'PROJECT', 'WIKI'];

// ---------------------------------------------------------------------------
// Runtime values
// ---------------------------------------------------------------------------

type GqlObj =
  | { __typename: 'Query' }
  | { __typename: 'Mutation' }
  | { __typename: 'Repository'; repo: Repo }
  | { __typename: 'Issue'; repo: Repo; issue: Issue }
  | { __typename: 'PullRequest'; repo: Repo; pull: Pull }
  | { __typename: 'User'; login: string }
  | { __typename: 'Ref'; name: string }
  | { __typename: 'PageInfo'; hasNextPage: boolean; hasPreviousPage: boolean; endCursor: string | null; startCursor: string | null }
  | { __typename: 'IssueConnection'; nodes: GqlObj[]; pageInfo: GqlObj }
  | { __typename: 'PullRequestConnection'; nodes: GqlObj[]; pageInfo: GqlObj }
  | { __typename: 'IssueCommentConnection'; nodes: GqlObj[]; pageInfo: GqlObj }
  | { __typename: 'PullRequestFileConnection'; nodes: GqlObj[]; pageInfo: GqlObj }
  | { __typename: 'PullRequestFile'; path: string }
  | { __typename: 'IssueComment'; id: number; body: string }
  | { __typename: 'IssueCommentEdge'; node: GqlObj; cursor: string }
  | { __typename: '__Type'; name: string; kind: string }
  | { __typename: '__Field'; name: string }
  | { __typename: '__EnumValue'; name: string }
  | { __typename: 'CreateIssuePayload'; issue: GqlObj }
  | { __typename: 'CloseIssuePayload'; issue: GqlObj }
  | { __typename: 'CreatePullRequestPayload'; pullRequest: GqlObj }
  | { __typename: 'MergePullRequestPayload'; pullRequest: GqlObj }
  | { __typename: 'AddCommentPayload'; commentEdge: GqlObj };

function evalValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'var': {
      const v = variables[node.name];
      return v === undefined ? null : v;
    }
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => evalValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = evalValue(f.value, variables);
      return out;
    }
  }
}

function argsMap(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of field.args) out[a.name] = evalValue(a.value, variables);
  return out;
}

function pageInfoFor(total: number, start: number, count: number): GqlObj {
  const endCursor = count > 0 ? Buffer.from(`cursor:${start + count - 1}`).toString('base64') : null;
  const startCursor = count > 0 ? Buffer.from(`cursor:${start}`).toString('base64') : null;
  return {
    __typename: 'PageInfo',
    hasNextPage: start + count < total,
    hasPreviousPage: start > 0,
    endCursor,
    startCursor,
  };
}

function decodeCursor(after: unknown): number {
  if (typeof after !== 'string') return 0;
  try {
    const s = Buffer.from(after, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(s);
    if (m) return parseInt(m[1], 10) + 1;
  } catch {
    return 0;
  }
  return 0;
}

function decodeGlobalId(id: unknown): { kind: string; key: string } | null {
  if (typeof id !== 'string') return null;
  try {
    const s = Buffer.from(id, 'base64').toString('utf8');
    const m = /^(R|I|PR|C):(.+)$/.exec(s);
    if (!m) return null;
    return { kind: m[1], key: m[2] };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Field resolution
// ---------------------------------------------------------------------------

function prMergeable(store: Store, repo: Repo, pull: Pull): string {
  if (pull.state !== 'open') return 'UNKNOWN';
  const baseTip = store.refTip(repo, `refs/heads/${pull.base}`);
  const headTip = store.refTip(repo, `refs/heads/${pull.head}`) ?? pull.headSha;
  if (!baseTip || !headTip) return 'UNKNOWN';
  const mergeBase = store.mergeBase(headTip, baseTip);
  if (!mergeBase) return 'CONFLICTING';
  const baseMap = store.flattenTree(mergeBase);
  const headMap = store.flattenTree(headTip);
  const tipMap = store.flattenTree(baseTip);
  const changed = diffTrees(store, baseMap, headMap);
  for (const c of changed) {
    const baseEntry = baseMap.get(c.filename);
    const headEntry = headMap.get(c.filename);
    const tipEntry = tipMap.get(c.filename);
    const tipChanged = (tipEntry?.oid ?? null) !== (baseEntry?.oid ?? null);
    if (tipChanged && (tipEntry?.oid ?? null) !== (headEntry?.oid ?? null)) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

function resolveField(
  store: Store,
  obj: GqlObj,
  field: FieldNode,
  variables: Record<string, unknown>,
): { value: unknown; typeName: string } {
  const args = argsMap(field, variables);
  switch (obj.__typename) {
    case 'Query': {
      if (field.name === 'viewer') return { value: { __typename: 'User', login: VIEWER_LOGIN } as GqlObj, typeName: 'User' };
      if (field.name === 'repository') {
        const owner = args.owner as string;
        const name = args.name as string;
        if (owner !== VIEWER_LOGIN) return { value: null, typeName: 'Repository' };
        const repo = store.getRepo(name);
        return { value: repo ? ({ __typename: 'Repository', repo } as GqlObj) : null, typeName: 'Repository' };
      }
      if (field.name === 'node') {
        const decoded = decodeGlobalId(args.id);
        if (!decoded) return { value: null, typeName: 'Node' };
        if (decoded.kind === 'R') {
          const repo = [...store.repos.values()].find((r) => r.dbId === Number(decoded.key));
          return { value: repo ? ({ __typename: 'Repository', repo } as GqlObj) : null, typeName: 'Repository' };
        }
        if (decoded.kind === 'I') {
          const [dbId, num] = decoded.key.split(':');
          const repo = [...store.repos.values()].find((r) => r.dbId === Number(dbId));
          const issue = repo?.issues.find((i) => i.number === Number(num));
          return { value: issue && repo ? ({ __typename: 'Issue', repo, issue } as GqlObj) : null, typeName: 'Issue' };
        }
        if (decoded.kind === 'PR') {
          const [dbId, num] = decoded.key.split(':');
          const repo = [...store.repos.values()].find((r) => r.dbId === Number(dbId));
          const pull = repo?.pulls.find((p) => p.number === Number(num));
          return { value: pull && repo ? ({ __typename: 'PullRequest', repo, pull } as GqlObj) : null, typeName: 'PullRequest' };
        }
        return { value: null, typeName: 'Node' };
      }
      if (field.name === '__type') {
        const name = args.name as string;
        return { value: { __typename: '__Type', name, kind: TYPE_KIND[name] ?? 'OBJECT' } as GqlObj, typeName: '__Type' };
      }
      if (field.name === '__schema') return { value: null, typeName: '__Schema' };
      break;
    }
    case 'Mutation': {
      const input = (args.input ?? {}) as Record<string, unknown>;
      if (field.name === 'createIssue') {
        const decoded = decodeGlobalId(input.repositoryId);
        const repo = decoded?.kind === 'R' ? [...store.repos.values()].find((r) => r.dbId === Number(decoded.key)) : undefined;
        if (!repo) return { value: { __typename: 'CreateIssuePayload', issue: null } as unknown as GqlObj, typeName: 'CreateIssuePayload' };
        const issue: Issue = {
          id: store.nextIssueId++,
          number: repo.nextIssue++,
          title: String(input.title ?? ''),
          body: typeof input.body === 'string' ? input.body : '',
          state: 'open',
          labels: [],
          createdSeq: store.nextSeq(),
          closedAt: null,
        };
        repo.issues.push(issue);
        return { value: { __typename: 'CreateIssuePayload', issue: { __typename: 'Issue', repo, issue } as GqlObj } as GqlObj, typeName: 'CreateIssuePayload' };
      }
      if (field.name === 'closeIssue') {
        const decoded = decodeGlobalId(input.issueId);
        let found: GqlObj | null = null;
        if (decoded?.kind === 'I') {
          const [dbId, num] = decoded.key.split(':');
          const repo = [...store.repos.values()].find((r) => r.dbId === Number(dbId));
          const issue = repo?.issues.find((i) => i.number === Number(num));
          if (issue && repo) {
            issue.state = 'closed';
            issue.closedAt = store.now.iso;
            found = { __typename: 'Issue', repo, issue } as GqlObj;
          }
        }
        return { value: { __typename: 'CloseIssuePayload', issue: found } as unknown as GqlObj, typeName: 'CloseIssuePayload' };
      }
      if (field.name === 'createPullRequest') {
        const decoded = decodeGlobalId(input.repositoryId);
        const repo = decoded?.kind === 'R' ? [...store.repos.values()].find((r) => r.dbId === Number(decoded.key)) : undefined;
        if (!repo) return { value: { __typename: 'CreatePullRequestPayload', pullRequest: null } as unknown as GqlObj, typeName: 'CreatePullRequestPayload' };
        const head = String(input.headRefName ?? '');
        const base = String(input.baseRefName ?? '');
        const headSha = repo.refs.get(`refs/heads/${head}`);
        const baseSha = repo.refs.get(`refs/heads/${base}`);
        let pull: Pull | undefined = repo.pulls.find((p) => p.state === 'open' && p.head === head && p.base === base);
        if (!pull && headSha && baseSha) {
          pull = {
            id: store.nextPullId++,
            number: repo.nextPull++,
            title: String(input.title ?? ''),
            body: typeof input.body === 'string' ? input.body : '',
            state: 'open',
            merged: false,
            mergedAt: null,
            mergeCommitSha: null,
            head,
            base,
            headSha,
            baseSha,
            createdSeq: store.nextSeq(),
          };
          repo.pulls.push(pull);
        }
        return { value: { __typename: 'CreatePullRequestPayload', pullRequest: pull ? ({ __typename: 'PullRequest', repo, pull } as GqlObj) : null } as unknown as GqlObj, typeName: 'CreatePullRequestPayload' };
      }
      if (field.name === 'mergePullRequest') {
        const decoded = decodeGlobalId(input.pullRequestId);
        let found: GqlObj | null = null;
        if (decoded?.kind === 'PR') {
          const [dbId, num] = decoded.key.split(':');
          const repo = [...store.repos.values()].find((r) => r.dbId === Number(dbId));
          const pull = repo?.pulls.find((p) => p.number === Number(num));
          if (pull && repo && pull.state === 'open') {
            const ctx = { store, reqId: '', origin: '' };
            mergePull(ctx, repo, pull);
            found = { __typename: 'PullRequest', repo, pull } as GqlObj;
          } else if (pull && repo) {
            found = { __typename: 'PullRequest', repo, pull } as GqlObj;
          }
        }
        return { value: { __typename: 'MergePullRequestPayload', pullRequest: found } as unknown as GqlObj, typeName: 'MergePullRequestPayload' };
      }
      if (field.name === 'addComment') {
        const decoded = decodeGlobalId(input.subjectId);
        let edge: GqlObj | null = null;
        if (decoded?.kind === 'I') {
          const [dbId, num] = decoded.key.split(':');
          const repo = [...store.repos.values()].find((r) => r.dbId === Number(dbId));
          const issue = repo?.issues.find((i) => i.number === Number(num));
          if (issue && repo) {
            const comment = { id: store.nextCommentId++, body: String(input.body ?? ''), createdSeq: store.nextSeq() };
            const list = repo.comments.get(issue.number) ?? [];
            list.push(comment);
            repo.comments.set(issue.number, list);
            const node: GqlObj = { __typename: 'IssueComment', id: comment.id, body: comment.body };
            edge = { __typename: 'IssueCommentEdge', node, cursor: Buffer.from(`cursor:${comment.id}`).toString('base64') };
          }
        }
        return { value: { __typename: 'AddCommentPayload', commentEdge: edge } as unknown as GqlObj, typeName: 'AddCommentPayload' };
      }
      break;
    }
    case 'Repository': {
      const repo = obj.repo;
      switch (field.name) {
        case 'id': return { value: restGqid('R', String(repo.dbId)), typeName: 'ID' };
        case 'databaseId': return { value: repo.dbId, typeName: 'Int' };
        case 'name': return { value: repo.name, typeName: 'String' };
        case 'nameWithOwner': return { value: `${repo.owner}/${repo.name}`, typeName: 'String' };
        case 'owner': return { value: { __typename: 'User', login: repo.owner } as GqlObj, typeName: 'User' };
        case 'defaultBranchRef': return { value: { __typename: 'Ref', name: repo.defaultBranch } as GqlObj, typeName: 'Ref' };
        case 'viewerPermission': return { value: 'ADMIN', typeName: 'String' };
        case 'hasIssuesEnabled': return { value: true, typeName: 'Boolean' };
        case 'description': return { value: repo.description || null, typeName: 'String' };
        case 'url': return { value: `https://github.com/${repo.owner}/${repo.name}`, typeName: 'String' };
        case 'createdAt': return { value: store.now.iso, typeName: 'String' };
        case 'isPrivate': return { value: repo.isPrivate, typeName: 'Boolean' };
        case 'issue': {
          const issue = repo.issues.find((i) => i.number === Number(args.number));
          return { value: issue ? ({ __typename: 'Issue', repo, issue } as GqlObj) : null, typeName: 'Issue' };
        }
        case 'issues': {
          let items = [...repo.issues];
          const states = args.states as string[] | undefined;
          if (states && states.length > 0) {
            const want = new Set(states.map((s) => s.toLowerCase()));
            items = items.filter((i) => want.has(i.state));
          }
          const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
          const fieldName = String(orderBy.field ?? 'CREATED_AT');
          const direction = String(orderBy.direction ?? 'DESC');
          if (fieldName === 'CREATED_AT') {
            items.sort((a, b) => (direction === 'ASC' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
          }
          const start = decodeCursor(args.after);
          const first = typeof args.first === 'number' ? args.first : 30;
          const slice = items.slice(start, start + first);
          const nodes = slice.map((issue) => ({ __typename: 'Issue', repo, issue } as GqlObj));
          return {
            value: { __typename: 'IssueConnection', nodes, pageInfo: pageInfoFor(items.length, start, slice.length) } as GqlObj,
            typeName: 'IssueConnection',
          };
        }
        case 'pullRequests': {
          const items = [...repo.pulls].sort((a, b) => b.createdSeq - a.createdSeq);
          const start = decodeCursor(args.after);
          const first = typeof args.first === 'number' ? args.first : 30;
          const slice = items.slice(start, start + first);
          const nodes = slice.map((pull) => ({ __typename: 'PullRequest', repo, pull } as GqlObj));
          return {
            value: { __typename: 'PullRequestConnection', nodes, pageInfo: pageInfoFor(items.length, start, slice.length) } as GqlObj,
            typeName: 'PullRequestConnection',
          };
        }
        case 'pullRequest': {
          const pull = repo.pulls.find((p) => p.number === Number(args.number));
          return { value: pull ? ({ __typename: 'PullRequest', repo, pull } as GqlObj) : null, typeName: 'PullRequest' };
        }
      }
      break;
    }
    case 'Issue': {
      const issue = obj.issue;
      switch (field.name) {
        case 'id': return { value: restGqid('I', `${obj.repo.dbId}:${issue.number}`), typeName: 'ID' };
        case 'number': return { value: issue.number, typeName: 'Int' };
        case 'title': return { value: issue.title, typeName: 'String' };
        case 'state': return { value: issue.state.toUpperCase(), typeName: 'String' };
        case 'body': return { value: issue.body, typeName: 'String' };
        case 'url': return { value: `https://github.com/${obj.repo.owner}/${obj.repo.name}/issues/${issue.number}`, typeName: 'String' };
        case 'createdAt': return { value: store.now.iso, typeName: 'String' };
        case 'author': return { value: { __typename: 'User', login: VIEWER_LOGIN } as GqlObj, typeName: 'User' };
        case 'labels': return { value: issue.labels.map((name) => ({ __typename: 'Label', name }) as unknown as GqlObj), typeName: 'LabelConnection' };
        case 'comments': {
          const list = obj.repo.comments.get(issue.number) ?? [];
          const nodes = list.map((c) => ({ __typename: 'IssueComment', id: c.id, body: c.body } as GqlObj));
          return {
            value: { __typename: 'IssueCommentConnection', nodes, pageInfo: pageInfoFor(list.length, 0, list.length) } as GqlObj,
            typeName: 'IssueCommentConnection',
          };
        }
      }
      break;
    }
    case 'PullRequest': {
      const pull = obj.pull;
      switch (field.name) {
        case 'id': return { value: restGqid('PR', `${obj.repo.dbId}:${pull.number}`), typeName: 'ID' };
        case 'number': return { value: pull.number, typeName: 'Int' };
        case 'title': return { value: pull.title, typeName: 'String' };
        case 'state': return { value: pull.merged ? 'MERGED' : pull.state.toUpperCase(), typeName: 'String' };
        case 'merged': return { value: pull.merged, typeName: 'Boolean' };
        case 'headRefName': return { value: pull.head, typeName: 'String' };
        case 'baseRefName': return { value: pull.base, typeName: 'String' };
        case 'mergeable': return { value: prMergeable(store, obj.repo, pull), typeName: 'String' };
        case 'body': return { value: pull.body, typeName: 'String' };
        case 'url': return { value: `https://github.com/${obj.repo.owner}/${obj.repo.name}/pull/${pull.number}`, typeName: 'String' };
        case 'createdAt': return { value: store.now.iso, typeName: 'String' };
        case 'author': return { value: { __typename: 'User', login: VIEWER_LOGIN } as GqlObj, typeName: 'User' };
        case 'files': {
          const headTip = store.refTip(obj.repo, `refs/heads/${pull.head}`) ?? pull.headSha;
          const baseTip = store.refTip(obj.repo, `refs/heads/${pull.base}`) ?? pull.baseSha;
          const mergeBase = store.mergeBase(headTip, baseTip) ?? pull.baseSha;
          const files = diffTrees(store, store.flattenTree(mergeBase), store.flattenTree(headTip));
          const first = typeof args.first === 'number' ? args.first : 100;
          const slice = files.slice(0, first);
          const nodes = slice.map((f) => ({ __typename: 'PullRequestFile', path: f.filename } as GqlObj));
          return {
            value: { __typename: 'PullRequestFileConnection', nodes, pageInfo: pageInfoFor(files.length, 0, slice.length) } as GqlObj,
            typeName: 'PullRequestFileConnection',
          };
        }
      }
      break;
    }
    case 'User': {
      if (field.name === 'login') return { value: obj.login, typeName: 'String' };
      if (field.name === 'id') return { value: VIEWER_ID, typeName: 'Int' };
      if (field.name === 'name') return { value: VIEWER_NAME, typeName: 'String' };
      if (field.name === 'email') return { value: 'adaiversen@example.invalid', typeName: 'String' };
      break;
    }
    case 'Ref': {
      if (field.name === 'name') return { value: obj.name, typeName: 'String' };
      if (field.name === 'target') return { value: null, typeName: 'Commit' };
      break;
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'IssueCommentConnection':
    case 'PullRequestFileConnection': {
      if (field.name === 'nodes') return { value: obj.nodes, typeName: 'NodeList' };
      if (field.name === 'pageInfo') return { value: obj.pageInfo, typeName: 'PageInfo' };
      if (field.name === 'totalCount') return { value: obj.nodes.length, typeName: 'Int' };
      if (field.name === 'edges') {
        const edges = obj.nodes.map((node, i) => ({ __typename: 'IssueCommentEdge', node, cursor: Buffer.from(`cursor:${i}`).toString('base64') } as GqlObj));
        return { value: edges, typeName: 'EdgeList' };
      }
      break;
    }
    case 'PageInfo': {
      if (field.name === 'hasNextPage') return { value: obj.hasNextPage, typeName: 'Boolean' };
      if (field.name === 'hasPreviousPage') return { value: obj.hasPreviousPage, typeName: 'Boolean' };
      if (field.name === 'endCursor') return { value: obj.endCursor, typeName: 'String' };
      if (field.name === 'startCursor') return { value: obj.startCursor, typeName: 'String' };
      break;
    }
    case 'IssueCommentEdge': {
      if (field.name === 'node') return { value: obj.node, typeName: 'IssueComment' };
      if (field.name === 'cursor') return { value: obj.cursor, typeName: 'String' };
      break;
    }
    case 'IssueComment': {
      if (field.name === 'id') return { value: restGqid('C', String(obj.id)), typeName: 'ID' };
      if (field.name === 'body') return { value: obj.body, typeName: 'String' };
      if (field.name === 'author') return { value: { __typename: 'User', login: VIEWER_LOGIN } as GqlObj, typeName: 'User' };
      if (field.name === 'createdAt') return { value: store.now.iso, typeName: 'String' };
      break;
    }
    case 'PullRequestFile': {
      if (field.name === 'path') return { value: obj.path, typeName: 'String' };
      if (field.name === 'additions') return { value: 1, typeName: 'Int' };
      if (field.name === 'deletions') return { value: 0, typeName: 'Int' };
      if (field.name === 'changeType') return { value: 'ADDED', typeName: 'String' };
      break;
    }
    case '__Type': {
      if (field.name === 'name') return { value: obj.name, typeName: 'String' };
      if (field.name === 'kind') return { value: obj.kind, typeName: 'String' };
      if (field.name === 'description') return { value: null, typeName: 'String' };
      if (field.name === 'fields') {
        if (obj.kind === 'ENUM') return { value: null, typeName: 'FieldList' };
        const list = (TYPE_FIELDS[obj.name] ?? []).map((name) => ({ __typename: '__Field', name } as GqlObj));
        return { value: list, typeName: 'FieldList' };
      }
      if (field.name === 'enumValues') {
        if (obj.kind !== 'ENUM') return { value: null, typeName: 'EnumList' };
        const list = (obj.name === 'SearchType' ? SEARCH_TYPE_VALUES : []).map((name) => ({ __typename: '__EnumValue', name } as GqlObj));
        return { value: list, typeName: 'EnumList' };
      }
      break;
    }
    case '__Field': {
      if (field.name === 'name') return { value: obj.name, typeName: 'String' };
      if (field.name === 'description') return { value: null, typeName: 'String' };
      if (field.name === 'type') return { value: null, typeName: '__Type' };
      if (field.name === 'args') return { value: [], typeName: 'InputList' };
      break;
    }
    case '__EnumValue': {
      if (field.name === 'name') return { value: obj.name, typeName: 'String' };
      if (field.name === 'description') return { value: null, typeName: 'String' };
      break;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (field.name === 'issue') return { value: (obj as { issue: GqlObj | null }).issue ?? null, typeName: 'Issue' };
      if (field.name === 'clientMutationId') return { value: null, typeName: 'String' };
      break;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (field.name === 'pullRequest') return { value: (obj as { pullRequest: GqlObj | null }).pullRequest ?? null, typeName: 'PullRequest' };
      if (field.name === 'clientMutationId') return { value: null, typeName: 'String' };
      break;
    }
    case 'AddCommentPayload': {
      if (field.name === 'commentEdge') return { value: (obj as { commentEdge: GqlObj | null }).commentEdge ?? null, typeName: 'IssueCommentEdge' };
      if (field.name === 'clientMutationId') return { value: null, typeName: 'String' };
      break;
    }
  }
  return { value: null, typeName: 'String' };
}

// ---------------------------------------------------------------------------
// Selection execution
// ---------------------------------------------------------------------------

function isLeafType(typeName: string): boolean {
  return ['String', 'Int', 'ID', 'Boolean', 'Float'].includes(typeName) || typeName === 'NodeList' || typeName === 'EdgeList' || typeName === 'FieldList' || typeName === 'EnumList' || typeName === 'InputList';
}

function executeSelection(
  store: Store,
  obj: GqlObj | null,
  typeName: string,
  selection: SelectionNode[],
  variables: Record<string, unknown>,
  fragments: Map<string, FragmentNode>,
  errors: { message: string }[],
): Record<string, unknown> | null {
  if (obj === null) return null;
  const out: Record<string, unknown> = {};
  for (const sel of selection) {
    if (sel.kind === 'spread') {
      const frag = fragments.get(sel.name);
      if (!frag) continue;
      if (frag.typeCondition !== obj.__typename && frag.typeCondition !== 'Node') continue;
      const sub = executeSelection(store, obj, frag.typeCondition, frag.selection, variables, fragments, errors);
      if (sub) Object.assign(out, sub);
      continue;
    }
    if (sel.kind === 'inline') {
      if (sel.typeCondition && sel.typeCondition !== obj.__typename && sel.typeCondition !== 'Node') continue;
      const sub = executeSelection(store, obj, sel.typeCondition ?? typeName, sel.selection, variables, fragments, errors);
      if (sub) Object.assign(out, sub);
      continue;
    }
    // field
    const allowed = TYPE_FIELDS[typeName] ?? TYPE_FIELDS[obj.__typename] ?? [];
    if (!allowed.includes(sel.name)) {
      errors.push({ message: `Cannot query field "${sel.name}" on type "${typeName}".` });
      out[sel.alias ?? sel.name] = null;
      continue;
    }
    const { value, typeName: fieldType } = resolveField(store, obj, sel, variables);
    const key = sel.alias ?? sel.name;
    if (sel.selection) {
      if (value === null || value === undefined) {
        out[key] = null;
      } else if (Array.isArray(value)) {
        // List of objects: resolve each item with the field's item type.
        const itemType = fieldType === 'NodeList' || fieldType === 'EdgeList' ? (value[0] as GqlObj | undefined)?.__typename ?? typeName : fieldType;
        out[key] = value.map((item) => {
          if (item === null) return null;
          if (typeof item === 'object' && '__typename' in (item as Record<string, unknown>)) {
            return executeSelection(store, item as GqlObj, (item as GqlObj).__typename, sel.selection!, variables, fragments, errors);
          }
          return item;
        });
      } else if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
        out[key] = executeSelection(store, value as GqlObj, (value as GqlObj).__typename, sel.selection, variables, fragments, errors);
      } else {
        out[key] = value;
      }
    } else {
      out[key] = value;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface GraphQLResponse {
  data?: Record<string, unknown> | null;
  errors?: { message: string }[];
}

export function handleGraphQL(store: Store, body: unknown): { status: number; body: unknown } {
  const docs = Array.isArray(body) ? body : [body];
  const results: GraphQLResponse[] = [];
  for (const doc of docs) {
    results.push(executeDocument(store, doc as Record<string, unknown>));
  }
  return { status: 200, body: Array.isArray(body) ? results : results[0] };
}

function executeDocument(store: Store, doc: Record<string, unknown>): GraphQLResponse {
  const query = typeof doc.query === 'string' ? doc.query : '';
  const variables = (doc.variables ?? {}) as Record<string, unknown>;
  const operationName = typeof doc.operationName === 'string' ? doc.operationName : undefined;
  let defs: DefinitionNode[];
  try {
    defs = new Parser(lex(query)).parseDocument();
  } catch (e) {
    return { data: null, errors: [{ message: e instanceof Error ? e.message : 'parse error' }] };
  }
  const fragments = new Map<string, FragmentNode>();
  const operations: OperationNode[] = [];
  for (const d of defs) {
    if (d.kind === 'fragment') fragments.set(d.name, d);
    else operations.push(d);
  }
  const op = operationName
    ? operations.find((o) => o.name === operationName) ?? operations[0]
    : operations[0];
  if (!op) return { data: null, errors: [{ message: 'no operation found' }] };
  const errors: { message: string }[] = [];
  const root: GqlObj = op.operation === 'mutation' ? { __typename: 'Mutation' } : { __typename: 'Query' };
  const rootType = op.operation === 'mutation' ? 'Mutation' : 'Query';
  // Apply variable defaults.
  const vars: Record<string, unknown> = { ...variables };
  for (const v of op.variables) {
    if (vars[v.name] === undefined && v.default !== undefined) {
      vars[v.name] = evalValue(v.default, vars);
    }
  }
  const data = executeSelection(store, root, rootType, op.selection, vars, fragments, errors);
  const out: GraphQLResponse = { data };
  if (errors.length > 0) out.errors = errors;
  return out;
}
