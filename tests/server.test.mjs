import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import { registerHooks } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import * as XLSX from 'xlsx';

const PKG_VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

// 注册轻量 sidecar_sdk mock，模拟 Antigravity 宿主注入的 SidecarApp 与 Response 精确行为
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'sidecar_sdk') {
      return {
        shortCircuit: true,
        url: 'mock://sidecar_sdk',
      };
    }
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (
        specifier.startsWith('.') &&
        !/\.[cm]?[jt]s$/i.test(specifier) &&
        context.parentURL?.endsWith('.ts')
      ) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw err;
    }
  },
  load(url, context, nextLoad) {
    if (url === 'mock://sidecar_sdk') {
      return {
        shortCircuit: true,
        format: 'module',
        source: `
          import { createServer } from 'node:http';

          export class Response {
            constructor(body, { contentType = 'text/plain', status = 200, headers } = {}) {
              this.body = body;
              this.contentType = contentType;
              this.status = status;
              this.headers = headers;
            }
          }

          export class SidecarApp {
            #token;
            #port;
            #server;
            #pages = new Map();
            #apis = new Map();

            constructor() {
              const portStr = process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || '0';
              this.#token = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN;
              this.#port = parseInt(portStr, 10);
            }

            page(path, handler) {
              this.#pages.set(path, handler);
            }

            api(path, handler, method = 'POST') {
              if (!this.#apis.has(path)) {
                this.#apis.set(path, new Map());
              }
              this.#apis.get(path).set(method.toUpperCase(), handler);
            }

            run() {
              const server = createServer(async (req, res) => {
                const url = new URL(req.url, 'http://127.0.0.1');
                if (req.method !== 'GET' && this.#token) {
                  const provided = req.headers['x-sidecar-token'] || url.searchParams.get('token');
                  if (provided !== this.#token) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'unauthorized' }));
                    return;
                  }
                }

                if (req.method === 'GET' && this.#pages.has(url.pathname)) {
                  const content = await this.#pages.get(url.pathname)();
                  if (content instanceof Response) {
                    res.writeHead(content.status || 200, {
                      'Content-Type': content.contentType,
                      ...content.headers,
                    });
                    res.end(content.body);
                    return;
                  }
                  const isJS = url.pathname.endsWith('.js');
                  res.writeHead(200, {
                    'Content-Type': isJS ? 'application/javascript' : 'text/html',
                  });
                  res.end(content);
                  return;
                }

                if (this.#apis.has(url.pathname)) {
                  const methodMap = this.#apis.get(url.pathname);
                  if (methodMap.has(req.method)) {
                    const handler = methodMap.get(req.method);
                    let body = '';
                    req.on('data', (chunk) => { body += chunk; });
                    req.on('end', async () => {
                      try {
                        const data = {};
                        for (const [k, v] of url.searchParams.entries()) {
                          if (k.toLowerCase() !== 'token') data[k] = v;
                        }
                        if (body) Object.assign(data, JSON.parse(body));
                        const result = await handler(data);
                        if (
                          result instanceof Response ||
                          (result && typeof result === 'object' && result.contentType && result.body !== undefined)
                        ) {
                          const status = result.status || 200;
                          const respBody = typeof result.body === 'string' ? result.body : Buffer.from(result.body);
                          res.writeHead(status, {
                            'Content-Type': result.contentType,
                            ...result.headers,
                          });
                          res.end(respBody);
                          return;
                        }
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify(result));
                      } catch (err) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: err.message }));
                      }
                    });
                    return;
                  }
                  res.writeHead(405, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ error: 'Method Not Allowed' }));
                  return;
                }

                res.writeHead(404);
                res.end('Not found');
              });

              return new Promise((resolve) => {
                this.#server = server.listen(this.#port, '127.0.0.1', () => resolve(server));
              });
            }

            close() {
              return new Promise((resolve) => (this.#server ? this.#server.close(() => resolve()) : resolve()));
            }
          }
        `,
      };
    }
    return nextLoad(url, context);
  },
});

const {
  HttpError,
  isForbiddenSystemPath,
  isPathWithinRoot,
  parseInputPath,
  validateFilePath,
} = await import('../server/pathSecurity.mjs');

const {
  closeHtmlServer,
  getActiveAudioMountCount,
  getActiveImageMountCount,
  getActiveMountCount,
  getActivePdfMountCount,
  mountAudioTarget,
  mountHtmlTarget,
  mountImageTarget,
  mountPdfTarget,
  mountVideoTarget,
} = await import('../server/htmlServer.mjs');

const { scanWorkspaceFiles } = await import('../server/workspaceScanner.mjs');
const { startServer } = await import('../server/index.mjs');

function rawHttpGet(urlString, rawPath) {
  const url = new URL(urlString);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: rawPath,
        method: 'GET',
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('pathSecurity 路径安全与格式分类测试', () => {
  let tempRoot;
  let workspaceDir;
  let outsideDir;

  before(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'fp-sec-test-'));
    workspaceDir = join(tempRoot, 'workspace');
    outsideDir = join(tempRoot, 'outside');
    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    mkdirSync(join(workspaceDir, '.system_generated', 'logs'), { recursive: true });
    mkdirSync(join(workspaceDir, '.system_generated', 'messages'), { recursive: true });

    writeFileSync(join(workspaceDir, 'deck.pptx'), Buffer.from('PK\x03\x04pptx'));
    writeFileSync(join(workspaceDir, 'report.DOCX'), Buffer.from('PK\x03\x04docx'));
    writeFileSync(join(workspaceDir, 'sheet.XLSX'), Buffer.from('PK\x03\x04xlsx'));
    writeFileSync(join(workspaceDir, 'legacy.xls'), Buffer.from('\xD0\xCF\x11\xE0xls'));
    writeFileSync(join(workspaceDir, 'data.csv'), 'a,b\n1,2\n');
    writeFileSync(join(workspaceDir, 'table.TSV'), 'a\tb\n1\t2\n');
    writeFileSync(join(workspaceDir, 'manual.PDF'), Buffer.from('%PDF-1.7\n'));
    writeFileSync(join(workspaceDir, 'page.html'), '<h1>Hello</h1>');
    writeFileSync(join(workspaceDir, 'legacy.doc'), 'legacy doc');
    writeFileSync(join(workspaceDir, 'legacy.ppt'), 'legacy ppt');
    writeFileSync(join(workspaceDir, 'notes.txt'), 'plain');
    writeFileSync(join(workspaceDir, '.system_generated', 'logs', 'run.html'), '<p>log</p>');
    writeFileSync(join(workspaceDir, '.system_generated', 'messages', 'msg.html'), '<p>msg</p>');
    writeFileSync(join(outsideDir, 'secret.html'), '<p>secret</p>');
  });

  after(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('正确解析 file:// URI 与 ~/ 路径并拒绝空字节', () => {
    const parsedFromUri = parseInputPath(pathToFileURL(join(workspaceDir, 'deck.pptx')).href);
    assert.equal(parsedFromUri.toLowerCase(), join(workspaceDir, 'deck.pptx').toLowerCase());

    const homeExpanded = parseInputPath('~/demo.docx');
    assert.equal(homeExpanded, join(homedir(), 'demo.docx'));

    assert.throws(
      () => parseInputPath('C:\\foo\\bar\0.pptx'),
      (err) => err instanceof HttpError && err.status === 400,
    );
  });

  it('正确处理 Windows 大小写不敏感与盘符根目录 D:\\ 不产生双分隔符', () => {
    assert.equal(isPathWithinRoot('d:\\Projects\\Demo\\a.pptx', 'D:\\', 'win32'), true);
    assert.equal(isPathWithinRoot('D:\\projects\\demo\\a.pptx', 'd:\\Projects', 'win32'), true);
    assert.equal(isPathWithinRoot('D:\\ProjectsOther\\a.pptx', 'D:\\Projects', 'win32'), false);
    assert.equal(isPathWithinRoot('E:\\a.pptx', 'D:\\', 'win32'), false);
    assert.equal(isPathWithinRoot('/home/user/demo/a.pptx', '/home/user', 'linux'), true);
    assert.equal(isPathWithinRoot('/home/User/demo/a.pptx', '/home/user', 'linux'), false);
    assert.equal(isPathWithinRoot('/etc/passwd', '/', 'linux'), true);
  });

  it('拦截 .system_generated/logs 与 .system_generated/messages', () => {
    assert.equal(isForbiddenSystemPath(join(workspaceDir, '.system_generated', 'logs', 'run.html')), true);
    assert.equal(isForbiddenSystemPath(join(workspaceDir, '.system_generated', 'messages', 'msg.html')), true);

    assert.throws(
      () => validateFilePath(join(workspaceDir, '.system_generated', 'logs', 'run.html'), {
        allowedRootsOverride: [workspaceDir],
      }),
      (err) => err instanceof HttpError && err.status === 403,
    );

    assert.throws(
      () => validateFilePath(join(workspaceDir, '.system_generated', 'messages', 'msg.html'), {
        allowedRootsOverride: [workspaceDir],
      }),
      (err) => err instanceof HttpError && err.status === 403,
    );
  });

  it('拦截白名单之外与路径穿越请求', () => {
    assert.throws(
      () => validateFilePath(join(workspaceDir, '..', 'outside', 'secret.html'), {
        allowedRootsOverride: [workspaceDir],
      }),
      (err) => err instanceof HttpError && err.status === 403,
    );
  });

  it('对旧版 .doc / .ppt 与未知格式返回 415 清晰中文提示', () => {
    assert.throws(
      () => validateFilePath(join(workspaceDir, 'legacy.doc'), { allowedRootsOverride: [workspaceDir] }),
      (err) => err instanceof HttpError && err.status === 415 && err.message.includes('.docx'),
    );

    assert.throws(
      () => validateFilePath(join(workspaceDir, 'legacy.ppt'), { allowedRootsOverride: [workspaceDir] }),
      (err) => err instanceof HttpError && err.status === 415 && err.message.includes('.pptx'),
    );

    assert.throws(
      () => validateFilePath(join(workspaceDir, 'notes.txt'), { allowedRootsOverride: [workspaceDir] }),
      (err) => (
        err instanceof HttpError
        && err.status === 415
        && err.message.includes('.pdf')
        && err.message.includes('.xlsx')
        && err.message.includes('.xls')
        && err.message.includes('.csv')
        && err.message.includes('.tsv')
      ),
    );
  });

  it('支持大小写混合扩展名分类与合法文件校验', () => {
    const ppt = validateFilePath(join(workspaceDir, 'deck.pptx'), { allowedRootsOverride: [workspaceDir] });
    assert.equal(ppt.kind, 'ppt');
    assert.equal(ppt.ext, '.pptx');

    const docx = validateFilePath(join(workspaceDir, 'report.DOCX'), { allowedRootsOverride: [workspaceDir] });
    assert.equal(docx.kind, 'word');
    assert.equal(docx.ext, '.docx');

    const xlsx = validateFilePath(join(workspaceDir, 'sheet.XLSX'), { allowedRootsOverride: [workspaceDir] });
    assert.equal(xlsx.kind, 'excel');
    assert.equal(xlsx.ext, '.xlsx');

    const xls = validateFilePath(join(workspaceDir, 'legacy.xls'), { allowedRootsOverride: [workspaceDir] });
    assert.equal(xls.kind, 'excel');
    assert.equal(xls.ext, '.xls');

    const csv = validateFilePath(join(workspaceDir, 'data.csv'), { allowedRootsOverride: [workspaceDir] });
    assert.equal(csv.kind, 'excel');
    assert.equal(csv.ext, '.csv');

    const tsv = validateFilePath(join(workspaceDir, 'table.TSV'), { allowedRootsOverride: [workspaceDir] });
    assert.equal(tsv.kind, 'excel');
    assert.equal(tsv.ext, '.tsv');

    const pdf = validateFilePath(join(workspaceDir, 'manual.PDF'), { allowedRootsOverride: [workspaceDir] });
    assert.equal(pdf.kind, 'pdf');
    assert.equal(pdf.ext, '.pdf');

    const html = validateFilePath(join(workspaceDir, 'page.html'), { allowedRootsOverride: [workspaceDir] });
    assert.equal(html.kind, 'html');
    assert.equal(html.ext, '.html');
  });

  it('拦截指向白名单外部的目录 junction / 符号链接逃逸', () => {
    const linkDir = join(workspaceDir, 'escape-dir');
    symlinkSync(outsideDir, linkDir, 'junction');

    assert.throws(
      () => validateFilePath(join(linkDir, 'secret.html'), { allowedRootsOverride: [workspaceDir] }),
      (err) => err instanceof HttpError && err.status === 403 && err.code === 'SYMLINK_ESCAPE',
    );
  });
});

describe('htmlServer 独立静态预览服务测试', () => {
  let tempRoot;
  let workspaceDir;
  let outsideDir;

  before(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'fp-html-test-'));
    workspaceDir = join(tempRoot, 'workspace');
    outsideDir = join(tempRoot, 'outside');
    mkdirSync(join(workspaceDir, 'slides'), { recursive: true });
    mkdirSync(join(workspaceDir, 'assets'), { recursive: true });
    mkdirSync(outsideDir, { recursive: true });

    writeFileSync(
      join(workspaceDir, 'slides', 'index.html'),
      '<!doctype html><link rel="stylesheet" href="./style.css"><script src="./app.js"></script><img src="../assets/logo.svg">',
    );
    writeFileSync(join(workspaceDir, 'slides', 'style.css'), 'body { color: #38bdf8; }');
    writeFileSync(join(workspaceDir, 'slides', 'app.js'), 'console.log("ok");');
    writeFileSync(join(workspaceDir, 'assets', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    writeFileSync(join(outsideDir, 'secret.txt'), 'top-secret');
  });

  after(async () => {
    await closeHtmlServer();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('支持挂载工作区并完整加载相对路径 CSS/JS/SVG，且带安全响应头', async () => {
    const mounted = await mountHtmlTarget(join(workspaceDir, 'slides', 'index.html'), [workspaceDir]);
    assert.match(mounted.mountId, /^[0-9a-f]{48}$/);
    assert.equal(mounted.entryRelPath, 'slides/index.html');

    const htmlRes = await fetch(mounted.url);
    assert.equal(htmlRes.status, 200);
    assert.match(htmlRes.headers.get('content-type'), /^text\/html/);
    assert.equal(htmlRes.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(htmlRes.headers.get('cache-control'), 'no-store');

    const cssUrl = new URL('./style.css', mounted.url).href;
    const cssRes = await fetch(cssUrl);
    assert.equal(cssRes.status, 200);
    assert.match(cssRes.headers.get('content-type'), /^text\/css/);
    assert.match(await cssRes.text(), /#38bdf8/);

    const jsUrl = new URL('./app.js', mounted.url).href;
    const jsRes = await fetch(jsUrl);
    assert.equal(jsRes.status, 200);
    assert.match(jsRes.headers.get('content-type'), /^application\/javascript/);

    const svgUrl = new URL('../assets/logo.svg', mounted.url).href;
    const svgRes = await fetch(svgUrl);
    assert.equal(svgRes.status, 200);
    assert.equal(svgRes.headers.get('content-type'), 'image/svg+xml');
  });

  it('拦截原始 HTTP 请求中的 .. 与 %2e%2e 路径穿越并返回 403', async () => {
    const mounted = await mountHtmlTarget(join(workspaceDir, 'slides', 'index.html'), [workspaceDir]);

    const res1 = await rawHttpGet(mounted.url, `/m/${mounted.mountId}/../outside/secret.txt`);
    assert.equal(res1.status, 403);

    const res2 = await rawHttpGet(mounted.url, `/m/${mounted.mountId}/%2e%2e/outside/secret.txt`);
    assert.equal(res2.status, 403);
  });

  it('未处于工作区内时 mountRoot 严格收窄为入口文件所在目录，无法向上访问父目录', async () => {
    const mounted = await mountHtmlTarget(join(workspaceDir, 'slides', 'index.html'), []);
    assert.equal(mounted.entryRelPath, 'index.html');
    const res = await rawHttpGet(mounted.url, `/m/${mounted.mountId}/../assets/logo.svg`);
    assert.equal(res.status, 403);
  });

  it('LRU 挂载上限不超过 32 个', async () => {
    for (let i = 0; i < 36; i += 1) {
      await mountHtmlTarget(join(workspaceDir, 'slides', 'index.html'), [workspaceDir]);
    }
    assert.equal(getActiveMountCount(), 32);
  });

  it('支持 PDF 挂载与 HTTP Range 流式传输、CORS 预检及 416/空文件边界', async () => {
    const pdfPayload = Buffer.from('%PDF-1.7-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    const pdfPath = join(workspaceDir, 'sample 测试.pdf');
    const emptyPdfPath = join(workspaceDir, 'empty.pdf');
    writeFileSync(pdfPath, pdfPayload);
    writeFileSync(emptyPdfPath, Buffer.alloc(0));

    const mounted = await mountPdfTarget(pdfPath);
    assert.match(mounted.mountId, /^[0-9a-f]{48}$/);
    assert.equal(mounted.fileName, 'sample 测试.pdf');
    assert.equal(mounted.size, pdfPayload.length);
    assert.match(mounted.url, /^http:\/\/127\.0\.0\.1:\d+\/p\/[0-9a-f]{48}\/sample%20%E6%B5%8B%E8%AF%95\.pdf$/);

    // OPTIONS 预检
    const optRes = await fetch(mounted.url, { method: 'OPTIONS' });
    assert.equal(optRes.status, 204);
    assert.equal(optRes.headers.get('access-control-allow-origin'), '*');
    assert.match(optRes.headers.get('access-control-allow-methods'), /GET/);
    assert.match(optRes.headers.get('access-control-allow-headers'), /Range/);
    assert.match(optRes.headers.get('access-control-expose-headers'), /Content-Range/);

    // 无 Range 全量 GET
    const fullRes = await fetch(mounted.url);
    assert.equal(fullRes.status, 200);
    assert.equal(fullRes.headers.get('content-type'), 'application/pdf');
    assert.equal(fullRes.headers.get('accept-ranges'), 'bytes');
    assert.equal(fullRes.headers.get('content-disposition'), 'inline');
    assert.equal(fullRes.headers.get('access-control-allow-origin'), '*');
    assert.equal(fullRes.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await fullRes.arrayBuffer()), pdfPayload);

    // bytes=start-end 分片 Range
    const r1 = await fetch(mounted.url, { headers: { Range: 'bytes=0-9' } });
    assert.equal(r1.status, 206);
    assert.equal(r1.headers.get('content-range'), `bytes 0-9/${pdfPayload.length}`);
    assert.equal(r1.headers.get('content-length'), '10');
    assert.deepEqual(Buffer.from(await r1.arrayBuffer()), pdfPayload.subarray(0, 10));

    // bytes=start- 分片 Range
    const r2 = await fetch(mounted.url, { headers: { Range: 'bytes=20-' } });
    assert.equal(r2.status, 206);
    assert.equal(r2.headers.get('content-range'), `bytes 20-${pdfPayload.length - 1}/${pdfPayload.length}`);
    assert.deepEqual(Buffer.from(await r2.arrayBuffer()), pdfPayload.subarray(20));

    // bytes=-suffix 分片 Range
    const r3 = await fetch(mounted.url, { headers: { Range: 'bytes=-5' } });
    assert.equal(r3.status, 206);
    assert.equal(
      r3.headers.get('content-range'),
      `bytes ${pdfPayload.length - 5}-${pdfPayload.length - 1}/${pdfPayload.length}`,
    );
    assert.deepEqual(Buffer.from(await r3.arrayBuffer()), pdfPayload.subarray(pdfPayload.length - 5));

    // HEAD Range 请求
    const headRes = await fetch(mounted.url, { method: 'HEAD', headers: { Range: 'bytes=0-4' } });
    assert.equal(headRes.status, 206);
    assert.equal(headRes.headers.get('content-length'), '5');
    assert.equal((await headRes.arrayBuffer()).byteLength, 0);

    // 越界 / 非法 Range 返回 416
    const r416 = await fetch(mounted.url, { headers: { Range: 'bytes=99999-100010' } });
    assert.equal(r416.status, 416);
    assert.equal(r416.headers.get('content-range'), `bytes */${pdfPayload.length}`);

    const rBad = await fetch(mounted.url, { headers: { Range: 'bytes=abc-def' } });
    assert.equal(rBad.status, 416);

    // 空 PDF 边界
    const emptyMounted = await mountPdfTarget(emptyPdfPath);
    const emptyFull = await fetch(emptyMounted.url);
    assert.equal(emptyFull.status, 200);
    assert.equal(emptyFull.headers.get('content-length'), '0');
    assert.equal((await emptyFull.arrayBuffer()).byteLength, 0);

    const emptyRange = await fetch(emptyMounted.url, { headers: { Range: 'bytes=0-0' } });
    assert.equal(emptyRange.status, 416);
    assert.equal(emptyRange.headers.get('content-range'), 'bytes */0');

    // PDF LRU 上限 32
    for (let i = 0; i < 36; i += 1) {
      await mountPdfTarget(pdfPath);
    }
    assert.equal(getActivePdfMountCount(), 32);
  });
});

describe('workspaceScanner 工作区扫描测试', () => {
  let tempRoot;

  before(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'fp-scan-test-'));
    mkdirSync(join(tempRoot, 'docs', 'sub'), { recursive: true });
    mkdirSync(join(tempRoot, 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(join(tempRoot, 'dist'), { recursive: true });
    mkdirSync(join(tempRoot, '.git'), { recursive: true });
    mkdirSync(join(tempRoot, '.dsh'), { recursive: true });
    mkdirSync(join(tempRoot, 'd1', 'd2', 'd3', 'd4', 'd5', 'd6'), { recursive: true });

    writeFileSync(join(tempRoot, 'docs', 'a.docx'), 'docx');
    writeFileSync(join(tempRoot, 'docs', '~$a.docx'), 'lock');
    writeFileSync(join(tempRoot, 'docs', '.~lock.a.docx#'), 'lock');
    writeFileSync(join(tempRoot, 'docs', '._a.docx'), 'meta');
    writeFileSync(join(tempRoot, 'docs', 'sub', 'b.pptx'), 'pptx');
    writeFileSync(join(tempRoot, 'docs', 'budget.xlsx'), 'xlsx');
    writeFileSync(join(tempRoot, 'docs', 'data.csv'), 'col1,col2\n1,2\n');
    writeFileSync(join(tempRoot, 'docs', 'manual.pdf'), '%PDF-1.7');
    writeFileSync(join(tempRoot, 'docs', 'readme.html'), '<h1>doc</h1>');
    writeFileSync(join(tempRoot, 'index.htm'), '<h1>hi</h1>');
    writeFileSync(join(tempRoot, 'node_modules', 'pkg', 'ignored.html'), '<p>ignore</p>');
    writeFileSync(join(tempRoot, 'dist', 'ignored.html'), '<p>ignore</p>');
    writeFileSync(join(tempRoot, '.git', 'ignored.html'), '<p>ignore</p>');
    writeFileSync(join(tempRoot, '.dsh', 'ignored.docx'), 'lock');
    writeFileSync(join(tempRoot, 'd1', 'd2', 'd3', 'd4', 'd5', 'depth5.pptx'), 'ok');
    writeFileSync(join(tempRoot, 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'depth6.pptx'), 'too deep');
  });

  after(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('跳过 node_modules / dist / .git 并限制最大递归深度为 5', () => {
    const files = scanWorkspaceFiles([pathToFileURL(tempRoot).href]);
    const relPaths = files.map((f) => f.relPath).sort();

    assert.deepEqual(relPaths, [
      'd1/d2/d3/d4/d5/depth5.pptx',
      'docs/a.docx',
      'docs/budget.xlsx',
      'docs/data.csv',
      'docs/manual.pdf',
      'docs/readme.html',
      'docs/sub/b.pptx',
      'index.htm',
    ]);

    const xlsxItem = files.find((f) => f.relPath === 'docs/budget.xlsx');
    const csvItem = files.find((f) => f.relPath === 'docs/data.csv');
    assert.equal(xlsxItem?.kind, 'excel');
    assert.equal(csvItem?.kind, 'excel');
  });

  it('支持 HTML/HTM 格式检测并归类为 html kind', () => {
    const files = scanWorkspaceFiles([pathToFileURL(tempRoot).href]);
    const htmlItem = files.find((f) => f.relPath === 'docs/readme.html');
    const htmItem = files.find((f) => f.relPath === 'index.htm');

    assert.ok(htmlItem, '应扫描出 .html 文件');
    assert.equal(htmlItem.kind, 'html');
    assert.equal(htmlItem.ext, '.html');

    assert.ok(htmItem, '应扫描出 .htm 文件');
    assert.equal(htmItem.kind, 'html');
    assert.equal(htmItem.ext, '.htm');
  });

  it('workspaceUris 为空或无有效目录时自动回退到 process.env.WORKSPACE_ROOT', () => {
    const prevEnv = process.env.WORKSPACE_ROOT;
    try {
      process.env.WORKSPACE_ROOT = tempRoot;

      // workspaceUris 为空数组
      const filesFromEmpty = scanWorkspaceFiles([]);
      assert.ok(filesFromEmpty.length > 0);
      assert.ok(filesFromEmpty.some((f) => f.relPath === 'index.htm'));

      // workspaceUris 为无效路径列表
      const filesFromInvalid = scanWorkspaceFiles(['non/existent/path/for/test']);
      assert.ok(filesFromInvalid.length > 0);
      assert.ok(filesFromInvalid.some((f) => f.relPath === 'index.htm'));

      // 验证 workspaceRoot 指向 tempRoot 真实路径
      assert.equal(filesFromEmpty[0].workspaceRoot.toLowerCase(), tempRoot.toLowerCase());
    } finally {
      if (prevEnv === undefined) {
        delete process.env.WORKSPACE_ROOT;
      } else {
        process.env.WORKSPACE_ROOT = prevEnv;
      }
    }
  });

  it('在无可用根目录时支持回退扫描 dirname(options.currentFile)（支持普通路径与 file:// URI）', () => {
    const prevEnv = process.env.WORKSPACE_ROOT;
    delete process.env.WORKSPACE_ROOT;

    try {
      const docHtmlPath = join(tempRoot, 'docs', 'readme.html');
      const docHtmlUri = pathToFileURL(docHtmlPath).href;

      // 1. 通过普通文件绝对路径作为 currentFile 回退扫描
      const filesFromPath = scanWorkspaceFiles([], { currentFile: docHtmlPath });
      const relPathsFromPath = filesFromPath.map((f) => f.relPath).sort();
      assert.deepEqual(relPathsFromPath, [
        'a.docx',
        'budget.xlsx',
        'data.csv',
        'manual.pdf',
        'readme.html',
        'sub/b.pptx',
      ]);
      const htmlFromPath = filesFromPath.find((f) => f.relPath === 'readme.html');
      assert.equal(htmlFromPath?.kind, 'html');

      // 2. 通过 file:// URI 作为 currentFile 回退扫描
      const filesFromUri = scanWorkspaceFiles([], { currentFile: docHtmlUri });
      const relPathsFromUri = filesFromUri.map((f) => f.relPath).sort();
      assert.deepEqual(relPathsFromUri, relPathsFromPath);

      // 3. 打开顶级 index.htm 时，回退扫描 tempRoot 目录
      const filesFromRootHtml = scanWorkspaceFiles([], { currentFile: join(tempRoot, 'index.htm') });
      assert.ok(filesFromRootHtml.some((f) => f.relPath === 'index.htm'));
      assert.ok(filesFromRootHtml.some((f) => f.relPath === 'docs/readme.html'));
    } finally {
      if (prevEnv === undefined) {
        delete process.env.WORKSPACE_ROOT;
      } else {
        process.env.WORKSPACE_ROOT = prevEnv;
      }
    }
  });

  it('跳过 _work/_tmp/_cache/__pycache__ 等中间渲染目录，且大量图片不挤占 PDF 等文档配额', () => {
    const isolatedRoot = mkdtempSync(join(tmpdir(), 'fp-scan-balance-'));
    try {
      mkdirSync(join(isolatedRoot, '_work', 'render', 'slides'), { recursive: true });
      mkdirSync(join(isolatedRoot, '_tmp'), { recursive: true });
      mkdirSync(join(isolatedRoot, '__pycache__'), { recursive: true });
      mkdirSync(join(isolatedRoot, 'images'), { recursive: true });

      const pdfPath = join(isolatedRoot, 'lecture.pdf');
      writeFileSync(pdfPath, '%PDF-1.7');
      const oldTime = new Date(Date.now() - 3600_000);
      utimesSync(pdfPath, oldTime, oldTime);

      // 中间工作目录里的分页渲染图应被彻底跳过
      writeFileSync(join(isolatedRoot, '_work', 'render', 'slides', '幻灯片1.PNG'), 'png');
      writeFileSync(join(isolatedRoot, '_tmp', 'preview.png'), 'png');
      writeFileSync(join(isolatedRoot, '__pycache__', 'cache.html'), '<p>cache</p>');

      // 合法目录里有 15 张更新时间更新的图片，limit=10 时仍需保底保留 lecture.pdf
      const now = Date.now();
      for (let i = 1; i <= 15; i += 1) {
        const imgPath = join(isolatedRoot, 'images', `fig-${i}.png`);
        writeFileSync(imgPath, 'png');
        const imgTime = new Date(now + i * 1000);
        utimesSync(imgPath, imgTime, imgTime);
      }

      const scanned = scanWorkspaceFiles([pathToFileURL(isolatedRoot).href], { limit: 10 });
      assert.equal(scanned.length, 10);
      assert.equal(scanned.some((f) => f.relPath.startsWith('_work/')), false);
      assert.equal(scanned.some((f) => f.relPath.startsWith('_tmp/')), false);
      assert.equal(scanned.some((f) => f.relPath.startsWith('__pycache__/')), false);

      const pdfItem = scanned.find((f) => f.relPath === 'lecture.pdf');
      assert.ok(pdfItem, '即使存在大量更新时间的图片，PDF 文档仍应保留在扫描结果中');
      assert.equal(pdfItem.kind, 'pdf');
    } finally {
      rmSync(isolatedRoot, { recursive: true, force: true });
    }
  });

  it('多文件夹工作区按根目录均衡扫描，前序目录文件较多或较新时不挤占后续目录', () => {
    const multiRoot = mkdtempSync(join(tmpdir(), 'fp-scan-multi-'));
    try {
      const rootA = join(multiRoot, 'folderA');
      const rootB = join(multiRoot, 'folderB');
      mkdirSync(rootA, { recursive: true });
      mkdirSync(rootB, { recursive: true });

      const now = Date.now();
      for (let i = 1; i <= 15; i += 1) {
        const p = join(rootA, `a-${i}.pdf`);
        writeFileSync(p, '%PDF-1.7');
        const t = new Date(now + i * 1000);
        utimesSync(p, t, t);
      }

      const older = new Date(now - 7200_000);
      const bPdf = join(rootB, 'b-guide.pdf');
      const bDocx = join(rootB, 'b-notes.docx');
      writeFileSync(bPdf, '%PDF-1.7');
      writeFileSync(bDocx, 'docx');
      utimesSync(bPdf, older, older);
      utimesSync(bDocx, older, older);

      const scanned = scanWorkspaceFiles(
        [pathToFileURL(rootA).href, pathToFileURL(rootB).href],
        { limit: 10 },
      );

      assert.equal(scanned.length, 10);
      const fromA = scanned.filter((f) => f.workspaceRoot.toLowerCase() === rootA.toLowerCase());
      const fromB = scanned.filter((f) => f.workspaceRoot.toLowerCase() === rootB.toLowerCase());
      assert.ok(fromA.length > 0, '应包含第一个工作区文件夹中的文档');
      assert.equal(fromB.length, 2, '第二个工作区文件夹中的旧文档也应完整保留');
      assert.ok(fromB.some((f) => f.relPath === 'b-guide.pdf'));
      assert.ok(fromB.some((f) => f.relPath === 'b-notes.docx'));
    } finally {
      rmSync(multiRoot, { recursive: true, force: true });
    }
  });
});

describe('SidecarApp HTTP 路由集成测试', () => {
  let tempRoot;
  let workspaceDir;
  let distDir;
  let assetsDir;
  let running;
  let baseUrl;
  const token = 'test-sidecar-token-123';

  before(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'fp-api-test-'));
    workspaceDir = join(tempRoot, 'ws');
    distDir = join(tempRoot, 'dist');
    assetsDir = join(tempRoot, 'assets');
    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(distDir, { recursive: true });
    mkdirSync(assetsDir, { recursive: true });

    writeFileSync(join(distDir, 'index.html'), '<html><body>Mock UI</body></html>');
    writeFileSync(join(distDir, 'app.js'), 'console.log("ui");');
    writeFileSync(join(distDir, 'pdf.worker.js'), 'console.log("worker");');
    writeFileSync(join(distDir, 'styles.css'), 'body{}');
    writeFileSync(join(assetsDir, 'logo.svg'), '<svg></svg>');

    writeFileSync(join(workspaceDir, 'demo.pptx'), Buffer.from([1, 2, 3, 4]));
    writeFileSync(join(workspaceDir, 'demo.xlsx'), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x05]));
    writeFileSync(join(workspaceDir, 'demo.csv'), '姓名,分数\n张三,95\n');
    writeFileSync(join(workspaceDir, 'demo.html'), '<html><body>Demo</body></html>');
    writeFileSync(join(workspaceDir, 'demo.pdf'), Buffer.from('%PDF-1.7-MOCK-BODY'));
    writeFileSync(join(workspaceDir, 'old.doc'), 'old');

    process.env.ANTIGRAVITY_SIDECAR_WEB_PORT = '0';
    process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN = token;

    running = await startServer({
      distDir,
      assetsDir,
      allowedRootsOverride: [workspaceDir],
    });
    const addr = running.server.address();
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await running.close();
    delete process.env.ANTIGRAVITY_SIDECAR_WEB_PORT;
    delete process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('GET /api/health 与静态页面路由返回正确内容且静态缓存按 mtime 失效', async () => {
    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthRes.status, 200);
    assert.deepEqual(await healthRes.json(), { status: 'ok', version: PKG_VERSION });

    const pageRes = await fetch(`${baseUrl}/`);
    assert.equal(pageRes.status, 200);
    assert.match(await pageRes.text(), /Mock UI/);

    const logoRes = await fetch(`${baseUrl}/assets/logo.svg`);
    assert.equal(logoRes.status, 200);
    assert.equal(logoRes.headers.get('content-type'), 'image/svg+xml');

    const workerRes = await fetch(`${baseUrl}/pdf.worker.js`);
    assert.equal(workerRes.status, 200);
    assert.match(workerRes.headers.get('content-type'), /^application\/javascript/);
    assert.match(await workerRes.text(), /worker/);

    const appPath = join(distDir, 'app.js');
    const firstAppRes = await fetch(`${baseUrl}/app.js`);
    assert.equal(firstAppRes.status, 200);
    assert.equal(await firstAppRes.text(), 'console.log("ui");');

    writeFileSync(appPath, 'console.log("ui-v2-updated");');
    const futureDate = new Date(Date.now() + 10_000);
    utimesSync(appPath, futureDate, futureDate);
    const updatedAppRes = await fetch(`${baseUrl}/app.js`);
    assert.equal(updatedAppRes.status, 200);
    assert.equal(await updatedAppRes.text(), 'console.log("ui-v2-updated");');
  });

  it('POST 接口强制校验 X-Sidecar-Token，未携带返回 401', async () => {
    const res = await fetch(`${baseUrl}/api/fs/stat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: join(workspaceDir, 'demo.pptx'), workspaceUris: [workspaceDir] }),
    });
    assert.equal(res.status, 401);
  });

  it('POST /api/fs/stat、/api/fs/read、/api/fs/list、/api/html/mount 正常响应', async () => {
    const headers = {
      'Content-Type': 'application/json',
      'X-Sidecar-Token': token,
    };

    const statRes = await fetch(`${baseUrl}/api/fs/stat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ file: join(workspaceDir, 'demo.pptx'), workspaceUris: [workspaceDir] }),
    });
    assert.equal(statRes.status, 200);
    const statJson = await statRes.json();
    assert.equal(statJson.kind, 'ppt');
    assert.equal(statJson.ext, '.pptx');
    assert.equal(statJson.size, 4);

    const readRes = await fetch(`${baseUrl}/api/fs/read`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ file: join(workspaceDir, 'demo.pptx'), workspaceUris: [workspaceDir] }),
    });
    assert.equal(readRes.status, 200);
    assert.equal(readRes.headers.get('content-type'), 'application/octet-stream');
    assert.equal(readRes.headers.get('x-content-type-options'), 'nosniff');
    const buf = Buffer.from(await readRes.arrayBuffer());
    assert.deepEqual(buf, Buffer.from([1, 2, 3, 4]));

    const listRes = await fetch(`${baseUrl}/api/fs/list`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ workspaceUris: [workspaceDir] }),
    });
    assert.equal(listRes.status, 200);
    const listJson = await listRes.json();
    assert.equal(listJson.files.length, 5);

    const listCurrentFileRes = await fetch(`${baseUrl}/api/fs/list`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ workspaceUris: [], currentFile: join(workspaceDir, 'demo.html') }),
    });
    assert.equal(listCurrentFileRes.status, 200);
    const listCurrentFileJson = await listCurrentFileRes.json();
    assert.equal(listCurrentFileJson.files.length, 5);
    const listedHtml = listCurrentFileJson.files.find((f) => f.name === 'demo.html');
    assert.ok(listedHtml);
    assert.equal(listedHtml.kind, 'html');

    const xlsxStatRes = await fetch(`${baseUrl}/api/fs/stat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ file: join(workspaceDir, 'demo.xlsx'), workspaceUris: [workspaceDir] }),
    });
    assert.equal(xlsxStatRes.status, 200);
    const xlsxStatJson = await xlsxStatRes.json();
    assert.equal(xlsxStatJson.kind, 'excel');
    assert.equal(xlsxStatJson.ext, '.xlsx');
    assert.equal(xlsxStatJson.size, 5);

    const xlsxReadRes = await fetch(`${baseUrl}/api/fs/read`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ file: join(workspaceDir, 'demo.xlsx'), workspaceUris: [workspaceDir] }),
    });
    assert.equal(xlsxReadRes.status, 200);
    assert.equal(xlsxReadRes.headers.get('content-type'), 'application/octet-stream');
    assert.deepEqual(Buffer.from(await xlsxReadRes.arrayBuffer()), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x05]));

    const csvStatRes = await fetch(`${baseUrl}/api/fs/stat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ file: join(workspaceDir, 'demo.csv'), workspaceUris: [workspaceDir] }),
    });
    assert.equal(csvStatRes.status, 200);
    const csvStatJson = await csvStatRes.json();
    assert.equal(csvStatJson.kind, 'excel');
    assert.equal(csvStatJson.ext, '.csv');

    const csvReadRes = await fetch(`${baseUrl}/api/fs/read`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ file: join(workspaceDir, 'demo.csv'), workspaceUris: [workspaceDir] }),
    });
    assert.equal(csvReadRes.status, 200);
    assert.equal(await csvReadRes.text(), '姓名,分数\n张三,95\n');

    const mountRes = await fetch(`${baseUrl}/api/html/mount`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ file: join(workspaceDir, 'demo.html'), workspaceUris: [workspaceDir] }),
    });
    assert.equal(mountRes.status, 200);
    const mountJson = await mountRes.json();
    assert.equal(mountJson.entryRelPath, 'demo.html');

    const htmlFetch = await fetch(mountJson.url);
    assert.equal(htmlFetch.status, 200);
    assert.match(await htmlFetch.text(), /Demo/);

    // PDF 挂载与 Range 请求
    const pdfMountRes = await fetch(`${baseUrl}/api/pdf/mount`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ file: join(workspaceDir, 'demo.pdf'), workspaceUris: [workspaceDir] }),
    });
    assert.equal(pdfMountRes.status, 200);
    const pdfMountJson = await pdfMountRes.json();
    assert.equal(pdfMountJson.fileName, 'demo.pdf');
    assert.equal(pdfMountJson.size, Buffer.from('%PDF-1.7-MOCK-BODY').length);

    const pdfRangeRes = await fetch(pdfMountJson.url, { headers: { Range: 'bytes=0-7' } });
    assert.equal(pdfRangeRes.status, 206);
    assert.equal(await pdfRangeRes.text(), '%PDF-1.7');

    // 非 PDF 文件调用 /api/pdf/mount 返回 415
    const nonPdfMount = await fetch(`${baseUrl}/api/pdf/mount`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ file: join(workspaceDir, 'demo.pptx'), workspaceUris: [workspaceDir] }),
    });
    assert.equal(nonPdfMount.status, 415);

    // MP4 挂载与 HTTP Range 流式播放
    const mp4Path = join(workspaceDir, 'demo.mp4');
    writeFileSync(mp4Path, Buffer.from('0123456789ABCDEF'));
    const videoMountRes = await fetch(`${baseUrl}/api/video/mount`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ file: mp4Path, workspaceUris: [workspaceDir] }),
    });
    assert.equal(videoMountRes.status, 200);
    const videoMountJson = await videoMountRes.json();
    assert.equal(videoMountJson.fileName, 'demo.mp4');
    assert.equal(videoMountJson.size, 16);

    const videoRangeRes = await fetch(videoMountJson.url, { headers: { Range: 'bytes=4-9' } });
    assert.equal(videoRangeRes.status, 206);
    assert.equal(videoRangeRes.headers.get('content-type'), 'video/mp4');
    assert.equal(videoRangeRes.headers.get('accept-ranges'), 'bytes');
    assert.equal(await videoRangeRes.text(), '456789');

    const nonVideoMount = await fetch(`${baseUrl}/api/video/mount`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ file: join(workspaceDir, 'demo.pptx'), workspaceUris: [workspaceDir] }),
    });
    assert.equal(nonVideoMount.status, 415);

    // 旧版 .doc 返回 415
    const docStat = await fetch(`${baseUrl}/api/fs/stat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ file: join(workspaceDir, 'old.doc'), workspaceUris: [workspaceDir] }),
    });
    assert.equal(docStat.status, 415);
    const docErr = await docStat.json();
    assert.match(docErr.error, /\.docx/);
  });

  it('POST /api/fs/read 对解析格式（60MB）与普通读取格式（80MB）执行分级大小上限', async () => {
    const headers = {
      'Content-Type': 'application/json',
      'X-Sidecar-Token': token,
    };

    const largeXlsx = join(workspaceDir, 'oversized.xlsx');
    writeFileSync(largeXlsx, '');
    truncateSync(largeXlsx, 61 * 1024 * 1024);

    const xlsxReadRes = await fetch(`${baseUrl}/api/fs/read`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ file: largeXlsx, workspaceUris: [workspaceDir] }),
    });
    assert.equal(xlsxReadRes.status, 413);
    const xlsxErr = await xlsxReadRes.json();
    assert.equal(xlsxErr.code, 'FILE_TOO_LARGE');
    assert.match(xlsxErr.error, /60MB/);

    const largeHtml = join(workspaceDir, 'oversized.html');
    writeFileSync(largeHtml, '');
    truncateSync(largeHtml, 81 * 1024 * 1024);

    const htmlReadRes = await fetch(`${baseUrl}/api/fs/read`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ file: largeHtml, workspaceUris: [workspaceDir] }),
    });
    assert.equal(htmlReadRes.status, 413);
    const htmlErr = await htmlReadRes.json();
    assert.equal(htmlErr.code, 'FILE_TOO_LARGE');
    assert.match(htmlErr.error, /80MB/);
  });
});

describe('xlsx 内存工作簿多工作表、合并单元格与公式无损读写测试', () => {
  it('生成真实内存 .xlsx buffer 并无损读回多 Sheet、!merges 合并区域、日期(.w)与公式单元格', () => {
    const wb = XLSX.utils.book_new();

    const summarySheet = XLSX.utils.aoa_to_sheet([
      ['季度财务汇总报表', null, null],
      ['项目', 'Q1', 'Q2'],
      ['营收', 100, 200],
      ['合计', null, null],
      ['日期', new Date(Date.UTC(2026, 10, 14)), null],
    ]);
    summarySheet['!merges'] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: 2 } },
    ];
    summarySheet['B4'] = { t: 'n', v: 300, f: 'SUM(B3:C3)' };

    const detailSheet = XLSX.utils.aoa_to_sheet([
      ['部门', '负责人', '预算'],
      ['研发部', '张伟', 180],
      ['产品部', '李娜', 120],
    ]);

    XLSX.utils.book_append_sheet(wb, summarySheet, '汇总');
    XLSX.utils.book_append_sheet(wb, detailSheet, '明细');

    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    assert.ok(Buffer.isBuffer(buffer) && buffer.length > 0);

    const parsed = XLSX.read(new Uint8Array(buffer), {
      type: 'array',
      cellFormula: true,
      cellDates: false,
      cellNF: true,
      cellStyles: true,
    });

    assert.deepEqual(parsed.SheetNames, ['汇总', '明细']);

    const parsedSummary = parsed.Sheets['汇总'];
    assert.equal(parsedSummary['A1']?.v, '季度财务汇总报表');
    assert.deepEqual(parsedSummary['!merges'], [
      { s: { r: 0, c: 0 }, e: { r: 0, c: 2 } },
    ]);
    assert.equal(parsedSummary['B4']?.f, 'SUM(B3:C3)');
    assert.equal(parsedSummary['B4']?.v, 300);
    assert.equal(parsedSummary['B5']?.t, 'n');
    assert.equal(parsedSummary['B5']?.w, '11/14/26');

    const parsedDetail = parsed.Sheets['明细'];
    assert.equal(parsedDetail['A2']?.v, '研发部');
    assert.equal(parsedDetail['B2']?.v, '张伟');
    assert.equal(parsedDetail['C3']?.v, 120);
  });
});

describe('PPTX 大条目 ZIP 限额与错误格式化测试', () => {
  it('构造 5100+ 条目内存 .pptx：RECOMMENDED_ZIP_LIMITS 报错而 PPTX_ZIP_LIMITS 可成功解析并读取幻灯片与惰性媒体', async () => {
    const [{ default: JSZip }, pptxBrowser, pptConfig] = await Promise.all([
      import('jszip'),
      import('@aiden0z/pptx-renderer/browser'),
      import('../src/utils/pptConfig.ts'),
    ]);
    const { parseZipLazyMedia, RECOMMENDED_ZIP_LIMITS } = pptxBrowser;
    const { PPTX_ZIP_LIMITS, PPTX_EMBEDDED_FONT_LIMITS, formatPptLoadError } = pptConfig;

    assert.equal(RECOMMENDED_ZIP_LIMITS.maxEntries, 4000);
    assert.equal(PPTX_ZIP_LIMITS.maxEntries, 50_000);
    assert.equal(PPTX_EMBEDDED_FONT_LIMITS.maxFaces, 32);

    const zip = new JSZip();
    const contentTypesXml =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="png" ContentType="image/png"/>' +
      '</Types>';
    const presentationXml =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>' +
      '</p:presentation>';
    const presentationRelsXml =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>' +
      '</Relationships>';
    const slide1Xml =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
      '<p:cSld><p:spTree><p:sp><p:txBody><a:p xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:r><a:t>数字逻辑构件测试</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>' +
      '</p:sld>';
    const pngPayload = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    zip.file('[Content_Types].xml', contentTypesXml);
    zip.file('ppt/presentation.xml', presentationXml);
    zip.file('ppt/_rels/presentation.xml.rels', presentationRelsXml);
    zip.file('ppt/slides/slide1.xml', slide1Xml);
    zip.file('ppt/media/image1.png', pngPayload);

    // 追加 5100 个媒体条目，使总条目数达到 5105（模拟 5097+ 条目的大型课件）
    const tinyAsset = new Uint8Array([1, 2, 3, 4]);
    for (let i = 0; i < 5100; i += 1) {
      zip.file(`ppt/media/asset_${i}.bin`, tinyAsset, { compression: 'STORE' });
    }

    const nodeBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
    const arrayBuffer = nodeBuffer.buffer.slice(
      nodeBuffer.byteOffset,
      nodeBuffer.byteOffset + nodeBuffer.byteLength,
    );

    let defaultLimitError = null;
    await assert.rejects(
      async () => parseZipLazyMedia(arrayBuffer, RECOMMENDED_ZIP_LIMITS),
      (err) => {
        defaultLimitError = err;
        return (
          err instanceof Error &&
          err.message.includes('entries') &&
          err.message.includes('maxEntries 4000')
        );
      },
    );

    const formattedDefaultErr = formatPptLoadError(defaultLimitError);
    assert.match(formattedDefaultErr.message, /条目数过多/);
    assert.match(formattedDefaultErr.message, /5105/);
    assert.match(formattedDefaultErr.message, /4000/);

    const parsedFiles = await parseZipLazyMedia(arrayBuffer, PPTX_ZIP_LIMITS);
    assert.ok(parsedFiles.presentation.includes('p:presentation'));
    assert.equal(parsedFiles.slides.get('ppt/slides/slide1.xml')?.includes('数字逻辑构件测试'), true);
    assert.ok(parsedFiles.mediaResolver);
    assert.equal(parsedFiles.mediaResolver.totalCount, 5101);

    const resolvedImage = await parsedFiles.mediaResolver.resolve('../media/image1.png');
    assert.equal(resolvedImage?.mediaPath, 'ppt/media/image1.png');
    assert.deepEqual(resolvedImage?.data, pngPayload);
  });

  it('formatPptLoadError 正确格式化各类 zip limit exceeded 与常见压缩包损坏错误', async () => {
    const { formatPptLoadError } = await import('../src/utils/pptConfig.ts');

    const entriesErr = formatPptLoadError(
      new Error('PPTX zip limit exceeded: entries 5097 > maxEntries 4000'),
    );
    assert.match(entriesErr.message, /5097/);
    assert.match(entriesErr.message, /4000/);
    assert.match(entriesErr.message, /条目数过多/);

    const mediaErr = formatPptLoadError(
      new Error('PPTX zip limit exceeded: media bytes 250000000 > maxMediaBytes 201326592'),
    );
    assert.match(mediaErr.message, /媒体资源体积过大/);
    assert.match(mediaErr.message, /250000000/);
    assert.match(mediaErr.message, /201326592/);

    const totalErr = formatPptLoadError(
      new Error(
        'PPTX zip limit exceeded: total uncompressed bytes 300000000 > maxTotalUncompressedBytes 268435456',
      ),
    );
    assert.match(totalErr.message, /解压后总体积过大/);
    assert.match(totalErr.message, /300000000/);
    assert.match(totalErr.message, /268435456/);

    const entryErr = formatPptLoadError(
      new Error(
        'PPTX zip limit exceeded: ppt/media/video1.mp4 is 40000000 bytes > maxEntryUncompressedBytes 33554432',
      ),
    );
    assert.match(entryErr.message, /ppt\/media\/video1\.mp4/);
    assert.match(entryErr.message, /40000000/);
    assert.match(entryErr.message, /33554432/);

    const corruptErr = formatPptLoadError(
      new Error("Corrupted zip: can't find end of central directory"),
    );
    assert.match(corruptErr.message, /格式无效或压缩包已损坏/);

    const encryptedErr = formatPptLoadError(new Error('File is encrypted with password'));
    assert.match(encryptedErr.message, /已加密或受密码保护/);

    const emptyErr = formatPptLoadError(new Error('empty buffer (0 bytes)'));
    assert.match(emptyErr.message, /内容为空/);
  });
});

describe('fileMeta 兜底文件元信息推断与格式徽标测试', () => {
  it('inferFallbackFileStat 与 formatKindBadge 正确覆盖全格式、Windows 反斜杠、大小写混合及未知/无后缀路径', async () => {
    const { inferFallbackFileStat, formatKindBadge } = await import('../src/utils/fileMeta.ts');

    const cases = [
      { path: 'D:\\Courses\\05 数字逻辑构件 Digital Building Blocks.pptx', kind: 'ppt', ext: '.pptx', badge: 'PPTX' },
      { path: 'C:\\legacy\\slides.PPT', kind: 'ppt', ext: '.ppt', badge: 'PPT' },
      { path: '/docs/report.Docx', kind: 'word', ext: '.docx', badge: 'DOCX' },
      { path: '/docs/legacy.doc', kind: 'word', ext: '.doc', badge: 'DOC' },
      { path: 'C:\\sheets\\Budget.XLSX\\', kind: 'excel', ext: '.xlsx', badge: 'XLSX' },
      { path: '/sheets/old.xls?t=123', kind: 'excel', ext: '.xls', badge: 'XLS' },
      { path: '/sheets/data.CSV#sheet1', kind: 'excel', ext: '.csv', badge: 'CSV' },
      { path: 'D:\\data\\table.TsV', kind: 'excel', ext: '.tsv', badge: 'TSV' },
      { path: '/papers/manual.PDF', kind: 'pdf', ext: '.pdf', badge: 'PDF' },
      { path: 'D:\\media\\demo.Mp4', kind: 'mp4', ext: '.mp4', badge: 'MP4' },
      { path: 'D:\\media\\clip.WebM', kind: 'mp4', ext: '.webm', badge: 'WEBM' },
      { path: 'D:\\audio\\bgm.MP3', kind: 'audio', ext: '.mp3', badge: 'MP3' },
      { path: '/audio/sound.wav', kind: 'audio', ext: '.wav', badge: 'WAV' },
      { path: '/audio/voice.m4a', kind: 'audio', ext: '.m4a', badge: 'M4A' },
      { path: '/audio/effect.ogg', kind: 'audio', ext: '.ogg', badge: 'OGG' },
      { path: '/audio/lossless.FLAC', kind: 'audio', ext: '.flac', badge: 'FLAC' },
      { path: 'D:\\images\\photo.JPG', kind: 'image', ext: '.jpg', badge: 'JPG' },
      { path: '/images/banner.jpeg', kind: 'image', ext: '.jpeg', badge: 'JPEG' },
      { path: 'C:\\assets\\icon.Png', kind: 'image', ext: '.png', badge: 'PNG' },
      { path: '/images/hero.webp', kind: 'image', ext: '.webp', badge: 'WEBP' },
      { path: '/images/anim.GIF', kind: 'image', ext: '.gif', badge: 'GIF' },
      { path: '/images/logo.svg', kind: 'image', ext: '.svg', badge: 'SVG' },
      { path: '/images/raw.bmp', kind: 'image', ext: '.bmp', badge: 'BMP' },
      { path: '/images/favicon.ico', kind: 'image', ext: '.ico', badge: 'ICO' },
      { path: '/images/nextgen.avif', kind: 'image', ext: '.avif', badge: 'AVIF' },
      { path: '/web/index.HTML', kind: 'html', ext: '.html', badge: 'HTML' },
      { path: '/web/page.htm', kind: 'html', ext: '.htm', badge: 'HTM' },
      { path: 'D:\\notes\\readme.txt', kind: 'word', ext: '.txt', badge: 'DOCX' },
      { path: 'D:\\notes\\Makefile', kind: 'word', ext: '', badge: 'DOCX' },
      { path: '/repo/.gitignore', kind: 'word', ext: '', badge: 'DOCX' },
    ];

    for (const item of cases) {
      const stat = inferFallbackFileStat(item.path);
      assert.equal(stat.kind, item.kind, `path=${item.path} kind`);
      assert.equal(stat.ext, item.ext, `path=${item.path} ext`);
      assert.equal(stat.size, 0);
      assert.equal(stat.mtimeMs, 0);
      assert.equal(formatKindBadge(stat.kind, stat.ext), item.badge, `path=${item.path} badge`);
    }

    // 显式断言 .pptx 报错兜底绝不会回退成 word / DOCX
    const pptxFallback = inferFallbackFileStat('E:\\课堂\\05 数字逻辑构件.PPTX');
    assert.equal(pptxFallback.kind, 'ppt');
    assert.equal(pptxFallback.ext, '.pptx');
    assert.equal(pptxFallback.name, '05 数字逻辑构件.PPTX');
    assert.equal(formatKindBadge(pptxFallback.kind, pptxFallback.ext), 'PPTX');
    assert.notEqual(pptxFallback.kind, 'word');
    assert.notEqual(formatKindBadge(pptxFallback.kind, pptxFallback.ext), 'DOCX');
  });
});

describe('wheelPager 单页模式滚轮翻页控制测试', () => {
  function createMockWheelEvent(overrides = {}) {
    let prevented = false;
    const event = {
      deltaX: 0,
      deltaY: 0,
      deltaMode: 0,
      ctrlKey: false,
      metaKey: false,
      defaultPrevented: false,
      preventDefault() {
        prevented = true;
        event.defaultPrevented = true;
      },
      ...overrides,
    };
    return {
      event,
      isPrevented: () => prevented,
    };
  }

  it('支持单页上下滚轮翻页、抑制触控板惯性连翻，并在放大可滚动时优先滚动内容', async () => {
    const { createWheelPager } = await import('../src/utils/wheelPager.ts');

    let enabled = true;
    let currentPage = 2;
    const totalPages = 5;
    let nowMs = 1000;
    const scrollBox = {
      scrollTop: 0,
      clientHeight: 500,
      scrollHeight: 500,
    };

    const pager = createWheelPager({
      getScrollContainer: () => scrollBox,
      isEnabled: () => enabled,
      getPageInfo: () => ({ currentPage, totalPages }),
      onPrevPage: () => {
        currentPage -= 1;
      },
      onNextPage: () => {
        currentPage += 1;
      },
      now: () => nowMs,
    });

    // 1. 鼠标向下滚动 1 格 -> 立即翻到下一页
    const downStep = createMockWheelEvent({ deltaY: 100 });
    pager.handleWheel(downStep.event);
    assert.equal(currentPage, 3);
    assert.equal(downStep.isPrevented(), true);

    // 2. 紧接着触控板高频惯性尾流（16ms 间隔、小幅衰减）-> 仅被抑制，不连翻
    for (const delta of [24, 18, 12, 8, 4]) {
      nowMs += 16;
      const tail = createMockWheelEvent({ deltaY: delta });
      pager.handleWheel(tail.event);
      assert.equal(currentPage, 3);
      assert.equal(tail.isPrevented(), true);
    }

    // 3. 停顿超过冷却期后再向上滚动 -> 翻回上一页
    nowMs += 220;
    const upStep = createMockWheelEvent({ deltaY: -100 });
    pager.handleWheel(upStep.event);
    assert.equal(currentPage, 2);
    assert.equal(upStep.isPrevented(), true);

    // 4. Ctrl+滚轮缩放手势与横向主导滚动不触发翻页
    nowMs += 300;
    const zoomWheel = createMockWheelEvent({ deltaY: -120, ctrlKey: true });
    pager.handleWheel(zoomWheel.event);
    assert.equal(currentPage, 2);
    assert.equal(zoomWheel.isPrevented(), false);

    const horizontalWheel = createMockWheelEvent({ deltaX: 120, deltaY: 10 });
    pager.handleWheel(horizontalWheel.event);
    assert.equal(currentPage, 2);
    assert.equal(horizontalWheel.isPrevented(), false);

    // 5. 放大溢出时：未滚动到底部前不翻页；到达底部后再向下滚才翻页
    scrollBox.scrollHeight = 900;
    scrollBox.scrollTop = 100;
    nowMs += 300;
    const midScroll = createMockWheelEvent({ deltaY: 120 });
    pager.handleWheel(midScroll.event);
    assert.equal(currentPage, 2);
    assert.equal(midScroll.isPrevented(), false);

    scrollBox.scrollTop = 400; // 400 + 500 >= 900，已到底部
    nowMs += 300;
    const bottomFlip = createMockWheelEvent({ deltaY: 120 });
    pager.handleWheel(bottomFlip.event);
    assert.equal(currentPage, 3);
    assert.equal(bottomFlip.isPrevented(), true);

    // 6. 滚动布局模式关闭时（isEnabled=false）不拦截
    enabled = false;
    nowMs += 300;
    const listModeWheel = createMockWheelEvent({ deltaY: 120 });
    pager.handleWheel(listModeWheel.event);
    assert.equal(currentPage, 3);
    assert.equal(listModeWheel.isPrevented(), false);

    // 7. 第一页继续向上、最后一页继续向下均不拦截
    enabled = true;
    scrollBox.scrollHeight = 500;
    scrollBox.scrollTop = 0;
    currentPage = 1;
    nowMs += 300;
    const firstPageUp = createMockWheelEvent({ deltaY: -120 });
    pager.handleWheel(firstPageUp.event);
    assert.equal(currentPage, 1);
    assert.equal(firstPageUp.isPrevented(), false);

    currentPage = totalPages;
    nowMs += 300;
    const lastPageDown = createMockWheelEvent({ deltaY: 120 });
    pager.handleWheel(lastPageDown.event);
    assert.equal(currentPage, totalPages);
    assert.equal(lastPageDown.isPrevented(), false);

    pager.destroy();
  });
});

describe('dragPanner 放大拖拽平移控制器测试', () => {
  function createMockEventTarget() {
    const listeners = new Map();
    return {
      addEventListener(type, fn) {
        let set = listeners.get(type);
        if (!set) {
          set = new Set();
          listeners.set(type, set);
        }
        set.add(fn);
      },
      removeEventListener(type, fn) {
        listeners.get(type)?.delete(fn);
      },
      dispatch(type, event = {}) {
        for (const fn of Array.from(listeners.get(type) ?? [])) {
          fn(event);
        }
      },
      listenerCount(type) {
        return listeners.get(type)?.size ?? 0;
      },
    };
  }

  function createMockContainer({
    clientWidth = 400,
    clientHeight = 300,
    rectLeft = 0,
    rectTop = 0,
    scrollLeft = 0,
    scrollTop = 0,
  } = {}) {
    const classes = new Set();
    return {
      clientWidth,
      clientHeight,
      scrollLeft,
      scrollTop,
      classList: {
        add(name) {
          classes.add(name);
        },
        remove(name) {
          classes.delete(name);
        },
        contains(name) {
          return classes.has(name);
        },
      },
      getBoundingClientRect() {
        return {
          left: rectLeft,
          top: rectTop,
          width: clientWidth,
          height: clientHeight,
          right: rectLeft + clientWidth,
          bottom: rectTop + clientHeight,
        };
      },
    };
  }

  function createMockMouseEvent(overrides = {}) {
    let prevented = false;
    let stopped = false;
    const event = {
      button: 0,
      clientX: 0,
      clientY: 0,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      defaultPrevented: false,
      target: null,
      preventDefault() {
        prevented = true;
        event.defaultPrevented = true;
      },
      stopPropagation() {
        stopped = true;
      },
      ...overrides,
    };
    return {
      event,
      isPrevented: () => prevented,
      isStopped: () => stopped,
    };
  }

  it('放大启用状态下按住左键或中键拖动超过阈值时按反向位移更新滚动并添加 is-panning', async () => {
    const { createDragPanner } = await import('../src/utils/dragPanner.ts');

    const eventTarget = createMockEventTarget();
    const container = createMockContainer({ scrollLeft: 100, scrollTop: 80 });
    const panner = createDragPanner({
      getScrollContainer: () => container,
      isEnabled: () => true,
      dragThresholdPx: 3,
      eventTarget,
    });

    panner.syncState();
    assert.equal(container.classList.contains('is-pannable'), true);
    assert.equal(container.classList.contains('is-panning'), false);

    // 左键按下并在阈值内微移：尚未进入拖拽状态
    const downLeft = createMockMouseEvent({ button: 0, clientX: 150, clientY: 120 });
    panner.handleMouseDown(downLeft.event);
    assert.equal(eventTarget.listenerCount('mousemove'), 1);
    assert.equal(eventTarget.listenerCount('mouseup'), 1);
    assert.equal(eventTarget.listenerCount('blur'), 1);

    const smallMove = createMockMouseEvent({ clientX: 151, clientY: 121 });
    eventTarget.dispatch('mousemove', smallMove.event);
    assert.equal(panner.isPanning(), false);
    assert.equal(container.classList.contains('is-panning'), false);
    assert.equal(container.scrollLeft, 100);
    assert.equal(container.scrollTop, 80);

    // 移动超过阈值（dx=+40, dy=-25）：进入 is-panning 并反向更新 scrollLeft/scrollTop
    const dragMove = createMockMouseEvent({ clientX: 190, clientY: 95 });
    eventTarget.dispatch('mousemove', dragMove.event);
    assert.equal(panner.isPanning(), true);
    assert.equal(dragMove.isPrevented(), true);
    assert.equal(container.classList.contains('is-panning'), true);
    assert.equal(container.scrollLeft, 60);
    assert.equal(container.scrollTop, 105);

    eventTarget.dispatch('mouseup', createMockMouseEvent({ button: 0 }).event);
    assert.equal(panner.isPanning(), false);
    assert.equal(container.classList.contains('is-panning'), false);
    assert.equal(eventTarget.listenerCount('mousemove'), 0);

    // 中键按下会先阻止默认自动滚屏，拖动后同样正确更新滚动位置
    const downMiddle = createMockMouseEvent({ button: 1, clientX: 200, clientY: 150 });
    panner.handleMouseDown(downMiddle.event);
    assert.equal(downMiddle.isPrevented(), true);

    const middleMove = createMockMouseEvent({ clientX: 170, clientY: 180 });
    eventTarget.dispatch('mousemove', middleMove.event);
    assert.equal(panner.isPanning(), true);
    assert.equal(container.classList.contains('is-panning'), true);
    assert.equal(container.scrollLeft, 90);
    assert.equal(container.scrollTop, 75);

    eventTarget.dispatch('mouseup', createMockMouseEvent({ button: 1 }).event);
    panner.destroy();
  });

  it('拖动释放后紧随其后的 click 被捕获抑制，而未超过阈值的普通点击不抑制 click', async () => {
    const { createDragPanner } = await import('../src/utils/dragPanner.ts');

    const eventTarget = createMockEventTarget();
    const container = createMockContainer();
    const panner = createDragPanner({
      getScrollContainer: () => container,
      isEnabled: () => true,
      dragThresholdPx: 3,
      eventTarget,
    });

    // 1. 超过阈值拖动并释放 -> 紧随其后的首个 click 应被抑制，第二次不再被抑制
    panner.handleMouseDown(createMockMouseEvent({ button: 0, clientX: 50, clientY: 50 }).event);
    eventTarget.dispatch('mousemove', createMockMouseEvent({ clientX: 65, clientY: 50 }).event);
    assert.equal(panner.isPanning(), true);
    eventTarget.dispatch('mouseup', createMockMouseEvent({ button: 0, clientX: 65, clientY: 50 }).event);

    const suppressedClick = createMockMouseEvent({ button: 0, clientX: 65, clientY: 50 });
    panner.handleClickCapture(suppressedClick.event);
    assert.equal(suppressedClick.isPrevented(), true);
    assert.equal(suppressedClick.isStopped(), true);

    const subsequentClick = createMockMouseEvent({ button: 0, clientX: 65, clientY: 50 });
    panner.handleClickCapture(subsequentClick.event);
    assert.equal(subsequentClick.isPrevented(), false);
    assert.equal(subsequentClick.isStopped(), false);

    // 2. 未超过阈值的普通点击（微移 1px 后释放）-> 不应抑制 click
    panner.handleMouseDown(createMockMouseEvent({ button: 0, clientX: 80, clientY: 80 }).event);
    eventTarget.dispatch('mousemove', createMockMouseEvent({ clientX: 81, clientY: 81 }).event);
    assert.equal(panner.isPanning(), false);
    eventTarget.dispatch('mouseup', createMockMouseEvent({ button: 0, clientX: 81, clientY: 81 }).event);

    const normalClick = createMockMouseEvent({ button: 0, clientX: 81, clientY: 81 });
    panner.handleClickCapture(normalClick.event);
    assert.equal(normalClick.isPrevented(), false);
    assert.equal(normalClick.isStopped(), false);

    panner.destroy();
  });

  it('未启用状态、点击交互元素或滚动条轨道位置时不触发拖拽', async () => {
    const { createDragPanner } = await import('../src/utils/dragPanner.ts');

    const eventTarget = createMockEventTarget();
    const container = createMockContainer({
      clientWidth: 400,
      clientHeight: 300,
      rectLeft: 10,
      rectTop: 20,
      scrollLeft: 50,
      scrollTop: 50,
    });
    let enabled = false;
    const panner = createDragPanner({
      getScrollContainer: () => container,
      isEnabled: () => enabled,
      eventTarget,
    });

    // 1. 未启用状态不触发拖拽
    panner.handleMouseDown(createMockMouseEvent({ button: 0, clientX: 100, clientY: 100 }).event);
    eventTarget.dispatch('mousemove', createMockMouseEvent({ clientX: 150, clientY: 150 }).event);
    assert.equal(panner.isPanning(), false);
    assert.equal(eventTarget.listenerCount('mousemove'), 0);
    assert.equal(container.scrollLeft, 50);

    // 2. 启用后点击 BUTTON / INPUT / 按钮内子元素不触发拖拽
    enabled = true;
    const buttonTarget = { tagName: 'BUTTON', parentElement: container };
    const inputTarget = { tagName: 'INPUT', parentElement: container };
    const nestedIconTarget = { tagName: 'SPAN', parentElement: buttonTarget };

    for (const target of [buttonTarget, inputTarget, nestedIconTarget]) {
      panner.handleMouseDown(
        createMockMouseEvent({ button: 0, clientX: 100, clientY: 100, target }).event,
      );
      assert.equal(eventTarget.listenerCount('mousemove'), 0);
      eventTarget.dispatch('mousemove', createMockMouseEvent({ clientX: 160, clientY: 160 }).event);
      assert.equal(panner.isPanning(), false);
      assert.equal(container.scrollLeft, 50);
    }

    // 3. 点击在右侧竖向滚动条或底部横向滚动条轨道位置时不触发拖拽
    // 右边界为 rectLeft(10) + clientWidth(400) = 410；底边界为 rectTop(20) + clientHeight(300) = 320
    panner.handleMouseDown(createMockMouseEvent({ button: 0, clientX: 410, clientY: 100 }).event);
    assert.equal(eventTarget.listenerCount('mousemove'), 0);
    panner.handleMouseDown(createMockMouseEvent({ button: 0, clientX: 100, clientY: 320 }).event);
    assert.equal(eventTarget.listenerCount('mousemove'), 0);

    // 4. 修饰键（Ctrl）或右键（button=2）不触发拖拽
    panner.handleMouseDown(
      createMockMouseEvent({ button: 0, clientX: 100, clientY: 100, ctrlKey: true }).event,
    );
    panner.handleMouseDown(createMockMouseEvent({ button: 2, clientX: 100, clientY: 100 }).event);
    assert.equal(eventTarget.listenerCount('mousemove'), 0);

    panner.destroy();
  });

  it('syncState 与 destroy 能正确同步和清理 is-pannable / is-panning 类名并释放监听', async () => {
    const { createDragPanner } = await import('../src/utils/dragPanner.ts');

    const eventTarget = createMockEventTarget();
    const containerA = createMockContainer({ scrollLeft: 30, scrollTop: 30 });
    const containerB = createMockContainer({ scrollLeft: 0, scrollTop: 0 });
    let activeContainer = containerA;
    let enabled = false;

    const panner = createDragPanner({
      getScrollContainer: () => activeContainer,
      isEnabled: () => enabled,
      eventTarget,
    });

    // 初始禁用：无 is-pannable
    panner.syncState();
    assert.equal(containerA.classList.contains('is-pannable'), false);

    // 启用后 syncState 添加 is-pannable
    enabled = true;
    panner.syncState();
    assert.equal(containerA.classList.contains('is-pannable'), true);

    // 切换容器时同步清理旧容器类名
    activeContainer = containerB;
    panner.syncState();
    assert.equal(containerA.classList.contains('is-pannable'), false);
    assert.equal(containerB.classList.contains('is-pannable'), true);

    // 拖拽途中禁用并 syncState：应清理 is-pannable 与 is-panning 并解绑监听
    panner.handleMouseDown(createMockMouseEvent({ button: 0, clientX: 40, clientY: 40 }).event);
    eventTarget.dispatch('mousemove', createMockMouseEvent({ clientX: 60, clientY: 60 }).event);
    assert.equal(panner.isPanning(), true);
    assert.equal(containerB.classList.contains('is-panning'), true);
    assert.equal(eventTarget.listenerCount('mousemove'), 1);

    enabled = false;
    panner.syncState();
    assert.equal(panner.isPanning(), false);
    assert.equal(containerB.classList.contains('is-pannable'), false);
    assert.equal(containerB.classList.contains('is-panning'), false);
    assert.equal(eventTarget.listenerCount('mousemove'), 0);
    assert.equal(eventTarget.listenerCount('mouseup'), 0);
    assert.equal(eventTarget.listenerCount('blur'), 0);

    // 重新启用并再次进入拖拽后调用 destroy()：彻底清理类名、解绑监听且后续事件不生效
    enabled = true;
    panner.syncState();
    assert.equal(containerB.classList.contains('is-pannable'), true);
    panner.handleMouseDown(createMockMouseEvent({ button: 0, clientX: 40, clientY: 40 }).event);
    eventTarget.dispatch('mousemove', createMockMouseEvent({ clientX: 70, clientY: 70 }).event);
    assert.equal(panner.isPanning(), true);
    assert.equal(containerB.classList.contains('is-panning'), true);

    panner.destroy();
    assert.equal(panner.isPanning(), false);
    assert.equal(containerB.classList.contains('is-pannable'), false);
    assert.equal(containerB.classList.contains('is-panning'), false);
    assert.equal(eventTarget.listenerCount('mousemove'), 0);
    assert.equal(eventTarget.listenerCount('mouseup'), 0);
    assert.equal(eventTarget.listenerCount('blur'), 0);

    // destroy 后再次 syncState / handleMouseDown 均不再挂载状态或监听
    panner.syncState();
    panner.handleMouseDown(createMockMouseEvent({ button: 0, clientX: 40, clientY: 40 }).event);
    assert.equal(containerB.classList.contains('is-pannable'), false);
    assert.equal(eventTarget.listenerCount('mousemove'), 0);
  });

  it('isPointOverText 准确区分交互控件/工具条/纯容器/远距吸附/字符矩形命中与子 Text 降级', async () => {
    const { isPointOverText } = await import('../src/utils/dragPanner.ts');

    const prevDocument = globalThis.document;
    try {
      // 辅助：创建带 rect 的 mock Text 节点与容器
      const container = createMockContainer();
      const children = new Set();
      container.contains = (node) => {
        let cur = node;
        let guard = 0;
        while (cur && guard < 32) {
          if (cur === container || children.has(cur)) return true;
          cur = cur.parentElement ?? cur.parentNode ?? null;
          guard += 1;
        }
        return false;
      };

      const makeTextNode = (text, parentElement) => {
        const node = { nodeType: 3, textContent: text, parentElement };
        children.add(node);
        return node;
      };

      const spanEl = { tagName: 'SPAN', parentElement: container, childNodes: [] };
      const textNode = makeTextNode('Hello World', spanEl);
      spanEl.childNodes = [textNode];
      children.add(spanEl);

      // 1. 纯容器、空输入、图片/画布直接返回 false
      assert.equal(isPointOverText(null, 50, 50, container), false);
      assert.equal(isPointOverText(container, 50, 50, container), false);
      assert.equal(isPointOverText({ tagName: 'IMG', parentElement: container }, 50, 50, container), false);
      assert.equal(isPointOverText({ tagName: 'CANVAS', parentElement: container }, 50, 50, container), false);
      assert.equal(isPointOverText({ tagName: 'DIV', parentElement: container, childNodes: [] }, 50, 50, container), false);

      // 2. 交互控件与排除 UI 区域（选区工具条/缩略图侧栏）即使含文本也返回 false
      const btn = { tagName: 'BUTTON', parentElement: container };
      const btnText = makeTextNode('发送', btn);
      btn.childNodes = [btnText];
      const link = { tagName: 'A', parentElement: container };
      const linkText = makeTextNode('链接', link);
      link.childNodes = [linkText];
      const roleLink = {
        tagName: 'SPAN',
        parentElement: container,
        getAttribute: (name) => (name === 'role' ? 'link' : null),
      };
      const editable = { tagName: 'DIV', isContentEditable: true, parentElement: container };
      const selBar = { tagName: 'DIV', className: 'fp-selection-bar', parentElement: container };
      const selBarChild = { tagName: 'SPAN', parentElement: selBar };
      const pptThumbs = { tagName: 'ASIDE', className: 'fp-ppt-thumbs', parentElement: container };
      const pptThumbChild = { tagName: 'SPAN', parentElement: pptThumbs };
      const pdfThumbs = { tagName: 'ASIDE', className: 'fp-pdf-thumbs', parentElement: container };
      const pdfThumbChild = { tagName: 'SPAN', parentElement: pdfThumbs };

      for (const excluded of [
        btn,
        btnText,
        link,
        linkText,
        roleLink,
        editable,
        selBarChild,
        pptThumbChild,
        pdfThumbChild,
      ]) {
        assert.equal(isPointOverText(excluded, 100, 100, container), false);
      }

      // 3. caretRangeFromPoint + 3px 字符矩形命中与远距吸附排除
      const outsideTextNode = { nodeType: 3, textContent: '外部文本', parentElement: { tagName: 'P' } };
      let caretResult = null;
      const charRect = { left: 100, right: 120, top: 200, bottom: 218, width: 20, height: 18 };
      const textRunRect = { left: 100, right: 180, top: 200, bottom: 218, width: 80, height: 18 };

      globalThis.document = {
        caretRangeFromPoint: () => caretResult,
        createRange() {
          let targetNode = null;
          return {
            setStart(node) {
              targetNode = node;
            },
            setEnd() {},
            selectNodeContents(node) {
              targetNode = node;
            },
            getClientRects() {
              if (targetNode === textNode) return [charRect];
              return [];
            },
          };
        },
      };

      // 命中字符矩形内部与 3px 容差边界
      caretResult = { startContainer: textNode, startOffset: 2, getClientRects: () => [charRect] };
      assert.equal(isPointOverText(spanEl, 110, 209, container), true);
      assert.equal(isPointOverText(spanEl, 97, 197, container), true);
      assert.equal(isPointOverText(spanEl, 123, 221, container), true);

      // 远距吸附排除：caretRangeFromPoint 吸附到该文本，但指针在 4px 之外的空白处（124, 209）及降级矩形之外 -> 返回 false
      assert.equal(isPointOverText(spanEl, 124, 209, container), false);
      assert.equal(isPointOverText(spanEl, 110, 222, container), false);

      // caretRangeFromPoint 命中容器外部节点时排除
      caretResult = {
        startContainer: outsideTextNode,
        startOffset: 0,
        getClientRects: () => [{ left: 0, right: 300, top: 0, bottom: 300, width: 300, height: 300 }],
      };
      assert.equal(isPointOverText({ tagName: 'DIV', parentElement: container, childNodes: [] }, 10, 10, container), false);

      // 4. caretPositionFromPoint 兼容与子 Text 节点矩形降级（如 PDF 透明文本层 .fp-pdf-text-layer span）
      const pdfTextLayer = { tagName: 'DIV', className: 'fp-pdf-text-layer', parentElement: container };
      const pdfSpan = { tagName: 'SPAN', parentElement: pdfTextLayer, childNodes: [] };
      const pdfText = makeTextNode('PDF 文字', pdfSpan);
      pdfSpan.childNodes = [pdfText];
      children.add(pdfTextLayer);
      children.add(pdfSpan);

      globalThis.document = {
        caretPositionFromPoint: () => null,
        createRange() {
          let selected = null;
          return {
            setStart(node) {
              selected = node;
            },
            setEnd() {},
            selectNodeContents(node) {
              selected = node;
            },
            getClientRects() {
              if (selected === pdfText) return [textRunRect];
              return [];
            },
          };
        },
      };

      // 在 PDF span 的文本运行矩形内返回 true，空白处返回 false
      assert.equal(isPointOverText(pdfSpan, 150, 210, container), true);
      assert.equal(isPointOverText(pdfSpan, 250, 210, container), false);

      // 5. 无 createRange 的轻量测试替身环境：直接子 Text 节点或 nodeType===3 回退命中
      globalThis.document = {};
      assert.equal(isPointOverText(spanEl, 10, 10, container), true);
      assert.equal(isPointOverText(textNode, 10, 10, container), true);
    } finally {
      globalThis.document = prevDocument;
    }
  });

  it('左键停文字放行划选、空白处自动拖拽、中键全区拖拽与 shouldPanTarget 生效', async () => {
    const { createDragPanner } = await import('../src/utils/dragPanner.ts');

    const prevDocument = globalThis.document;
    try {
      const eventTarget = createMockEventTarget();
      const container = createMockContainer({ scrollLeft: 100, scrollTop: 100 });
      const textTarget = {
        tagName: 'P',
        parentElement: container,
        childNodes: [{ nodeType: 3, textContent: '可划选段落文本' }],
      };
      const blankTarget = {
        tagName: 'DIV',
        parentElement: container,
        childNodes: [],
      };
      const noPanBlank = {
        tagName: 'DIV',
        className: 'custom-no-pan',
        parentElement: container,
        childNodes: [],
      };

      // 无 createRange 时，含直接 Text 子节点的 textTarget 命中文字，blankTarget 为空白区
      globalThis.document = {};

      const panner = createDragPanner({
        getScrollContainer: () => container,
        isEnabled: () => true,
        shouldPanTarget: (target) => target !== noPanBlank,
        dragThresholdPx: 3,
        eventTarget,
      });

      // 1. 左键按在文字上：放行原生选字，不绑定全局拖拽监听，不改变滚动位置
      const textDown = createMockMouseEvent({ button: 0, clientX: 60, clientY: 60, target: textTarget });
      panner.handleMouseDown(textDown.event);
      assert.equal(eventTarget.listenerCount('mousemove'), 0);
      eventTarget.dispatch('mousemove', createMockMouseEvent({ clientX: 120, clientY: 120 }).event);
      assert.equal(panner.isPanning(), false);
      assert.equal(container.scrollLeft, 100);
      assert.equal(container.scrollTop, 100);

      // 2. shouldPanTarget 返回 false 的区域：左键同样放行不拖拽
      panner.handleMouseDown(
        createMockMouseEvent({ button: 0, clientX: 60, clientY: 60, target: noPanBlank }).event,
      );
      assert.equal(eventTarget.listenerCount('mousemove'), 0);

      // 3. 左键按在空白处：自动触发拖拽平移
      panner.handleMouseDown(
        createMockMouseEvent({ button: 0, clientX: 100, clientY: 100, target: blankTarget }).event,
      );
      assert.equal(eventTarget.listenerCount('mousemove'), 1);
      eventTarget.dispatch('mousemove', createMockMouseEvent({ clientX: 80, clientY: 70 }).event);
      assert.equal(panner.isPanning(), true);
      assert.equal(container.scrollLeft, 120);
      assert.equal(container.scrollTop, 130);
      eventTarget.dispatch('mouseup', createMockMouseEvent({ button: 0 }).event);
      assert.equal(panner.isPanning(), false);

      // 4. 中键即使按在文字节点上，仍保持任意区域拖拽平移
      const middleDown = createMockMouseEvent({
        button: 1,
        clientX: 100,
        clientY: 100,
        target: textTarget,
      });
      panner.handleMouseDown(middleDown.event);
      assert.equal(middleDown.isPrevented(), true);
      assert.equal(eventTarget.listenerCount('mousemove'), 1);
      eventTarget.dispatch('mousemove', createMockMouseEvent({ clientX: 110, clientY: 115 }).event);
      assert.equal(panner.isPanning(), true);
      assert.equal(container.scrollLeft, 110);
      assert.equal(container.scrollTop, 115);
      eventTarget.dispatch('mouseup', createMockMouseEvent({ button: 1 }).event);

      panner.destroy();
    } finally {
      globalThis.document = prevDocument;
    }
  });

  it('handleHoverMove（含划选期间不闪烁）、handleMouseLeave 与 reset/destroy 正确清理 is-over-text', async () => {
    const { createDragPanner } = await import('../src/utils/dragPanner.ts');

    const prevDocument = globalThis.document;
    try {
      globalThis.document = {};

      const eventTarget = createMockEventTarget();
      const container = createMockContainer();
      const textTarget = {
        tagName: 'SPAN',
        parentElement: container,
        childNodes: [{ nodeType: 3, textContent: '正文内容' }],
      };
      const blankTarget = {
        tagName: 'DIV',
        parentElement: container,
        childNodes: [],
      };

      let enabled = true;
      const panner = createDragPanner({
        getScrollContainer: () => container,
        isEnabled: () => enabled,
        eventTarget,
      });

      panner.syncState();
      assert.equal(container.classList.contains('is-pannable'), true);

      // 悬停在文字上 -> 添加 is-over-text
      panner.handleHoverMove(
        createMockMouseEvent({ buttons: 0, clientX: 40, clientY: 40, target: textTarget }).event,
      );
      assert.equal(container.classList.contains('is-over-text'), true);

      // 左键划选拖字期间（buttons=1）移过空白处 -> 保持当前类名不闪烁
      panner.handleHoverMove(
        createMockMouseEvent({ buttons: 1, clientX: 200, clientY: 200, target: blankTarget }).event,
      );
      assert.equal(container.classList.contains('is-over-text'), true);

      // 松开左键后移回空白处 -> 移除 is-over-text
      panner.handleHoverMove(
        createMockMouseEvent({ buttons: 0, clientX: 200, clientY: 200, target: blankTarget }).event,
      );
      assert.equal(container.classList.contains('is-over-text'), false);

      // 再次悬停文字后触发 handleMouseLeave -> 清理 is-over-text
      panner.handleHoverMove(
        createMockMouseEvent({ buttons: 0, clientX: 40, clientY: 40, target: textTarget }).event,
      );
      assert.equal(container.classList.contains('is-over-text'), true);
      panner.handleMouseLeave();
      assert.equal(container.classList.contains('is-over-text'), false);

      // 悬停文字后调用 reset() -> 清理 is-over-text
      panner.handleHoverMove(
        createMockMouseEvent({ buttons: 0, clientX: 40, clientY: 40, target: textTarget }).event,
      );
      assert.equal(container.classList.contains('is-over-text'), true);
      panner.reset();
      assert.equal(container.classList.contains('is-over-text'), false);

      // 禁用状态下调用 handleHoverMove -> 清理 is-over-text 与 is-pannable
      panner.handleHoverMove(
        createMockMouseEvent({ buttons: 0, clientX: 40, clientY: 40, target: textTarget }).event,
      );
      assert.equal(container.classList.contains('is-over-text'), true);
      enabled = false;
      panner.handleHoverMove(
        createMockMouseEvent({ buttons: 0, clientX: 40, clientY: 40, target: textTarget }).event,
      );
      assert.equal(container.classList.contains('is-over-text'), false);
      assert.equal(container.classList.contains('is-pannable'), false);

      // 恢复启用悬停文字后调用 destroy() -> 彻底清理 is-over-text
      enabled = true;
      panner.syncState();
      panner.handleHoverMove(
        createMockMouseEvent({ buttons: 0, clientX: 40, clientY: 40, target: textTarget }).event,
      );
      assert.equal(container.classList.contains('is-over-text'), true);
      panner.destroy();
      assert.equal(container.classList.contains('is-over-text'), false);
      assert.equal(container.classList.contains('is-pannable'), false);
    } finally {
      globalThis.document = prevDocument;
    }
  });
});

describe('i18n 中英双语自动识别与错误翻译测试', () => {
  it('detectSystemLocale 与 resolveLocale 正确识别中文及各类非中文语言偏好', async () => {
    const { detectSystemLocale, resolveLocale } = await import('../src/utils/i18n.ts');

    assert.equal(detectSystemLocale('zh-CN'), 'zh');
    assert.equal(detectSystemLocale('ZH-tw'), 'zh');
    assert.equal(detectSystemLocale(['zh-Hans-CN', 'en-US']), 'zh');
    assert.equal(detectSystemLocale('en-US'), 'en');
    assert.equal(detectSystemLocale(['fr-FR', 'en-US']), 'en');
    assert.equal(detectSystemLocale([]), 'en');

    assert.equal(resolveLocale('en', 'zh-CN'), 'en');
    assert.equal(resolveLocale('zh', 'en-US'), 'zh');
    assert.equal(resolveLocale('auto', 'en-GB'), 'en');
    assert.equal(resolveLocale('auto', 'zh-HK'), 'zh');
  });

  it('setLocalePreference / cycleLocalePreference / translateApiErrorMessage 与英文 PPT 报错工作正常', async () => {
    const {
      cycleLocalePreference,
      getCurrentLocale,
      getLocalePreference,
      getLocaleToggleDisplay,
      onLocaleChange,
      setLocalePreference,
      translateApiErrorMessage,
    } = await import('../src/utils/i18n.ts');
    const { formatPptLoadError } = await import('../src/utils/pptConfig.ts');

    const prevPref = getLocalePreference();
    const events = [];
    const unsubscribe = onLocaleChange((locale, pref) => {
      events.push({ locale, pref });
    });

    try {
      setLocalePreference('auto');
      assert.equal(cycleLocalePreference(), 'zh');
      assert.equal(getCurrentLocale(), 'zh');
      assert.equal(getLocaleToggleDisplay('zh', 'zh').label, '中文');

      assert.equal(cycleLocalePreference(), 'en');
      assert.equal(getCurrentLocale(), 'en');
      assert.equal(getLocaleToggleDisplay('en', 'en').label, 'EN');

      const pptEntriesErr = formatPptLoadError(
        new Error('PPTX zip limit exceeded: entries 5105 > maxEntries 4000'),
      );
      assert.match(pptEntriesErr.message, /Too many entries/);
      assert.match(pptEntriesErr.message, /5105/);

      assert.match(
        translateApiErrorMessage('FILE_NOT_FOUND', 404, '目标文件不存在'),
        /does not exist/i,
      );
      assert.match(
        translateApiErrorMessage('UNKNOWN_CODE', 403, '无权访问'),
        /Permission denied/i,
      );
      assert.equal(
        translateApiErrorMessage('UNKNOWN_CODE', 500, 'Plain ASCII upstream error'),
        'Plain ASCII upstream error',
      );

      assert.equal(cycleLocalePreference(), 'auto');
      assert.equal(events.length, 4);
    } finally {
      unsubscribe();
      setLocalePreference(prevPref);
    }
  });
});

describe('docxPageFields Word 页码域解析与静态缓存清理测试', () => {
  it('能正确识别 PAGE / NUMPAGES / SECTIONPAGES 并格式化各类页码', async () => {
    const { parsePageFieldKind, formatPageNumber } = await import('../src/utils/docxPageFields.ts');

    assert.equal(parsePageFieldKind(' PAGE '), 'PAGE');
    assert.equal(parsePageFieldKind('page \\* MERGEFORMAT'), 'PAGE');
    assert.equal(parsePageFieldKind(' NUMPAGES \\* Arabic '), 'NUMPAGES');
    assert.equal(parsePageFieldKind('SECTIONPAGES'), 'SECTIONPAGES');
    assert.equal(parsePageFieldKind('DATE \\@ "yyyy-MM-dd"'), null);
    assert.equal(parsePageFieldKind('PAGEREF _Toc123'), null);

    assert.equal(formatPageNumber(4), '4');
    assert.equal(formatPageNumber(4, 'upperRoman'), 'IV');
    assert.equal(formatPageNumber(9, 'lowerRoman'), 'ix');
    assert.equal(formatPageNumber(27, 'upperLetter'), 'AA');
    assert.equal(formatPageNumber(3, 'lowerLetter'), 'c');
  });

  it('能清理复杂域中的静态缓存数字（如每页重复的 5）并保留原 run 样式', async () => {
    const {
      DOCX_NUMPAGES_FIELD_TOKEN,
      DOCX_PAGE_FIELD_TOKEN,
      DOCX_SECTION_END_CLASS_PREFIX,
      preprocessDocxPageFields,
      rewriteParagraphPageFields,
    } = await import('../src/utils/docxPageFields.ts');

    const cachedPageRun = {
      type: 'run',
      cssStyle: { 'font-size': '10.5pt' },
      children: [{ type: 'text', text: '5' }],
    };
    const paragraphChildren = [
      { type: 'run', fieldRun: true, children: [{ type: 'complexField', charType: 'begin' }] },
      { type: 'run', fieldRun: true, children: [{ type: 'instruction', text: ' PAGE ' }] },
      { type: 'run', fieldRun: true, children: [{ type: 'complexField', charType: 'separate' }] },
      cachedPageRun,
      { type: 'run', children: [{ type: 'text', text: 'extra' }] },
      { type: 'run', fieldRun: true, children: [{ type: 'complexField', charType: 'end' }] },
      { type: 'run', children: [{ type: 'text', text: ' / ' }] },
      { type: 'simpleField', instruction: ' NUMPAGES \\* MERGEFORMAT ' },
    ];

    assert.equal(rewriteParagraphPageFields(paragraphChildren), true);
    assert.equal(cachedPageRun.cssStyle['font-size'], '10.5pt');
    assert.equal(cachedPageRun.children[0].text, DOCX_PAGE_FIELD_TOKEN);
    // 额外的缓存 run 应被移除，避免残留数字或文本
    assert.equal(
      paragraphChildren.some((n) => n?.children?.[0]?.text === 'extra'),
      false,
    );
    assert.equal(
      paragraphChildren.some((n) => n?.children?.[0]?.text === DOCX_NUMPAGES_FIELD_TOKEN),
      true,
    );

    const mockDoc = {
      parts: [
        {
          rootElement: {
            type: 'footer',
            children: [
              {
                type: 'table',
                children: [
                  {
                    type: 'tableRow',
                    children: [
                      {
                        type: 'tableCell',
                        children: [
                          {
                            type: 'paragraph',
                            children: [
                              { type: 'run', fieldRun: true, children: [{ type: 'complexField', charType: 'begin' }] },
                              { type: 'run', fieldRun: true, children: [{ type: 'instruction', text: 'PAGE' }] },
                              { type: 'run', fieldRun: true, children: [{ type: 'complexField', charType: 'end' }] },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
      ],
      documentPart: {
        body: {
          children: [
            {
              type: 'paragraph',
              sectionProps: { pageNumber: { format: 'decimal', start: 1 } },
              children: [],
            },
          ],
          props: {
            pageNumber: { format: 'decimal', start: 1 },
          },
        },
      },
    };

    const configs = preprocessDocxPageFields(mockDoc);
    assert.equal(configs.length, 2);
    assert.equal(configs[1].start, 1);
    assert.equal(
      mockDoc.documentPart.body.children[0].className,
      `${DOCX_SECTION_END_CLASS_PREFIX}0`,
    );
    const cellParaChildren =
      mockDoc.parts[0].rootElement.children[0].children[0].children[0].children[0].children;
    assert.equal(cellParaChildren.at(-1).children[0].text, DOCX_PAGE_FIELD_TOKEN);
  });

  it('能修复 titlePage 首页空页脚回退并沿样式继承链收集页脚制表位', async () => {
    const {
      DOCX_TAB_PARA_CLASS_PREFIX,
      collectDocxTabStops,
      patchTitlePageMissingFirstRefs,
    } = await import('../src/utils/docxPageFields.ts');

    const sectWithTitlePage = {
      titlePage: true,
      footerRefs: [{ id: 'rId1', type: 'default' }],
      headerRefs: [
        { id: 'rId2', type: 'default' },
        { id: 'rId3', type: 'first' },
      ],
    };
    patchTitlePageMissingFirstRefs(sectWithTitlePage);
    assert.equal(
      sectWithTitlePage.footerRefs.some((r) => r.type === 'first'),
      true,
    );
    assert.equal(sectWithTitlePage.headerRefs.length, 2);

    const mockDoc = {
      settingsPart: { settings: { defaultTabStop: '21pt' } },
      stylesPart: {
        styles: [
          {
            id: 'FooterBase',
            paragraphProps: {
              tabs: [
                { position: '207.65pt', style: 'center' },
                { position: '415.3pt', style: 'right' },
              ],
            },
          },
          { id: 'Footer', basedOn: 'FooterBase', paragraphProps: {} },
        ],
      },
      parts: [
        {
          rootElement: {
            type: 'footer',
            children: [
              {
                type: 'paragraph',
                styleName: 'Footer',
                children: [
                  { type: 'run', children: [{ type: 'tab' }] },
                  { type: 'run', children: [{ type: 'text', text: '1' }] },
                ],
              },
            ],
          },
        },
      ],
    };

    const tabCtx = collectDocxTabStops(mockDoc);
    assert.equal(tabCtx.defaultTabStop, '21pt');
    assert.equal(tabCtx.tabParagraphs.size, 1);
    const para = mockDoc.parts[0].rootElement.children[0];
    assert.match(para.className, new RegExp(`^${DOCX_TAB_PARA_CLASS_PREFIX}0$`));
    assert.equal(tabCtx.tabParagraphs.get(`${DOCX_TAB_PARA_CLASS_PREFIX}0`)?.[0]?.style, 'center');
  });

  it('能为非连续分节符补充分页标记并提取页脚 framePr 居中对齐', async () => {
    const {
      applyFrameAlignmentsToParagraphs,
      ensureSectionBreakPageBreak,
      extractFrameAlignmentsFromXml,
    } = await import('../src/utils/docxPageFields.ts');

    const nextPageSectPara = { type: 'paragraph', sectionProps: {}, children: [] };
    const continuousSectPara = {
      type: 'paragraph',
      sectionProps: { type: 'continuous' },
      children: [],
    };
    ensureSectionBreakPageBreak(nextPageSectPara);
    ensureSectionBreakPageBreak(continuousSectPara);

    assert.equal(nextPageSectPara.children.length, 1);
    assert.equal(nextPageSectPara.children[0].children[0].break, 'page');
    assert.equal(continuousSectPara.children.length, 0);

    const footerXml = `<?xml version="1.0" encoding="UTF-8"?>
      <w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:p><w:pPr><w:framePr w:wrap="around" w:vAnchor="text" w:hAnchor="margin" w:xAlign="center" w:y="1"/></w:pPr><w:r><w:t>5</w:t></w:r></w:p>
        <w:p><w:pPr><w:jc w:val="right"/></w:pPr></w:p>
      </w:ftr>`;
    const aligns = extractFrameAlignmentsFromXml(footerXml);
    assert.deepEqual(aligns, ['center', null]);

    const paras = [{ type: 'paragraph', cssStyle: {} }, { type: 'paragraph', cssStyle: { 'text-align': 'right' } }];
    applyFrameAlignmentsToParagraphs(paras, aligns);
    assert.equal(paras[0].cssStyle['text-align'], 'center');
    assert.equal(paras[1].cssStyle['text-align'], 'right');
  });

  it('能剥离分节符后首段前导空白 lastRenderedPageBreak 避免多出空白页', async () => {
    const { stripLeadingPageBreakIfEmptyBefore } = await import('../src/utils/docxPageFields.ts');

    const leadingBreakPara = {
      type: 'paragraph',
      children: [
        {
          type: 'run',
          children: [
            { type: 'break', break: 'lastRenderedPageBreak' },
            { type: 'text', text: '正文标题' },
          ],
        },
      ],
    };
    stripLeadingPageBreakIfEmptyBefore(leadingBreakPara);
    assert.equal(leadingBreakPara.children[0].children.length, 1);
    assert.equal(leadingBreakPara.children[0].children[0].text, '正文标题');

    const midBreakPara = {
      type: 'paragraph',
      children: [
        {
          type: 'run',
          children: [
            { type: 'text', text: '前半句' },
            { type: 'break', break: 'lastRenderedPageBreak' },
            { type: 'text', text: '后半句' },
          ],
        },
      ],
    };
    stripLeadingPageBreakIfEmptyBefore(midBreakPara);
    assert.equal(midBreakPara.children[0].children.length, 3);
  });
});

describe('POST /api/fs/reveal 在文件资源管理器中定位文件测试', () => {
  it('校验路径安全后调用 revealFile，拒绝越权路径', async () => {
    const { startServer } = await import('../server/index.mjs');

    const rootDir = mkdtempSync(join(tmpdir(), 'fp-reveal-'));
    const sampleFile = join(rootDir, 'demo.docx');
    writeFileSync(sampleFile, 'docx-placeholder');

    const revealed = [];
    const prevPort = process.env.ANTIGRAVITY_SIDECAR_WEB_PORT;
    const prevToken = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN;
    process.env.ANTIGRAVITY_SIDECAR_WEB_PORT = '0';
    process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN = 'reveal-test-token';

    const running = await startServer({
      allowedRootsOverride: [rootDir],
      revealFile: (p) => revealed.push(p),
    });

    try {
      const addr = running.server.address();
      const baseUrl = `http://127.0.0.1:${addr.port}`;

      const okRes = await fetch(`${baseUrl}/api/fs/reveal`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Sidecar-Token': 'reveal-test-token',
        },
        body: JSON.stringify({ file: sampleFile }),
      });
      assert.equal(okRes.status, 200);
      const okJson = await okRes.json();
      assert.equal(okJson.ok, true);
      assert.equal(revealed.length, 1);

      const denyRes = await fetch(`${baseUrl}/api/fs/reveal`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Sidecar-Token': 'reveal-test-token',
        },
        body: JSON.stringify({ file: join(rootDir, '..', 'outside.docx') }),
      });
      assert.equal(denyRes.status, 403);
      assert.equal(revealed.length, 1);
    } finally {
      await running.close();
      if (prevPort === undefined) delete process.env.ANTIGRAVITY_SIDECAR_WEB_PORT;
      else process.env.ANTIGRAVITY_SIDECAR_WEB_PORT = prevPort;
      if (prevToken === undefined) delete process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN;
      else process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN = prevToken;
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

describe('uiHelpers 文件名保尾拆分与 IME 安全判定测试', () => {
  it('splitFileNameParts 正确拆分普通文件名、多点文件名、隐藏文件与无扩展名文件', async () => {
    const { splitFileNameParts, isImeComposing } = await import('../src/utils/uiHelpers.ts');

    assert.deepEqual(splitFileNameParts('年度财务报告.v2.final.xlsx'), {
      stem: '年度财务报告.v2.final',
      ext: '.xlsx',
    });
    assert.deepEqual(splitFileNameParts('README'), { stem: 'README', ext: '' });
    assert.deepEqual(splitFileNameParts('.gitignore'), { stem: '.gitignore', ext: '' });
    assert.deepEqual(splitFileNameParts('archive.'), { stem: 'archive.', ext: '' });

    assert.equal(isImeComposing({ isComposing: true, keyCode: 13 }), true);
    assert.equal(isImeComposing({ isComposing: false, keyCode: 229 }), true);
    assert.equal(isImeComposing({ isComposing: false, keyCode: 13 }), false);
  });
});

describe('themeSync 外观种子与色板预设测试', () => {
  it('SEED_PRESETS 与 getAppearancePrefs 在非浏览器或无效存储下返回安全默认值', async () => {
    const { SEED_PRESETS, getAppearancePrefs, computeRelativeLuminance, parseCssColorToRgb } =
      await import('../src/services/themeSync.ts');

    assert.equal(SEED_PRESETS.length, 6);
    assert.deepEqual(getAppearancePrefs(), {
      seedId: 'auto-pair',
      colorStyle: 'vivid',
      pureBlack: false,
      liquidGlass: true,
    });

    const rgb = parseCssColorToRgb('#0A7AFF');
    assert.ok(rgb);
    assert.ok(computeRelativeLuminance(rgb) < 0.5);
  });
});

describe('docxCjkLayout 中文字符缩进与行单位段距解析测试', () => {
  function mkEl(localName, attrs = {}, children = []) {
    return {
      localName,
      nodeType: 1,
      attributes: Object.entries(attrs).map(([k, v]) => ({ localName: k, value: String(v) })),
      childNodes: children,
    };
  }

  it('parseIndAttributes 与 parseSpacingAttributes 正确处理字符缩进、绝对值优先级与显式归零', async () => {
    const { parseIndAttributes, parseSpacingAttributes } = await import(
      '../src/utils/docxCjkLayout.ts'
    );

    const fromObj = (obj) => (name) => (Object.prototype.hasOwnProperty.call(obj, name) ? obj[name] : null);

    // 纯 firstLineChars（如中文首行缩进 2 字符）
    assert.deepEqual(parseIndAttributes(fromObj({ firstLineChars: '200' })), {
      textIndent: { kind: 'chars', value: 2 },
    });

    // firstLine="0" 同时存在 firstLineChars="200"，应采用 firstLineChars
    assert.deepEqual(parseIndAttributes(fromObj({ firstLine: '0', firstLineChars: '200' })), {
      textIndent: { kind: 'chars', value: 2 },
    });

    // firstLine 非零且 firstLineChars 非零，保留 docx-preview 已处理的绝对值（kind: 'dxa'）
    assert.deepEqual(parseIndAttributes(fromObj({ firstLine: '480', firstLineChars: '200' })), {
      textIndent: { kind: 'dxa' },
    });

    // firstLine 非零且 firstLineChars="0"，不能错误归零
    assert.deepEqual(parseIndAttributes(fromObj({ firstLine: '420', firstLineChars: '0' })), {
      textIndent: { kind: 'dxa' },
    });

    // 仅 firstLineChars="0"，应显式归零以覆盖父样式
    assert.deepEqual(parseIndAttributes(fromObj({ firstLineChars: '0' })), {
      textIndent: { kind: 'zero' },
    });

    // hangingChars 优先生效并带负号；leftChars / rightChars 独立生效
    assert.deepEqual(
      parseIndAttributes(
        fromObj({
          firstLineChars: '200',
          hangingChars: '150',
          leftChars: '200',
          rightChars: '100',
        }),
      ),
      {
        textIndent: { kind: 'chars', value: -1.5 },
        marginStart: { kind: 'chars', value: 2 },
        marginEnd: { kind: 'chars', value: 1 },
      },
    );

    // startChars 优先于 leftChars，endChars 优先于 rightChars
    assert.deepEqual(
      parseIndAttributes(
        fromObj({
          leftChars: '100',
          startChars: '300',
          rightChars: '50',
          endChars: '250',
        }),
      ),
      {
        marginStart: { kind: 'chars', value: 3 },
        marginEnd: { kind: 'chars', value: 2.5 },
      },
    );

    // beforeLines / afterLines（含 after="0" 搭配 afterLines="100"）
    assert.deepEqual(
      parseSpacingAttributes(fromObj({ before: '0', after: '0', afterLines: '100' })),
      {
        marginTop: { kind: 'dxa' },
        marginBottom: { kind: 'lines', value: 1 },
      },
    );
    assert.deepEqual(
      parseSpacingAttributes(fromObj({ beforeLines: '50', after: '240', afterLines: '100' })),
      {
        marginTop: { kind: 'lines', value: 0.5 },
        marginBottom: { kind: 'dxa' },
      },
    );
  });

  it('collectDocxCjkLayout 正确同步正文、表格、SDT、样式继承链、编号与 docGrid 并释放 _xmlDocument', async () => {
    const { collectDocxCjkLayout, DOCX_CJK_PARA_CLASS_PREFIX } = await import(
      '../src/utils/docxCjkLayout.ts'
    );

    const stylesRoot = mkEl('styles', {}, [
      mkEl('docDefaults', {}, [
        mkEl('rPrDefault', {}, [mkEl('rPr', {}, [mkEl('sz', { val: '22' })])]),
        mkEl('pPrDefault', {}, [mkEl('pPr', {}, [mkEl('spacing', { after: '200' })])]),
      ]),
      mkEl('style', { type: 'paragraph', default: '1', styleId: 'Normal' }, [
        mkEl('pPr', {}, [mkEl('ind', { firstLineChars: '200' })]),
        mkEl('rPr', {}, [mkEl('sz', { val: '24' })]),
      ]),
      mkEl('style', { type: 'paragraph', styleId: 'Heading1' }, [
        mkEl('basedOn', { val: 'Normal' }),
        mkEl('pPr', {}, [mkEl('ind', { firstLineChars: '0' })]),
      ]),
      mkEl('style', { type: 'paragraph', styleId: 'LeftOnly' }, [
        mkEl('basedOn', { val: 'Normal' }),
        mkEl('pPr', {}, [mkEl('ind', { leftChars: '100' })]),
      ]),
    ]);

    const numberingRoot = mkEl('numbering', {}, [
      mkEl('abstractNum', { abstractNumId: '1' }, [
        mkEl('lvl', { ilvl: '0' }, [mkEl('pPr', {}, [mkEl('ind', { hangingChars: '200' })])]),
      ]),
      mkEl('num', { numId: '5' }, [mkEl('abstractNumId', { val: '1' })]),
    ]);

    const bodyXml = mkEl('body', {}, [
      // P0: 无样式名 -> 继承默认 Normal 的 firstLineChars="200"
      mkEl('p', {}, [mkEl('pPr', {}, [mkEl('spacing', { after: '0', afterLines: '100' })])]),
      // P1: Heading1 -> 显式 firstLineChars="0" 取消继承
      mkEl('p', {}, [mkEl('pPr', {}, [mkEl('pStyle', { val: 'Heading1' })])]),
      // P2: LeftOnly -> 仅覆盖 leftChars="100"，仍继承 Normal 的 firstLineChars="200"
      mkEl('p', {}, [mkEl('pPr', {}, [mkEl('pStyle', { val: 'LeftOnly' })])]),
      // P3: 段落显式 dxa firstLine="420" 覆盖 Normal 的 firstLineChars -> 无需补丁
      mkEl('p', {}, [mkEl('pPr', {}, [mkEl('ind', { firstLine: '420' })])]),
      // P4: 带列表编号 numId=5 ilvl=0 -> 悬挂缩进 -2 字符
      mkEl('p', {}, [
        mkEl('pPr', {}, [
          mkEl('numPr', {}, [mkEl('ilvl', { val: '0' }), mkEl('numId', { val: '5' })]),
        ]),
      ]),
      // Tbl: 表格单元格内段落使用直接 firstLineChars="200"
      mkEl('tbl', {}, [
        mkEl('tr', {}, [
          mkEl('tc', {}, [mkEl('p', {}, [mkEl('pPr', {}, [mkEl('ind', { firstLineChars: '200' })])])]),
        ]),
      ]),
      // SDT: 展开 sdtContent 内的段落
      mkEl('sdt', {}, [
        mkEl('sdtContent', {}, [
          mkEl('p', {}, [mkEl('pPr', {}, [mkEl('ind', { firstLineChars: '150' })])]),
        ]),
      ]),
      mkEl('sectPr', {}, [mkEl('docGrid', { linePitch: '360' })]),
    ]);

    const p0 = { type: 'paragraph', children: [] };
    const p1 = { type: 'paragraph', styleName: 'Heading1', children: [] };
    const p2 = { type: 'paragraph', styleName: 'LeftOnly', children: [] };
    const p3 = { type: 'paragraph', children: [] };
    const p4 = { type: 'paragraph', children: [] };
    const cellP = { type: 'paragraph', children: [] };
    const sdtP = { type: 'paragraph', children: [] };

    const stylesPart = { _xmlDocument: { firstElementChild: stylesRoot } };
    const numberingPart = { _xmlDocument: { firstElementChild: numberingRoot } };
    const documentPart = {
      _xmlDocument: { firstElementChild: mkEl('document', {}, [bodyXml]) },
      body: {
        children: [
          p0,
          p1,
          p2,
          p3,
          p4,
          { type: 'table', children: [{ type: 'row', children: [{ type: 'cell', children: [cellP] }] }] },
          sdtP,
        ],
      },
    };

    const mockDoc = {
      stylesPart,
      numberingPart,
      documentPart,
      parts: [stylesPart, numberingPart, documentPart],
    };

    const ctx = await collectDocxCjkLayout(mockDoc);

    // 验证 _xmlDocument 已释放
    assert.equal(stylesPart._xmlDocument, undefined);
    assert.equal(documentPart._xmlDocument, undefined);

    // P0: 继承 firstLineChars=2 + 自身 afterLines=1 + linePitch=18pt + Normal fallbackFontSizePt=12
    assert.ok(p0.className?.startsWith(DOCX_CJK_PARA_CLASS_PREFIX));
    assert.deepEqual(ctx.patches.get(p0.className), {
      textIndent: { kind: 'chars', value: 2 },
      marginBottom: { kind: 'lines', value: 1 },
      fallbackFontSizePt: 12,
      linePitchPt: 18,
    });

    // P1: Heading1 显式归零
    assert.deepEqual(ctx.patches.get(p1.className)?.textIndent, { kind: 'zero' });

    // P2: 同时拥有 Normal 的首行缩进与 LeftOnly 的左缩进
    assert.deepEqual(ctx.patches.get(p2.className)?.textIndent, { kind: 'chars', value: 2 });
    assert.deepEqual(ctx.patches.get(p2.className)?.marginStart, { kind: 'chars', value: 1 });

    // P3: 已有非零 dxa 覆盖，不需要打标记
    assert.equal(p3.className, undefined);

    // P4: 列表悬挂缩进 -2 字符
    assert.deepEqual(ctx.patches.get(p4.className)?.textIndent, { kind: 'chars', value: -2 });

    // 表格单元格段落与 SDT 段落均正确打标
    assert.deepEqual(ctx.patches.get(cellP.className)?.textIndent, { kind: 'chars', value: 2 });
    assert.deepEqual(ctx.patches.get(sdtP.className)?.textIndent, { kind: 'chars', value: 1.5 });
  });

  it('applyDocxCjkLayout 正确按字号与行距写入样式，跨页续段不重复首行缩进，页眉页脚每页独立应用', async () => {
    const { applyDocxCjkLayout } = await import('../src/utils/docxCjkLayout.ts');

    const mkDomP = (text, inHeaderFooter = false) => ({
      textContent: text,
      style: {},
      closest: (sel) => (inHeaderFooter && sel.includes('header') ? {} : null),
      querySelector: () => null,
    });

    const bodyFirst = mkDomP('第一页开头文字');
    const bodyContinuation = mkDomP('第二页续行文字');
    const headerPage1 = mkDomP('页眉', true);
    const headerPage2 = mkDomP('页眉', true);

    const mockStage = {
      querySelectorAll: (selector) => {
        if (selector === 'p.fp-cjk-p-0') return [bodyFirst, bodyContinuation];
        if (selector === 'p.fp-cjk-p-1') return [headerPage1, headerPage2];
        return [];
      },
    };

    const patches = new Map([
      [
        'fp-cjk-p-0',
        {
          textIndent: { kind: 'chars', value: 2 },
          marginStart: { kind: 'chars', value: 1 },
          marginTop: { kind: 'lines', value: 0.5 },
          marginBottom: { kind: 'lines', value: 1 },
          linePitchPt: 18,
        },
      ],
      [
        'fp-cjk-p-1',
        {
          textIndent: { kind: 'chars', value: 2 },
        },
      ],
    ]);

    applyDocxCjkLayout(
      mockStage,
      { patches },
      {
        ptToPx: 4 / 3,
        measureCharPx: () => 16, // 12pt = 16px
      },
    );

    // 正文首段：有首行缩进 32px、左缩进 16px、段前 12px（0.5 * 24px），无段后
    assert.equal(bodyFirst.style.textIndent, '32.00px');
    assert.equal(bodyFirst.style.marginInlineStart, '16.00px');
    assert.equal(bodyFirst.style.marginTop, '12.00px');
    assert.equal(bodyFirst.style.marginBottom, undefined);

    // 正文跨页续段：无首行缩进、无段前，但延续左缩进 16px 并保留末片段段后 24px
    assert.equal(bodyContinuation.style.textIndent, undefined);
    assert.equal(bodyContinuation.style.marginInlineStart, '16.00px');
    assert.equal(bodyContinuation.style.marginTop, undefined);
    assert.equal(bodyContinuation.style.marginBottom, '24.00px');

    // 页眉每页独立应用首行缩进
    assert.equal(headerPage1.style.textIndent, '32.00px');
    assert.equal(headerPage2.style.textIndent, '32.00px');
  });

  it('fitWidthLayout 防震荡计算：精准扣除 padding 与安全边距，高度溢出时自动预留滚动条避免死循环', async () => {
    const {
      computeFitWidthLayout,
      measureScrollContainerBox,
      measureVerticalMargins,
      floorScalePrecision,
      DEFAULT_FALLBACK_SCROLLBAR_WIDTH,
    } = await import('../src/utils/fitWidthLayout.ts');

    // 1. 容器尺寸度量测试
    const mockEl = {
      clientWidth: 400,
      clientHeight: 500,
      offsetWidth: 400,
      offsetHeight: 500,
    };
    const box = measureScrollContainerBox(mockEl, 12, 0);
    assert.equal(box.clientWidth, 400);
    assert.equal(box.outerWidth, 400);
    assert.equal(box.paddingX, 12);

    // 2. 无滚动条且高度不溢出：全宽缩放，scaledWidth 严格小于可用内容区，绝不产生水平滚动条
    const resNoOverflow = computeFitWidthLayout({
      viewportClientWidth: 400,
      viewportClientHeight: 600,
      viewportOuterWidth: 400,
      viewportOuterHeight: 600,
      paddingX: 12,
      paddingY: 0,
      extraVerticalSpace: 38,
      rawWidth: 800,
      rawHeight: 400, // 缩放后高度 ~192px + 38px = 230px < 600px，不溢出
      observedScrollbarWidth: 0,
      minScale: 0.2,
      maxScale: 1.0,
      horizontalSafetyPx: 4,
    });
    // 可用宽 = 400 - 12 - 4 = 384px，rawWidth = 800 => scale = 384/800 = 0.48
    assert.equal(resNoOverflow.scale, 0.48);
    assert.equal(resNoOverflow.scaledWidth, 384);
    assert.equal(resNoOverflow.reservedScrollbarGutter, false);
    // 容器内宽容纳上限为 400 - 12 = 388px，384px 留有 4px 安全裕量，绝不触发横向滚动条
    assert.ok(resNoOverflow.scaledWidth <= 400 - 12);

    // 3. 无滚动条但高度显著溢出：自动启用预留滚动条槽位（默认 16px），一步到位计算稳定缩放，杜绝死循环
    const resOverflow = computeFitWidthLayout({
      viewportClientWidth: 400,
      viewportClientHeight: 500,
      viewportOuterWidth: 400,
      viewportOuterHeight: 500,
      paddingX: 12,
      paddingY: 0,
      extraVerticalSpace: 38,
      rawWidth: 800,
      rawHeight: 2000, // 高度巨大，必然溢出
      observedScrollbarWidth: 0,
      minScale: 0.2,
      maxScale: 1.0,
      horizontalSafetyPx: 4,
    });
    // outerW = 400, 预留滚动条 16px => reservedClientW = 384px
    // 可用宽 = 384 - 12 (padding) - 4 (safety) = 368px
    // scale = 368 / 800 = 0.46
    assert.equal(resOverflow.reservedScrollbarGutter, true);
    assert.equal(resOverflow.observedScrollbarWidth, DEFAULT_FALLBACK_SCROLLBAR_WIDTH);
    assert.equal(resOverflow.scale, 0.46);
    assert.equal(resOverflow.scaledWidth, 368);
    // 缩放后宽度 368px 加上 12px padding = 380px，严格小于出现滚动条后的 384px 视口，完全不产生水平滚动条
    assert.ok(resOverflow.scaledWidth <= 400 - DEFAULT_FALLBACK_SCROLLBAR_WIDTH - 12);

    // 4. 当已出现真实纵向滚动条时（outerWidth 400, clientWidth 383，滚动条 17px）
    const resWithScrollbar = computeFitWidthLayout({
      viewportClientWidth: 383,
      viewportClientHeight: 500,
      viewportOuterWidth: 400,
      viewportOuterHeight: 500,
      paddingX: 12,
      paddingY: 0,
      extraVerticalSpace: 38,
      rawWidth: 800,
      rawHeight: 2000,
      observedScrollbarWidth: 17,
      minScale: 0.2,
      maxScale: 1.0,
      horizontalSafetyPx: 4,
    });
    assert.equal(resWithScrollbar.reservedScrollbarGutter, false);
    assert.equal(resWithScrollbar.observedScrollbarWidth, 17);
    // 可用宽 = 383 - 12 - 4 = 367px => scale = 367/800 = 0.4587
    assert.equal(resWithScrollbar.scale, 0.4587);
    assert.equal(resWithScrollbar.scaledWidth, 367);
    assert.ok(resWithScrollbar.scaledWidth <= 383 - 12);
  });
});

describe('docxPaginator Word 无预渲染分页符几何自动分页测试', () => {
  function createMockDomEnv() {
    class MockClassList {
      constructor(el) {
        this._el = el;
      }
      _list() {
        return (this._el._className ?? '').split(/\s+/).filter(Boolean);
      }
      _save(items) {
        this._el._className = items.join(' ');
      }
      contains(cls) {
        return this._list().includes(cls);
      }
      add(...classes) {
        const set = new Set(this._list());
        for (const c of classes) if (c) set.add(c);
        this._save(Array.from(set));
      }
      remove(...classes) {
        const drop = new Set(classes);
        this._save(this._list().filter((c) => !drop.has(c)));
      }
      [Symbol.iterator]() {
        return this._list()[Symbol.iterator]();
      }
    }

    class MockNode {
      constructor(nodeType) {
        this.nodeType = nodeType;
        this.parentNode = null;
        this.childNodes = [];
      }
      get nextSibling() {
        if (!this.parentNode) return null;
        const siblings = this.parentNode.childNodes;
        const idx = siblings.indexOf(this);
        return idx >= 0 && idx + 1 < siblings.length ? siblings[idx + 1] : null;
      }
    }

    class MockText extends MockNode {
      constructor(text) {
        super(3);
        this.nodeValue = text;
      }
      get textContent() {
        return this.nodeValue;
      }
      set textContent(v) {
        this.nodeValue = String(v);
      }
      cloneNode() {
        return new MockText(this.nodeValue);
      }
    }

    class MockElement extends MockNode {
      constructor(tagName, opts = {}) {
        super(1);
        this.tagName = tagName.toUpperCase();
        this._className = opts.className ?? '';
        this.style = { ...(opts.style ?? {}) };
        this.attributes = { ...(opts.attributes ?? {}) };
        this.classList = new MockClassList(this);
        this._mockHeight = opts.height ?? 0;
        this._mockMarginTop = opts.marginTop ?? 0;
        this._mockMarginBottom = opts.marginBottom ?? 0;
        this.rowSpan = opts.rowSpan ?? 1;
        this._rect = opts.rect ?? null;
      }
      get className() {
        return this._className;
      }
      set className(val) {
        this._className = String(val ?? '');
      }
      get children() {
        return this.childNodes.filter((n) => n.nodeType === 1);
      }
      get offsetHeight() {
        if (this.tagName === 'TABLE' && this._mockHeight === 0) {
          let total = 0;
          for (const ch of this.children) {
            if (ch.tagName === 'TR') total += ch.offsetHeight;
          }
          return total;
        }
        if (this._mockHeight > 0) return this._mockHeight;
        if (this.tagName === 'SECTION') {
          let total = 0;
          for (const ch of this.children) total += ch.offsetHeight;
          return total;
        }
        return 0;
      }
      set offsetHeight(v) {
        this._mockHeight = v;
      }
      get textContent() {
        return this.childNodes.map((n) => n.textContent ?? '').join('');
      }
      set textContent(v) {
        this.childNodes = v ? [new MockText(String(v))] : [];
        if (this.childNodes[0]) this.childNodes[0].parentNode = this;
      }
      getAttribute(name) {
        if (name === 'rowspan' && this.rowSpan > 1) return String(this.rowSpan);
        return Object.prototype.hasOwnProperty.call(this.attributes, name)
          ? this.attributes[name]
          : null;
      }
      setAttribute(name, value) {
        this.attributes[name] = String(value);
      }
      removeAttribute(name) {
        delete this.attributes[name];
      }
      closest(selector) {
        const parts = selector.split(',').map((s) => s.trim().toUpperCase());
        let curr = this;
        while (curr && curr.nodeType === 1) {
          if (parts.includes(curr.tagName)) return curr;
          curr = curr.parentNode;
        }
        return null;
      }
      appendChild(child) {
        if (child.parentNode) {
          const oldSibs = child.parentNode.childNodes;
          const idx = oldSibs.indexOf(child);
          if (idx >= 0) oldSibs.splice(idx, 1);
        }
        child.parentNode = this;
        this.childNodes.push(child);
        return child;
      }
      insertBefore(newChild, refChild) {
        if (!refChild) return this.appendChild(newChild);
        if (newChild.parentNode) {
          const oldSibs = newChild.parentNode.childNodes;
          const oldIdx = oldSibs.indexOf(newChild);
          if (oldIdx >= 0) oldSibs.splice(oldIdx, 1);
        }
        const idx = this.childNodes.indexOf(refChild);
        newChild.parentNode = this;
        if (idx >= 0) {
          this.childNodes.splice(idx, 0, newChild);
        } else {
          this.childNodes.push(newChild);
        }
        return newChild;
      }
      remove() {
        if (!this.parentNode) return;
        const idx = this.parentNode.childNodes.indexOf(this);
        if (idx >= 0) this.parentNode.childNodes.splice(idx, 1);
        this.parentNode = null;
      }
      cloneNode(deep = false) {
        const copy = new MockElement(this.tagName, {
          className: this._className,
          style: { ...this.style },
          attributes: { ...this.attributes },
          height: this._mockHeight,
          marginTop: this._mockMarginTop,
          marginBottom: this._mockMarginBottom,
          rowSpan: this.rowSpan,
          rect: this._rect ? { ...this._rect } : null,
        });
        if (deep) {
          for (const ch of this.childNodes) {
            copy.appendChild(ch.cloneNode(true));
          }
        }
        return copy;
      }
      getBoundingClientRect() {
        return this._rect ?? { top: 0, bottom: this._mockHeight, height: this._mockHeight };
      }
      querySelectorAll(selector) {
        const res = [];
        const matchSingle = (el, sel) => {
          if (sel === '[id]') return Object.prototype.hasOwnProperty.call(el.attributes, 'id');
          if (sel.startsWith('[class*="')) {
            const needle = sel.slice(9, -2);
            return el.className.includes(needle);
          }
          if (sel === 'section.docx') {
            return el.tagName === 'SECTION' && el.classList.contains('docx');
          }
          if (/^[a-z0-9]+$/i.test(sel)) {
            return el.tagName === sel.toUpperCase();
          }
          return false;
        };
        const matchSimple = (el, sel) => {
          if (sel.includes(',')) {
            return sel
              .split(',')
              .map((part) => part.trim())
              .filter(Boolean)
              .some((part) => matchSingle(el, part));
          }
          return matchSingle(el, sel);
        };
        if (selector === '.docx-wrapper > section.docx') {
          const walkWrap = (node) => {
            for (const ch of node.children) {
              if (ch.classList.contains('docx-wrapper')) {
                for (const sec of ch.children) {
                  if (sec.tagName === 'SECTION' && sec.classList.contains('docx')) res.push(sec);
                }
              }
              walkWrap(ch);
            }
          };
          walkWrap(this);
          return res;
        }
        const walk = (node) => {
          for (const ch of node.children) {
            if (matchSimple(ch, selector)) res.push(ch);
            walk(ch);
          }
        };
        walk(this);
        return res;
      }
      querySelector(selector) {
        return this.querySelectorAll(selector)[0] ?? null;
      }
    }

    const mockDocument = {
      createElement(tag) {
        return new MockElement(tag);
      },
      createTreeWalker(root, whatToShow) {
        const nodes = [];
        const collect = (node) => {
          for (const ch of node.childNodes) {
            if (whatToShow === 4 && ch.nodeType === 3) {
              nodes.push(ch);
            } else if (ch.nodeType === 1) {
              collect(ch);
            }
          }
        };
        collect(root);
        let idx = -1;
        return {
          nextNode() {
            idx += 1;
            return idx < nodes.length ? nodes[idx] : null;
          },
        };
      },
    };

    return { MockElement, MockText, mockDocument };
  }

  it('collectDocxPaginationMeta 准确识别有无 lastRenderedPageBreak、继承链 keepNext/keepLines 与 tblHeader', async () => {
    const {
      DOCX_KEEP_LINES_CLASS,
      DOCX_KEEP_NEXT_CLASS,
      DOCX_TBL_HEADER_CLASS,
      collectDocxPaginationMeta,
    } = await import('../src/utils/docxPaginator.ts');

    const headingPara = { type: 'paragraph', styleName: 'Heading1', children: [] };
    const overrideNoKeepPara = {
      type: 'paragraph',
      styleName: 'Heading1',
      keepNext: false,
      children: [],
    };
    const keepLinesPara = { type: 'paragraph', styleName: 'BodyKeep', children: [] };
    const headerRow = { type: 'row', isHeader: true, children: [] };
    const bodyRow = { type: 'row', isHeader: false, children: [] };

    const docWithoutBreak = {
      settingsPart: { settings: { evenAndOddHeaders: true } },
      stylesPart: {
        styles: [
          {
            id: 'Normal',
            isDefault: true,
            target: 'p',
            paragraphProps: {},
          },
          {
            id: 'HeadingBase',
            target: 'p',
            paragraphProps: { keepNext: true },
          },
          {
            id: 'Heading1',
            target: 'p',
            basedOn: 'HeadingBase',
            paragraphProps: {},
          },
          {
            id: 'BodyKeep',
            target: 'p',
            paragraphProps: { keepLines: true },
          },
        ],
      },
      documentPart: {
        body: {
          props: { pageSize: { height: '841.9pt' } },
          children: [
            headingPara,
            overrideNoKeepPara,
            keepLinesPara,
            { type: 'table', children: [headerRow, bodyRow] },
          ],
        },
      },
    };

    const metaNoBreak = collectDocxPaginationMeta(docWithoutBreak);
    assert.equal(metaNoBreak.hasLastRenderedPageBreak, false);
    assert.equal(metaNoBreak.evenAndOddHeaders, true);
    assert.equal(metaNoBreak.sectionMetas.length, 1);
    assert.ok(headingPara.className?.includes(DOCX_KEEP_NEXT_CLASS));
    assert.equal(Boolean(overrideNoKeepPara.className?.includes(DOCX_KEEP_NEXT_CLASS)), false);
    assert.ok(keepLinesPara.className?.includes(DOCX_KEEP_LINES_CLASS));
    assert.ok(headerRow.className?.includes(DOCX_TBL_HEADER_CLASS));
    assert.equal(bodyRow.className, undefined);

    const docWithBreak = {
      documentPart: {
        body: {
          props: {},
          children: [
            {
              type: 'paragraph',
              children: [
                { type: 'run', children: [{ type: 'break', break: 'lastRenderedPageBreak' }] },
              ],
            },
          ],
        },
      },
    };
    const metaWithBreak = collectDocxPaginationMeta(docWithBreak);
    assert.equal(metaWithBreak.hasLastRenderedPageBreak, true);
  });

  it('无 lastRenderedPageBreak 的 8 页长文档自动拆分为多页并与 resolveDocxPageFields 联动生成 1..N 页码（含 titlePage 与奇偶页）', async () => {
    const { paginateOverflowDocxSections } = await import('../src/utils/docxPaginator.ts');
    const {
      DOCX_NUMPAGES_FIELD_TOKEN,
      DOCX_PAGE_FIELD_TOKEN,
      DOCX_SECTION_END_CLASS_PREFIX,
      resolveDocxPageFields,
    } = await import('../src/utils/docxPageFields.ts');

    const { MockElement, MockText, mockDocument } = createMockDomEnv();
    const prevDocument = globalThis.document;
    const prevNodeFilter = globalThis.NodeFilter;
    globalThis.document = mockDocument;
    globalThis.NodeFilter = { SHOW_TEXT: 4 };

    try {
      const stage = new MockElement('div');
      const wrapper = new MockElement('div', { className: 'docx-wrapper' });
      const section = new MockElement('section', {
        className: 'docx',
        height: 7600,
        style: { minHeight: '1120px' },
      });

      const firstHeader = new MockElement('header');
      firstHeader.appendChild(new MockText('首页页眉'));
      const firstFooter = new MockElement('footer');
      firstFooter.appendChild(new MockText(''));

      const article = new MockElement('article');
      // 构造恰好 8 页内容：21 个普通段落（280px，每页 3 段共 7 页）+ 2 张大图片段落（440px，共 880px 占第 8 页）
      for (let i = 0; i < 21; i += 1) {
        const p = new MockElement('p', {
          height: 280,
          marginTop: 0,
          marginBottom: 0,
        });
        p.appendChild(new MockText(`正文第 ${i + 1} 段`));
        article.appendChild(p);
      }
      for (let j = 0; j < 2; j += 1) {
        const imgP = new MockElement('p', {
          height: 440,
          marginTop: 0,
          marginBottom: 0,
          className: j === 1 ? `${DOCX_SECTION_END_CLASS_PREFIX}0` : '',
        });
        imgP.appendChild(new MockElement('img', { height: 420 }));
        article.appendChild(imgP);
      }

      section.appendChild(firstHeader);
      section.appendChild(article);
      section.appendChild(firstFooter);
      wrapper.appendChild(section);
      stage.appendChild(wrapper);

      const defaultHeader = new MockElement('header');
      defaultHeader.appendChild(new MockText('正文章节页眉'));
      const defaultFooter = new MockElement('footer');
      defaultFooter.appendChild(
        new MockText(`${DOCX_PAGE_FIELD_TOKEN} / ${DOCX_NUMPAGES_FIELD_TOKEN}`),
      );
      const evenFooter = new MockElement('footer');
      evenFooter.appendChild(
        new MockText(`偶数页 ${DOCX_PAGE_FIELD_TOKEN} / ${DOCX_NUMPAGES_FIELD_TOKEN}`),
      );

      const meta = {
        hasLastRenderedPageBreak: false,
        evenAndOddHeaders: true,
        sectionMetas: [{ sectProps: { titlePage: true } }],
      };

      const measurer = {
        getSectionMinHeightPx: () => 1120,
        getSectionHeightPx: (sec) => sec.offsetHeight,
        getMaxArticleHeightPx: () => 920,
        getArticleColumnCount: () => 1,
        measureBlock: (el) => ({
          height: el._mockHeight,
          marginTop: el._mockMarginTop,
          marginBottom: el._mockMarginBottom,
        }),
        splitParagraph: () => null,
        splitTable: () => null,
      };

      await paginateOverflowDocxSections(stage, meta, {
        measurer,
        renderHeaderFooterTemplates: async () => ({
          first: { header: firstHeader, footer: firstFooter },
          even: { header: defaultHeader, footer: evenFooter },
          default: { header: defaultHeader, footer: defaultFooter },
        }),
      });

      const pages = stage.querySelectorAll('.docx-wrapper > section.docx');
      assert.equal(pages.length, 8);

      resolveDocxPageFields(stage, [{ format: 'decimal', start: 1 }]);

      assert.equal(pages[0].querySelectorAll('header')[0]?.textContent, '首页页眉');
      assert.equal(pages[0].querySelectorAll('footer')[0]?.textContent, '');
      assert.equal(pages[1].querySelectorAll('header')[0]?.textContent, '正文章节页眉');
      assert.equal(pages[1].querySelectorAll('footer')[0]?.textContent, '偶数页 2 / 8');
      assert.equal(pages[2].querySelectorAll('footer')[0]?.textContent, '3 / 8');
      assert.equal(pages[7].querySelectorAll('footer')[0]?.textContent, '偶数页 8 / 8');
    } finally {
      globalThis.document = prevDocument;
      globalThis.NodeFilter = prevNodeFilter;
    }
  });

  it('已有 lastRenderedPageBreak 时微弱溢出（1.08x）不误拆页，严重溢出（1.35x）仍兜底分页', async () => {
    const { paginateOverflowDocxSections } = await import('../src/utils/docxPaginator.ts');
    const { MockElement, MockText } = createMockDomEnv();

    const makeStage = (sectionHeight) => {
      const stage = new MockElement('div');
      const wrapper = new MockElement('div', { className: 'docx-wrapper' });
      const section = new MockElement('section', {
        className: 'docx',
        height: sectionHeight,
        style: { minHeight: '1000px' },
      });
      const article = new MockElement('article');
      for (let i = 0; i < 3; i += 1) {
        const p = new MockElement('p', { height: Math.round(sectionHeight / 3) });
        p.appendChild(new MockText(`段落 ${i}`));
        article.appendChild(p);
      }
      section.appendChild(article);
      wrapper.appendChild(section);
      stage.appendChild(wrapper);
      return stage;
    };

    const metaWithBreak = {
      hasLastRenderedPageBreak: true,
      evenAndOddHeaders: false,
      sectionMetas: [{ sectProps: {} }],
    };

    const measurer = {
      getSectionMinHeightPx: () => 1000,
      getSectionHeightPx: (sec) => sec.offsetHeight,
      getMaxArticleHeightPx: () => 900,
      getArticleColumnCount: () => 1,
      measureBlock: (el) => ({ height: el._mockHeight, marginTop: 0, marginBottom: 0 }),
      splitParagraph: () => null,
      splitTable: () => null,
    };

    // 1.08x <= 1.28x：不误拆页
    const slightStage = makeStage(1080);
    await paginateOverflowDocxSections(slightStage, metaWithBreak, { measurer });
    assert.equal(slightStage.querySelectorAll('.docx-wrapper > section.docx').length, 1);

    // 1.35x > 1.28x：触发兜底拆页
    const heavyStage = makeStage(1350);
    await paginateOverflowDocxSections(heavyStage, metaWithBreak, { measurer });
    assert.equal(heavyStage.querySelectorAll('.docx-wrapper > section.docx').length, 2);
  });

  it('keepNext 标题不孤立在页底；跨页续段清除首行缩进/段前距并迁移 fp-sect-end-* 到末片段', async () => {
    const {
      DOCX_CONTINUED_PARA_CLASS,
      DOCX_KEEP_NEXT_CLASS,
      applyParagraphSplitPostProcess,
      findBestSplitUnitIndex,
      paginateOverflowDocxSections,
    } = await import('../src/utils/docxPaginator.ts');
    const { DOCX_SECTION_END_CLASS_PREFIX } = await import('../src/utils/docxPageFields.ts');
    const { MockElement, MockText } = createMockDomEnv();

    // 1. 验证二分查找与跨页样式后处理
    assert.equal(findBestSplitUnitIndex(100, 45, (u) => Math.ceil(u / 20) * 18), 40);
    assert.equal(findBestSplitUnitIndex(100, 10, (u) => Math.ceil(u / 20) * 18), 0);

    const head = new MockElement('p', {
      className: `${DOCX_SECTION_END_CLASS_PREFIX}0`,
      style: { textIndent: '32px', marginTop: '12px', marginBottom: '12px', textAlign: 'justify' },
    });
    const tail = head.cloneNode(false);
    applyParagraphSplitPostProcess(head, tail, true);
    assert.equal(head.style.marginBottom, '0px');
    assert.equal(head.style.textAlignLast, 'justify');
    assert.equal(head.classList.contains(`${DOCX_SECTION_END_CLASS_PREFIX}0`), false);
    assert.equal(tail.style.textIndent, '0px');
    assert.equal(tail.style.marginTop, '0px');
    assert.equal(tail.classList.contains(DOCX_CONTINUED_PARA_CLASS), true);
    assert.equal(tail.classList.contains(`${DOCX_SECTION_END_CLASS_PREFIX}0`), true);

    // 2. 验证 keepNext 粘连整组移至下一页 + 三页超长段落连续切分
    const stage = new MockElement('div');
    const wrapper = new MockElement('div', { className: 'docx-wrapper' });
    const section = new MockElement('section', {
      className: 'docx',
      height: 1500,
      style: { minHeight: '300px' },
    });
    const article = new MockElement('article');

    const pIntro = new MockElement('p', { height: 180 });
    pIntro.appendChild(new MockText('引言'));
    const pHeading = new MockElement('p', {
      className: DOCX_KEEP_NEXT_CLASS,
      height: 40,
    });
    pHeading.appendChild(new MockText('一、章节标题'));
    const pBodyAfterHeading = new MockElement('p', { height: 100 });
    pBodyAfterHeading.appendChild(new MockText('紧随标题的正文'));
    const pLongMultiPage = new MockElement('p', {
      height: 550,
      className: `${DOCX_SECTION_END_CLASS_PREFIX}0`,
      style: { textIndent: '28px', marginTop: '10px', marginBottom: '10px' },
    });
    pLongMultiPage.appendChild(new MockText('超长段落'.repeat(60)));

    article.appendChild(pIntro);
    article.appendChild(pHeading);
    article.appendChild(pBodyAfterHeading);
    article.appendChild(pLongMultiPage);
    section.appendChild(article);
    wrapper.appendChild(section);
    stage.appendChild(wrapper);

    const measurer = {
      getSectionMinHeightPx: () => 300,
      getSectionHeightPx: (sec) => sec.offsetHeight,
      getMaxArticleHeightPx: () => 240,
      getArticleColumnCount: () => 1,
      measureBlock: (el) => ({
        height: el._mockHeight,
        marginTop: el._mockMarginTop,
        marginBottom: el._mockMarginBottom,
      }),
      splitParagraph: (para, available) => {
        if (para._mockHeight <= 240 || available < 60) return null;
        const cut = Math.floor(available / 20) * 20;
        const remaining = para._mockHeight - cut;
        if (cut <= 0 || remaining <= 0) return null;
        para._mockHeight = cut;
        const nextFrag = para.cloneNode(false);
        nextFrag._mockHeight = remaining;
        nextFrag.appendChild(new MockText('续段内容'));
        applyParagraphSplitPostProcess(para, nextFrag, false);
        para.parentNode?.insertBefore(nextFrag, para.nextSibling);
        return { head: para, tail: nextFrag };
      },
      splitTable: () => null,
    };

    await paginateOverflowDocxSections(
      stage,
      { hasLastRenderedPageBreak: false, evenAndOddHeaders: false, sectionMetas: [{ sectProps: {} }] },
      { measurer },
    );

    const pages = stage.querySelectorAll('.docx-wrapper > section.docx');
    // 页1: pIntro (180)；页2: pHeading(40)+pBodyAfterHeading(100)+pLong段1(100)；页3: pLong段2(240)；页4: pLong段3(210)
    assert.equal(pages.length, 4);
    assert.deepEqual(
      pages[0].querySelectorAll('p') ? pages[0].children[0].children.map((p) => p.textContent) : [],
      ['引言'],
    );
    assert.equal(pages[1].children[0].children[0], pHeading);
    assert.equal(pages[1].children[0].children[1], pBodyAfterHeading);
    // 末片段独占 fp-sect-end-0
    assert.equal(pages[1].children[0].children[2].classList.contains(`${DOCX_SECTION_END_CLASS_PREFIX}0`), false);
    assert.equal(pages[2].children[0].children[0].classList.contains(`${DOCX_SECTION_END_CLASS_PREFIX}0`), false);
    assert.equal(pages[2].children[0].children[0].classList.contains(DOCX_CONTINUED_PARA_CLASS), true);
    assert.equal(pages[3].children[0].children[0].classList.contains(`${DOCX_SECTION_END_CLASS_PREFIX}0`), true);
  });

  it('跨页大表格避开 rowSpan 合并行安全切分，并在续表顶部重复 tblHeader 表头行', async () => {
    const {
      DOCX_TBL_HEADER_CLASS,
      computeSafeTableSplitBoundaries,
      paginateOverflowDocxSections,
    } = await import('../src/utils/docxPaginator.ts');
    const { MockElement, MockText } = createMockDomEnv();

    // 1. 验证安全切分边界识别 rowSpan
    const mkRow = (cells) => {
      const tr = new MockElement('tr');
      for (const c of cells) tr.appendChild(c);
      return tr;
    };
    const rA = mkRow([new MockElement('td', { rowSpan: 3 })]);
    const rB = mkRow([new MockElement('td', { style: { display: 'none' } })]);
    const rC = mkRow([new MockElement('td', { style: { display: 'none' } })]);
    const rD = mkRow([new MockElement('td')]);
    assert.deepEqual(computeSafeTableSplitBoundaries([rA, rB, rC, rD]), [
      false,
      false,
      true,
      true,
    ]);

    // 2. 端到端验证默认 splitTable 在跨页时避开 rowSpan=2 并克隆表头行
    const stageReal = new MockElement('div');
    const wrapperReal = new MockElement('div', { className: 'docx-wrapper' });
    const secReal = new MockElement('section', {
      className: 'docx',
      height: 500,
      style: { minHeight: '160px' },
    });
    const artReal = new MockElement('article');
    const tblReal = new MockElement('table', { rect: { top: 0, bottom: 250, height: 250 } });
    const colgroup = new MockElement('colgroup');
    colgroup.appendChild(new MockElement('col'));
    tblReal.appendChild(colgroup);

    // Row 0: 表头 (0..50)
    // Row 1: 普通数据行1 (50..100)
    // Row 2: rowSpan=2 合并行起始 (100..150)
    // Row 3: 被合并行 (150..200) -> 可用高度 160px 时不能在 Row 2 后切分，必须退回到 Row 1 后切分！
    // Row 4: 普通数据行4 (200..250)
    const row0 = new MockElement('tr', {
      className: DOCX_TBL_HEADER_CLASS,
      height: 50,
      rect: { top: 0, bottom: 50, height: 50 },
    });
    row0.appendChild(new MockElement('td'));
    const row1 = new MockElement('tr', { height: 50, rect: { top: 50, bottom: 100, height: 50 } });
    row1.appendChild(new MockElement('td'));
    const row2 = new MockElement('tr', { height: 50, rect: { top: 100, bottom: 150, height: 50 } });
    row2.appendChild(new MockElement('td', { rowSpan: 2 }));
    const row3 = new MockElement('tr', { height: 50, rect: { top: 150, bottom: 200, height: 50 } });
    row3.appendChild(new MockElement('td', { style: { display: 'none' } }));
    const row4 = new MockElement('tr', { height: 50, rect: { top: 200, bottom: 250, height: 50 } });
    row4.appendChild(new MockElement('td'));

    for (const r of [row0, row1, row2, row3, row4]) {
      tblReal.appendChild(r);
    }
    artReal.appendChild(tblReal);
    secReal.appendChild(artReal);
    wrapperReal.appendChild(secReal);
    stageReal.appendChild(wrapperReal);

    const prevGcs = globalThis.getComputedStyle;
    globalThis.getComputedStyle = (el) => ({
      minHeight: el.style?.minHeight ?? '',
      borderTopWidth: '0px',
      borderBottomWidth: '0px',
      paddingTop: '0px',
      paddingBottom: '0px',
      marginTop: el.style?.marginTop ?? '0px',
      marginBottom: el.style?.marginBottom ?? '0px',
      columnCount: 'auto',
    });

    try {
      await paginateOverflowDocxSections(stageReal, {
        hasLastRenderedPageBreak: false,
        evenAndOddHeaders: false,
        sectionMetas: [{ sectProps: {} }],
      });
    } finally {
      globalThis.getComputedStyle = prevGcs;
    }

    const tblPages = stageReal.querySelectorAll('.docx-wrapper > section.docx');
    // 页1: row0(表头) + row1(数据行1)；页2+: 克隆表头 row0 + row2 + row3 (+ row4)
    assert.ok(tblPages.length >= 2);
    const page1Table = tblPages[0].children[0].children[0];
    const page1Rows = page1Table.children.filter((c) => c.tagName === 'TR');
    assert.equal(page1Rows.length, 2);
    assert.equal(page1Rows[0].classList.contains(DOCX_TBL_HEADER_CLASS), true);

    const page2Table = tblPages[1].children[0].children[0];
    const page2Rows = page2Table.children.filter((c) => c.tagName === 'TR');
    assert.equal(page2Rows[0].classList.contains(DOCX_TBL_HEADER_CLASS), true);
    assert.equal(page2Rows[1].children[0].rowSpan, 2);
    assert.equal(page2Rows[2].children[0].style.display, 'none');
  });

  it('normalizeDocxAutoLineHeight 修正 1.5 倍无单位行距为 1.95，同时保留图片段落与固定单位行高', async () => {
    const { normalizeDocxAutoLineHeight } = await import('../src/utils/docxPaginator.ts');
    const { MockElement, MockText } = createMockDomEnv();

    const stage = new MockElement('div');
    const styleEl = new MockElement('style');
    styleEl.appendChild(
      new MockText('.docx p { line-height: 1.15; } .fixed { line-height: 18pt; }'),
    );

    const bodyPara = new MockElement('p', { style: { lineHeight: '1.50' } });
    bodyPara.appendChild(new MockText('正文段落文本'));

    const fixedPara = new MockElement('p', { style: { lineHeight: '20pt' } });
    fixedPara.appendChild(new MockText('固定行距文本'));

    const imgPara = new MockElement('p', { style: { lineHeight: '1.00' } });
    imgPara.appendChild(new MockElement('img'));

    const imgNoLhPara = new MockElement('p');
    imgNoLhPara.appendChild(new MockElement('img'));

    const footer = new MockElement('footer');
    const footerPara = new MockElement('p', { style: { lineHeight: '1.00' } });
    footerPara.appendChild(new MockText('1'));
    footer.appendChild(footerPara);

    stage.appendChild(styleEl);
    stage.appendChild(bodyPara);
    stage.appendChild(fixedPara);
    stage.appendChild(imgPara);
    stage.appendChild(imgNoLhPara);
    stage.appendChild(footer);

    normalizeDocxAutoLineHeight(stage);
    // 幂等性二次调用不应重复放大
    normalizeDocxAutoLineHeight(stage);

    assert.equal(bodyPara.style.lineHeight, '1.95');
    assert.equal(fixedPara.style.lineHeight, '20pt');
    assert.equal(imgPara.style.lineHeight, '1.00');
    assert.equal(imgNoLhPara.style.lineHeight, '1.2');
    assert.equal(footerPara.style.lineHeight, '1.00');
    assert.match(styleEl.textContent, /line-height:\s*1\.495;/);
    assert.match(styleEl.textContent, /line-height:\s*18pt;/);
  });

  it('超过半页的 keepNext 大图及无 keepNext 纯图+短图注均整组推入下一页，不把图注拆散到下一页', async () => {
    const {
      DOCX_KEEP_NEXT_CLASS,
      paginateOverflowDocxSections,
    } = await import('../src/utils/docxPaginator.ts');
    const { MockElement, MockText } = createMockDomEnv();

    const stage = new MockElement('div');
    const wrapper = new MockElement('div', { className: 'docx-wrapper' });
    const section = new MockElement('section', {
      className: 'docx',
      height: 2200,
      style: { minHeight: '1120px' },
    });
    const article = new MockElement('article');

    // 第一页：图1(326px) + 图注1(48px) = 374px，剩余 546px
    // 紧接图2(504px > 920*0.5=460px，占 54.8% 页高！) + 图注2(48px) = 552px > 546px
    // 由于 504px 能放进剩余 546px，若错误跳过 >50% 的 keepNext，图2 会硬塞在页1而图注2被拆到页2
    const img1 = new MockElement('p', { className: DOCX_KEEP_NEXT_CLASS, height: 326 });
    img1.appendChild(new MockElement('img', { height: 326 }));
    const cap1 = new MockElement('p', { height: 48 });
    cap1.appendChild(new MockText('图1 说明'));

    const img2 = new MockElement('p', { className: DOCX_KEEP_NEXT_CLASS, height: 504 });
    img2.appendChild(new MockElement('img', { height: 504 }));
    const cap2 = new MockElement('p', { height: 48 });
    cap2.appendChild(new MockText('图2 说明'));

    // 第三张图故意不带 keepNext 类，验证纯图片+短图注隐式粘连保护（页2剩余 920-552=368px；若换成高330+图注48=378px > 368px）
    const img3 = new MockElement('p', { height: 330 });
    img3.appendChild(new MockElement('img', { height: 330 }));
    const cap3 = new MockElement('p', { height: 48 });
    cap3.appendChild(new MockText('图3 说明'));

    for (const el of [img1, cap1, img2, cap2, img3, cap3]) {
      article.appendChild(el);
    }
    section.appendChild(article);
    wrapper.appendChild(section);
    stage.appendChild(wrapper);

    await paginateOverflowDocxSections(
      stage,
      { hasLastRenderedPageBreak: false, evenAndOddHeaders: false, sectionMetas: [{ sectProps: {} }] },
      {
        measurer: {
          getSectionMinHeightPx: () => 1120,
          getSectionHeightPx: (sec) => sec.offsetHeight,
          getMaxArticleHeightPx: () => 920,
          getArticleColumnCount: () => 1,
          measureBlock: (el) => ({ height: el._mockHeight, marginTop: 0, marginBottom: 0 }),
          splitParagraph: () => null,
          splitTable: () => null,
        },
      },
    );

    const pages = stage.querySelectorAll('.docx-wrapper > section.docx');
    assert.equal(pages.length, 3);
    assert.deepEqual(pages[0].children[0].children, [img1, cap1]);
    assert.deepEqual(pages[1].children[0].children, [img2, cap2]);
    assert.deepEqual(pages[2].children[0].children, [img3, cap3]);
  });
});

describe('图片 (.jpg / .jpeg / .png) 预览后端挂载与布局几何测试', () => {
  let tempRoot;
  let workspaceDir;
  let distDir;
  let assetsDir;
  let running;
  let baseUrl;
  const token = 'test-img-token-456';

  before(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'fp-image-test-'));
    workspaceDir = join(tempRoot, 'ws');
    distDir = join(tempRoot, 'dist');
    assetsDir = join(tempRoot, 'assets');
    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(distDir, { recursive: true });
    mkdirSync(assetsDir, { recursive: true });

    writeFileSync(join(distDir, 'index.html'), '<html><body>Mock UI</body></html>');
    writeFileSync(join(distDir, 'app.js'), 'console.log("ui");');
    writeFileSync(join(distDir, 'pdf.worker.js'), 'console.log("worker");');
    writeFileSync(join(distDir, 'styles.css'), 'body{}');
    writeFileSync(join(assetsDir, 'logo.svg'), '<svg></svg>');

    writeFileSync(join(workspaceDir, 'photo.JPG'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02]));
    writeFileSync(join(workspaceDir, 'cover.jpeg'), Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x03, 0x04]));
    writeFileSync(
      join(workspaceDir, '透明图.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xaa, 0xbb]),
    );
    writeFileSync(join(workspaceDir, 'other.pptx'), Buffer.from('PK\x03\x04'));

    process.env.ANTIGRAVITY_SIDECAR_WEB_PORT = '0';
    process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN = token;

    running = await startServer({
      distDir,
      assetsDir,
      allowedRootsOverride: [workspaceDir],
    });
    const addr = running.server.address();
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await running.close();
    delete process.env.ANTIGRAVITY_SIDECAR_WEB_PORT;
    delete process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('pathSecurity 与 workspaceScanner 正确识别并扫描 .jpg / .jpeg / .png 为 image 类型', () => {
    const jpgInfo = validateFilePath(join(workspaceDir, 'photo.JPG'), { allowedRootsOverride: [workspaceDir] });
    assert.equal(jpgInfo.kind, 'image');
    assert.equal(jpgInfo.ext, '.jpg');

    const jpegInfo = validateFilePath(join(workspaceDir, 'cover.jpeg'), { allowedRootsOverride: [workspaceDir] });
    assert.equal(jpegInfo.kind, 'image');
    assert.equal(jpegInfo.ext, '.jpeg');

    const pngInfo = validateFilePath(join(workspaceDir, '透明图.png'), { allowedRootsOverride: [workspaceDir] });
    assert.equal(pngInfo.kind, 'image');
    assert.equal(pngInfo.ext, '.png');

    const scanned = scanWorkspaceFiles([pathToFileURL(workspaceDir).href]);
    const imageFiles = scanned.filter((item) => item.kind === 'image').map((item) => item.name).sort();
    assert.deepEqual(imageFiles, ['cover.jpeg', 'photo.JPG', '透明图.png']);
  });

  it('mountImageTarget 与 POST /api/image/mount 正确挂载并输出对应 MIME、CORS、Range 与 415/413 防护', async () => {
    const jpgPath = join(workspaceDir, 'photo.JPG');
    const pngPath = join(workspaceDir, '透明图.png');

    const directMounted = await mountImageTarget(pngPath);
    assert.match(directMounted.url, /^http:\/\/127\.0\.0\.1:\d+\/i\/[0-9a-f]{48}\//);
    const pngRes = await fetch(directMounted.url);
    assert.equal(pngRes.status, 200);
    assert.equal(pngRes.headers.get('content-type'), 'image/png');
    assert.equal(pngRes.headers.get('access-control-allow-origin'), '*');
    assert.equal(pngRes.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(
      Buffer.from(await pngRes.arrayBuffer()),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xaa, 0xbb]),
    );

    const headers = {
      'Content-Type': 'application/json',
      'X-Sidecar-Token': token,
    };

    const apiMountRes = await fetch(`${baseUrl}/api/image/mount`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ file: jpgPath, workspaceUris: [workspaceDir] }),
    });
    assert.equal(apiMountRes.status, 200);
    const apiMountJson = await apiMountRes.json();
    assert.equal(apiMountJson.fileName, 'photo.JPG');

    const jpgRes = await fetch(apiMountJson.url);
    assert.equal(jpgRes.status, 200);
    assert.equal(jpgRes.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual(
      Buffer.from(await jpgRes.arrayBuffer()),
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02]),
    );

    // 非图片文件返回 415
    const badRes = await fetch(`${baseUrl}/api/image/mount`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ file: join(workspaceDir, 'other.pptx'), workspaceUris: [workspaceDir] }),
    });
    assert.equal(badRes.status, 415);

    // 超过 256MB 图片返回 413
    const oversizedPng = join(workspaceDir, 'huge.png');
    writeFileSync(oversizedPng, '');
    truncateSync(oversizedPng, 257 * 1024 * 1024);
    const tooLargeRes = await fetch(`${baseUrl}/api/image/mount`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ file: oversizedPng, workspaceUris: [workspaceDir] }),
    });
    assert.equal(tooLargeRes.status, 413);

    // 图片 LRU 上限 32
    for (let i = 0; i < 36; i += 1) {
      await mountImageTarget(jpgPath);
    }
    assert.equal(getActiveImageMountCount(), 32);
  });

  it('imageLayout 正确计算适应视口缩放、小图不放大、90°/270° 旋转包围盒与缩放上下限', async () => {
    const {
      normalizeImageRotation,
      computeImageDisplayMetrics,
    } = await import('../src/utils/imageLayout.ts');

    assert.equal(normalizeImageRotation(0), 0);
    assert.equal(normalizeImageRotation(90), 90);
    assert.equal(normalizeImageRotation(-90), 270);
    assert.equal(normalizeImageRotation(450), 90);
    assert.equal(normalizeImageRotation(360), 0);

    // 1. 大图适应视口：2000x1000 放入 432x632（扣除 32px 内边距后可用 400x600）=> 0.2x => 400x200
    const fitLarge = computeImageDisplayMetrics({
      naturalWidth: 2000,
      naturalHeight: 1000,
      rotation: 0,
      viewportWidth: 432,
      viewportHeight: 632,
      fitMode: true,
      zoom: 1,
    });
    assert.equal(fitLarge.scale, 0.2);
    assert.equal(fitLarge.rotatedWidth, 400);
    assert.equal(fitLarge.rotatedHeight, 200);

    // 2. 旋转 90° 后：2000x1000 变为竖向 1000x2000 适应 400x600 => 600/2000 = 0.3x => 外接包围盒 300x600
    const fitRotated = computeImageDisplayMetrics({
      naturalWidth: 2000,
      naturalHeight: 1000,
      rotation: 90,
      viewportWidth: 432,
      viewportHeight: 632,
      fitMode: true,
      zoom: 1,
    });
    assert.equal(fitRotated.rotation, 90);
    assert.equal(fitRotated.scale, 0.3);
    assert.equal(fitRotated.boxWidth, 600);
    assert.equal(fitRotated.boxHeight, 300);
    assert.equal(fitRotated.rotatedWidth, 300);
    assert.equal(fitRotated.rotatedHeight, 600);

    // 3. 小图适应视口时封顶 100%，不模糊放大
    const fitSmall = computeImageDisplayMetrics({
      naturalWidth: 120,
      naturalHeight: 80,
      rotation: 0,
      viewportWidth: 500,
      viewportHeight: 500,
      fitMode: true,
      zoom: 1,
    });
    assert.equal(fitSmall.scale, 1);
    assert.equal(fitSmall.rotatedWidth, 120);
    assert.equal(fitSmall.rotatedHeight, 80);

    // 4. 手动缩放限制在 [0.1, 8.0]
    const manualMax = computeImageDisplayMetrics({
      naturalWidth: 100,
      naturalHeight: 50,
      rotation: 270,
      viewportWidth: 500,
      viewportHeight: 500,
      fitMode: false,
      zoom: 12,
    });
    assert.equal(manualMax.scale, 8);
    assert.equal(manualMax.rotatedWidth, 400);
    assert.equal(manualMax.rotatedHeight, 800);
  });
});

describe('全格式图片（WebP/GIF/SVG/BMP/ICO/AVIF）、WebM 视频与音频流式挂载测试', () => {
  let tempRoot;
  let workspaceDir;
  let distDir;
  let assetsDir;
  let running;
  let baseUrl;
  const token = 'test-media-token-789';

  before(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'fp-media-test-'));
    workspaceDir = join(tempRoot, 'ws');
    distDir = join(tempRoot, 'dist');
    assetsDir = join(tempRoot, 'assets');
    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(distDir, { recursive: true });
    mkdirSync(assetsDir, { recursive: true });

    writeFileSync(join(distDir, 'index.html'), '<html><body>Mock UI</body></html>');
    writeFileSync(join(distDir, 'app.js'), 'console.log("ui");');
    writeFileSync(join(distDir, 'pdf.worker.js'), 'console.log("worker");');
    writeFileSync(join(distDir, 'styles.css'), 'body{}');
    writeFileSync(join(assetsDir, 'logo.svg'), '<svg></svg>');

    writeFileSync(join(workspaceDir, 'anim.webp'), Buffer.from('RIFF\x00\x00\x00\x00WEBP'));
    writeFileSync(join(workspaceDir, 'loop.GIF'), Buffer.from('GIF89a'));
    writeFileSync(join(workspaceDir, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    writeFileSync(join(workspaceDir, 'pic.avif'), Buffer.from('ftypavif'));
    writeFileSync(join(workspaceDir, 'clip.webm'), Buffer.from('WEBM-0123456789'));
    writeFileSync(join(workspaceDir, 'track.mp3'), Buffer.from('ID3-AUDIO-PAYLOAD'));
    writeFileSync(join(workspaceDir, 'lossless.flac'), Buffer.from('fLaC-AUDIO-PAYLOAD'));
    writeFileSync(join(workspaceDir, 'doc.docx'), Buffer.from('PK\x03\x04'));

    process.env.ANTIGRAVITY_SIDECAR_WEB_PORT = '0';
    process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN = token;

    running = await startServer({
      distDir,
      assetsDir,
      allowedRootsOverride: [workspaceDir],
    });
    const addr = running.server.address();
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await running.close();
    delete process.env.ANTIGRAVITY_SIDECAR_WEB_PORT;
    delete process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('pathSecurity 与 workspaceScanner 正确识别全格式图片、WebM 与音频文件', () => {
    assert.equal(validateFilePath(join(workspaceDir, 'anim.webp'), { allowedRootsOverride: [workspaceDir] }).kind, 'image');
    assert.equal(validateFilePath(join(workspaceDir, 'icon.svg'), { allowedRootsOverride: [workspaceDir] }).kind, 'image');
    assert.equal(validateFilePath(join(workspaceDir, 'pic.avif'), { allowedRootsOverride: [workspaceDir] }).kind, 'image');
    assert.equal(validateFilePath(join(workspaceDir, 'clip.webm'), { allowedRootsOverride: [workspaceDir] }).kind, 'mp4');
    assert.equal(validateFilePath(join(workspaceDir, 'track.mp3'), { allowedRootsOverride: [workspaceDir] }).kind, 'audio');
    assert.equal(validateFilePath(join(workspaceDir, 'lossless.flac'), { allowedRootsOverride: [workspaceDir] }).kind, 'audio');

    const scanned = scanWorkspaceFiles([pathToFileURL(workspaceDir).href]);
    assert.deepEqual(
      scanned.filter((f) => f.kind === 'audio').map((f) => f.name).sort(),
      ['lossless.flac', 'track.mp3'],
    );
    assert.deepEqual(
      scanned.filter((f) => f.kind === 'image').map((f) => f.name).sort(),
      ['anim.webp', 'icon.svg', 'loop.GIF', 'pic.avif'],
    );
    assert.deepEqual(
      scanned.filter((f) => f.kind === 'mp4').map((f) => f.name),
      ['clip.webm'],
    );
  });

  it('SVG 挂载自动附加 CSP 沙箱头，WebM 与音频支持 HTTP Range 流式播放与 415/413/LRU 边界', async () => {
    const svgMounted = await mountImageTarget(join(workspaceDir, 'icon.svg'));
    const svgRes = await fetch(svgMounted.url);
    assert.equal(svgRes.status, 200);
    assert.equal(svgRes.headers.get('content-type'), 'image/svg+xml');
    assert.match(svgRes.headers.get('content-security-policy') || '', /default-src 'none'/);

    const webpMounted = await mountImageTarget(join(workspaceDir, 'anim.webp'));
    const webpRes = await fetch(webpMounted.url);
    assert.equal(webpRes.status, 200);
    assert.equal(webpRes.headers.get('content-type'), 'image/webp');

    const webmMounted = await mountVideoTarget(join(workspaceDir, 'clip.webm'));
    const webmRes = await fetch(webmMounted.url, { headers: { Range: 'bytes=5-9' } });
    assert.equal(webmRes.status, 206);
    assert.equal(webmRes.headers.get('content-type'), 'video/webm');
    assert.equal(await webmRes.text(), '01234');

    const headers = {
      'Content-Type': 'application/json',
      'X-Sidecar-Token': token,
    };

    const audioMountRes = await fetch(`${baseUrl}/api/audio/mount`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ file: join(workspaceDir, 'track.mp3'), workspaceUris: [workspaceDir] }),
    });
    assert.equal(audioMountRes.status, 200);
    const audioJson = await audioMountRes.json();
    assert.equal(audioJson.fileName, 'track.mp3');

    const mp3RangeRes = await fetch(audioJson.url, { headers: { Range: 'bytes=4-8' } });
    assert.equal(mp3RangeRes.status, 206);
    assert.equal(mp3RangeRes.headers.get('content-type'), 'audio/mpeg');
    assert.equal(await mp3RangeRes.text(), 'AUDIO');

    const flacMounted = await mountAudioTarget(join(workspaceDir, 'lossless.flac'));
    const flacRes = await fetch(flacMounted.url);
    assert.equal(flacRes.status, 200);
    assert.equal(flacRes.headers.get('content-type'), 'audio/flac');

    const nonAudioRes = await fetch(`${baseUrl}/api/audio/mount`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ file: join(workspaceDir, 'doc.docx'), workspaceUris: [workspaceDir] }),
    });
    assert.equal(nonAudioRes.status, 415);

    const hugeAudio = join(workspaceDir, 'huge.wav');
    writeFileSync(hugeAudio, '');
    truncateSync(hugeAudio, 1025 * 1024 * 1024);
    const hugeAudioRes = await fetch(`${baseUrl}/api/audio/mount`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ file: hugeAudio, workspaceUris: [workspaceDir] }),
    });
    assert.equal(hugeAudioRes.status, 413);

    for (let i = 0; i < 36; i += 1) {
      await mountAudioTarget(join(workspaceDir, 'track.mp3'));
    }
    assert.equal(getActiveAudioMountCount(), 32);
  });
});






