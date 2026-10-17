// OpenCode host contract test (release gate, spec §10).
//
// Runs the REAL OpenCode binary against probe plugins and records what the
// host actually does with them. Bun-only: `bun test tests/host/contract.test.ts`.
// vitest excludes tests/host/**.
//
// Binary:  $OPENCODE_BIN, else `opencode` on PATH. The version must equal
//          compatibility.json#opencode — this gates a pinned release.
// Isolation: every OpenCode process runs with HOME, USERPROFILE, XDG_*_HOME,
//          OPENCODE_CONFIG and OPENCODE_TEST_MANAGED_CONFIG_DIR pointed into a
//          fresh temp dir, and with a scrubbed environment (no *_API_KEY, no
//          inherited OPENCODE_*). Nothing under the real ~/.config/opencode,
//          ~/.local/share/opencode or ~/.cache/opencode is read or written.
// Model:   no credentials. A fake OpenAI-compatible server started here is the
//          only provider; it streams one fixed reply and records each request,
//          which is how the test sees the system prompt the host really sent.
// Output:  observed findings are written to $CT_HOST_FINDINGS_OUT (default
//          tests/host/host-findings.local.json, gitignored) for comparison
//          against the findings recorded in compatibility.json.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import type { ProbeRecord } from './fixtures/probe-shared.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures');
const COMPAT = JSON.parse(readFileSync(join(HERE, 'compatibility.json'), 'utf8')) as {
  opencode: string;
  findings?: {
    exportForms?: { default?: boolean; serverModule?: boolean };
    nestedLoaderLoads?: boolean;
    bareNpmSpecLoads?: boolean;
    mcpStatusEventTypes?: string[];
    skills?: { singularSkillDirAlsoRead?: boolean };
    systemTransform?: { auxiliaryTitleCallCarriesSessionId?: boolean };
  };
};
const BLOCK_HEADING = '## Curated Thoughts';
const SKILL_NAMES = ['curated-thoughts-usage', 'curated-thoughts-ops', 'curated-thoughts-sidecar'];
const RUN_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 300_000;

// ---------------------------------------------------------------------------
// Binary
// ---------------------------------------------------------------------------

function resolveOpencodeBin(): string {
  const fromEnv = process.env.OPENCODE_BIN;
  if (fromEnv) {
    if (!existsSync(fromEnv)) throw new Error(`OPENCODE_BIN=${fromEnv} does not exist`);
    return fromEnv;
  }
  const onPath = Bun.which('opencode');
  if (onPath) return onPath;
  throw new Error(
    'OpenCode binary not found. Set OPENCODE_BIN to an opencode executable ' +
      `(e.g. npm install --prefix <dir> opencode-ai@${COMPAT.opencode}; ` +
      'OPENCODE_BIN=<dir>/node_modules/.bin/opencode) or put opencode on PATH.',
  );
}

// ---------------------------------------------------------------------------
// Fake OpenAI-compatible provider
// ---------------------------------------------------------------------------

interface ChatMessage {
  role: string;
  content: unknown;
}
interface CapturedRequest {
  url: string;
  body: { messages?: ChatMessage[]; tools?: Array<{ function?: { name?: string; description?: string } }> };
}

/** Optional per-test script: return a tool call to stream instead of text. */
type ProviderScript = (body: CapturedRequest['body']) => { name: string; args: Record<string, unknown> } | null;
let providerScript: ProviderScript | null = null;

interface FakeProvider {
  baseURL: string;
  requests: CapturedRequest[];
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function startFakeProvider(): Promise<FakeProvider> {
  const requests: CapturedRequest[] = [];
  const server: Server = createServer(async (req, res) => {
    const raw = await readBody(req);
    const url = req.url ?? '';
    if (url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model', object: 'model' }] }));
      return;
    }
    let body: CapturedRequest['body'] & { stream?: boolean } = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      /* keep empty */
    }
    requests.push({ url, body });
    const created = Math.floor(Date.now() / 1000);
    const scripted = body.stream ? providerScript?.(body) ?? null : null;
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'fake-1',
          object: 'chat.completion',
          created,
          model: 'fake-model',
          choices: [{ index: 0, message: { role: 'assistant', content: 'probe-ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
      return;
    }
    // Minimal stream that makes `opencode run` complete: one content delta,
    // a stop, a usage chunk, [DONE].
    const chunk = (extra: object) =>
      `data: ${JSON.stringify({ id: 'fake-1', object: 'chat.completion.chunk', created, model: 'fake-model', ...extra })}\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    if (scripted) {
      // Scripted tool call (wisdom N3 contract): one tool_calls delta, then
      // finish_reason 'tool_calls'; the host runs the tool and calls back.
      res.write(
        chunk({
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                tool_calls: [
                  { index: 0, id: `call_${requests.length}`, type: 'function', function: { name: scripted.name, arguments: JSON.stringify(scripted.args) } },
                ],
              },
              finish_reason: null,
            },
          ],
        }),
      );
      res.write(chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }));
      res.write(chunk({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      res.end('data: [DONE]\n\n');
      return;
    }
    res.write(chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: 'probe-ok' }, finish_reason: null }] }));
    res.write(chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
    res.write(chunk({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ---------------------------------------------------------------------------
// Minimal npm registry (record-only: does a bare `plugin` npm spec load?)
// ---------------------------------------------------------------------------

function tarEntry(name: string, content: Buffer): Buffer {
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  header.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`, 136, 12, 'ascii');
  header.write('        ', 148, 8, 'ascii');
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  const pad = Buffer.alloc((512 - (content.length % 512)) % 512, 0);
  return Buffer.concat([header, content, pad]);
}

function npmTarball(files: Record<string, string>): Buffer {
  const entries = Object.entries(files).map(([name, text]) => tarEntry(`package/${name}`, Buffer.from(text)));
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024, 0)]));
}

interface FakeRegistry {
  url: string;
  hits: string[];
  close(): Promise<void>;
}

async function startFakeRegistry(pkgName: string, version: string, tarball: Buffer): Promise<FakeRegistry> {
  const hits: string[] = [];
  let base = '';
  const server = createServer(async (req, res) => {
    await readBody(req);
    const url = decodeURIComponent(req.url ?? '');
    hits.push(`${req.method} ${url}`);
    if (url === `/${pkgName}` || url === `/${pkgName}/${version}` || url === `/${pkgName}/latest`) {
      const manifest = {
        name: pkgName,
        version,
        main: 'index.js',
        type: 'module',
        dist: { tarball: `${base}/${pkgName}/-/${pkgName}-${version}.tgz` },
      };
      const body = url === `/${pkgName}`
        ? { name: pkgName, 'dist-tags': { latest: version }, versions: { [version]: manifest } }
        : manifest;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
      return;
    }
    if (url.endsWith('.tgz')) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(tarball);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"not found"}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url: base, hits, close: () => new Promise<void>((r) => server.close(() => r())) };
}

// ---------------------------------------------------------------------------
// Sandbox + runner
// ---------------------------------------------------------------------------

interface Sandbox {
  root: string;
  home: string;
  configHome: string; // XDG_CONFIG_HOME == $HOME/.config
  dataHome: string;
  cacheHome: string;
  stateHome: string;
  managedConfig: string;
  project: string;
  opencodeConfig: string; // OPENCODE_CONFIG
  probeOut: string;
}

function makeSandbox(label: string): Sandbox {
  // realpath: macOS tmpdir is /var -> /private/var, and the host reports
  // module URLs by their resolved path.
  const root = realpathSync(mkdtempSync(join(tmpdir(), `ct-oc-${label}-`)));
  const home = join(root, 'home');
  const sb: Sandbox = {
    root,
    home,
    configHome: join(home, '.config'),
    dataHome: join(home, '.local', 'share'),
    cacheHome: join(home, '.cache'),
    stateHome: join(home, '.local', 'state'),
    managedConfig: join(root, 'managed'),
    project: join(root, 'project'),
    opencodeConfig: join(root, 'opencode-custom.json'),
    probeOut: join(root, 'probe.jsonl'),
  };
  for (const dir of [sb.configHome, sb.dataHome, sb.cacheHome, sb.stateHome, sb.managedConfig, sb.project]) {
    mkdirSync(dir, { recursive: true });
  }
  return sb;
}

function writeOpencodeConfig(sb: Sandbox, provider: FakeProvider, extra: Record<string, unknown> = {}): void {
  const config = {
    $schema: 'https://opencode.ai/config.json',
    autoupdate: false,
    share: 'disabled',
    provider: {
      fake: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Fake (host contract test)',
        options: { baseURL: provider.baseURL, apiKey: 'not-a-real-key' },
        models: { 'fake-model': { name: 'Fake model' } },
      },
    },
    model: 'fake/fake-model',
    small_model: 'fake/fake-model',
    ...extra,
  };
  writeFileSync(sb.opencodeConfig, JSON.stringify(config, null, 2));
}

/** Scrubbed environment: only what a process needs to start, plus the sandbox. */
function sandboxEnv(sb: Sandbox, extra: Record<string, string> = {}): Record<string, string> {
  const keep = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'TERM'];
  const env: Record<string, string> = {};
  for (const key of keep) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return {
    ...env,
    HOME: sb.home,
    USERPROFILE: sb.home,
    XDG_CONFIG_HOME: sb.configHome,
    XDG_DATA_HOME: sb.dataHome,
    XDG_CACHE_HOME: sb.cacheHome,
    XDG_STATE_HOME: sb.stateHome,
    OPENCODE_CONFIG: sb.opencodeConfig,
    OPENCODE_TEST_MANAGED_CONFIG_DIR: sb.managedConfig,
    OPENCODE_DISABLE_AUTOUPDATE: 'true',
    OPENCODE_DISABLE_MODELS_FETCH: 'true',
    OPENCODE_DISABLE_SHARE: 'true',
    CT_PROBE_OUT: sb.probeOut,
    ...extra,
  };
}

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

async function runOpencode(bin: string, sb: Sandbox, args: string[], extraEnv: Record<string, string> = {}): Promise<RunResult> {
  const proc = Bun.spawn([bin, ...args], {
    cwd: sb.project,
    env: sandboxEnv(sb, extraEnv),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, RUN_TIMEOUT_MS);
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const exitCode = await proc.exited;
  clearTimeout(timer);
  return { exitCode, stdout, stderr, timedOut };
}

function readProbe(sb: Sandbox): ProbeRecord[] {
  if (!existsSync(sb.probeOut)) return [];
  return readFileSync(sb.probeOut, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ProbeRecord);
}

/** Bundle one fixture (inlining probe-shared) into a single ESM file. */
async function bundleFixture(entry: string, outFile: string): Promise<string> {
  const result = await Bun.build({ entrypoints: [join(FIXTURES, entry)], target: 'bun', format: 'esm' });
  if (!result.success) throw new Error(`bundling ${entry} failed: ${result.logs.join('\n')}`);
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, await result.outputs[0]!.text());
  return outFile;
}

/** The loader file install.sh renders (spec §4), pointing at a payload by file:// URL. */
function loaderSource(payloadIndex: string): string {
  return [
    '// Generated by curated-thoughts install.sh — do not edit.',
    `// Payload: ${dirname(dirname(dirname(payloadIndex)))}  (reinstall to move it)`,
    `export { CuratedThoughts } from ${JSON.stringify(pathToFileURL(payloadIndex).href)};`,
    '',
  ].join('\n');
}

function installSkillFixtures(sb: Sandbox): string {
  // $HOME/.config/opencode/skills/<name>/SKILL.md — plural `skills/`.
  // The REAL packaged skills, not fixtures: from Task 6 the packaged skills/
  // tree is the payload of record, and this is the copy install.ts performs.
  const skillsDir = join(sb.home, '.config', 'opencode', 'skills');
  const packaged = join(HERE, '..', '..', 'skills');
  for (const name of SKILL_NAMES) {
    const source = join(packaged, name);
    // No fallback: a missing packaged skill must fail the contract here,
    // not silently verify placeholder content instead of the shipped payload.
    cpSync(join(source, 'SKILL.md'), join(skillsDir, name, 'SKILL.md'));
  }
  return skillsDir;
}

/** Minimal SKILL.md frontmatter parser (flat `key: value` lines). */
function parseSkillFrontmatter(text: string): { data: Record<string, string>; body: string } {
  const end = text.indexOf('\n---', 4);
  const block = text.slice(4, end);
  const data: Record<string, string> = {};
  for (const line of block.split('\n')) {
    const m = /^([A-Za-z0-9_-]+):\s?(.*)$/.exec(line);
    if (m) data[m[1]] = m[2];
  }
  return { data, body: text.slice(end + 4) };
}

// ---------------------------------------------------------------------------
// Analysis helpers
// ---------------------------------------------------------------------------

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) count++;
  return count;
}

function isMcpStatus(type: string): boolean {
  return /mcp/i.test(type);
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'object' && part && 'text' in part ? String(part.text) : '')).join('');
  }
  return '';
}

function systemMessages(req: CapturedRequest): string[] {
  return (req.body.messages ?? []).filter((m) => m.role === 'system').map((m) => textOf(m.content));
}

function toolNames(req: CapturedRequest): string[] {
  return (req.body.tools ?? []).map((t) => t.function?.name ?? '');
}

const findings: Record<string, unknown> = {};
function record(key: string, value: unknown): void {
  findings[key] = value;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let bin: string;
let provider: FakeProvider;
const sandboxes: Sandbox[] = [];

beforeAll(async () => {
  bin = resolveOpencodeBin();
  provider = await startFakeProvider();
});

afterAll(async () => {
  await provider?.close();
  const out = process.env.CT_HOST_FINDINGS_OUT ?? join(HERE, 'host-findings.local.json');
  writeFileSync(out, `${JSON.stringify({ opencodeBin: bin, ...findings }, null, 2)}\n`);
  // Record-only findings are not asserted, but drift from what
  // compatibility.json claims must be visible in the job log.
  const recorded = COMPAT.findings ?? {};
  const pairs: Array<[string, unknown, unknown]> = [
    ['defaultExportInvoked', findings.defaultExportInvoked, recorded.exportForms?.default],
    ['serverModuleFormInvoked', findings.serverModuleFormInvoked, recorded.exportForms?.serverModule],
    ['nestedLoaderLoads', findings.nestedLoaderLoads, recorded.nestedLoaderLoads],
    ['bareNpmSpecLoads', findings.bareNpmSpecLoads, recorded.bareNpmSpecLoads],
    ['mcpStatusEventTypes', findings.mcpStatusEventTypes, recorded.mcpStatusEventTypes],
    ['singularSkillDirDiscovered', findings.singularSkillDirDiscovered, recorded.skills?.singularSkillDirAlsoRead],
    [
      'auxiliaryRequestsCarrySessionId',
      (findings.auxiliaryRequestsCarrySessionId as boolean[] | undefined)?.every(Boolean),
      recorded.systemTransform?.auxiliaryTitleCallCarriesSessionId,
    ],
  ];
  for (const [key, observed, claimed] of pairs) {
    if (observed === undefined) continue; // that test did not run
    if (JSON.stringify(observed) !== JSON.stringify(claimed)) {
      console.warn(`[host-contract] DRIFT ${key}: observed ${JSON.stringify(observed)}, compatibility.json says ${JSON.stringify(claimed)}`);
    }
  }
  console.log(`[host-contract] findings written to ${out}`);
  if (!process.env.CT_HOST_KEEP_SANDBOX) {
    for (const sb of sandboxes) rmSync(sb.root, { recursive: true, force: true });
  }
});

describe('OpenCode host contract', () => {
  test('binary is the pinned release', async () => {
    const proc = Bun.spawnSync([bin, '--version'], { env: sandboxEnv(makeSandboxTracked('version')) });
    const version = proc.stdout.toString().trim();
    record('opencodeVersion', version);
    expect(version).toBe(COMPAT.opencode);
  });

  // Step 1.4-1.7: the v0 install path, a session-bearing chat call, skills.
  test(
    'v0 loader-file install: named export, system transform, dispose, skills',
    async () => {
      const sb = makeSandboxTracked('v0');
      const requestsBefore = provider.requests.length;

      // Payload unpacked into the data dir, OUTSIDE plugins/ (spec §4).
      const payloadDir = join(sb.dataHome, 'curated-thoughts', 'opencode');
      const payloadIndex = await bundleFixture('probe-plugin.ts', join(payloadDir, 'lib', 'src', 'index.js'));
      const loaderPath = join(sb.configHome, 'opencode', 'plugins', 'curated-thoughts.js');
      mkdirSync(dirname(loaderPath), { recursive: true });
      writeFileSync(loaderPath, loaderSource(payloadIndex));
      const skillsDir = installSkillFixtures(sb);
      // Record-only: is the legacy singular `skill/` directory still read?
      const singular = join(sb.configHome, 'opencode', 'skill', 'ct-singular-probe');
      mkdirSync(singular, { recursive: true });
      writeFileSync(
        join(singular, 'SKILL.md'),
        '---\nname: ct-singular-probe\ndescription: Probe for the singular skill/ directory.\n---\n\nProbe.\n',
      );

      // An MCP server (and a broken one) so connection state has something to
      // report through `event`, if the host emits anything for it.
      writeOpencodeConfig(sb, provider, {
        mcp: {
          'ct-probe-ok': { type: 'local', command: [process.execPath, join(FIXTURES, 'mcp-server.ts')], enabled: true },
          'ct-probe-broken': { type: 'local', command: [join(sb.root, 'no-such-mcp-binary')], enabled: true },
        },
      });

      const first = await runOpencode(bin, sb, ['run', 'hello from the host contract test']);
      const second = await runOpencode(bin, sb, ['run', '--continue', 'second turn: repeated assembly']);
      for (const [name, run] of [['first', first], ['second', second]] as const) {
        if (run.exitCode !== 0 || run.timedOut) {
          console.error(`[${name}] exit=${run.exitCode} timedOut=${run.timedOut}\n${run.stderr.slice(-4000)}`);
        }
        expect(run.timedOut).toBe(false);
        expect(run.exitCode).toBe(0);
      }

      const records = readProbe(sb);
      const payloadUrl = pathToFileURL(payloadIndex).href;
      const named = records.filter((r) => r.form === 'named');
      const transforms = named.filter((r): r is Extract<ProbeRecord, { kind: 'transform' }> => r.kind === 'transform');
      const requests = provider.requests.slice(requestsBefore);
      const chatRequests = requests.filter((r) => toolNames(r).length > 0);
      const auxRequests = requests.filter((r) => toolNames(r).length === 0);

      // A transform record "belongs" to a request when its final array is
      // exactly the request's system messages.
      const matchesRequest = (t: (typeof transforms)[number], req: CapturedRequest) =>
        JSON.stringify(systemMessages(req)) === JSON.stringify(t.after);
      const chatTransforms = transforms.filter((t) => chatRequests.some((req) => matchesRequest(t, req)));

      const lastChat = chatRequests.at(-1);
      const probe = {
        namedExportInvoked: named.some((r) => r.kind === 'invoked' && r.module === payloadUrl),
        systemTransformFired: transforms.length > 0,
        sessionIdPresentOnChatCall: chatTransforms.length > 0 && chatTransforms.every((t) => t.sessionIDPresent),
        // What the host actually sent: every entry the host handed the hook
        // survives verbatim, in order, ahead of the pushed block.
        priorSystemEntriesPreserved:
          transforms.length > 0 &&
          transforms.every((t) => {
            const req = requests.find((r) => matchesRequest(t, r));
            if (!req) return false;
            const sent = systemMessages(req);
            return t.before.every((entry, i) => sent[i] === entry);
          }),
        finalSystem: lastChat ? systemMessages(lastChat) : [],
        disposeCalled: named.some((r) => r.kind === 'dispose'),
        eventTypes: [...new Set(named.filter((r) => r.kind === 'event').map((r) => (r as { type: string }).type))],
      };

      expect(probe.namedExportInvoked).toBe(true);
      expect(probe.systemTransformFired).toBe(true);
      expect(probe.sessionIdPresentOnChatCall).toBe(true);
      expect(probe.priorSystemEntriesPreserved).toBe(true); // pre-existing output.system entries verbatim
      expect(countOccurrences(probe.finalSystem.join('\n'), BLOCK_HEADING)).toBe(1);
      // Repeated assembly: every request the host sent carries the block once.
      for (const req of requests) expect(countOccurrences(systemMessages(req).join('\n'), BLOCK_HEADING)).toBe(1);
      expect(probe.disposeCalled).toBe(true);

      // Skills. In 1.18.31 the `skill` tool description no longer enumerates
      // skills; it says they are "listed in the system prompt", and the host
      // renders an <available_skills>-style listing of <skill><name>…</name>
      // <location>…</location></skill> entries into the agent system prompt.
      // Discovery is asserted there, with the location proving the file came
      // from $HOME/.config/opencode/skills/<name>/SKILL.md (plural).
      const skillTool = lastChat?.body.tools?.find((t) => t.function?.name === 'skill');
      const skillDescription = skillTool?.function?.description ?? '';
      const chatSystem = probe.finalSystem.join('\n');
      const skillSystem = probe.finalSystem.find((s) => s.includes('<skill>')) ?? '';
      expect(skillTool).toBeDefined();
      for (const name of SKILL_NAMES) {
        expect(chatSystem).toContain(`<name>${name}</name>`);
        expect(chatSystem).toContain(join(skillsDir, name, 'SKILL.md'));
      }
      // Task 6 (Step 6.4): OpenCode 1.18.31 lists skills in the SYSTEM PROMPT
      // (<available_skills>), not in the `skill` tool description (the tool
      // description only points at the system prompt — recorded below). The
      // real binary parsed the PACKAGED skills' frontmatter: name and
      // description from each SKILL.md appear in the host's listing.
      for (const name of SKILL_NAMES) {
        const { data } = parseSkillFrontmatter(readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8'));
        expect(skillSystem, `<skill>${name}</skill> listed by the host`).toContain(
          `<name>${name}</name>`,
        );
        expect(skillSystem, `frontmatter description of ${name} rendered`).toContain(
          `<description>${data.description}</description>`,
        );
      }

      // Recorded, not asserted — drives the unknown fallback and Task 3's
      // session-less guard.
      const invoked = named.find((r) => r.kind === 'invoked') as Extract<ProbeRecord, { kind: 'invoked' }> | undefined;
      record('v0LoaderFileLoads', probe.namedExportInvoked);
      record('namedExportInvoked', probe.namedExportInvoked);
      record('optionsUnderLoaderFile', invoked?.options ?? null);
      record('pluginInputKeys', invoked?.inputKeys ?? null);
      record('systemTransformFired', probe.systemTransformFired);
      record('sessionIdPresentOnChatCall', probe.sessionIdPresentOnChatCall);
      record('transformCalls', transforms.length);
      record('transformCallsWithoutSessionId', transforms.filter((t) => !t.sessionIDPresent).length);
      record('auxiliaryRequests', auxRequests.length);
      record(
        'auxiliaryRequestsCarrySessionId',
        transforms.filter((t) => auxRequests.some((req) => matchesRequest(t, req))).map((t) => t.sessionIDPresent),
      );
      record('systemEntriesHandedToHook', transforms.map((t) => t.before.length));
      record('blockAlreadyPresentWhenHookRan', transforms.some((t) => t.before.some((s) => s.startsWith(BLOCK_HEADING))));
      record('priorSystemEntriesPreserved', probe.priorSystemEntriesPreserved);
      record('disposeCalled', probe.disposeCalled);
      record('disposeCallsPerProcess', named.filter((r) => r.kind === 'dispose').length / 2);
      record('eventTypes', probe.eventTypes);
      record('mcpStatusEventTypes', probe.eventTypes.filter(isMcpStatus));
      record(
        'mcpEventPayloads',
        named.filter((r) => r.kind === 'event' && isMcpStatus(r.type)).map((r) => (r as { properties: unknown }).properties),
      );
      const mcpStatus = named.find((r) => r.kind === 'mcpStatus') as Extract<ProbeRecord, { kind: 'mcpStatus' }> | undefined;
      record('mcpStatusViaClient', mcpStatus ? { data: mcpStatus.data, error: mcpStatus.error } : null);
      record('mcpToolsVisibleToModel', lastChat ? toolNames(lastChat).filter((n) => /probe/i.test(n)) : []);
      record('skillsDiscoveredFromConfigSkillsDir', SKILL_NAMES.every((n) => chatSystem.includes(`<name>${n}</name>`)));
      record('skillsListedInSkillToolDescription', SKILL_NAMES.some((n) => skillDescription.includes(n)));
      record('singularSkillDirDiscovered', chatSystem.includes('<name>ct-singular-probe</name>'));
    },
    TEST_TIMEOUT_MS,
  );

  // Step 1.3/1.6 record-only: export forms and a loader in a subdirectory.
  test(
    'export forms and nested loader (recorded)',
    async () => {
      const sb = makeSandboxTracked('forms');
      const plugins = join(sb.configHome, 'opencode', 'plugins');
      await bundleFixture('probe-default.ts', join(plugins, 'probe-default.js'));
      await bundleFixture('probe-server.ts', join(plugins, 'probe-server.js'));
      await bundleFixture('probe-mixed.ts', join(plugins, 'probe-mixed.js'));
      // v0 assumes top-level loader files only; does a nested one load too?
      const payloadIndex = await bundleFixture('probe-plugin.ts', join(sb.dataHome, 'ct-nested-payload', 'lib', 'src', 'index.js'));
      mkdirSync(join(plugins, 'nested'), { recursive: true });
      writeFileSync(join(plugins, 'nested', 'curated-thoughts.js'), loaderSource(payloadIndex));
      writeOpencodeConfig(sb, provider);

      const run = await runOpencode(bin, sb, ['run', 'export-form probe']);
      if (run.exitCode !== 0) console.error(run.stderr.slice(-4000));
      expect(run.exitCode).toBe(0);

      const records = readProbe(sb);
      const invokedForms = records.filter((r) => r.kind === 'invoked').map((r) => r.form);
      const firedForms = [...new Set(records.filter((r) => r.kind === 'transform').map((r) => r.form))];
      const runtime = records.find((r): r is Extract<ProbeRecord, { kind: 'invoked' }> => r.kind === 'invoked')?.runtime;
      record('defaultExportInvoked', invokedForms.includes('default'));
      record('serverModuleFormInvoked', invokedForms.includes('server'));
      record('mixedModuleInvokes', {
        named: invokedForms.includes('mixed-named'),
        server: invokedForms.includes('mixed-server'),
      });
      record('invokedFormsInFormsRun', invokedForms);
      record('transformFiredForForms', firedForms);
      record('nestedLoaderLoads', invokedForms.includes('named'));
      record('hostEmbeddedRuntime', runtime ?? null);
    },
    TEST_TIMEOUT_MS,
  );

  // Step 1.4: per-plugin options from the ["<spec>", { … }] tuple form.
  test(
    'tuple-form options reach the plugin as the second argument',
    async () => {
      const sb = makeSandboxTracked('options');
      const payloadIndex = await bundleFixture('probe-plugin.ts', join(sb.root, 'tuple-payload', 'index.js'));
      const options = { marker: 'ct-host-contract', brainDir: '/tmp/ct-probe-brain' };
      writeOpencodeConfig(sb, provider, { plugin: [[pathToFileURL(payloadIndex).href, options]] });

      const run = await runOpencode(bin, sb, ['run', 'options probe']);
      if (run.exitCode !== 0) console.error(run.stderr.slice(-4000));
      expect(run.exitCode).toBe(0);

      const invoked = readProbe(sb).filter(
        (r): r is Extract<ProbeRecord, { kind: 'invoked' }> => r.kind === 'invoked' && r.form === 'named',
      );
      const optionsPropagated = invoked.some((r) => JSON.stringify(r.options) === JSON.stringify(options));
      record('fileUrlPluginSpecLoads', invoked.length > 0);
      record('optionsPropagated', optionsPropagated);
      record('optionsReceived', invoked.map((r) => r.options));
      expect(optionsPropagated).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  // Step 1.6 record-only: a bare npm spec in `plugin`, served by a local registry.
  test(
    'bare npm spec in plugin config (recorded)',
    async () => {
      const sb = makeSandboxTracked('npm');
      const pkgName = 'ct-host-probe-plugin';
      const version = '0.0.1';
      const bundle = await bundleFixture('probe-plugin.ts', join(sb.root, 'npm-src', 'index.js'));
      const tarball = npmTarball({
        'package.json': JSON.stringify({ name: pkgName, version, type: 'module', main: 'index.js' }),
        'index.js': readFileSync(bundle, 'utf8'),
      });
      const registry = await startFakeRegistry(pkgName, version, tarball);
      try {
        writeFileSync(join(sb.home, '.npmrc'), `registry=${registry.url}/\n`);
        writeOpencodeConfig(sb, provider, { plugin: [`${pkgName}@${version}`] });
        const run = await runOpencode(bin, sb, ['run', 'npm spec probe'], {
          NPM_CONFIG_REGISTRY: `${registry.url}/`,
          npm_config_registry: `${registry.url}/`,
          BUN_CONFIG_REGISTRY: `${registry.url}/`,
        });
        const invoked = readProbe(sb).filter((r) => r.kind === 'invoked' && r.form === 'named');
        record('bareNpmSpecLoads', invoked.length > 0);
        record('bareNpmSpecRun', {
          exitCode: run.exitCode,
          timedOut: run.timedOut,
          registryHits: registry.hits,
          stderrTail: invoked.length > 0 ? undefined : run.stderr.slice(-1500),
        });
      } finally {
        await registry.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  // Leg spec LD11 (cross-harness parity, OpenCode leg; AC 2/7/10/11 at the
  // host): the REAL built payload (lib/ incl. the vendored ct-wisdom-core),
  // loaded through the v0 loader file, against the real pinned binary. CT is
  // a test-only stub `ct` on PATH (tests/fixtures/ct-stub.mjs) plus a fake CT
  // MCP server; the fake provider scripts one recall tool call per turn.
  test(
    'wisdom live delivery: bootstrap + chat.message append + MCP N3 rewrite, exactly once across processes',
    async () => {
      const sb = makeSandboxTracked('wisdom');
      const pkgRoot = join(HERE, '..', '..');
      const builtEntry = join(pkgRoot, 'lib', 'src', 'index.js');
      if (!existsSync(builtEntry) || !existsSync(join(pkgRoot, 'lib', 'ct-wisdom-core', 'index.js'))) {
        throw new Error('built payload missing: run `pnpm run build` (core built first) before the host contract');
      }
      // Install the payload the way registration.ts does: lib/ + package.json.
      const payloadDir = join(sb.dataHome, 'curated-thoughts', 'opencode');
      cpSync(join(pkgRoot, 'lib'), join(payloadDir, 'lib'), { recursive: true });
      cpSync(join(pkgRoot, 'package.json'), join(payloadDir, 'package.json'));
      const payloadIndex = join(payloadDir, 'lib', 'src', 'index.js');
      const loaderPath = join(sb.configHome, 'opencode', 'plugins', 'curated-thoughts.js');
      mkdirSync(dirname(loaderPath), { recursive: true });
      writeFileSync(loaderPath, loaderSource(payloadIndex));

      // Test-only `ct` on PATH.
      const stubBin = join(sb.root, 'bin');
      mkdirSync(stubBin, { recursive: true });
      cpSync(join(HERE, '..', 'fixtures', 'ct-stub.mjs'), join(stubBin, 'ct'));
      chmodSync(join(stubBin, 'ct'), 0o755);
      const ctLog = join(sb.root, 'ct.jsonl');
      const mcpLog = join(sb.root, 'mcp.jsonl');
      const fact = (id: string) => ({ id, title: `Fact ${id}`, text: `The body of ${id}.` });
      const extraEnv = {
        PATH: `${stubBin}${delimiter}${process.env.PATH ?? ''}`, // POSIX-only stub (ubuntu CI job)
        CURATED_BRAIN_DIR: join(sb.root, 'brain'),
        CT_STUB_LOG: ctLog,
        CT_STUB_RECALL: JSON.stringify([fact('hc-boot-1')]),
        // The stub ignores --exclude: the plugin's own post-filter must hold.
        CT_STUB_MATCH: JSON.stringify([fact('hc-live-1'), fact('hc-live-2')]),
        CT_STUB_IGNORE_EXCLUDE: '1',
        CT_HC_RECALL_IDS: 'hc-live-1,hc-recall-1',
        CT_HC_MCP_LOG: mcpLog,
      };

      const RECALL_TOOL = 'curated-thoughts_curated_recall_context';
      writeOpencodeConfig(sb, provider, {
        mcp: { 'curated-thoughts': { type: 'local', command: [process.execPath, join(FIXTURES, 'ct-mcp-server.ts')], enabled: true } },
        permission: { 'curated-thoughts_*': 'allow' },
      });
      providerScript = (body) => {
        const messages = body.messages ?? [];
        const last = messages.at(-1);
        const offersRecall = toolNames({ url: '', body }).includes(RECALL_TOOL);
        if (offersRecall && last?.role === 'user' && textOf(last.content).includes('CALL_RECALL')) {
          return { name: RECALL_TOOL, args: { query: 'tire pressure' } };
        }
        return null;
      };
      const requestsBefore = provider.requests.length;
      let first: RunResult;
      let second: RunResult;
      let turnOneEnd = 0;
      try {
        first = await runOpencode(bin, sb, ['run', 'CALL_RECALL turn one: what is the tire pressure?'], extraEnv);
        turnOneEnd = provider.requests.length;
        second = await runOpencode(bin, sb, ['run', '--continue', 'CALL_RECALL turn two: and again?'], extraEnv);
      } finally {
        providerScript = null;
      }
      for (const [name, run] of [['first', first], ['second', second]] as const) {
        if (run.exitCode !== 0 || run.timedOut) console.error(`[${name}] exit=${run.exitCode}\n${run.stderr.slice(-4000)}`);
        expect(run.timedOut).toBe(false);
        expect(run.exitCode).toBe(0);
      }

      const chat = (from: number, to: number) =>
        provider.requests.slice(from, to).filter((r) => toolNames(r).includes(RECALL_TOOL));
      // Parts joined by newlines (textOf concatenates them, which would glue
      // a part's last line to the next part's first).
      const partsText = (content: unknown) =>
        Array.isArray(content) ? content.map((p) => textOf([p])).join('\n') : textOf(content);
      const all = (r: CapturedRequest) => (r.body.messages ?? []).map((m) => partsText(m.content)).join('\n');
      const toolResults = (r: CapturedRequest) =>
        (r.body.messages ?? []).filter((m) => m.role === 'tool').map((m) => partsText(m.content));
      const t1 = chat(requestsBefore, turnOneEnd);
      const t2 = chat(turnOneEnd, provider.requests.length);
      expect(t1.length).toBeGreaterThanOrEqual(2); // user turn + after-tool callback
      expect(t2.length).toBeGreaterThanOrEqual(2);
      const LIVE = 'source.kind: curated-thoughts/wisdom';
      const BOOT = 'source.kind: curated-thoughts/wisdom-bootstrap';
      const lines = (text: string, line: string) => text.split('\n').filter((l) => l.trim() === line).length;

      // (a) Turn 1, first request: bootstrap block + live block, each once;
      // the bootstrap fact is not live-delivered again; the stub's
      // already-delivered ids never re-enter (post-filter).
      const t1first = all(t1[0]!);
      expect(lines(t1first, BOOT)).toBe(1);
      expect(lines(t1first, LIVE)).toBe(1);
      expect(countOccurrences(t1first, 'ct-fact:hc-boot-1')).toBe(1);
      expect(countOccurrences(t1first, 'ct-fact:hc-live-1')).toBe(1);
      expect(countOccurrences(t1first, 'ct-fact:hc-live-2')).toBe(1);

      // (b) N3 on the real MCP shape: the tool result the host sent back
      // stubs the id delivered this turn and trails the new one.
      expect(readFileSync(mcpLog, 'utf8')).toContain('curated_recall_context');
      const t1tool = toolResults(t1.at(-1)!).join('\n');
      expect(t1tool).toContain('"in_context":true');
      expect(t1tool).toContain('already in context: ct-fact:hc-live-1');
      expect(t1tool).toContain('<!-- ct-fact:hc-recall-1 -->');
      expect(t1tool).toContain('Recalled body of hc-recall-1.');
      expect(t1tool).not.toContain('Recalled body of hc-live-1.');

      // (c) Turn 2 in a NEW process: nothing redelivered — the ledger came
      // from the persisted history; both recall ids are stubbed now.
      const t2first = all(t2[0]!);
      expect(lines(t2first, BOOT)).toBe(1);
      expect(lines(t2first, LIVE)).toBe(1);
      for (const id of ['hc-boot-1', 'hc-live-1', 'hc-live-2']) {
        expect(countOccurrences(t2first, `<!-- ct-fact:${id} -->`), id).toBe(1);
      }
      const t2tool = toolResults(t2.at(-1)!).at(-1) ?? '';
      expect(t2tool).toContain('already in context: ct-fact:hc-recall-1');
      expect(t2tool).toContain('already in context: ct-fact:hc-live-1');
      const ctCalls = readFileSync(ctLog, 'utf8').split('\n').filter(Boolean).map((l) => (JSON.parse(l) as { argv: string[] }).argv);
      const matches = ctCalls.filter((a) => a[0] === 'wisdom' && !a.includes('--help'));
      expect(matches.length).toBe(2);
      expect(matches[1]).toEqual(expect.arrayContaining(['--exclude=hc-live-1', '--exclude=hc-live-2', '--exclude=hc-boot-1', '--exclude=hc-recall-1']));
      expect(ctCalls.filter((a) => a[0] === 'recall').length).toBe(1); // bootstrap: first turn only

      // (d) Persisted: our parts are synthetic, host-format ids, on user rows.
      const list = await runOpencode(bin, sb, ['session', 'list', '--format', 'json'], extraEnv);
      const sessions = JSON.parse(list.stdout) as Array<{ id: string }>;
      expect(sessions.length).toBe(1);
      const exported = await runOpencode(bin, sb, ['export', sessions[0]!.id], extraEnv);
      const dump = JSON.parse(exported.stdout.slice(exported.stdout.indexOf('{'))) as {
        messages: Array<{ info: { role: string }; parts: Array<{ id: string; type: string; text?: string; synthetic?: boolean }> }>;
      };
      const ours = dump.messages.flatMap((m) =>
        m.parts.filter((p) => p.type === 'text' && typeof p.text === 'string' && (lines(p.text, LIVE) + lines(p.text, BOOT)) > 0).map((p) => ({ role: m.info.role, p })),
      );
      expect(ours.length).toBe(2);
      for (const { role, p } of ours) {
        expect(role).toBe('user');
        expect(p.synthetic).toBe(true);
        expect(p.id).toMatch(/^prt_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
      }
      record('wisdomLiveDelivery', {
        turnOneRequests: t1.length,
        turnTwoRequests: t2.length,
        persistedWisdomParts: ours.length,
        ctMatchCalls: matches.length,
      });
    },
    TEST_TIMEOUT_MS,
  );

  // Autonomous-work delivery (spec 2026-10-17-opencode-autonomous-work-
  // wisdom-design.md) on the real binary: the fake provider scripts one tool
  // call per model step: read an ABSOLUTE in-project path, `ls -la`, `ls -l`
  // (same key), then `read secrets.env`, which the default ruleset asks for
  // and `opencode run` auto-rejects. Asserts the [V run] host facts: the
  // block appended in tool.execute.after reaches the model and persists as
  // the tool part's state.output; the tool part (callID → messageID) is in
  // the history while the hook runs (else nothing would be delivered: no
  // step id); the session directory turns the absolute path into the
  // project-relative query; a refused call never reaches CT.
  test(
    'wisdom autonomous work: tool.execute.after append, once per key, refused calls send nothing',
    async () => {
      const sb = makeSandboxTracked('activity');
      const pkgRoot = join(HERE, '..', '..');
      if (!existsSync(join(pkgRoot, 'lib', 'src', 'index.js')) || !existsSync(join(pkgRoot, 'lib', 'ct-wisdom-core', 'index.js'))) {
        throw new Error('built payload missing: run `pnpm run build` (core built first) before the host contract');
      }
      const payloadDir = join(sb.dataHome, 'curated-thoughts', 'opencode');
      cpSync(join(pkgRoot, 'lib'), join(payloadDir, 'lib'), { recursive: true });
      cpSync(join(pkgRoot, 'package.json'), join(payloadDir, 'package.json'));
      const loaderPath = join(sb.configHome, 'opencode', 'plugins', 'curated-thoughts.js');
      mkdirSync(dirname(loaderPath), { recursive: true });
      writeFileSync(loaderPath, loaderSource(join(payloadDir, 'lib', 'src', 'index.js')));
      // A project root: paths are sent only relative to one.
      mkdirSync(join(sb.project, '.git'), { recursive: true });
      mkdirSync(join(sb.project, 'src'), { recursive: true });
      writeFileSync(join(sb.project, 'src', 'index.ts'), 'export const x = 1;\n');
      writeFileSync(join(sb.project, 'secrets.env'), 'TOKEN=not-a-secret\n');

      const stubBin = join(sb.root, 'bin');
      mkdirSync(stubBin, { recursive: true });
      cpSync(join(HERE, '..', 'fixtures', 'ct-stub.mjs'), join(stubBin, 'ct'));
      chmodSync(join(stubBin, 'ct'), 0o755);
      const ctLog = join(sb.root, 'ct.jsonl');
      const vlog = join(sb.root, 'verbose.jsonl');
      const fact = (id: string) => ({ id, title: `Fact ${id}`, text: `The body of ${id}.`, provenance: 'stated' });
      const extraEnv = {
        PATH: `${stubBin}${delimiter}${process.env.PATH ?? ''}`,
        CURATED_BRAIN_DIR: join(sb.root, 'brain'),
        CT_STUB_LOG: ctLog,
        CT_STUB_MATCH: '[]',
        CT_STUB_MATCH_ACTIVITY: JSON.stringify([fact('hc-act-1'), fact('hc-act-2')]),
        CT_WISDOM_VERBOSE: '1',
        CT_WISDOM_VERBOSE_LOG: vlog,
      };
      writeOpencodeConfig(sb, provider);
      const absIndex = join(sb.project, 'src', 'index.ts');
      const script: Array<{ name: string; args: Record<string, unknown> }> = [
        { name: 'read', args: { filePath: absIndex } },
        { name: 'bash', args: { command: 'ls -la', description: 'list' } },
        { name: 'bash', args: { command: 'ls -l', description: 'list again' } },
        { name: 'read', args: { filePath: 'secrets.env' } },
      ];
      providerScript = (body) => {
        const messages = body.messages ?? [];
        const firstUser = messages.find((m) => m.role === 'user');
        if (!firstUser || !textOf(firstUser.content).includes('ACTIVITY_RUN')) return null;
        const done = messages.filter((m) => m.role === 'tool').length;
        return script[done] ?? null;
      };
      const before = provider.requests.length;
      let run: RunResult;
      try {
        run = await runOpencode(bin, sb, ['run', 'ACTIVITY_RUN: work on the project.'], extraEnv);
      } finally {
        providerScript = null;
      }
      if (run.exitCode !== 0 || run.timedOut) console.error(`[activity] exit=${run.exitCode}\n${run.stderr.slice(-4000)}`);
      expect(run.timedOut).toBe(false);
      expect(run.exitCode).toBe(0);

      const reqs = provider.requests.slice(before).filter((r) => (r.body.messages ?? []).some((m) => m.role === 'user' && textOf(m.content).includes('ACTIVITY_RUN')));
      const last = reqs.at(-1)!;
      const toolTexts = (last.body.messages ?? []).filter((m) => m.role === 'tool').map((m) => textOf(m.content));
      // A refused ask ends `opencode run`'s loop: the model sees the first
      // three results; the refused call is checked in the export below.
      expect(toolTexts.length).toBeGreaterThanOrEqual(3);
      const HEAD = '## Curated Thoughts — relevant to this step';
      // (1) the read's result carries one block, marker first.
      expect(countOccurrences(toolTexts[0]!, HEAD)).toBe(1);
      expect(toolTexts[0]).toContain(`${HEAD}\n_for: read src/index.ts_\n\n<!-- ct-fact:hc-act-1 --> **Fact hc-act-1** (provenance: stated)`);
      // (2) the first `ls` delivers the next fact; the second `ls` (same key) nothing.
      expect(toolTexts[1]).toContain('<!-- ct-fact:hc-act-2 -->');
      expect(countOccurrences(toolTexts[2]!, HEAD)).toBe(0);
      const all = toolTexts.join('\n');
      for (const id of ['hc-act-1', 'hc-act-2']) expect(countOccurrences(all, `ct-fact:${id}`), id).toBe(1);

      // (4) CT saw exactly two activity queries: bare, project-relative, last after `--`.
      const ctCalls = readFileSync(ctLog, 'utf8').split('\n').filter(Boolean).map((l) => (JSON.parse(l) as { argv: string[] }).argv);
      const act = ctCalls.filter((a) => a[0] === 'wisdom' && a[a.indexOf('--max') + 1] === '1');
      expect(act.map((a) => a.slice(a.indexOf('--')))).toEqual([['--', 'src/index.ts'], ['--', 'ls']]);
      expect(act[1]).toContain('--exclude=hc-act-1');
      expect(JSON.stringify(ctCalls)).not.toContain('secrets.env');

      // (5) persisted: the tool parts' state.output hold the blocks; the refused read errored.
      const list = await runOpencode(bin, sb, ['session', 'list', '--format', 'json'], extraEnv);
      const sessions = JSON.parse(list.stdout) as Array<{ id: string }>;
      const exported = await runOpencode(bin, sb, ['export', sessions[0]!.id], extraEnv);
      const dump = JSON.parse(exported.stdout.slice(exported.stdout.indexOf('{'))) as {
        messages: Array<{ parts: Array<{ type: string; tool?: string; state?: { status?: string; output?: string; input?: Record<string, unknown> } }> }>;
      };
      const toolParts = dump.messages.flatMap((m) => m.parts.filter((p) => p.type === 'tool'));
      expect(toolParts.length).toBe(4);
      expect(toolParts[0]!.state?.output).toContain('<!-- ct-fact:hc-act-1 -->');
      expect(toolParts[1]!.state?.output).toContain('<!-- ct-fact:hc-act-2 -->');
      expect(toolParts[3]!.state?.status).toBe('error');
      expect(JSON.stringify(toolParts[3])).not.toContain(HEAD);
      expect(toolParts.filter((p) => (p.state?.output ?? '').includes(HEAD)).length).toBe(2);

      // (6) verbose: two activity deliveries, nothing about the refused call.
      const verbose = readFileSync(vlog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
      const deliveries = verbose.filter((v) => v.channel === 'activity' && v.event === 'delivery');
      expect(deliveries.map((v) => v.query)).toEqual(['src/index.ts', 'ls']);
      expect(JSON.stringify(verbose)).not.toContain('secrets.env');
      record('wisdomActivity', {
        toolResults: toolTexts.length,
        activityQueries: act.map((a) => a.at(-1)),
        refusedReadStatus: toolParts[3]!.state?.status,
      });
    },
    TEST_TIMEOUT_MS,
  );
});

function makeSandboxTracked(label: string): Sandbox {
  const sb = makeSandbox(label);
  sandboxes.push(sb);
  return sb;
}
