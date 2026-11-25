#!/usr/bin/env node
// Deterministic gate for the MPanel monorepo.
//
// 1. Parses the frozen ownership table in docs/file-layout.md:
//    every path must exist, owners must be from the 16-name roster, paths are
//    unique and each web page directory has exactly one owner.
// 2. Static prohibitions (exec/execSync/shell:true/stdio:'inherit', web importing
//    @mpanel/shared, TODO/FIXME markers, worker console/stdout misuse).
// 3. Reverse coverage: every server source file and web src TS/TSX file is owned.
// 4. API §15 type-mirror coverage in web/src/api/types.ts.
// 5. `tsc -b` at the repo root, web typecheck and `vite build` (spawnSync via the
//    current node binary; never pnpm/npm, which are .cmd shims on Windows).
//
// Flags: --no-typecheck, --no-build, --verbose. Exits 1 on any failure.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);
const verbose = args.has('--verbose');
const runTypecheck = !args.has('--no-typecheck');
const runBuild = !args.has('--no-build');

const failures = [];
const stats = { paths: 0, files: 0, types: 0 };

function fail(message) {
  failures.push(message);
}

function info(message) {
  if (verbose) console.log(`[check] ${message}`);
}

function rel(filePath) {
  return path.relative(root, filePath).split(path.sep).join('/');
}

function walk(dir, predicate, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      walk(full, predicate, out);
      continue;
    }
    if (entry.isFile() && predicate(full)) out.push(full);
  }
  return out;
}

function read(relPath) {
  return readFileSync(path.join(root, relPath), 'utf8');
}

/* ------------------------------------------------------------------ */
/* 1. Ownership table                                                  */
/* ------------------------------------------------------------------ */

const OWNERS = new Set([
  '架构',
  '脚手架',
  'worker 核心',
  'worker 站点',
  'worker 容器',
  'worker 数据',
  'worker 文件',
  'worker 终端与任务',
  'core 主机与代理',
  'core 认证与网关',
  '前端外壳',
  '前端数据库页',
  '前端容器页',
  '前端文件页',
  '前端终端与任务页',
  '边缘节点后端',
  '边缘节点与概览前端',
  '集成',
]);

const layoutText = read('docs/file-layout.md');
const tableStart = layoutText.indexOf('<!-- OWNERSHIP_TABLE_START -->');
const tableEnd = layoutText.indexOf('<!-- OWNERSHIP_TABLE_END -->');
const ownedPaths = new Set();
const pageDirOwners = new Map();

if (tableStart < 0 || tableEnd < 0 || tableEnd <= tableStart) {
  fail('docs/file-layout.md: ownership table markers are missing or out of order');
} else {
  const table = layoutText.slice(tableStart, tableEnd);
  for (const line of table.split(/\r?\n/)) {
    const match = /^\|\s*`([^`]+)`\s*\|\s*([^|]+?)\s*\|(.*)$/.exec(line.trim());
    if (match === null) continue;
    const filePath = match[1];
    const owner = match[2].trim();
    if (!OWNERS.has(owner)) {
      fail(`ownership: unknown owner "${owner}" for ${filePath}`);
      continue;
    }
    if (ownedPaths.has(filePath)) {
      fail(`ownership: duplicate path ${filePath}`);
      continue;
    }
    ownedPaths.add(filePath);
    stats.paths += 1;
    if (!existsSync(path.join(root, filePath))) {
      fail(`ownership: missing path ${filePath} (owner: ${owner})`);
    }
    const pageMatch = /^web\/src\/pages\/([^/]+)\//.exec(filePath);
    if (pageMatch !== null) {
      const dir = pageMatch[1];
      const existing = pageDirOwners.get(dir);
      if (existing !== undefined && existing !== owner) {
        fail(`ownership: page directory ${dir} has multiple owners (${existing}, ${owner})`);
      }
      pageDirOwners.set(dir, owner);
    }
  }
  if (ownedPaths.size === 0) fail('ownership: table parsed zero paths');
}

function isOwned(filePath) {
  return ownedPaths.has(filePath);
}

/* ------------------------------------------------------------------ */
/* 2/3. Static prohibitions + reverse coverage                         */
/* ------------------------------------------------------------------ */

const serverSources = walk(
  path.join(root, 'server'),
  (full) => full.endsWith('.ts') && full.includes(`${path.sep}src${path.sep}`),
);
const webSources = walk(path.join(root, 'web', 'src'), (full) => /\.(ts|tsx)$/.test(full));
stats.files = serverSources.length + webSources.length;

const bannedServerPatterns = [
  { regex: /child_process\.exec\s*\(/, label: 'child_process.exec(' },
  { regex: /\bexecSync\s*\(/, label: 'execSync(' },
  { regex: /shell:\s*true/, label: "shell: true" },
  { regex: /stdio:\s*['"]inherit['"]/, label: "stdio: 'inherit'" },
];

for (const full of serverSources) {
  const source = readFileSync(full, 'utf8');
  const filePath = rel(full);
  for (const rule of bannedServerPatterns) {
    if (rule.regex.test(source)) fail(`static: ${filePath} contains ${rule.label}`);
  }
  if (/\b(TODO|FIXME)\b/.test(source)) fail(`static: ${filePath} contains TODO/FIXME`);
  if (!isOwned(filePath)) fail(`coverage: ${filePath} is not in the ownership table`);
}

for (const full of webSources) {
  const source = readFileSync(full, 'utf8');
  const filePath = rel(full);
  if (
    /from\s+['"]@mpanel\/shared['"]/.test(source) ||
    /require\(\s*['"]@mpanel\/shared['"]\s*\)/.test(source)
  ) {
    fail(`static: ${filePath} imports @mpanel/shared (web must use api/types.ts)`);
  }
  if (/\b(TODO|FIXME)\b/.test(source)) fail(`static: ${filePath} contains TODO/FIXME`);
  if (!isOwned(filePath)) fail(`coverage: ${filePath} is not in the ownership table`);
}

const workerSourceRoot = path.join(root, 'server', 'worker', 'src');
const workerStdoutAllowlist = new Set([
  path.join(workerSourceRoot, 'index.ts'),
  path.join(workerSourceRoot, 'transports', 'http.ts'),
]);
for (const full of serverSources) {
  if (!full.startsWith(workerSourceRoot)) continue;
  if (workerStdoutAllowlist.has(full)) continue;
  const source = readFileSync(full, 'utf8');
  if (/console\.(log|info|debug)\s*\(/.test(source)) {
    fail(`static: ${rel(full)} uses console.log/info/debug (stdout is frames-only)`);
  }
  if (/process\.stdout\.write\s*\(/.test(source)) {
    fail(`static: ${rel(full)} writes to stdout (stdio mode must use stderr/pino)`);
  }
}

/* ------------------------------------------------------------------ */
/* 4. API §15 type mirror coverage                                     */
/* ------------------------------------------------------------------ */

const apiText = read('docs/api-contract.md');
const section15 = apiText.indexOf('## 15.');
const typesPath = 'web/src/api/types.ts';
if (section15 < 0) {
  fail('api-contract: §15 not found');
} else {
  const fenceStart = apiText.indexOf('```ts', section15);
  const fenceEnd = apiText.indexOf('```', fenceStart + 5);
  if (fenceStart < 0 || fenceEnd < 0) {
    fail('api-contract: §15 code fence not found');
  } else {
    const names = [];
    for (const match of apiText.slice(fenceStart, fenceEnd).matchAll(/\/\/\s*([A-Za-z0-9_]+)/g)) {
      names.push(match[1]);
    }
    const typesSource = read(typesPath);
    for (const name of names) {
      stats.types += 1;
      const exported = new RegExp(`export\\s+(?:type|interface)\\s+${name}\\b`).test(typesSource);
      if (!exported) fail(`types-mirror: ${typesPath} is missing export ${name}`);
    }
    if (names.length === 0) fail('types-mirror: §15 listed zero type names');
  }
}

/* ------------------------------------------------------------------ */
/* 4b. API §18 coverage table paths exist in the contract              */
/* ------------------------------------------------------------------ */

const section18 = apiText.indexOf('## 18.');
if (section18 < 0) {
  fail('api-contract: §18 not found');
} else {
  const tokens = new Set();
  for (const line of apiText.slice(section18).split(/\r?\n/)) {
    if (!line.startsWith('|')) continue;
    for (const match of line.matchAll(/`([^`]+)`/g)) tokens.add(match[1]);
  }
  if (tokens.size === 0) fail('api-contract: §18 lists no covered paths');
  for (const token of tokens) {
    if (!apiText.includes(token)) {
      fail(`api-contract: §18 path ${token} is not documented elsewhere`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 5. Build and typecheck                                              */
/* ------------------------------------------------------------------ */

function run(label, command, commandArgs, cwd, timeoutMs = 600_000) {
  info(`running ${label}: node ${commandArgs.join(' ')} (cwd ${rel(cwd) || '.'})`);
  const result = spawnSync(command, commandArgs, {
    cwd,
    encoding: 'utf8',
    env: process.env,
    timeout: timeoutMs,
  });
  if (result.error !== undefined && result.error !== null) {
    fail(`${label}: could not start (${result.error.message})`);
    return false;
  }
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  if (result.status !== 0) {
    fail(`${label}: failed with exit ${String(result.status)}\n${output}`);
    return false;
  }
  if (output.length > 0) info(`${label}: ${output}`);
  return true;
}

const tscBin = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const viteBin = path.join(root, 'web', 'node_modules', 'vite', 'bin', 'vite.js');

if (!existsSync(tscBin)) {
  fail(`build: TypeScript binary missing at ${rel(tscBin)}; run pnpm install`);
}

if (runTypecheck) {
  if (existsSync(tscBin)) {
    run('tsc -b', process.execPath, [tscBin, '-b'], root);
    run('web typecheck', process.execPath, [tscBin, '-p', 'web/tsconfig.json', '--noEmit'], root);
  }
} else {
  info('skipping typecheck (--no-typecheck)');
}

if (runBuild) {
  if (!existsSync(viteBin)) {
    fail(`build: Vite binary missing at ${rel(viteBin)}; run pnpm install`);
  } else {
    run('vite build', process.execPath, [viteBin, 'build'], path.join(root, 'web'));
  }
} else {
  info('skipping web build (--no-build)');
}

/* Shared artifacts must actually load (dist + zod resolution). */
if (runTypecheck && existsSync(path.join(root, 'server', 'shared', 'dist', 'index.js'))) {
  const sharedUrl = pathToFileURL(path.join(root, 'server', 'shared', 'dist', 'index.js')).href;
  const probe = [
    `const m = await import(${JSON.stringify(sharedUrl)});`,
    "if (typeof m.decodeTunnelFrame !== 'function') {",
    "  console.error('decodeTunnelFrame export missing');",
    '  process.exit(1);',
    '}',
  ].join('\n');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
  });
  if (result.status !== 0) {
    fail(
      `shared artifacts: import failed (exit ${String(result.status)})\n${`${result.stdout ?? ''}${result.stderr ?? ''}`.trim()}`,
    );
  } else {
    info('shared artifacts: loadable (decodeTunnelFrame present)');
  }
}

/* ------------------------------------------------------------------ */

if (failures.length > 0) {
  console.error(`CHECK: FAIL (${failures.length} issue${failures.length === 1 ? '' : 's'})`);
  failures.forEach((failure, index) => {
    console.error(`${index + 1}. ${failure}`);
  });
  process.exit(1);
}

console.log(
  `CHECK: PASS (${stats.paths} owned paths, ${stats.files} source files, ${stats.types} mirrored types)`,
);
process.exit(0);
