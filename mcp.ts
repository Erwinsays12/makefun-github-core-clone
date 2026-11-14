// mcp.ts — MCP Streamable HTTP endpoint (POST /mcp), modern era
// 2026-07-28 with a legacy `initialize` fallback. Written fresh in this
// session. Tools act on the same store as the REST surface.
import { Store, VIEWER_LOGIN, VIEWER_ID } from './store.ts';
import { repoJson, issueJson, pullJson, mergePull } from './rest.ts';
import type { Issue, Pull } from './store.ts';

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18'];

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: string; properties: Record<string, unknown>; required: string[] };
}

export const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full repository name "owner/repo"' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'list_repos',
    description: 'List repositories owned by the authenticated user.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get an issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        number: { type: 'integer', description: 'Issue number' },
      },
      required: ['owner', 'repo', 'number'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request between two branches.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
        body: { type: 'string', description: 'Pull request body' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function toolResult(obj: unknown, isError = false): Record<string, unknown> {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
  const out: Record<string, unknown> = {
    content: [{ type: 'text', text }],
  };
  if (typeof obj !== 'string') out.structuredContent = obj;
  if (isError) out.isError = true;
  return out;
}

function resolveRepo(store: Store, args: Record<string, unknown>): { owner: string; name: string } | null {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let name = typeof args.repo === 'string' ? args.repo : '';
  if ((!owner || !name) && typeof args.full_name === 'string') {
    const parts = args.full_name.split('/');
    if (parts.length === 2) {
      owner = parts[0];
      name = parts[1];
    }
  }
  if (!owner || !name) return null;
  return { owner, name };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const missing = (fields: string[]): Record<string, unknown> | null => {
    const bad = fields.filter((f) => args[f] === undefined || args[f] === null || args[f] === '');
    if (bad.length > 0) return toolResult(`missing required argument(s): ${bad.join(', ')}`, true);
    return null;
  };
  switch (name) {
    case 'create_repo': {
      const m = missing(['name']);
      if (m) return m;
      const repoName = String(args.name);
      const existing = store.getRepo(repoName);
      if (existing) return toolResult(repoJson(store, existing));
      const repo = store.createRepo(
        repoName,
        typeof args.description === 'string' ? args.description : '',
        args.private === true,
      );
      return toolResult(repoJson(store, repo));
    }
    case 'get_repo': {
      const r = resolveRepo(store, args);
      if (!r) return toolResult('missing required argument(s): owner, repo', true);
      if (r.owner !== VIEWER_LOGIN) return toolResult('Repository not found', true);
      const repo = store.getRepo(r.name);
      if (!repo) return toolResult('Repository not found', true);
      return toolResult(repoJson(store, repo));
    }
    case 'list_repos': {
      const repos = [...store.repos.values()].map((r) => repoJson(store, r));
      return toolResult({ repos });
    }
    case 'create_issue': {
      const m = missing(['title']);
      if (m) return m;
      const r = resolveRepo(store, args);
      if (!r) return toolResult('missing required argument(s): owner, repo', true);
      if (r.owner !== VIEWER_LOGIN) return toolResult('Repository not found', true);
      const repo = store.getRepo(r.name);
      if (!repo) return toolResult('Repository not found', true);
      const issue: Issue = {
        id: store.nextIssueId++,
        number: repo.nextIssue++,
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels: [],
        createdSeq: store.nextSeq(),
        closedAt: null,
      };
      repo.issues.push(issue);
      return toolResult(issueJson(store, repo, issue));
    }
    case 'get_issue': {
      const r = resolveRepo(store, args);
      if (!r) return toolResult('missing required argument(s): owner, repo', true);
      const repo = r.owner === VIEWER_LOGIN ? store.getRepo(r.name) : undefined;
      const issue = repo?.issues.find((i) => i.number === Number(args.number));
      if (!issue || !repo) return toolResult('Issue not found', true);
      return toolResult(issueJson(store, repo, issue));
    }
    case 'list_issues': {
      const r = resolveRepo(store, args);
      if (!r) return toolResult('missing required argument(s): owner, repo', true);
      const repo = r.owner === VIEWER_LOGIN ? store.getRepo(r.name) : undefined;
      if (!repo) return toolResult('Repository not found', true);
      const state = typeof args.state === 'string' ? args.state : 'open';
      const items = repo.issues.filter((i) => state === 'all' || i.state === state);
      return toolResult({ issues: items.map((i) => issueJson(store, repo, i)) });
    }
    case 'create_pull_request': {
      const m = missing(['title', 'head', 'base']);
      if (m) return m;
      const r = resolveRepo(store, args);
      if (!r) return toolResult('missing required argument(s): owner, repo', true);
      const repo = r.owner === VIEWER_LOGIN ? store.getRepo(r.name) : undefined;
      if (!repo) return toolResult('Repository not found', true);
      const head = String(args.head);
      const base = String(args.base);
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) return toolResult('Head or base branch does not exist', true);
      let pull = repo.pulls.find((p) => p.state === 'open' && p.head === head && p.base === base);
      if (!pull) {
        pull = {
          id: store.nextPullId++,
          number: repo.nextPull++,
          title: String(args.title),
          body: typeof args.body === 'string' ? args.body : '',
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
      return toolResult(pullJson(store, repo, pull));
    }
    case 'merge_pull_request': {
      const r = resolveRepo(store, args);
      if (!r) return toolResult('missing required argument(s): owner, repo', true);
      const repo = r.owner === VIEWER_LOGIN ? store.getRepo(r.name) : undefined;
      if (!repo) return toolResult('Repository not found', true);
      const pull = repo.pulls.find((p) => p.number === Number(args.pull_number));
      if (!pull) return toolResult('Pull request not found', true);
      if (pull.state !== 'open') return toolResult('Pull request is already closed', true);
      const ctx = { store, reqId: '', origin: '' };
      const result = mergePull(ctx, repo, pull);
      if (result.status !== 200) return toolResult('Merge conflict', true);
      return toolResult(result.body);
    }
    default:
      return toolResult(`unknown tool: ${name}`, true);
  }
}

export interface McpOutcome {
  status: number;
  body: unknown; // object to JSON-encode, or null for an empty body
}

export function handleMcp(store: Store, rawBody: Buffer): McpOutcome {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
  } catch {
    return {
      status: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    };
  }
  if (Array.isArray(msg)) {
    // Batch: answer each in order (the suite never batches MCP).
    const out = msg.map((m) => handleOne(store, m as Record<string, unknown>)).filter((r) => r !== null);
    return { status: 200, body: out };
  }
  const one = handleOne(store, msg);
  if (one === null) return { status: 202, body: null }; // notification
  return { status: 200, body: one };
}

function handleOne(store: Store, msg: Record<string, unknown>): Record<string, unknown> | null {
  const id = msg.id === undefined ? null : msg.id;
  const isNotification = msg.id === undefined;
  const method = typeof msg.method === 'string' ? msg.method : '';
  const params = (msg.params ?? {}) as Record<string, unknown>;
  const error = (code: number, message: string): Record<string, unknown> => ({
    jsonrpc: '2.0',
    id,
    error: { code, message },
  });
  const result = (r: unknown): Record<string, unknown> => ({ jsonrpc: '2.0', id, result: r });

  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return null;
  }
  if (method === 'server/discover') {
    return result({
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const version = SUPPORTED_VERSIONS.includes(requested) ? requested : '2026-07-28';
    return result({
      protocolVersion: version,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'ping') {
    return result({});
  }
  if (method === 'tools/list') {
    return result({ tools: TOOLS });
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (!TOOLS.some((t) => t.name === name)) {
      return error(-32602, `Unknown tool: ${name}`);
    }
    const out = callTool(store, name, args);
    return result(out);
  }
  if (isNotification) return null;
  return error(-32601, `Method not found: ${method}`);
}
