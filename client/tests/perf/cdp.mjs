// title: tests/perf/cdp.mjs
// project: Glim
// author: Reina Hastings
// contact: reinahastings13@gmail.com
// date created: 2026-09-18
//
// purpose:
//   Minimal Chrome DevTools Protocol client, plus a static file server, so the
//   perf harness needs no dependencies at all: Node 22+ ships a global
//   WebSocket, and macOS ships Chrome. Deliberately not Playwright - that is
//   tests/visual's dependency and its concern.
//
// inputs:  none
// outputs: CDP, launchChrome, newPage, serve, sleep
// -----------------------------------------------------------------------------

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { spawn } from 'node:child_process';

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};

export function serve(root, port) {
  const server = createServer(async (req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    try {
      const body = await readFile(join(root, normalize(p).replace(/^(\.\.[/\\])+/, '')));
      res.writeHead(200, { 'content-type': TYPES[extname(p)] ?? 'application/octet-stream',
                           'cache-control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404); res.end('not found');
    }
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server)));
}

export class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }

  static async attach(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new CDP(ws);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      const p = msg.id && c.pending.get(msg.id);
      if (!p) return;
      c.pending.delete(msg.id);
      msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
    };
    return c;
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression, awaitPromise = false) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate failed');
    }
    return r.result.value;
  }

  close() { this.ws.close(); }
}

export async function launchChrome(userDataDir, port) {
  // A Chrome left over from a crashed run answers on this port and would be
  // silently reused, serving a stale page and hanging the next run. Fail loudly
  // instead; this cost one confusing debugging round.
  try {
    const stale = await fetch(`http://127.0.0.1:${port}/json/version`);
    if (stale.ok) {
      throw new Error(`a Chrome is already listening on ${port}; ` +
        `kill it first (pkill -f "remote-debugging-port=${port}")`);
    }
  } catch (e) {
    if (e.message.includes('already listening')) throw e;   // ours, not a connection error
  }

  const bin = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const proc = spawn(bin, [
    `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--window-size=1280,860', '--window-position=40,40', 'about:blank',
  ], { stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return proc;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error('Chrome did not expose a debugging port');
}

export async function newPage(port, url) {
  const r = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  return CDP.attach((await r.json()).webSocketDebuggerUrl);
}

// Dispatches a pointer path as a real mouse gesture. `hz` controls dispatch rate
// (shake detection depends on it). Returns the number of events sent.
export async function movePath(cdp, points, hz = 60, buttons = 0) {
  const t0 = Date.now();
  for (let i = 0; i < points.length; i++) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: points[i].x, y: points[i].y,
      button: buttons ? 'left' : 'none', buttons,
    });
    const wait = t0 + (i + 1) * (1000 / hz) - Date.now();
    if (wait > 0) await sleep(wait);
  }
  return points.length;
}
