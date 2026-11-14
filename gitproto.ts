// gitproto.ts — git smart-HTTP wire protocol: pkt-lines, packfiles, delta
// resolution, upload-pack v0/v2 and receive-pack v0. Written fresh in this
// session; no code is copied from the kit's suite (the suite is only read
// to learn the wire contract).
import { createHash } from 'node:crypto';
import * as zlib from 'node:zlib';
import { Store, ZERO_OID, hashObject, parseCommit, parseTag, parseTree } from './store.ts';
import type { ObjType, Repo } from './store.ts';

const AGENT = 'forge/1.0';

// ---------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------

export function pktLine(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = payload.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, payload]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

export interface Pkt {
  kind: 'data' | 'flush' | 'delim' | 'end';
  data: Buffer;
}

/** Parse a pkt-line stream. Returns packets in order. */
export function parsePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const len = parseInt(buf.subarray(i, i + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) break;
    if (len === 0) {
      out.push({ kind: 'flush', data: Buffer.alloc(0) });
      i += 4;
    } else if (len === 1) {
      out.push({ kind: 'delim', data: Buffer.alloc(0) });
      i += 4;
    } else if (len === 2) {
      out.push({ kind: 'end', data: Buffer.alloc(0) });
      i += 4;
    } else {
      out.push({ kind: 'data', data: buf.subarray(i + 4, i + len) });
      i += len;
    }
  }
  return out;
}

/** Sideband framing: band 1 = data, 2 = progress, 3 = error. */
export function sideband(band: number, payload: Buffer): Buffer {
  const inner = Buffer.concat([Buffer.from([band]), payload]);
  return pktLine(inner);
}

// ---------------------------------------------------------------------------
// zlib helpers (inflateSync ignores trailing bytes, so binary-search the
// exact compressed length; the predicate is monotonic).
// ---------------------------------------------------------------------------

export function inflateAt(buf: Buffer, offset: number): { data: Buffer; consumed: number } {
  let lo = offset;
  let hi = buf.length;
  // Verify the full remainder inflates at all.
  zlib.inflateSync(buf.subarray(offset));
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    try {
      zlib.inflateSync(buf.subarray(offset, mid));
      hi = mid;
    } catch {
      lo = mid;
    }
  }
  const data = zlib.inflateSync(buf.subarray(offset, hi));
  return { data, consumed: hi - offset };
}

// ---------------------------------------------------------------------------
// Packfiles
// ---------------------------------------------------------------------------

const TYPE_NAME: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const TYPE_NUM: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

export interface PackObject {
  type: ObjType;
  data: Buffer;
  oid: string;
}

function readSizeType(buf: Buffer, offset: number): { type: number; size: number; next: number } {
  const b0 = buf[offset];
  const type = (b0 >> 4) & 0x7;
  let size = b0 & 0x0f;
  let shift = 4;
  let i = offset + 1;
  while (b0 & 0x80 || (i > offset + 1 && (buf[i - 1] & 0x80))) {
    const b = buf[i];
    size |= (b & 0x7f) << shift;
    shift += 7;
    i++;
    if (!(b & 0x80)) break;
  }
  return { type, size, next: i };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let i = 0;
  const readVar = (): number => {
    let v = 0;
    let shift = 0;
    for (;;) {
      const b = delta[i++];
      v |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return v;
  };
  readVar(); // source size (trusted, verified by hash later)
  readVar(); // target size
  const parts: Buffer[] = [];
  while (i < delta.length) {
    const op = delta[i++];
    if (op & 0x80) {
      let off = 0;
      let size = 0;
      if (op & 0x01) off = delta[i++];
      if (op & 0x02) off |= delta[i++] << 8;
      if (op & 0x04) off |= delta[i++] << 16;
      if (op & 0x08) off |= delta[i++] << 24;
      if (op & 0x10) size = delta[i++];
      if (op & 0x20) size |= delta[i++] << 8;
      if (op & 0x40) size |= delta[i++] << 16;
      if (size === 0) size = 0x10000;
      parts.push(base.subarray(off, off + size));
    } else if (op !== 0) {
      parts.push(delta.subarray(i, i + op));
      i += op;
    } else {
      throw new Error('invalid delta opcode 0');
    }
  }
  return Buffer.concat(parts);
}

export interface ParsedPack {
  objects: PackObject[];
}

/** Parse a packfile. baseLookup resolves REF_DELTA bases (the store). */
export function parsePack(buf: Buffer, baseLookup: (oid: string) => { type: ObjType; data: Buffer } | undefined): ParsedPack {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const count = buf.readUInt32BE(8);
  let offset = 12;
  const byOffset = new Map<number, PackObject>();
  const objects: PackObject[] = [];
  for (let n = 0; n < count; n++) {
    const start = offset;
    const { type, size, next } = readSizeType(buf, offset);
    offset = next;
    let objType: ObjType;
    let data: Buffer;
    if (type === 6) {
      // OFS_DELTA: offset encoding.
      let b = buf[offset++];
      let baseOff = b & 0x7f;
      while (b & 0x80) {
        b = buf[offset++];
        baseOff = ((baseOff + 1) << 7) | (b & 0x7f);
      }
      const baseStart = start - baseOff;
      const base = byOffset.get(baseStart);
      if (!base) throw new Error('ofs-delta base not found');
      const { data: delta, consumed } = inflateAt(buf, offset);
      offset += consumed;
      data = applyDelta(base.data, delta);
      objType = base.type;
    } else if (type === 7) {
      const baseOid = buf.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const { data: delta, consumed } = inflateAt(buf, offset);
      offset += consumed;
      const base = baseLookup(baseOid) ?? objects.find((o) => o.oid === baseOid);
      if (!base) throw new Error('ref-delta base not found');
      data = applyDelta(base.data, delta);
      objType = base.type;
    } else {
      objType = TYPE_NAME[type];
      if (!objType) throw new Error(`unknown pack object type ${type}`);
      const { data: d, consumed } = inflateAt(buf, offset);
      offset += consumed;
      data = d;
    }
    if (data.length !== size) throw new Error(`object size mismatch: got ${data.length}, want ${size}`);
    const oid = hashObject(objType, data);
    const obj: PackObject = { type: objType, data, oid };
    objects.push(obj);
    byOffset.set(start, obj);
  }
  return { objects };
}

/** Build a packfile of full (non-delta) objects. */
export function buildPack(entries: { type: ObjType; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(entries.length, 8);
  parts.push(head);
  for (const e of entries) {
    const typeNum = TYPE_NUM[e.type];
    const size = e.data.length;
    // varint header: low 4 bits of size in first byte, then 7 bits each.
    const bytes: number[] = [];
    let s = size;
    let first = (typeNum << 4) | (s & 0x0f);
    s >>= 4;
    if (s > 0) first |= 0x80;
    bytes.push(first);
    while (s > 0) {
      let b = s & 0x7f;
      s >>= 7;
      if (s > 0) b |= 0x80;
      bytes.push(b);
    }
    parts.push(Buffer.from(bytes));
    parts.push(zlib.deflateSync(e.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------------------
// Reachability / send-set computation for upload-pack
// ---------------------------------------------------------------------------

export interface FetchPlan {
  objects: PackObject[]; // in an order parents come after children is not required
  shallow: string[];
  unshallow: string[];
}

/** Compute what a fetch must send.
 *  wants: commit oids the client wants. haves: commits the client has.
 *  shallow: commits the client marks shallow (boundary). depth: 0 = full.
 *  Returns the object set to pack, plus shallow/unshallow lines.
 */
export function computeFetch(
  store: Store,
  wants: string[],
  haves: string[],
  shallow: string[],
  depth: number,
): FetchPlan {
  // Included commits: BFS from wants over parents, limited by depth.
  // A wanted tag contributes the tag object itself and peels to its commit.
  const included = new Set<string>();
  const extraObjects = new Set<string>();
  const queue: { oid: string; d: number }[] = [];
  for (const w of wants) {
    const obj = store.getObject(w);
    if (!obj) continue;
    if (obj.type === 'tag') {
      extraObjects.add(w);
      queue.push({ oid: store.peelToCommit(w), d: 0 });
    } else if (obj.type === 'commit') {
      queue.push({ oid: w, d: 0 });
    } else {
      extraObjects.add(w);
    }
  }
  const shallowSet = new Set(shallow);
  const newShallow = new Set<string>();
  const unshallow = new Set<string>();
  while (queue.length > 0) {
    const { oid, d } = queue.shift()!;
    if (included.has(oid)) continue;
    const obj = store.getObject(oid);
    if (!obj || obj.type !== 'commit') continue;
    included.add(oid);
    const isBoundary = depth > 0 && d === depth - 1;
    if (isBoundary) {
      newShallow.add(oid);
      continue; // do not traverse parents of a depth-boundary commit
    }
    if (depth === 0 && shallowSet.has(oid)) {
      // No deepen requested: a client-declared shallow boundary stays a
      // boundary (a plain fetch from a shallow repo must not pull the
      // whole history). With a deepen, the depth limit governs instead
      // and the boundary moves (see unshallow below).
      newShallow.add(oid);
      continue;
    }
    const c = parseCommit(obj.data);
    for (const p of c.parents) queue.push({ oid: p, d: d + 1 });
  }
  // Exclusion: objects reachable from haves, stopping traversal at
  // shallow-boundary commits (the boundary commit and its tree/blobs are
  // excluded as held, but its parents are not).
  const excluded = new Set<string>();
  const exSeen = new Set<string>();
  const exQueue = [...haves];
  while (exQueue.length > 0) {
    const oid = exQueue.shift()!;
    if (exSeen.has(oid)) continue;
    exSeen.add(oid);
    const obj = store.getObject(oid);
    if (!obj) continue;
    if (obj.type === 'commit') {
      excluded.add(oid);
      const c = parseCommit(obj.data);
      for (const t of treeObjectSet(store, c.tree)) excluded.add(t);
      if (!shallowSet.has(oid)) {
        for (const p of c.parents) exQueue.push(p);
      }
    } else if (obj.type === 'tag') {
      excluded.add(oid);
      exQueue.push(parseTag(obj.data).object);
    } else if (obj.type === 'tree') {
      for (const t of treeObjectSet(store, oid)) excluded.add(t);
    } else {
      excluded.add(oid);
    }
  }
  // Send set: each included commit with its tree/blobs only (never a
  // parent that depth or the have-set excluded), plus wanted tag objects.
  const send = new Set<string>(extraObjects);
  for (const oid of included) {
    send.add(oid);
    const obj = store.getObject(oid);
    if (!obj || obj.type !== 'commit') continue;
    const c = parseCommit(obj.data);
    for (const t of treeObjectSet(store, c.tree)) send.add(t);
  }
  for (const e of excluded) send.delete(e);
  // Unshallow: a have that was shallow on the client but is now included
  // with its parents (i.e. the boundary moved past it).
  for (const h of haves) {
    if (shallowSet.has(h) && included.has(h)) {
      const obj = store.getObject(h);
      if (obj && obj.type === 'commit') {
        const c = parseCommit(obj.data);
        if (c.parents.some((p) => included.has(p))) unshallow.add(h);
      }
    }
  }
  const objects: PackObject[] = [];
  for (const oid of send) {
    const obj = store.getObject(oid);
    if (obj) objects.push({ type: obj.type, data: obj.data, oid });
  }
  return { objects, shallow: [...newShallow], unshallow: [...unshallow] };
}

function treeObjectSet(store: Store, treeOid: string): Set<string> {
  const out = new Set<string>();
  const stack = [treeOid];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (out.has(oid)) continue;
    const obj = store.getObject(oid);
    if (!obj || obj.type !== 'tree') continue;
    out.add(oid);
    for (const e of parseTree(obj.data)) {
      if (e.mode === '40000') stack.push(e.oid);
      else out.add(e.oid);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Advertisements
// ---------------------------------------------------------------------------

function refLinesV0(store: Store, repo: Repo): { oid: string; name: string; peeled?: string }[] {
  const lines: { oid: string; name: string; peeled?: string }[] = [];
  const head = store.headTip(repo);
  if (head) lines.push({ oid: head, name: 'HEAD' });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const peeled = name.startsWith('refs/tags/') ? store.peelToCommit(oid) : undefined;
    lines.push({ oid, name, peeled: peeled !== oid ? peeled : undefined });
  }
  return lines;
}

export function uploadPackAdvertisementV0(store: Store, repo: Repo): Buffer {
  const caps = [
    'side-band-64k',
    'thin-pack',
    'ofs-delta',
    'shallow',
    `agent=${AGENT}`,
    `symref=HEAD:refs/heads/${repo.defaultBranch}`,
  ].join(' ');
  const parts: Buffer[] = [];
  parts.push(pktLine('# service=git-upload-pack\n'));
  parts.push(FLUSH);
  const lines = refLinesV0(store, repo);
  if (lines.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    lines.forEach((l, i) => {
      const suffix = i === 0 ? `\0${caps}` : '';
      parts.push(pktLine(`${l.oid} ${l.name}${suffix}\n`));
      if (l.peeled) parts.push(pktLine(`${l.peeled} ${l.name}^{}\n`));
    });
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

export function receivePackAdvertisementV0(store: Store, repo: Repo): Buffer {
  const caps = ['report-status', 'side-band-64k', 'delete-refs', 'ofs-delta', `agent=${AGENT}`].join(' ');
  const parts: Buffer[] = [];
  parts.push(pktLine('# service=git-receive-pack\n'));
  parts.push(FLUSH);
  const lines = refLinesV0(store, repo);
  if (lines.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    lines.forEach((l, i) => {
      const suffix = i === 0 ? `\0${caps}` : '';
      parts.push(pktLine(`${l.oid} ${l.name}${suffix}\n`));
      if (l.peeled) parts.push(pktLine(`${l.peeled} ${l.name}^{}\n`));
    });
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

export function uploadPackAdvertisementV2(store: Store, repo: Repo): Buffer {
  const parts: Buffer[] = [];
  parts.push(pktLine('version 2\n'));
  parts.push(pktLine(`agent=${AGENT}\n`));
  parts.push(pktLine('ls-refs=unborn\n'));
  parts.push(pktLine('fetch=shallow filter\n'));
  parts.push(pktLine('object-format=sha1\n'));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// upload-pack request handling
// ---------------------------------------------------------------------------

export function handleUploadPackV2(store: Store, repo: Repo, body: Buffer): Buffer {
  const pkts = parsePktLines(body);
  const lines: string[] = [];
  for (const p of pkts) {
    if (p.kind === 'data') lines.push(p.data.toString('utf8'));
  }
  const command = lines[0]?.startsWith('command=') ? lines[0].slice(8).trim() : '';
  const args = lines.slice(1);
  if (command === 'ls-refs') {
    let peel = false;
    let symrefs = false;
    let unborn = false;
    const prefixes: string[] = [];
    for (const a of args) {
      const t = a.trim();
      if (t === 'peel') peel = true;
      else if (t === 'symrefs') symrefs = true;
      else if (t === 'unborn') unborn = true;
      else if (t.startsWith('ref-prefix ')) prefixes.push(t.slice(11));
      else if (t.startsWith('ref-prefix')) prefixes.push(t.slice(10).trim());
    }
    const parts: Buffer[] = [];
    const head = store.headTip(repo);
    const matches = (name: string) => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
    if (!head) {
      if (unborn && matches('HEAD')) {
        parts.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
      }
    } else {
      if (matches('HEAD')) {
        const extra = symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
        parts.push(pktLine(`${head} HEAD${extra}\n`));
      }
      const names = [...repo.refs.keys()].sort();
      for (const name of names) {
        if (!matches(name)) continue;
        const oid = repo.refs.get(name)!;
        let extra = '';
        if (peel && name.startsWith('refs/tags/')) {
          const peeled = store.peelToCommit(oid);
          if (peeled !== oid) extra += ` peeled:${peeled}`;
        }
        parts.push(pktLine(`${oid} ${name}${extra}\n`));
      }
    }
    parts.push(FLUSH);
    return Buffer.concat(parts);
  }
  if (command === 'fetch') {
    const wants: string[] = [];
    const haves: string[] = [];
    const shallow: string[] = [];
    let depth = 0;
    let deepenRelative = false;
    for (const a of args) {
      const t = a.trim();
      if (t.startsWith('want ')) wants.push(t.slice(5).trim());
      else if (t.startsWith('have ')) haves.push(t.slice(5).trim());
      else if (t.startsWith('shallow ')) shallow.push(t.slice(8).trim());
      else if (t === 'deepen-relative') deepenRelative = true;
      else if (t.startsWith('deepen ')) {
        const n = parseInt(t.slice(7).trim(), 10);
        if (Number.isFinite(n) && n > 0) depth = n;
      }
    }
    // deepen-relative (real git): the depth is additional generations past
    // the client's current shallow boundary (a depth-1 boundary), not an
    // absolute depth from the want.
    const effectiveDepth = depth > 0 && deepenRelative ? depth + 1 : depth;
    const plan = computeFetch(store, wants, haves, shallow, effectiveDepth);
    const parts: Buffer[] = [];
    let sections = 0;
    // The acknowledgments section is only sent when the client sent haves.
    // Acknowledge every have the server holds, then 'ready' so the client
    // stops negotiating and reads the packfile (a bare NAK makes real git
    // expect another round of haves).
    if (haves.length > 0) {
      parts.push(pktLine('acknowledgments\n'));
      let acked = 0;
      for (const h of haves) {
        if (store.getObject(h)) {
          parts.push(pktLine(`ACK ${h}\n`));
          acked++;
        }
      }
      if (acked === 0) parts.push(pktLine('NAK\n'));
      parts.push(pktLine('ready\n'));
      sections++;
    }
    if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
      if (sections > 0) parts.push(DELIM);
      parts.push(pktLine('shallow-info\n'));
      for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
      for (const u of plan.unshallow) parts.push(pktLine(`unshallow ${u}\n`));
      sections++;
    }
    if (plan.objects.length > 0) {
      if (sections > 0) parts.push(DELIM);
      parts.push(pktLine('packfile\n'));
      const pack = buildPack(plan.objects);
      // sideband: chunk pack data into <= 65515-byte payloads.
      let off = 0;
      while (off < pack.length) {
        const chunk = pack.subarray(off, Math.min(pack.length, off + 65515));
        parts.push(sideband(1, chunk));
        off += chunk.length;
      }
      sections++;
    }
    parts.push(FLUSH);
    return Buffer.concat(parts);
  }
  // Unknown command: empty response.
  return FLUSH;
}

export function handleUploadPackV0(store: Store, repo: Repo, body: Buffer): Buffer {
  const pkts = parsePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth = 0;
  let seenFlush = false;
  for (const p of pkts) {
    if (p.kind === 'flush') {
      seenFlush = true;
      continue;
    }
    if (p.kind !== 'data') continue;
    const line = p.data.toString('utf8').trim();
    if (!seenFlush) {
      if (line.startsWith('want ')) {
        const rest = line.slice(5);
        wants.push(rest.split(' ')[0]);
      } else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) {
        const n = parseInt(line.slice(7).trim(), 10);
        if (Number.isFinite(n) && n > 0) depth = n;
      }
    } else {
      if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    }
  }
  const plan = computeFetch(store, wants, haves, shallow, depth);
  const parts: Buffer[] = [];
  parts.push(pktLine('NAK\n'));
  for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
  if (plan.objects.length > 0) {
    const pack = buildPack(plan.objects);
    let off = 0;
    while (off < pack.length) {
      const chunk = pack.subarray(off, Math.min(pack.length, off + 65515));
      parts.push(sideband(1, chunk));
      off += chunk.length;
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

export interface PushResult {
  unpackOk: boolean;
  unpackDetail?: string;
  refs: { name: string; ok: boolean; reason?: string }[];
}

export function handleReceivePack(store: Store, repo: Repo, body: Buffer): { response: Buffer; result: PushResult } {
  const result: PushResult = { unpackOk: true, refs: [] };
  // Split pkt-line section (commands) from the pack bytes.
  const pkts = parsePktLines(body);
  const commands: { old: string; new: string; ref: string }[] = [];
  let packOffset = 0;
  let i = 0;
  let consumed = 0;
  while (i + 4 <= body.length) {
    const len = parseInt(body.subarray(i, i + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) break;
    if (len === 0) {
      consumed = i + 4;
      break;
    }
    const data = body.subarray(i + 4, i + len);
    const line = data.toString('utf8').split('\0')[0];
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)/.exec(line);
    if (m) commands.push({ old: m[1], new: m[2], ref: m[3] });
    i += len;
    consumed = i;
  }
  packOffset = consumed;
  const packBytes = body.subarray(packOffset);
  // Parse and store the pack (if any bytes follow the flush).
  let unpackError: string | undefined;
  if (packBytes.length > 0) {
    try {
      const parsed = parsePack(packBytes, (oid) => store.getObject(oid));
      for (const o of parsed.objects) store.putObject(o.type, o.data);
    } catch (e) {
      unpackError = e instanceof Error ? e.message : String(e);
    }
  }
  if (unpackError) {
    result.unpackOk = false;
    result.unpackDetail = unpackError;
    const resp = Buffer.concat([sideband(1, pktLine(`unpack ${unpackError}\n`)), sideband(1, FLUSH), FLUSH]);
    return { response: resp, result };
  }
  // Validate + apply each ref update.
  const reportLines: string[] = ['unpack ok\n'];
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref);
    let ok = true;
    let reason: string | undefined;
    if (cmd.new === ZERO_OID) {
      // delete
      if (!current) {
        ok = false;
        reason = 'remote ref does not exist';
      } else if (cmd.old !== ZERO_OID && cmd.old !== current) {
        ok = false;
        reason = 'non-fast-forward';
      }
    } else {
      // create or update: the new tip must exist. Branches must point at
      // commits and move fast-forward; tags (and other refs) may point at
      // any object and are only guarded against stale updates.
      const tipObj = store.getObject(cmd.new);
      if (!tipObj) {
        ok = false;
        reason = 'object not found';
      } else if (cmd.ref.startsWith('refs/heads/')) {
        if (tipObj.type !== 'commit') {
          ok = false;
          reason = 'object not found';
        } else if (!current) {
          if (cmd.old !== ZERO_OID) {
            ok = false;
            reason = 'non-fast-forward';
          }
        } else if (cmd.old !== current) {
          ok = false;
          reason = 'non-fast-forward';
        } else if (!store.isAncestor(current, cmd.new)) {
          ok = false;
          reason = 'non-fast-forward';
        }
      } else if (!current) {
        if (cmd.old !== ZERO_OID) {
          ok = false;
          reason = 'non-fast-forward';
        }
      } else if (cmd.old !== current) {
        ok = false;
        reason = 'non-fast-forward';
      }
    }
    if (ok) {
      if (cmd.new === ZERO_OID) repo.refs.delete(cmd.ref);
      else repo.refs.set(cmd.ref, cmd.new);
      reportLines.push(`ok ${cmd.ref}\n`);
      result.refs.push({ name: cmd.ref, ok: true });
    } else {
      reportLines.push(`ng ${cmd.ref} ${reason}\n`);
      result.refs.push({ name: cmd.ref, ok: false, reason });
    }
  }
  const respParts: Buffer[] = [];
  for (const line of reportLines) respParts.push(sideband(1, pktLine(line)));
  // Terminate the report stream inside band 1 (real git expects a flush
  // there), then the outer response.
  respParts.push(sideband(1, FLUSH));
  respParts.push(FLUSH);
  return { response: Buffer.concat(respParts), result };
}
