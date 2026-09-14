// Reproduce: node experiments/core-evaluation/portability.mjs
// Optional same-host Cordis smoke test: DSH_SOURCE_DIR=/path/to/deepseek-harness node ...
// Uses installed TypeScript and esbuild (via tsx), and Chrome when available.
// Builds an isolated package and consumer in os.tmpdir(); never updates checked-in dist.
import { mkdtemp, mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { DSH_REVISION, resolveDshSource } from './dsh-source.mjs';

function summarizeSmokeTests(report) {
  const results = report.results ?? {};
  const failures = [];
  const skipped = [];
  if (report.fatal) failures.push('fatal');
  for (const name of [
    'compileFreshDist', 'browserTypes', 'workerTypes', 'nodeNextTypesWithoutNodeAmbient',
    'freshNodePackageImport', 'freshNodeCommonJsRequire', 'browserBundle', 'freshPackageBrowserBundle',
  ]) {
    if (results[name]?.ok !== true) failures.push(name);
  }
  const hasCordis = report.dshRevision !== undefined || results.cordisBrowserBundle !== undefined;
  if (hasCordis && results.cordisBrowserBundle?.ok !== true) failures.push('cordisBrowserBundle');
  for (const name of ['browserBundle', 'freshPackageBrowserBundle', ...(hasCordis ? ['cordisBrowserBundle'] : [])]) {
    if (results[name]?.externalImports?.length !== 0) failures.push(`${name}.externalImports`);
    if (name !== 'freshPackageBrowserBundle' && results[name]?.nodeBuiltinImports?.length !== 0) {
      failures.push(`${name}.nodeBuiltinImports`);
    }
  }
  if (results.realBrowser?.skipped === true) {
    skipped.push('realBrowser: browser and Worker execution remain unverified');
  } else {
    if (results.browserProcess?.ok !== true) failures.push('browserProcess');
    for (const engine of ['aalis', ...(hasCordis ? ['cordis'] : [])]) {
      for (const host of ['main', 'worker']) {
        const result = results.realBrowser?.[engine]?.[host];
        const name = `realBrowser.${engine}.${host}`;
        if (result?.ok !== true) failures.push(name);
        else if (['process', 'require', 'Buffer'].some(key => result.result?.globals?.[key] !== 'undefined')) {
          failures.push(`${name}.nodeGlobals`);
        }
      }
    }
  }
  // The old workspace dist, deep imports, and invalid provider are observations:
  // absent old artifacts or a repaired type/exports boundary must not fail smoke tests.
  return { ok: failures.length === 0, failures, skipped };
}

// Check recorded/synthetic outcomes without compiling, launching Chrome, or
// overwriting the historical result. Useful for validating this runner itself.
if (process.argv[2] === '--check-results') {
  if (!process.argv[3]) throw new Error('Usage: portability.mjs --check-results <result.json>');
  const summary = summarizeSmokeTests(JSON.parse(await readFile(process.argv[3], 'utf8')));
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.ok ? 0 : 1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'package.json'));
const ts = require('typescript');
const tsxRequire = createRequire(require.resolve('tsx'));
const esbuild = tsxRequire('esbuild');
const temporary = await mkdtemp(path.join(tmpdir(), 'aalis-core-portability-'));
const packageRoot = path.join(temporary, 'node_modules/@aalis/core');
const report = {
  node: process.version, typescript: ts.version, esbuild: esbuild.version,
  platform: `${process.platform}/${process.arch}`, temporary,
  results: {},
};
const run = (executable, args, cwd = temporary) => {
  const r = spawnSync(executable, args, { cwd, encoding: 'utf8', timeout: 45000, maxBuffer: 4 * 1024 * 1024 });
  return { ok: r.status === 0 && !r.error, status: r.status, stdout: r.stdout?.trim(), stderr: r.stderr?.trim(), error: r.error?.message };
};
const tsc = args => run(process.execPath, [require.resolve('typescript/bin/tsc'), ...args]);
const fixture = path.join(root, 'experiments/core-evaluation/portability-fixture.ts');

// Native CDP avoids an automation dependency and lets us close Chrome after
// the actual asynchronous Worker result, without virtual-time assumptions.
async function evaluateInChrome(chrome, expression) {
  const child = spawn(chrome, ['--headless', '--disable-gpu', '--disable-extensions', '--disable-background-networking', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${path.join(temporary, 'chrome-profile')}`], { stdio: ['ignore', 'ignore', 'pipe'] });
  let socket;
  let diagnostics = '';
  let shutdown = 'not-started';
  try {
    const endpoint = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Chrome DevTools startup timed out')), 15000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.stderr.on('data', data => {
        diagnostics += data.toString();
        const match = diagnostics.match(/DevTools listening on (ws:\/\/\S+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
    });
    socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    let id = 0;
    const pending = new Map();
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      const operation = pending.get(message.id);
      if (operation) {
        pending.delete(message.id);
        clearTimeout(operation.timer);
        if (message.error) operation.reject(new Error(JSON.stringify(message.error)));
        else operation.resolve(message.result);
      }
    });
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const next = ++id;
      const timer = setTimeout(() => { pending.delete(next); reject(new Error(`CDP ${method} timed out`)); }, 15000);
      pending.set(next, { resolve, reject, timer });
      socket.send(JSON.stringify({ id: next, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    socket.send(JSON.stringify({ id: ++id, method: 'Browser.close' }));
    shutdown = await new Promise(resolve => {
      const timer = setTimeout(() => resolve('forced-after-close-timeout'), 5000);
      child.once('exit', code => { clearTimeout(timer); resolve(code === 0 ? 'clean' : `exit-${code}`); });
    });
    return { result: result.result.value, process: { ok: shutdown === 'clean', shutdown } };
  } catch (error) {
    return { error: error.message, diagnostics: diagnostics.slice(-1500), process: { ok: false, shutdown } };
  } finally {
    socket?.close();
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}

try {
  await mkdir(packageRoot, { recursive: true });
  const pkg = JSON.parse(await readFile(path.join(root, 'packages/core/package.json'), 'utf8'));
  await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify(pkg));
  await writeFile(path.join(temporary, 'package.json'), JSON.stringify({ type: 'module' }));
  report.package = { name: pkg.name, version: pkg.version, main: pkg.main, types: pkg.types, exports: pkg.exports ?? null, sideEffects: pkg.sideEffects ?? null, engines: pkg.engines ?? null, dependencies: pkg.dependencies };
  report.results.compileFreshDist = tsc(['-p', path.join(root, 'packages/core/tsconfig.json'), '--outDir', path.join(packageRoot, 'dist')]);
  if (!report.results.compileFreshDist.ok) throw new Error('fresh package compilation failed');
  await cp(fixture, path.join(temporary, 'fixture.ts'));
  for (const [name, module, moduleResolution, lib] of [
    ['browserTypes', 'ESNext', 'Bundler', ['ES2022', 'DOM']],
    ['workerTypes', 'ESNext', 'Bundler', ['ES2022', 'WebWorker']],
    ['nodeNextTypesWithoutNodeAmbient', 'NodeNext', 'NodeNext', ['ES2022', 'DOM']],
  ]) {
    const config = {
      compilerOptions: { target: 'ES2022', module, moduleResolution, lib, strict: true, skipLibCheck: false, types: [], noEmit: true },
      files: ['fixture.ts'],
    };
    await writeFile(path.join(temporary, `${name}.json`), JSON.stringify(config));
    report.results[name] = tsc(['-p', `${name}.json`]);
  }

  // A real bare-package Node import from the isolated fresh package, not a TS loader.
  await writeFile(path.join(temporary, 'node-consumer.mjs'), `import { createApp } from '@aalis/core';\nconst app=createApp({config:{name:'node-package',logLevel:'error',plugins:{}}}); await app.start(); await app.stop(); console.log(JSON.stringify({ok:true}));\n`);
  report.results.freshNodePackageImport = run(process.execPath, ['node-consumer.mjs']);
  report.results.freshNodeCommonJsRequire = run(process.execPath, ['--input-type=commonjs', '-e', "const mod=require('@aalis/core'); console.log(JSON.stringify({ok:typeof mod.createApp==='function'}));"]);
  report.results.existingWorkspaceDistImport = run(process.execPath, ['--input-type=module', '-e', "import {createApp} from '@aalis/core'; const app=createApp({config:{name:'existing-dist',logLevel:'error',plugins:{}}}); await app.start(); await app.stop(); console.log(JSON.stringify({ok:true}));"], root);
  report.results.unexportedInternalDeepImport = run(process.execPath, ['--input-type=module', '-e', "const mod=await import('@aalis/core/dist/context.js'); console.log(JSON.stringify({ok:typeof mod.Context==='function'}));"]);
  report.results.extensionlessDeepImport = run(process.execPath, ['--input-type=module', '-e', "await import('@aalis/core/context');"]);

  // Deliberately invalid implementation: tests the provider-side boundary of
  // augmentation, rather than assuming consumer inference protects providers.
  await writeFile(path.join(temporary, 'provider-boundary.ts'), `import {createApp} from '@aalis/core';
    declare module '@aalis/core' { interface ServiceTypeMap { 'portability:invalid': {increment():number} } }
    const app=createApp({config:{name:'type-boundary',logLevel:'error',plugins:{}}});
    app.ctx.provide('portability:invalid',{increment:()=> 'not-a-number'});
    const declaredNumber:number=app.ctx.getService('portability:invalid')!.increment();
    console.log(JSON.stringify({declared:'number',runtime:typeof declaredNumber}));
    await app.stop();`);
  await writeFile(path.join(temporary, 'provider-boundary.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', lib: ['ES2022', 'DOM'], strict: true, skipLibCheck: false, types: [], outDir: './provider-boundary-out' },
    files: ['provider-boundary.ts'],
  }));
  const boundaryCompilation = tsc(['-p', 'provider-boundary.json']);
  report.results.providerTypeBoundary = {
    invalidImplementationAccepted: boundaryCompilation.ok,
    compilation: boundaryCompilation,
    runtime: boundaryCompilation.ok ? run(process.execPath, ['provider-boundary-out/provider-boundary.js']) : undefined,
  };

  const build = await esbuild.build({
    entryPoints: [fixture], bundle: true, platform: 'browser', target: 'es2022', format: 'iife',
    globalName: 'Portability', write: false, minify: true, metafile: true,
    alias: { '@aalis/core': path.join(root, 'packages/core/src/index.ts') },
  });
  const bundle = build.outputFiles[0].text;
  const externalImports = Object.values(build.metafile.outputs).flatMap(o => o.imports).filter(i => i.external);
  report.results.browserBundle = {
    ok: externalImports.length === 0,
    bytes: Buffer.byteLength(bundle), gzipBytes: gzipSync(bundle).byteLength,
    sourceFiles: Object.keys(build.metafile.inputs).length,
    externalImports,
    nodeBuiltinImports: Object.values(build.metafile.inputs).flatMap(i => i.imports).filter(i => i.path.startsWith('node:')),
  };
  // Exercise package main resolution with a browser bundler as well as source aliasing.
  const packaged = await esbuild.build({
    stdin: { contents: "export {createApp} from '@aalis/core'", resolveDir: temporary },
    bundle: true, platform: 'browser', target: 'es2022', format: 'esm', write: false, metafile: true,
  });
  report.results.freshPackageBrowserBundle = { ok: true, externalImports: Object.values(packaged.metafile.outputs).flatMap(o => o.imports).filter(i => i.external) };
  await writeFile(path.join(temporary, 'probe.js'), bundle);

  const browserBundles = { aalis: bundle };
  const dshRoot = resolveDshSource();
  if (dshRoot) {
    report.dshRevision = DSH_REVISION;
    const cordisFixture = `import { Context, Service } from '@deepseek-ai/cordis';
      export async function probe() {
        const checks=[]; const check=(ok,name)=>{if(!ok)throw Error(name);checks.push(name)};
        let observed=0, disposed=false, count=0;
        class Counter extends Service {
          constructor(ctx){super(ctx,'portabilityCounter')}
          increment(){return ++count}
        }
        const root=new Context();
        await root.plugin(Counter);
        await root.plugin(Object.assign(ctx=>{
          check(ctx.portabilityCounter.increment()===1,'service registration and resolution');
          ctx.on('portability/tick',value=>{observed=value});
          ctx.effect(()=>async()=>{await Promise.resolve();disposed=true});
        },{inject:['portabilityCounter']}));
        await root.parallel('portability/tick',3);
        check(observed===3,'event delivery');
        await root.fiber.dispose();
        check(disposed,'asynchronous disposal awaited');
        check(root.get('portabilityCounter',false)===undefined,'service removed at disposal');
        return {checks,globals:{process:typeof globalThis.process,require:typeof globalThis.require,Buffer:typeof globalThis.Buffer,document:typeof globalThis.document,importScripts:typeof globalThis.importScripts}};
      }`;
    const cordisBuild = await esbuild.build({
      stdin: { contents: cordisFixture, resolveDir: temporary, loader: 'ts' },
      bundle: true, platform: 'browser', target: 'es2022', format: 'iife', globalName: 'Portability',
      write: false, minify: true, metafile: true,
      alias: {
        '@deepseek-ai/cordis': path.join(dshRoot, 'vendor/cordis/src/index.ts'),
        '@deepseek-ai/cosmokit': path.join(dshRoot, 'vendor/cosmokit/src/index.ts'),
      },
    });
    browserBundles.cordis = cordisBuild.outputFiles[0].text;
    report.results.cordisBrowserBundle = {
      ok: true,
      externalImports: Object.values(cordisBuild.metafile.outputs).flatMap(o => o.imports).filter(i => i.external),
      nodeBuiltinImports: Object.values(cordisBuild.metafile.inputs).flatMap(i => i.imports).filter(i => i.path.startsWith('node:')),
      note: 'Different public surfaces and smoke fixtures; bundle sizes are not a framework performance comparison.',
    };
  }

  const chrome = process.env.CHROME_PATH ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);
  if (chrome) {
    const expression = `(async()=>{
        const output={userAgent:navigator.userAgent};
        for(const [name,bundle] of Object.entries(${JSON.stringify(browserBundles)})) {
          const entry=output[name]={};
          try {entry.main={ok:true,result:await (new Function(bundle+';return Portability.probe()'))()};} catch(e){entry.main={ok:false,error:String(e),stack:e.stack};}
          entry.worker=await new Promise(resolve=>{
            const workerSource=bundle+';Portability.probe().then(result=>postMessage({ok:true,result}),e=>postMessage({ok:false,error:String(e),stack:e.stack}));';
            const worker=new Worker(URL.createObjectURL(new Blob([workerSource],{type:'text/javascript'})));
            worker.onmessage=e=>{worker.terminate();resolve(e.data)};
            worker.onerror=e=>{worker.terminate();resolve({ok:false,error:e.message})};
          });
        }
        return output;
      })()`;
    const html = `<!doctype html><meta charset="utf-8"><body>pending<script>${expression}.then(output=>document.body.textContent=JSON.stringify(output),error=>document.body.textContent=String(error));</script>`;
    const htmlPath = path.join(temporary, 'browser.html');
    await writeFile(htmlPath, html);
    report.chromeVersion = run(chrome, ['--version']).stdout;
    const browser = await evaluateInChrome(chrome, expression);
    report.results.browserProcess = browser.process;
    report.results.realBrowser = browser.result ?? browser;
  } else {
    report.results.realBrowser = { skipped: true, reason: 'No Chrome found; set CHROME_PATH. Browser and Worker execution are unverified.' };
  }
} catch (error) {
  report.fatal = { message: error.message, stack: error.stack };
} finally {
  report.smokeSummary = summarizeSmokeTests(report);
  process.exitCode = report.smokeSummary.ok ? 0 : 1;
  const resultPath = path.join(root, 'experiments/core-evaluation/results/portability.json');
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(resultPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (process.env.KEEP_PORTABILITY_TMP !== '1') await rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
