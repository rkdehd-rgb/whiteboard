#!/usr/bin/env node
/**
 * 协作白板回归基线（零依赖，只用本机 Chrome）
 *
 *   node test/run.js              # 跑全部三条主线
 *   node test/run.js export sync  # 只跑指定主线
 *
 * 环境变量：
 *   CHROME=/path/to/chrome        指定浏览器（默认 Windows 常见安装路径）
 *   TIMEOUT=90                    每条主线的超时秒数
 *
 * 主线：
 *   export  建图框 → 按框分页导出 → 像素/尺寸断言
 *   sync    双窗口实时同步（含畸形消息清洗）
 *   op      op 白名单 + JSON 序列化往返一致性
 *
 * 做法：把 whiteboard.html 复制到 test/.tmp/app.html，并在 IIFE 末尾注入测试探针
 * window.__T（不改动交付文件本体），再由无头 Chrome 打开各 spec 页面跑断言。
 * 页面的断言结果通过 fetch('/_report') 回传，本进程轮询到 PROBE_END 收尾。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(__dirname, '.tmp');
const REPORT = path.join(TMP, '_report.txt');
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const TIMEOUT = (parseInt(process.env.TIMEOUT || '90', 10)) * 1000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8'
};

const SPECS = [
  { name: 'export', file: 'specs/export.spec.html', desc: '图框 → 分页导出 → 像素断言' },
  { name: 'sync', file: 'specs/sync.spec.html', desc: '双窗口实时同步' },
  { name: 'op', file: 'specs/op.spec.html', desc: 'op 白名单与序列化往返' }
];

/* 注入到 IIFE 末尾的测试探针 */
const HOOK = `
window.__T = {
  doc, sel, doOps, applyOp, sanitizeOp, requestDraw, renderExport, handleMsg,
  addNote, addShape, addText, addComment, addFrame, addImage,
  toggleHidden, applyColor, hitTop, hitFrame, toScreen, view, applyView,
  get tool(){ return tool; },
  get ROOM(){ return ROOM; },
  get me(){ return me; },
  get peers(){ return peers; },
  get imgLockRatio(){ return imgLockRatio; },
  get frameMul(){ return frameMul; },
  get idbBroken(){ return idbBroken; }
};
`;

function buildApp() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const src = fs.readFileSync(path.join(ROOT, 'whiteboard.html'), 'utf8');
  const tail = '\n})();\n</script>';
  if (src.split(tail).length - 1 !== 1) {
    throw new Error('注入锚点不唯一，whiteboard.html 的 IIFE 结尾结构变了');
  }
  fs.writeFileSync(path.join(TMP, 'app.html'), src.split(tail).join('\n' + HOOK + '\n})();\n</script>'), 'utf8');
}

function serve(port) {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      if (u.pathname === '/_report') {
        try { fs.writeFileSync(REPORT, u.searchParams.get('d') || '', 'utf8'); } catch (e) {}
        res.writeHead(204); res.end(); return;
      }
      let p = decodeURIComponent(u.pathname);
      const f = path.resolve(path.join(ROOT, p));
      if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
        res.writeHead(404); res.end('404'); return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store'
      });
      fs.createReadStream(f).pipe(res);
    });
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

function runSpec(spec, port) {
  return new Promise(resolve => {
    if (!fs.existsSync(CHROME)) {
      console.log('!! 找不到 Chrome：' + CHROME + '\n   可用 CHROME=/path/to/chrome 指定');
      return resolve({ name: spec.name, ok: false, out: '(未运行)' });
    }
    try { fs.unlinkSync(REPORT); } catch (e) {}
    const child = spawn(CHROME, [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
      '--window-size=1300,1000',
      '--user-data-dir=' + path.join(TMP, 'profile-' + spec.name + '-' + Date.now()),
      'http://127.0.0.1:' + port + '/test/' + spec.file
    ], { stdio: 'ignore' });

    const t0 = Date.now();
    const timer = setInterval(() => {
      let txt = '';
      try { txt = fs.readFileSync(REPORT, 'utf8'); } catch (e) {}
      const done = txt.indexOf('PROBE_END') >= 0;
      if (done || Date.now() - t0 > TIMEOUT) {
        clearInterval(timer);
        try { child.kill(); } catch (e) {}
        const failed = /✗/.test(txt) || !done;
        resolve({ name: spec.name, ok: !failed, out: txt, secs: Math.round((Date.now() - t0) / 1000) });
      }
    }, 350);
  });
}

(async () => {
  const only = process.argv.slice(2).filter(a => !a.startsWith('-'));
  const list = only.length ? SPECS.filter(s => only.includes(s.name)) : SPECS;
  if (!list.length) { console.log('没有匹配的主线。可选：' + SPECS.map(s => s.name).join(' / ')); process.exit(1); }

  buildApp();
  const port = 8870 + Math.floor(Math.random() * 80);
  const srv = await serve(port);
  const results = [];
  for (const spec of list) {
    console.log('\n=== ' + spec.name + ' · ' + spec.desc + ' ===');
    const r = await runSpec(spec, port);
    process.stdout.write(r.out || '(无输出)\n');
    if (!r.out) console.log('!! 超时或未回传结果');
    results.push(r);
  }
  srv.close();

  const bad = results.filter(r => !r.ok);
  console.log('\n---------- 汇总 ----------');
  results.forEach(r => console.log((r.ok ? 'PASS  ' : 'FAIL  ') + r.name + (r.secs ? '  (' + r.secs + 's)' : '')));
  console.log(bad.length ? ('失败 ' + bad.length + ' 条主线') : '全部通过');
  process.exit(bad.length ? 1 : 0);
})().catch(err => { console.log('运行失败：' + (err && err.message)); process.exit(1); });
