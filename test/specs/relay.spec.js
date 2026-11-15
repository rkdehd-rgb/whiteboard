/**
 * 主线 4：中继安全与容量
 *   node test/specs/relay.spec.js      （由 test/run.js 调度，也可单独跑）
 *
 * 覆盖：口令鉴权、连接拒绝、消息限流、快照体积上限、snaps LRU、房间名校验
 */
'use strict';
const net = require('net');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const DIR_TMP = path.join(__dirname, '..', '.tmp', 'rooms-relay');

let pass = 0, fail = 0;
const ck = (c, m) => { if (c) { pass++; console.log('✓ ' + m); } else { fail++; console.log('✗ ' + m); } };
const wait = ms => new Promise(r => setTimeout(r, ms));

/* ---------- 极简 WebSocket 客户端 ---------- */
function connect(port, query, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    let buf = Buffer.alloc(0), handshook = false, bufAfter = Buffer.alloc(0);
    const client = {
      sock,
      closeCode: null,
      send(obj) {
        const payload = Buffer.from(JSON.stringify(obj), 'utf8');
        const mask = crypto.randomBytes(4);
        const masked = Buffer.from(payload);
        for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
        let head;
        if (payload.length < 126) head = Buffer.from([0x81, 0x80 | payload.length]);
        else { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 0x80 | 126; head.writeUInt16BE(payload.length, 2); }
        try { sock.write(Buffer.concat([head, mask, masked])); } catch (e) {}
      },
      end() { try { sock.destroy(); } catch (e) {} }
    };
    client.closed = new Promise(res => { client._closeResolve = res; });   // 对象建好后再建 Promise
    const timer = setTimeout(() => { try { sock.destroy(); } catch (e) {} reject(new Error('connect timeout')); }, timeout);

    sock.on('connect', () => {
      const key = crypto.randomBytes(16).toString('base64');
      sock.write('GET /ws' + (query || '') + ' HTTP/1.1\r\n' +
        'Host: 127.0.0.1:' + port + '\r\n' +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n\r\n');
    });
    sock.on('data', d => {
      buf = Buffer.concat([buf, d]);
      if (!handshook) {
        const s = buf.toString('latin1');
        const idx = s.indexOf('\r\n\r\n');
        if (idx < 0) return;
        clearTimeout(timer);
        const status = s.split('\r\n')[0];
        buf = buf.slice(idx + 4);       // 丢弃握手响应，剩下的才是帧
        if (status.indexOf('101') < 0) {
          client.status = status;
          try { sock.destroy(); } catch (e) {}
          return resolve(client);        // 拒绝场景也返回，由调用方断言 status
        }
        handshook = true;
        client.status = status;
        resolve(client);
        return;
      }
      // 解析服务端帧（只关心 close）
      while (buf.length >= 2) {
        const op = buf[0] & 0x0f;
        let len = buf[1] & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) return;
        const payload = buf.slice(off, off + len);
        buf = buf.slice(off + len);
        if (op === 0x8) {
          client.closeCode = payload.length >= 2 ? payload.readUInt16BE(0) : null;
          if (client._closeResolve) client._closeResolve(client.closeCode);
        }
      }
    });
    sock.on('close', () => { clearTimeout(timer); if (client._closeResolve) client._closeResolve(null); });
    sock.on('error', () => {});
  });
}

function get(port, p) {
  return new Promise((res, rej) => {
    const req = http.get({ host: '127.0.0.1', port, path: p }, r => {
      let b = ''; r.on('data', d => b += d); r.on('end', () => res({ code: r.statusCode, body: b }));
    });
    req.on('error', rej);
    req.setTimeout(3000, () => req.destroy(new Error('timeout')));
  });
}

function startServer(port, extra) {
  const args = ['relay-server.js', '--port', String(port), '--dir', DIR_TMP].concat(extra || []);
  const p = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  p.log = '';
  p.stdout.on('data', d => p.log += d.toString());
  p.stderr.on('data', d => p.log += d.toString());
  return p;
}

async function ready(port) {
  for (let i = 0; i < 50; i++) {
    try { const r = await get(port, '/health'); if (r.code === 200) return JSON.parse(r.body); } catch (e) {}
    await wait(120);
  }
  return null;
}

(async () => {
  try { fs.rmSync(DIR_TMP, { recursive: true, force: true }); } catch (e) {}

  /* ---------- A. 未启用口令：正常连通 ---------- */
  const P1 = 8951;
  let srv = startServer(P1);
  let h = await ready(P1);
  ck(!!h, '中继启动并可访问 /health');
  ck(h && h.auth === false, '未配置口令时 health.auth = false');

  let c = await connect(P1, '');
  ck(c.status && c.status.indexOf('101') >= 0, '无口令可正常握手');
  c.send({ t:'sync', room:'roomA', doc:{ shapes:{ s1:{ id:'s1', kind:'rect', x:0, y:0, w:10, h:10 } } } });
  await wait(300);
  h = JSON.parse((await get(P1, '/health')).body);
  ck((h.snaps || []).includes('roomA'), '快照进入内存');
  c.end();

  /* 房间名非法 → 归入 default，不会落到文件路径上 */
  let cBad = await connect(P1, '');
  cBad.send({ t:'sync', room:'../../etc/passwd', doc:{ notes:{ n1:{ id:'n1', x:0, y:0, text:'x' } } } });
  await wait(300);
  h = JSON.parse((await get(P1, '/health')).body);
  ck((h.snaps || []).includes('default'), '非法房间名被归入 default');
  ck(!(h.snaps || []).some(k => k.indexOf('..') >= 0), '路径穿越式房间名未被接受');
  cBad.end();
  srv.kill();

  /* ---------- B. 口令鉴权 ---------- */
  const P2 = 8952;
  srv = startServer(P2, ['--token', 's3cret']);
  h = await ready(P2);
  ck(h && h.auth === true, '配置口令后 health.auth = true');

  const cNo = await connect(P2, '');
  ck(cNo.status && /401/.test(cNo.status), '不带 token → 401 拒绝（' + (cNo.status || '无响应') + '）');
  const cWrong = await connect(P2, '?token=nope');
  ck(cWrong.status && /401/.test(cWrong.status), '错误 token → 401 拒绝');
  const cOk = await connect(P2, '?token=s3cret');
  ck(cOk.status && cOk.status.indexOf('101') >= 0, '正确 token → 握手成功');
  cOk.end();
  srv.kill();

  /* ---------- C. 限流 ---------- */
  const P3 = 8953;
  srv = startServer(P3, ['--ratemsg', '20']);
  await ready(P3);
  const cFlood = await connect(P3, '');
  ck(cFlood.status && cFlood.status.indexOf('101') >= 0, '限流实例可连通');
  for (let i = 0; i < 60; i++) cFlood.send({ t:'cur', from:'p1', x:i, y:i });
  const code = await Promise.race([cFlood.closed, wait(3000).then(() => 'timeout')]);
  ck(code === 1008, '超频发送被服务端以 1008（policy violation）关闭（实际 ' + code + '）');
  cFlood.end();
  srv.kill();

  /* ---------- D. 快照体积上限 ---------- */
  const P4 = 8954;
  srv = startServer(P4, ['--snapmb', '0.01']);   // 10KB
  await ready(P4);
  const cBig = await connect(P4, '');
  const big = {};
  for (let i = 0; i < 120; i++) big['n' + i] = { id:'n' + i, x:i, y:i, w:172, h:132, text:'x'.repeat(40) };
  cBig.send({ t:'sync', room:'big', doc:{ notes:big } });
  await wait(400);
  h = JSON.parse((await get(P4, '/health')).body);
  ck(!(h.snaps || []).includes('big'), '超过体积上限的快照被丢弃');
  cBig.end();
  const cSmall = await connect(P4, '');
  cSmall.send({ t:'sync', room:'small', doc:{ notes:{ n1:{ id:'n1', x:0, y:0, text:'ok' } } } });
  await wait(300);
  h = JSON.parse((await get(P4, '/health')).body);
  ck((h.snaps || []).includes('small'), '正常体积的快照仍会入库');
  cSmall.end();
  srv.kill();

  /* ---------- E. snaps LRU ---------- */
  const P5 = 8955;
  srv = startServer(P5, ['--snaprooms', '3']);
  await ready(P5);
  for (const room of ['r1', 'r2', 'r3', 'r4', 'r5']) {
    const cc = await connect(P5, '');
    cc.send({ t:'sync', room, doc:{ notes:{ n1:{ id:'n1', x:0, y:0, text:'x' } } } });
    await wait(120);
    cc.end();
    await wait(60);
  }
  h = JSON.parse((await get(P5, '/health')).body);
  const kept = h.snaps || [];
  ck(kept.length <= 3, 'snaps 数量不超过上限（' + kept.length + '）');
  ck(kept.includes('r5') && kept.includes('r4'), '保留最近使用的房间');
  ck(!kept.includes('r1'), '最久未使用的房间被淘汰');
  srv.kill();

  try { fs.rmSync(DIR_TMP, { recursive: true, force: true }); } catch (e) {}
  console.log('== ' + pass + ' 通过 / ' + fail + ' 失败 ==');
  process.exit(fail ? 1 : 0);
})().catch(err => { console.log('测试异常：' + (err && err.stack || err)); process.exit(1); });
