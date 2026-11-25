#!/usr/bin/env node
/**
 * End-to-end smoke suite for MPanel (docs/file-layout.md §5.3, owner: 集成).
 *
 * Boots the real worker/core dist entrypoints in a throw-away MPANEL_HOME under
 * os.tmpdir(), talks to them over real TCP (random ports via port 0) and asserts
 * the frozen API contract. No third-party dependencies: global fetch, global
 * WebSocket and node:child_process only.
 *
 * Covered:
 *   a) worker direct: /healthz, /api/v1/system/info capabilities, 401 without token
 *   b) files: mkdir/write/read/stat/rename/delete + trash, sandbox `..` rejection
 *   c) sites: create/preview/list/delete, apply -> UNAVAILABLE when caddy is missing
 *   d) tasks: every-5-minutes schedule -> 5 next runs, run-now -> success history
 *   e) containers/databases: list availability, profile password hiding, handoff
 *   f) terminal: real WS session, echo output (PTY or pipe fallback)
 *   g) core: first-run setup -> login cookie, stdio/http/reverse-ws machines and
 *      the authenticated /proxy path; machine deletion
 *   h) audit: login and machine writes are present in core audit.jsonl
 *   i) edge: key create/list, self-enrollment, proxied snapshot, run-task job,
 *      offline queue + identity reuse after restart, revoked key rejection
 *
 * Flags: --keep (keep temp dir), --verbose (stream child stderr),
 *        --timeout=120000 (per-operation timeout in ms).
 *
 * Prints PASS/FAIL for every check and ends with `SMOKE: PASS <n> checks` or
 * `SMOKE: FAIL <n> failed`; exits non-zero on any failure.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workerEntry = path.join(root, 'server', 'worker', 'dist', 'index.js');
const coreEntry = path.join(root, 'server', 'core', 'dist', 'index.js');

const cli = new Set(process.argv.slice(2));
const keepTemp = cli.has('--keep');
const verbose = cli.has('--verbose');
const timeoutArg = process.argv.slice(2).find((item) => item.startsWith('--timeout='));
const operationTimeoutMs = (() => {
  if (timeoutArg === undefined) return 120_000;
  const parsed = Number(timeoutArg.slice('--timeout='.length));
  return Number.isFinite(parsed) && parsed >= 1_000 ? parsed : 120_000;
})();

const results = [];
let failed = 0;

function oneLine(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').slice(0, 600);
}

function pass(name, detail) {
  results.push({ name, ok: true });
  console.log(`PASS ${name}${detail === undefined ? '' : ` — ${detail}`}`);
}

function fail(name, error) {
  failed += 1;
  results.push({ name, ok: false, error: oneLine(error) });
  console.log(`FAIL ${name} — ${oneLine(error)}`);
}

async function check(name, fn) {
  try {
    const detail = await fn();
    pass(name, detail === undefined ? undefined : String(detail));
  } catch (error) {
    fail(name, error);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, label, timeoutMs, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  for (;;) {
    try {
      const value = await fn();
      if (value !== undefined && value !== null && value !== false) return value;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      if (lastError !== undefined) {
        throw new Error(`${label}: timeout after ${timeoutMs}ms (last error: ${oneLine(lastError)})`);
      }
      throw new Error(`${label}: timeout after ${timeoutMs}ms`);
    }
    await delay(intervalMs);
  }
}

function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

/* ------------------------------------------------------------------ */
/* Process supervision                                                 */
/* ------------------------------------------------------------------ */

const processes = [];

function childEnv(overrides) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/^MPANEL_/i.test(key)) continue;
    if (key === 'NODE_OPTIONS') continue;
    env[key] = value;
  }
  return { ...env, ...overrides };
}

function startNodeService(label, entry, env) {
  assert(existsSync(entry), `${label}: entry point missing: ${entry} (run the build first)`);
  const child = spawn(process.execPath, [entry, 'serve'], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const handle = {
    label,
    child,
    lines: [],
    stderr: '',
    exitCode: null,
    exitSignal: null,
    exited: false,
    waiters: [],
  };
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (;;) {
      const index = buffer.indexOf('\n');
      if (index < 0) break;
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      handle.lines.push(line);
      for (const waiter of [...handle.waiters]) waiter();
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    handle.stderr = `${handle.stderr}${chunk}`.slice(-20_000);
    if (verbose) process.stderr.write(`[${label}] ${chunk}`);
  });
  child.on('error', (error) => {
    handle.stderr = `${handle.stderr}\nspawn error: ${error.message}`;
    handle.exited = true;
    for (const waiter of handle.waiters.splice(0)) waiter();
  });
  child.on('exit', (code, signal) => {
    handle.exited = true;
    handle.exitCode = code;
    handle.exitSignal = signal;
    for (const waiter of handle.waiters.splice(0)) waiter();
  });
  processes.push(handle);
  return handle;
}

function parseListening(handle) {
  for (const line of handle.lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed !== null && parsed.event === 'listening' && Number.isInteger(parsed.port)) {
        return parsed;
      }
    } catch {
      // ignore non-JSON stdout lines
    }
  }
  return null;
}

async function waitListening(handle, timeoutMs = operationTimeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const listening = parseListening(handle);
    if (listening !== null) return listening;
    if (handle.exited) {
      throw new Error(
        `${handle.label} exited before listening (code=${String(handle.exitCode)}): ${handle.stderr.slice(-800)}`,
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(`${handle.label}: no listening event after ${timeoutMs}ms; stderr: ${handle.stderr.slice(-800)}`);
    }
    await delay(50);
  }
}

async function waitExit(handle, timeoutMs) {
  if (handle.exited) return true;
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      const index = handle.waiters.indexOf(done);
      if (index >= 0) handle.waiters.splice(index, 1);
      resolve(false);
    }, timeoutMs);
    if (handle.exited) {
      clearTimeout(timer);
      resolve(true);
      return;
    }
    handle.waiters.push(done);
  });
}

async function stopProcess(handle) {
  if (handle === undefined || handle === null) return;
  if (handle.exited) return;
  const pid = handle.child.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    try {
      handle.child.kill('SIGTERM');
    } catch {
      // already gone
    }
  }
  const exited = await waitExit(handle, 5_000);
  if (!exited) {
    try {
      handle.child.kill('SIGKILL');
    } catch {
      // already gone
    }
    await waitExit(handle, 2_000);
  }
}

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */

function query(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const text = search.toString();
  return text.length === 0 ? '' : `?${text}`;
}

async function request(baseUrl, method, pathname, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
  if (options.cookie !== undefined) headers.cookie = options.cookie;
  if (method !== 'GET' && method !== 'HEAD') headers['x-mpanel-request'] = 'smoke';
  let body;
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
    signal: AbortSignal.timeout(options.timeoutMs ?? operationTimeoutMs),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, headers: response.headers, text, json };
}

function expectData(response, label, expectedStatus = 200) {
  assert(
    response.status === expectedStatus,
    `${label}: expected HTTP ${expectedStatus}, got ${response.status}: ${response.text.slice(0, 400)}`,
  );
  assert(
    response.json !== null && response.json.ok === true,
    `${label}: expected success envelope, got: ${response.text.slice(0, 400)}`,
  );
  return response.json.data;
}

function expectError(response, label, expectedCode) {
  assert(response.status >= 400, `${label}: expected an error status, got ${response.status}`);
  assert(
    response.json !== null && response.json.ok === false,
    `${label}: expected error envelope, got: ${response.text.slice(0, 400)}`,
  );
  const error = response.json.error;
  assert(typeof error.code === 'string', `${label}: error envelope has no code`);
  if (expectedCode !== undefined) {
    assert(error.code === expectedCode, `${label}: expected ${expectedCode}, got ${error.code}`);
  }
  return error;
}

function sessionCookie(response) {
  let cookies = [];
  if (typeof response.headers.getSetCookie === 'function') {
    cookies = response.headers.getSetCookie();
  }
  if (cookies.length === 0) {
    const raw = response.headers.get('set-cookie');
    if (raw !== null) cookies = [raw];
  }
  for (const cookie of cookies) {
    const pair = cookie.split(';', 1)[0]?.trim() ?? '';
    if (pair.startsWith('mpanel_session=') && pair.length > 'mpanel_session='.length) {
      return pair;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* WebSocket helper (global WebSocket, no dependencies)                */
/* ------------------------------------------------------------------ */

async function openWebSocket(url, timeoutMs) {
  const socket = new WebSocket(url);
  const state = {
    messages: [],
    output: '',
    closed: false,
    closeCode: null,
    closeReason: '',
  };
  socket.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') return;
    let message = null;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    state.messages.push(message);
    if (message.type === 'output' && typeof message.data === 'string') {
      state.output += message.data;
    }
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`WS open timeout after ${timeoutMs}ms`)), timeoutMs);
    const onOpen = () => {
      clearTimeout(timer);
      resolve();
    };
    const onError = () => {
      clearTimeout(timer);
      reject(new Error('WS connection failed'));
    };
    const onClose = (event) => {
      clearTimeout(timer);
      reject(new Error(`WS closed before open (code=${event.code} ${event.reason})`));
    };
    socket.addEventListener('open', onOpen, { once: true });
    socket.addEventListener('error', onError, { once: true });
    socket.addEventListener('close', onClose, { once: true });
  });
  socket.addEventListener('close', (event) => {
    state.closed = true;
    state.closeCode = event.code;
    state.closeReason = event.reason;
  });
  return {
    state,
    send(value) {
      socket.send(JSON.stringify(value));
    },
    close() {
      try {
        socket.close(1000, 'smoke done');
      } catch {
        // ignore
      }
    },
    async waitFor(predicate, label, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = state.messages.find(predicate);
        if (found !== undefined) return found;
        if (state.closed) {
          throw new Error(
            `${label}: socket closed (code=${String(state.closeCode)} ${state.closeReason}); output=${JSON.stringify(state.output.slice(-400))}`,
          );
        }
        if (Date.now() >= deadline) {
          throw new Error(`${label}: timeout; output=${JSON.stringify(state.output.slice(-400))}`);
        }
        await delay(40);
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

let tempRoot = null;

async function main() {
  console.log('MPanel smoke suite');
  console.log(`  repo      ${root}`);
  console.log(`  timeout   ${operationTimeoutMs}ms per operation`);

  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'mpanel-smoke-'));
  const directHome = path.join(tempRoot, 'worker-direct');
  const httpHome = path.join(tempRoot, 'worker-http');
  const reverseHome = path.join(tempRoot, 'worker-reverse');
  const coreHome = path.join(tempRoot, 'core');
  const missingBinDir = path.join(tempRoot, 'missing-bin');
  const emptyWebDist = path.join(tempRoot, 'no-web-dist');
  for (const directory of [directHome, httpHome, reverseHome, coreHome, missingBinDir]) {
    await mkdir(directory, { recursive: true });
  }
  console.log(`  home      ${tempRoot}`);

  const missingBin = (name) => path.join(missingBinDir, name);
  const baseEnv = childEnv({
    MPANEL_CADDY_BIN: missingBin('caddy'),
    MPANEL_DOCKER_BIN: missingBin('docker'),
    MPANEL_PG_DUMP_BIN: missingBin('pg_dump'),
    MPANEL_PG_RESTORE_BIN: missingBin('pg_restore'),
    MPANEL_PSQL_BIN: missingBin('psql'),
    MPANEL_REDIS_CLI_BIN: missingBin('redis-cli'),
    MPANEL_LOG_LEVEL: 'error',
  });

  const directToken = randomToken();
  const directWorker = startNodeService(
    'worker-direct',
    workerEntry,
    childEnv({
      ...baseEnv,
      MPANEL_HOME: directHome,
      MPANEL_TOKEN: directToken,
      MPANEL_TRANSPORT: 'http',
      MPANEL_LISTEN: '127.0.0.1:0',
    }),
  );
  const directListening = await waitListening(directWorker);
  const directUrl = `http://127.0.0.1:${directListening.port}`;
  console.log(`  worker    ${directUrl}`);

  /* ------------------------------ a. worker ------------------------------ */

  await check('a1 worker healthz', async () => {
    const response = await request(directUrl, 'GET', '/healthz');
    assert(response.status === 200, `healthz status ${response.status}`);
    assert(response.json?.ok === true, 'healthz ok flag missing');
    assert(response.json?.role === 'worker', `healthz role ${String(response.json?.role)}`);
    assert(response.json?.status === 'ok', 'healthz status field');
    return `GET /healthz -> ${String(response.json.version)}/${String(response.json.role)}`;
  });

  await check('a2 worker system info capabilities', async () => {
    const response = await request(directUrl, 'GET', '/api/v1/system/info?refresh=1', {
      token: directToken,
    });
    const data = expectData(response, 'system/info');
    assert(data.role === 'worker', `role=${String(data.role)}`);
    assert(data.apiVersion === 1, `apiVersion=${String(data.apiVersion)}`);
    assert(data.features?.websocket === true, 'features.websocket missing');
    assert(data.capabilities !== null && typeof data.capabilities === 'object', 'capabilities missing');
    for (const name of ['caddy', 'docker', 'postgres', 'redis', 'pty']) {
      assert(
        typeof data.capabilities[name]?.available === 'boolean',
        `capability ${name} has no boolean available`,
      );
    }
    // Missing binaries are forced via *_BIN so the result is host independent.
    assert(data.capabilities.caddy.available === false, 'caddy unexpectedly available');
    assert(data.capabilities.docker.available === false, 'docker unexpectedly available');
    assert(data.capabilities.postgres.available === false, 'postgres unexpectedly available');
    return ['caddy', 'docker', 'postgres', 'redis', 'pty']
      .map((name) => `${name}=${data.capabilities[name].available}`)
      .join(' ');
  });

  await check('a3 worker rejects unauthenticated api calls', async () => {
    const response = await request(directUrl, 'GET', '/api/v1/system/info');
    const error = expectError(response, 'system/info without token', 'UNAUTHORIZED');
    assert(response.status === 401, `expected 401, got ${response.status}`);
    return `401 ${error.code}`;
  });

  /* ------------------------------- b. files ------------------------------ */

  const filesRoot = 'files';
  await check('b1 files mkdir/write/read/stat/rename/delete+trash', async () => {
    const roots = expectData(
      await request(directUrl, 'GET', '/api/v1/files/roots', { token: directToken }),
      'files/roots',
    );
    assert(Array.isArray(roots.items) && roots.items.length > 0, 'no file roots configured');
    assert(filesRoot === roots.items[0].name, `unexpected first root ${String(roots.items[0].name)}`);

    expectData(
      await request(directUrl, 'POST', '/api/v1/files/mkdir', {
        token: directToken,
        body: { root: filesRoot, path: '/smoke', recursive: true },
      }),
      'mkdir',
    );

    const marker = `MPANEL FILE ${randomToken(4)}`;
    const written = expectData(
      await request(directUrl, 'PUT', '/api/v1/files/write', {
        token: directToken,
        body: { root: filesRoot, path: '/smoke/hello.txt', content: marker },
      }),
      'write',
    );
    assert(written.type === 'file', `write type=${String(written.type)}`);

    const read = expectData(
      await request(directUrl, 'GET', `/api/v1/files/read${query({ root: filesRoot, path: '/smoke/hello.txt' })}`, {
        token: directToken,
      }),
      'read',
    );
    assert(read.content === marker, 'read content mismatch');

    const info = expectData(
      await request(directUrl, 'GET', `/api/v1/files/stat${query({ root: filesRoot, path: '/smoke/hello.txt' })}`, {
        token: directToken,
      }),
      'stat',
    );
    assert(info.type === 'file' && info.size === Buffer.byteLength(marker), 'stat mismatch');

    expectData(
      await request(directUrl, 'POST', '/api/v1/files/rename', {
        token: directToken,
        body: { root: filesRoot, from: '/smoke/hello.txt', to: '/smoke/renamed.txt' },
      }),
      'rename',
    );

    const removed = expectData(
      await request(
        directUrl,
        'DELETE',
        `/api/v1/files${query({ root: filesRoot, path: '/smoke/renamed.txt' })}`,
        { token: directToken },
      ),
      'delete',
    );
    assert(removed.trashed === true, 'delete did not move the file to trash');
    assert(typeof removed.trashId === 'string' && removed.trashId.length > 0, 'trashId missing');

    const trash = expectData(
      await request(directUrl, 'GET', '/api/v1/files/trash', { token: directToken }),
      'trash list',
    );
    assert(
      Array.isArray(trash.items) && trash.items.some((entry) => entry.id === removed.trashId),
      'trashed entry missing from /files/trash',
    );
    return `trashId=${removed.trashId}`;
  });

  await check('b2 files sandbox rejects traversal', async () => {
    const dotdot = await request(
      directUrl,
      'GET',
      `/api/v1/files/stat${query({ root: filesRoot, path: '../escape.txt' })}`,
      { token: directToken },
    );
    expectError(dotdot, 'stat ../escape.txt');
    const backslash = await request(
      directUrl,
      'GET',
      `/api/v1/files/stat${query({ root: filesRoot, path: '..\\escape.txt' })}`,
      { token: directToken },
    );
    expectError(backslash, 'stat backslash escape');
    return `../ -> ${dotdot.status}, ..\\\\ -> ${backslash.status}`;
  });

  /* ------------------------------- c. sites ------------------------------ */

  const siteDomain = `smoke-${randomBytes(3).toString('hex')}.example.test`;
  const siteUpstream = '127.0.0.1:4321';
  let siteId = null;

  await check('c1 sites create/preview/list/delete', async () => {
    const created = expectData(
      await request(directUrl, 'POST', '/api/v1/sites', {
        token: directToken,
        body: {
          name: `smoke site ${randomToken(3)}`,
          enabled: true,
          config: {
            domains: [siteDomain],
            handler: { type: 'reverse_proxy', upstreams: [siteUpstream] },
          },
        },
      }),
      'sites create',
      201,
    );
    siteId = created.id;

    const preview = expectData(
      await request(directUrl, 'POST', '/api/v1/sites/preview', {
        token: directToken,
        body: { siteId },
      }),
      'sites preview',
    );
    assert(typeof preview.caddyfile === 'string', 'preview caddyfile missing');
    assert(preview.caddyfile.includes(siteDomain), 'preview does not contain the domain');
    assert(preview.caddyfile.includes(siteUpstream), 'preview does not contain the upstream');
    assert(Array.isArray(preview.warnings), 'preview warnings missing');

    const list = expectData(
      await request(directUrl, 'GET', '/api/v1/sites', { token: directToken }),
      'sites list',
    );
    assert(
      Array.isArray(list.items) && list.items.some((site) => site.id === siteId),
      'created site missing from list',
    );

    const removed = expectData(
      await request(directUrl, 'DELETE', `/api/v1/sites/${siteId}`, { token: directToken }),
      'sites delete',
    );
    assert(removed.deleted === true, 'delete flag missing');
    const after = expectData(
      await request(directUrl, 'GET', '/api/v1/sites', { token: directToken }),
      'sites list after delete',
    );
    assert(!after.items.some((site) => site.id === siteId), 'deleted site still listed');
    siteId = null;
    return `domain=${siteDomain} upstream=${siteUpstream}`;
  });

  await check('c2 sites apply UNAVAILABLE without caddy', async () => {
    const created = expectData(
      await request(directUrl, 'POST', '/api/v1/sites', {
        token: directToken,
        body: {
          name: `smoke apply ${randomToken(3)}`,
          enabled: true,
          config: {
            domains: [siteDomain],
            handler: { type: 'reverse_proxy', upstreams: [siteUpstream] },
          },
        },
      }),
      'sites create for apply',
      201,
    );
    const applied = await request(directUrl, 'POST', '/api/v1/sites/apply', {
      token: directToken,
      body: { siteIds: [created.id] },
    });
    const error = expectError(applied, 'sites apply', 'UNAVAILABLE');
    assert(
      typeof error.details?.hint === 'string' && error.details.hint.length > 0,
      'UNAVAILABLE details.hint missing',
    );
    expectData(
      await request(directUrl, 'DELETE', `/api/v1/sites/${created.id}`, { token: directToken }),
      'sites cleanup',
    );
    return `503 ${error.code} (${String(error.details?.reason).slice(0, 80)})`;
  });

  /* ------------------------------- d. tasks ------------------------------ */

  const taskMarker = `MPANEL_TASK_${randomToken(4)}`;
  let taskId = null;

  await check('d1 tasks next-runs returns 5 for */5 * * * *', async () => {
    const created = expectData(
      await request(directUrl, 'POST', '/api/v1/tasks', {
        token: directToken,
        body: {
          name: `smoke task ${randomToken(3)}`,
          schedule: '*/5 * * * *',
          command: `node -e "process.stdout.write('${taskMarker}')"`,
          enabled: true,
        },
      }),
      'tasks create',
      201,
    );
    taskId = created.id;
    const next = expectData(
      await request(directUrl, 'GET', `/api/v1/tasks/${taskId}/next-runs${query({ count: 5 })}`, {
        token: directToken,
      }),
      'tasks next-runs',
    );
    assert(Array.isArray(next.nextRuns), 'nextRuns missing');
    assert(next.nextRuns.length === 5, `expected 5 next runs, got ${next.nextRuns.length}`);
    for (const entry of next.nextRuns) {
      assert(typeof entry.at === 'string' && Number.isFinite(Date.parse(entry.at)), 'invalid nextRun.at');
    }
    return `${next.nextRuns.length} next runs`;
  });

  await check('d2 tasks run-now succeeds with fixed output', async () => {
    assert(taskId !== null, 'task was not created');
    const started = expectData(
      await request(directUrl, 'POST', `/api/v1/tasks/${taskId}/run`, {
        token: directToken,
        body: {},
      }),
      'tasks run',
    );
    assert(typeof started.run?.id === 'string', 'run id missing');
    const success = await waitFor(
      async () => {
        const history = expectData(
          await request(directUrl, 'GET', `/api/v1/tasks/${taskId}/history${query({ limit: 50 })}`, {
            token: directToken,
          }),
          'tasks history',
        );
        const run = history.items.find((entry) => entry.id === started.run.id);
        if (run === undefined) return null;
        if (run.status === 'running') return null;
        if (run.status !== 'success') {
          throw new Error(
            `run status=${run.status} stderr=${JSON.stringify(run.stderrTail ?? '').slice(0, 300)}`,
          );
        }
        return run;
      },
      'task run success',
      30_000,
      250,
    );
    assert(
      String(success.stdoutTail ?? '').includes(taskMarker),
      `stdout tail does not contain marker: ${JSON.stringify(success.stdoutTail ?? '')}`,
    );
    expectData(
      await request(directUrl, 'DELETE', `/api/v1/tasks/${taskId}`, { token: directToken }),
      'tasks delete',
    );
    taskId = null;
    return `run=${success.id} exit=${String(success.exitCode)}`;
  });

  /* --------------------------- e. containers/db -------------------------- */

  await check('e1 containers list unavailable without docker', async () => {
    const listed = expectData(
      await request(directUrl, 'GET', '/api/v1/containers', { token: directToken }),
      'containers list',
    );
    assert(listed.available === false, `expected available=false, got ${String(listed.available)}`);
    assert(Array.isArray(listed.items) && listed.items.length === 0, 'items should be empty');
    assert(typeof listed.reason === 'string' && listed.reason.length > 0, 'reason missing');
    return `available=false (${String(listed.reason).slice(0, 80)})`;
  });

  let dbProfileId = null;
  const dbPassword = `Smoke-${randomToken(8)}`;

  await check('e2 databases profile hides password, handoff issues a ticket', async () => {
    const created = expectData(
      await request(directUrl, 'POST', '/api/v1/databases/profiles', {
        token: directToken,
        body: {
          name: `smoke pg ${randomToken(3)}`,
          kind: 'postgres',
          host: '127.0.0.1',
          port: 5432,
          username: 'smoke',
          password: dbPassword,
          database: 'smoke',
        },
      }),
      'databases create',
      201,
    );
    dbProfileId = created.id;
    assert(created.hasPassword === true, 'hasPassword should be true');

    const list = expectData(
      await request(directUrl, 'GET', '/api/v1/databases/profiles', { token: directToken }),
      'databases list',
    );
    assert(list.available === true, 'profile store must stay available without pg/redis');
    assert(
      Array.isArray(list.items) && list.items.some((profile) => profile.id === dbProfileId),
      'created profile missing from list',
    );
    assert(
      !JSON.stringify(list).includes(dbPassword),
      'database profile list leaked the plaintext password',
    );

    const ticket = expectData(
      await request(directUrl, 'POST', `/api/v1/databases/profiles/${dbProfileId}/handoff`, {
        token: directToken,
        body: { ttlSec: 60 },
      }),
      'databases handoff',
    );
    assert(typeof ticket.ticket === 'string' && ticket.ticket.length >= 16, 'handoff ticket missing');
    assert(typeof ticket.redeemUrl === 'string', 'handoff redeemUrl missing');

    const redeemed = expectData(
      await request(directUrl, 'POST', '/api/v1/databases/handoff/redeem', {
        body: { ticket: ticket.ticket },
      }),
      'handoff redeem',
    );
    assert(redeemed.profileId === dbProfileId, 'redeem profileId mismatch');
    assert(redeemed.password === dbPassword, 'redeem did not return the stored password');

    expectData(
      await request(directUrl, 'DELETE', `/api/v1/databases/profiles/${dbProfileId}`, {
        token: directToken,
      }),
      'databases delete',
    );
    dbProfileId = null;
    return `ticket=${ticket.ticket.slice(0, 6)}… redeem=ok`;
  });

  /* ------------------------------ f. terminal ---------------------------- */

  await check('f1 terminal websocket echoes output', async () => {
    const session = expectData(
      await request(directUrl, 'POST', '/api/v1/terminal/sessions', {
        token: directToken,
        body: { cols: 100, rows: 30 },
      }),
      'terminal create',
      201,
    );
    assert(typeof session.id === 'string', 'terminal session id missing');
    const ticket = expectData(
      await request(directUrl, 'POST', '/api/v1/auth/ws-ticket', {
        token: directToken,
        body: { path: `/ws/terminal/${session.id}` },
      }),
      'terminal ws ticket',
    );
    assert(typeof ticket.ticket === 'string', 'ws ticket missing');
    const wsUrl = `ws://127.0.0.1:${directListening.port}/ws/terminal/${encodeURIComponent(session.id)}${query({ ticket: ticket.ticket })}`;
    const socket = await openWebSocket(wsUrl, 15_000);
    try {
      const ready = await socket.waitFor((message) => message.type === 'ready', 'terminal ready', 15_000);
      assert(ready.session?.id === session.id, 'ready session id mismatch');
      const marker = `MPANEL_TERM_${randomToken(4)}`;
      socket.send({ type: 'input', data: `echo ${marker}\r` });
      const deadline = Date.now() + 20_000;
      for (;;) {
        if (socket.state.output.includes(marker)) break;
        if (socket.state.closed) {
          throw new Error(`terminal socket closed early (code=${String(socket.state.closeCode)})`);
        }
        if (Date.now() >= deadline) {
          throw new Error(`terminal output timeout; tail=${JSON.stringify(socket.state.output.slice(-400))}`);
        }
        await delay(50);
      }
      expectData(
        await request(directUrl, 'DELETE', `/api/v1/terminal/sessions/${session.id}`, {
          token: directToken,
        }),
        'terminal delete',
      );
      return `session=${session.id} pty=${String(session.pty)} marker=seen`;
    } finally {
      socket.close();
    }
  });

  /* -------------------------------- g. core ------------------------------ */

  const coreSessionSecret = randomToken();
  const adminPassword = 'Smoke-Admin-1234';
  const coreWorker = startNodeService(
    'core',
    coreEntry,
    childEnv({
      MPANEL_CORE_HOME: coreHome,
      MPANEL_LISTEN: '127.0.0.1:0',
      MPANEL_ALLOW_STDIO: '1',
      MPANEL_WORKER_ENTRY: workerEntry,
      MPANEL_WEB_DIST: emptyWebDist,
      MPANEL_LOG_LEVEL: 'error',
      MPANEL_SESSION_SECRET: coreSessionSecret,
    }),
  );
  const coreListening = await waitListening(coreWorker);
  const coreUrl = `http://127.0.0.1:${coreListening.port}`;
  console.log(`  core      ${coreUrl}`);

  let cookie = null;
  let httpWorker = null;
  let reverseWorker = null;
  const machineIds = { stdio: null, http: null, reverse: null };

  await check('g1 core first-run setup + login cookie', async () => {
    const tokenFile = path.join(coreHome, 'state', 'bootstrap-token');
    const bootstrap = await waitFor(
      async () => {
        try {
          const value = (await readFile(tokenFile, 'utf8')).trim();
          return value.length >= 32 ? value : null;
        } catch {
          return null;
        }
      },
      'bootstrap token',
      15_000,
      100,
    );
    const setup = await request(coreUrl, 'POST', '/api/v1/auth/setup', {
      body: { token: bootstrap, username: 'smoke-admin', password: adminPassword },
    });
    const setupData = expectData(setup, 'auth/setup', 201);
    assert(setupData.user?.username === 'smoke-admin', 'setup username mismatch');
    assert(setupData.user?.role === 'admin', 'setup user is not admin');

    const login = await request(coreUrl, 'POST', '/api/v1/auth/login', {
      body: { username: 'smoke-admin', password: adminPassword },
    });
    const loginData = expectData(login, 'auth/login');
    assert(loginData.user?.username === 'smoke-admin', 'login username mismatch');
    cookie = sessionCookie(login);
    assert(cookie !== null, 'login did not set mpanel_session cookie');
    const me = expectData(await request(coreUrl, 'GET', '/api/v1/auth/me', { cookie }), 'auth/me');
    assert(me.authenticated === true && me.role === 'core', 'auth/me mismatch');
    return `cookie=${cookie.split('=', 1)[0]} role=${String(me.user?.role)}`;
  });

  await check('g2 core stdio machine online + proxy system/info', async () => {
    assert(cookie !== null, 'no session cookie from g1');
    const created = expectData(
      await request(coreUrl, 'POST', '/api/v1/machines', {
        cookie,
        body: { name: `smoke-stdio-${randomToken(2)}`, transport: 'stdio', token: randomToken(32) },
      }),
      'machines create stdio',
      201,
    );
    machineIds.stdio = created.machine?.id ?? null;
    assert(typeof machineIds.stdio === 'string', 'stdio machine id missing');
    const machine = await waitFor(
      async () => {
        const current = expectData(
          await request(coreUrl, 'GET', `/api/v1/machines/${machineIds.stdio}`, { cookie }),
          'machines get stdio',
        );
        return current.status === 'online' ? current : null;
      },
      'stdio machine online',
      25_000,
      250,
    );
    assert(machine.transport === 'stdio', `transport=${String(machine.transport)}`);
    const info = expectData(
      await request(coreUrl, 'GET', `/api/v1/machines/${machineIds.stdio}/proxy/api/v1/system/info`, {
        cookie,
      }),
      'proxy stdio system/info',
    );
    assert(info.role === 'worker', `proxy returned role=${String(info.role)}`);
    assert(typeof info.worker?.name === 'string', 'worker descriptor missing');
    // 契约 §2.5 的写法（不带内层 /api/v1）必须继续可用。
    const contractForm = expectData(
      await request(coreUrl, 'GET', `/api/v1/machines/${machineIds.stdio}/proxy/system/info`, {
        cookie,
      }),
      'proxy stdio contract path',
    );
    assert(contractForm.role === 'worker', 'contract-form proxy path failed');
    return `id=${machineIds.stdio} status=online worker=${String(info.worker?.version)} proxy=both-forms`;
  });

  await check('g3 core http machine online + proxy system/info', async () => {
    assert(cookie !== null, 'no session cookie from g1');
    const httpToken = randomToken();
    httpWorker = startNodeService(
      'worker-http',
      workerEntry,
      childEnv({
        ...baseEnv,
        MPANEL_HOME: httpHome,
        MPANEL_TOKEN: httpToken,
        MPANEL_TRANSPORT: 'http',
        MPANEL_LISTEN: '127.0.0.1:0',
      }),
    );
    const listening = await waitListening(httpWorker);
    const created = expectData(
      await request(coreUrl, 'POST', '/api/v1/machines', {
        cookie,
        body: {
          name: `smoke-http-${randomToken(2)}`,
          transport: 'http',
          url: `http://127.0.0.1:${listening.port}`,
          token: httpToken,
        },
      }),
      'machines create http',
      201,
    );
    machineIds.http = created.machine?.id ?? null;
    assert(typeof machineIds.http === 'string', 'http machine id missing');
    const machine = await waitFor(
      async () => {
        const current = expectData(
          await request(coreUrl, 'GET', `/api/v1/machines/${machineIds.http}`, { cookie }),
          'machines get http',
        );
        return current.status === 'online' ? current : null;
      },
      'http machine online',
      25_000,
      250,
    );
    assert(machine.transport === 'http', `transport=${String(machine.transport)}`);
    const info = expectData(
      await request(coreUrl, 'GET', `/api/v1/machines/${machineIds.http}/proxy/api/v1/system/info`, {
        cookie,
      }),
      'proxy http system/info',
    );
    assert(info.role === 'worker', `proxy returned role=${String(info.role)}`);
    return `id=${machineIds.http} status=online worker=${String(info.worker?.version)}`;
  });

  await check('g4 core reverse-ws machine online + proxy system/info', async () => {
    assert(cookie !== null, 'no session cookie from g1');
    const created = expectData(
      await request(coreUrl, 'POST', '/api/v1/machines', {
        cookie,
        body: { name: `smoke-reverse-${randomToken(2)}`, transport: 'reverse-ws' },
      }),
      'machines create reverse-ws',
      201,
    );
    machineIds.reverse = created.machine?.id ?? null;
    assert(typeof machineIds.reverse === 'string', 'reverse machine id missing');
    assert(created.enrollment !== undefined, 'reverse-ws enrollment missing');
    assert(typeof created.enrollment.secret === 'string', 'enrollment secret missing');
    assert(
      String(created.enrollment.url).includes('/ws/worker'),
      `enrollment url=${String(created.enrollment.url)}`,
    );
    reverseWorker = startNodeService(
      'worker-reverse',
      workerEntry,
      childEnv({
        ...created.enrollment.workerEnv,
        MPANEL_HOME: reverseHome,
        MPANEL_LOG_LEVEL: 'error',
      }),
    );
    const machine = await waitFor(
      async () => {
        const current = expectData(
          await request(coreUrl, 'GET', `/api/v1/machines/${machineIds.reverse}`, { cookie }),
          'machines get reverse',
        );
        return current.status === 'online' ? current : null;
      },
      'reverse-ws machine online',
      15_000,
      200,
    );
    assert(machine.transport === 'reverse-ws', `transport=${String(machine.transport)}`);
    const info = expectData(
      await request(coreUrl, 'GET', `/api/v1/machines/${machineIds.reverse}/proxy/api/v1/system/info`, {
        cookie,
      }),
      'proxy reverse system/info',
    );
    assert(info.role === 'worker', `proxy returned role=${String(info.role)}`);
    return `id=${machineIds.reverse} status=online worker=${String(info.worker?.version)}`;
  });

  await check('g5 core deletes all machines', async () => {
    assert(cookie !== null, 'no session cookie from g1');
    let deleted = 0;
    for (const id of Object.values(machineIds)) {
      if (id === null) continue;
      const removed = expectData(
        await request(coreUrl, 'DELETE', `/api/v1/machines/${id}`, { cookie }),
        `machines delete ${id}`,
      );
      assert(removed.deleted === true, `delete flag missing for ${id}`);
      deleted += 1;
    }
    const list = expectData(
      await request(coreUrl, 'GET', '/api/v1/machines', { cookie }),
      'machines list after delete',
    );
    for (const id of Object.values(machineIds)) {
      if (id === null) continue;
      assert(!list.items.some((machine) => machine.id === id), `machine ${id} still listed`);
    }
    return `${deleted} machines deleted`;
  });

  /* -------------------------------- h. audit ----------------------------- */

  await check('h1 audit records login and machine writes', async () => {
    const file = path.join(coreHome, 'audit.jsonl');
    const events = await waitFor(
      async () => {
        let text;
        try {
          text = await readFile(file, 'utf8');
        } catch {
          return null;
        }
        const parsed = [];
        for (const line of text.split(/\r?\n/)) {
          if (line.trim().length === 0) continue;
          try {
            parsed.push(JSON.parse(line));
          } catch {
            // partial trailing line while appending
          }
        }
        const login = parsed.some(
          (event) => event.action === 'auth.login' && event.result === 'ok' && event.actor === 'smoke-admin',
        );
        const creates = parsed.filter(
          (event) => event.action === 'machine.create' && event.result === 'ok',
        ).length;
        const deletes = parsed.filter(
          (event) => event.action === 'machine.delete' && event.result === 'ok',
        ).length;
        if (login && creates >= 3 && deletes >= 3) return { login, creates, deletes };
        return null;
      },
      'audit entries',
      15_000,
      200,
    );
    return `auth.login=ok machine.create=${events.creates} machine.delete=${events.deletes}`;
  });

  /* -------------------------------- i. edge ------------------------------- */

  const edgeGroup = `smoke-edge-${randomBytes(2).toString('hex')}`;
  let edgeKeyId = null;
  let edgeKeySecret = null;
  let edgeMachineId = null;
  let edgeWorker = null;

  const startEdgeWorker = (label, home) =>
    startNodeService(
      label,
      workerEntry,
      childEnv({
        ...baseEnv,
        MPANEL_HOME: home,
        MPANEL_EDGE_KEY: edgeKeySecret,
        MPANEL_CORE_URL: coreUrl,
        MPANEL_TRANSPORT: 'reverse-ws',
        MPANEL_LOG_LEVEL: 'error',
      }),
    );

  const findEdgeMachine = async () => {
    const list = expectData(
      await request(coreUrl, 'GET', '/api/v1/machines', { cookie }),
      'machines list edge',
    );
    return list.items.find((machine) => machine.edge === true && machine.group === edgeGroup) ?? null;
  };

  await check('i1 edge key create with group + maxUses, listed with uses=0', async () => {
    assert(cookie !== null, 'no session cookie from g1');
    const created = expectData(
      await request(coreUrl, 'POST', '/api/v1/edge/keys', {
        cookie,
        body: {
          name: `smoke-edge-key-${randomToken(2)}`,
          group: edgeGroup,
          maxUses: 2,
        },
      }),
      'edge key create',
      201,
    );
    assert(created.key !== undefined, 'edge key payload missing');
    edgeKeyId = created.key.id;
    edgeKeySecret = created.secret;
    assert(created.key.uses === 0, `expected uses=0, got ${String(created.key.uses)}`);
    assert(created.key.maxUses === 2, `expected maxUses=2, got ${String(created.key.maxUses)}`);
    assert(created.key.group === edgeGroup, `group=${String(created.key.group)}`);
    assert(created.key.revokedAt === null, 'new key must not be revoked');
    assert(
      typeof edgeKeySecret === 'string' && edgeKeySecret.length >= 16,
      'edge key secret missing or too short',
    );

    const list = expectData(
      await request(coreUrl, 'GET', '/api/v1/edge/keys', { cookie }),
      'edge keys list',
    );
    assert(list.available === true, `edge keys available=${String(list.available)}`);
    assert(typeof list.total === 'number', 'edge keys total missing');
    const found = list.items.find((key) => key.id === edgeKeyId);
    assert(found !== undefined, 'created edge key missing from list');
    assert(found.uses === 0, `listed key uses=${String(found.uses)}`);
    assert(!JSON.stringify(list).includes(edgeKeySecret), 'edge keys list leaked the secret');
    return `id=${edgeKeyId} group=${edgeGroup} uses=0 maxUses=2`;
  });

  await check('i2 edge worker enrolls and machine is online', async () => {
    assert(cookie !== null && edgeKeySecret !== null, 'edge key was not created');
    const edgeHome = path.join(tempRoot, 'worker-edge');
    edgeWorker = startEdgeWorker('worker-edge', edgeHome);
    const machine = await waitFor(
      async () => {
        if (edgeWorker.exited) {
          throw new Error(
            `edge worker exited (code=${String(edgeWorker.exitCode)}): ${edgeWorker.stderr.slice(-600)}`,
          );
        }
        const current = await findEdgeMachine();
        return current !== null && current.status === 'online' ? current : null;
      },
      'edge machine online',
      30_000,
      250,
    );
    edgeMachineId = machine.id;
    assert(machine.transport === 'reverse-ws', `transport=${String(machine.transport)}`);
    assert(machine.edge === true, 'machine.edge must be true');
    assert(machine.edgeKeyId === edgeKeyId, `edgeKeyId=${String(machine.edgeKeyId)}`);
    assert(machine.group === edgeGroup, `group=${String(machine.group)}`);

    const identity = JSON.parse(await readFile(path.join(edgeHome, 'edge.json'), 'utf8'));
    assert(identity.machineId === edgeMachineId, 'edge.json machineId mismatch');
    assert(
      !JSON.stringify(identity).includes(edgeKeySecret),
      'edge.json must not persist the enrollment key',
    );

    // PATCH /machines/:id 的 group（docs/api-contract.md §5.2 加法字段）必须生效。
    const patched = expectData(
      await request(coreUrl, 'PATCH', `/api/v1/machines/${edgeMachineId}`, {
        cookie,
        body: { group: `${edgeGroup}-patched` },
      }),
      'edge machine group patch',
    );
    assert(patched.group === `${edgeGroup}-patched`, `patched group=${String(patched.group)}`);
    const restored = expectData(
      await request(coreUrl, 'PATCH', `/api/v1/machines/${edgeMachineId}`, {
        cookie,
        body: { group: edgeGroup },
      }),
      'edge machine group restore',
    );
    assert(restored.group === edgeGroup, `restored group=${String(restored.group)}`);
    assert(restored.status === 'online', 'group patch must not restart the machine');

    const keys = expectData(
      await request(coreUrl, 'GET', '/api/v1/edge/keys', { cookie }),
      'edge keys list after enroll',
    );
    const key = keys.items.find((item) => item.id === edgeKeyId);
    assert(key !== undefined && key.uses === 1, `expected uses=1, got ${String(key?.uses)}`);
    return `machine=${edgeMachineId} status=online uses=1 identity=reused-ready`;
  });

  await check('i3 edge machine system snapshot via core proxy', async () => {
    assert(cookie !== null && edgeMachineId !== null, 'edge machine is not online');
    const snapshot = expectData(
      await request(
        coreUrl,
        'GET',
        `/api/v1/machines/${edgeMachineId}/proxy/system/snapshot`,
        { cookie },
      ),
      'proxy edge system/snapshot',
    );
    assert(typeof snapshot.hostname === 'string' && snapshot.hostname.length > 0, 'hostname missing');
    assert(typeof snapshot.platform === 'string' && snapshot.platform.length > 0, 'platform missing');
    assert(Array.isArray(snapshot.ips), 'ips missing');
    assert(snapshot.transport === 'reverse-ws', `transport=${String(snapshot.transport)}`);
    assert(typeof snapshot.pty === 'boolean', 'pty missing');
    assert(
      typeof snapshot.collectedAt === 'string' && Number.isFinite(Date.parse(snapshot.collectedAt)),
      'collectedAt invalid',
    );

    const metrics = expectData(
      await request(
        coreUrl,
        'GET',
        `/api/v1/machines/${edgeMachineId}/proxy/system/metrics`,
        { cookie },
      ),
      'proxy edge system/metrics',
    );
    assert(typeof metrics.cpuCount === 'number' && metrics.cpuCount > 0, 'metrics.cpuCount invalid');
    assert(
      metrics.cpuPercent === null ||
        (typeof metrics.cpuPercent === 'number' && metrics.cpuPercent >= 0 && metrics.cpuPercent <= 100),
      `metrics.cpuPercent=${String(metrics.cpuPercent)}`,
    );
    assert(
      metrics.loadavg === null || Array.isArray(metrics.loadavg),
      'metrics.loadavg must be null or an array',
    );
    return `hostname=${snapshot.hostname} platform=${snapshot.platform} cpu=${String(snapshot.cpuCount)} cpuPercent=${String(metrics.cpuPercent)}`;
  });

  await check('i4 run-task edge job succeeds with run info', async () => {
    assert(cookie !== null && edgeMachineId !== null, 'edge machine is not online');
    const taskMarker = `MPANEL_EDGE_TASK_${randomToken(4)}`;
    const task = expectData(
      await request(coreUrl, 'POST', `/api/v1/machines/${edgeMachineId}/proxy/tasks`, {
        cookie,
        body: {
          name: `smoke edge task ${randomToken(3)}`,
          schedule: '*/5 * * * *',
          command: `node -e "process.stdout.write('${taskMarker}')"`,
          enabled: true,
        },
      }),
      'edge task create via proxy',
      201,
    );
    assert(typeof task.id === 'string', 'task id missing');

    const job = expectData(
      await request(coreUrl, 'POST', '/api/v1/edge/jobs', {
        cookie,
        body: { machineId: edgeMachineId, kind: 'run-task', payload: { taskId: task.id } },
      }),
      'edge run-task job create',
      201,
    );
    assert(job.status === 'pending', `new job status=${String(job.status)}`);

    const done = await waitFor(
      async () => {
        const current = expectData(
          await request(coreUrl, 'GET', `/api/v1/edge/jobs/${job.id}`, { cookie }),
          'edge run-task job get',
        );
        if (current.status === 'pending' || current.status === 'running') return null;
        if (current.status !== 'succeeded') {
          throw new Error(`job status=${current.status} error=${JSON.stringify(current.error)}`);
        }
        return current;
      },
      'edge run-task job success',
      60_000,
      500,
    );
    assert(done.httpStatus === 200, `httpStatus=${String(done.httpStatus)}`);
    assert(done.result !== null && typeof done.result === 'object', 'job result is not an object');
    const run = done.result.run;
    assert(run !== undefined && typeof run.id === 'string', 'job result.run.id missing');
    assert(run.taskId === task.id, 'job result.run.taskId mismatch');
    return `job=${job.id} run=${run.id} http=200`;
  });

  await check('i5 offline snapshot job stays pending then succeeds after restart', async () => {
    assert(cookie !== null && edgeMachineId !== null && edgeWorker !== null, 'edge worker missing');
    await stopProcess(edgeWorker);
    edgeWorker = null;

    // 等待 core 把节点标记为离线，避免调度器把作业当作在线请求。
    await waitFor(
      async () => {
        const machine = expectData(
          await request(coreUrl, 'GET', `/api/v1/machines/${edgeMachineId}`, { cookie }),
          'edge machine health after kill',
        );
        return machine.status !== 'online' ? machine : null;
      },
      'edge machine offline',
      40_000,
      250,
    );

    const job = expectData(
      await request(coreUrl, 'POST', '/api/v1/edge/jobs', {
        cookie,
        body: { machineId: edgeMachineId, kind: 'snapshot', payload: {} },
      }),
      'edge snapshot job create',
      201,
    );
    assert(job.status === 'pending', `offline job status=${String(job.status)}`);
    await delay(1_500);
    const still = expectData(
      await request(coreUrl, 'GET', `/api/v1/edge/jobs/${job.id}`, { cookie }),
      'edge snapshot job pending',
    );
    assert(still.status === 'pending', `expected pending while offline, got ${still.status}`);

    edgeWorker = startEdgeWorker('worker-edge-restart', path.join(tempRoot, 'worker-edge'));
    const done = await waitFor(
      async () => {
        if (edgeWorker.exited) {
          throw new Error(
            `restarted edge worker exited (code=${String(edgeWorker.exitCode)}): ${edgeWorker.stderr.slice(-600)}`,
          );
        }
        const current = expectData(
          await request(coreUrl, 'GET', `/api/v1/edge/jobs/${job.id}`, { cookie }),
          'edge snapshot job after restart',
        );
        if (current.status === 'pending' || current.status === 'running') return null;
        if (current.status !== 'succeeded') {
          throw new Error(`job status=${current.status} error=${JSON.stringify(current.error)}`);
        }
        return current;
      },
      'edge snapshot job success after restart',
      90_000,
      500,
    );
    assert(done.result !== null && typeof done.result === 'object', 'snapshot result missing');
    assert(typeof done.result.hostname === 'string', 'snapshot result.hostname missing');

    const machines = expectData(
      await request(coreUrl, 'GET', '/api/v1/machines', { cookie }),
      'machines list after restart',
    );
    const edgeMachines = machines.items.filter(
      (machine) => machine.edge === true && machine.group === edgeGroup,
    );
    assert(edgeMachines.length === 1, `expected 1 edge machine, got ${edgeMachines.length}`);
    assert(edgeMachines[0].id === edgeMachineId, 'edge identity was not reused');
    return `job=${job.id} pending-then-succeeded machine=${edgeMachineId}`;
  });

  await check('i6 revoked key rejects re-enrollment with 403/FORBIDDEN', async () => {
    assert(cookie !== null && edgeKeyId !== null && edgeKeySecret !== null, 'edge key missing');
    expectData(
      await request(coreUrl, 'DELETE', `/api/v1/edge/keys/${edgeKeyId}`, { cookie }),
      'edge key revoke',
    );
    const rejected = await request(coreUrl, 'POST', '/api/v1/edge/enroll', {
      body: { key: edgeKeySecret, platform: 'linux', arch: 'x64', version: '0.1.0' },
    });
    const error = expectError(rejected, 'enroll with revoked key', 'FORBIDDEN');
    assert(rejected.status === 403, `expected 403, got ${rejected.status}`);

    const rejectedHome = path.join(tempRoot, 'worker-edge-rejected');
    const rejectedWorker = startEdgeWorker('worker-edge-rejected', rejectedHome);
    const exited = await waitExit(rejectedWorker, 20_000);
    assert(exited, 'worker with revoked key did not exit');
    assert(rejectedWorker.exitCode !== 0, `exitCode=${String(rejectedWorker.exitCode)}`);
    assert(
      /403|FORBIDDEN/.test(rejectedWorker.stderr),
      `worker stderr lacks 403/FORBIDDEN: ${rejectedWorker.stderr.slice(-400)}`,
    );
    return `enroll=403 ${error.code} workerExit=${String(rejectedWorker.exitCode)}`;
  });
}

/* ------------------------------------------------------------------ */

let fatal = null;
try {
  await main();
} catch (error) {
  fatal = error;
  failed += 1;
  console.log(`FAIL smoke bootstrap — ${oneLine(error)}`);
} finally {
  for (const handle of [...processes].reverse()) {
    await stopProcess(handle).catch(() => undefined);
  }
  if (tempRoot !== null) {
    if (keepTemp) {
      console.log(`KEEP temp dir: ${tempRoot}`);
    } else {
      await rm(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(
        () => undefined,
      );
    }
  }
}

if (fatal !== null) {
  console.log(`smoke bootstrap error: ${oneLine(fatal)}`);
}

if (failed > 0) {
  console.log(`SMOKE: FAIL ${failed} failed`);
  process.exitCode = 1;
} else {
  console.log(`SMOKE: PASS ${results.length} checks`);
  process.exitCode = 0;
}
