/**
 * 白板协作中继（零依赖，Node >= 18 可直接跑）
 *
 *   node relay-server.js                 # 监听 8787
 *   node relay-server.js --port 9000     # 指定端口
 *   node relay-server.js --dir ./rooms   # 快照存放目录（默认 ./rooms）
 *   node relay-server.js --no-save       # 不落盘，只做实时转发
 *
 * 职责：
 *   1) 把任一客户端发来的消息原样转发给同房间的其它客户端（fan-out）
 *   2) 记住房间的最新全量快照，新成员加入时自动补发 → 房间里没人时内容也不丢
 *   3) 快照落盘到 <dir>/<room>.json，服务重启后仍在
 *
 * 协议约定（与 whiteboard.html 一致）：
 *   客户端消息是 JSON，带 t 字段；房间由 URL 的 ?room= 决定，缺省时取消息里的 room 字段。
 *   t:'sync' / t:'state' 携带 doc 全量 → 服务端缓存并落盘。
 */
'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

/* ---------- 参数 ---------- */
const argv = process.argv.slice(2);
const argOf = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const PORT = parseInt(argOf('port', process.env.PORT || '8787'), 10);
const DIR = path.resolve(argOf('dir', path.join(__dirname, 'rooms')));
const SAVE = argv.indexOf('--no-save') < 0;
const PAGE = path.resolve(argOf('page', path.join(__dirname, 'whiteboard.html')));   // 顺便托管白板页面
const MAX_PAYLOAD = 32 * 1024 * 1024;      // 单帧上限 32MB（图片 base64 可能较大）
const SAVE_DEBOUNCE = 1500;                // 快照落盘节流

/* ---------- 安全与容量上限 ---------- */
const TOKEN = argOf('token', process.env.RELAY_TOKEN || '');   // 配置后所有连接都要带 ?token=
const MAX_CONNS = parseInt(argOf('maxconn', process.env.RELAY_MAX_CONN || '500'), 10);
const RL_MSG = parseInt(argOf('ratemsg', '120'), 10);          // 单连接每秒消息数上限
const RL_BYTES = 4 * 1024 * 1024;                             // 单连接每秒字节上限
const MAX_SNAP_BYTES = Math.round(parseFloat(argOf('snapmb', '12')) * 1024 * 1024); // 单房间快照上限（超出不落库）
const MAX_SNAP_ROOMS = parseInt(argOf('snaprooms', '200'), 10);   // 内存中最多保留多少个房间的快照
const ROOM_RE = /^[\w.\-]{1,64}$/;                            // 房间名只允许字母数字下划线点横线
const validRoom = r => (typeof r === 'string' && ROOM_RE.test(r)) ? r : '';

let conns = 0;

if (SAVE) fs.mkdirSync(DIR, { recursive: true });

/* ---------- 房间状态 ---------- */
/** @type {Map<string, Set<any>>} */
const rooms = new Map();
/** @type {Map<string, object>} */
const snaps = new Map();
/** @type {Map<string, NodeJS.Timeout>} */
const saveTimers = new Map();

const roomOf = key => {
  if (!rooms.has(key)) rooms.set(key, new Set());
  return rooms.get(key);
};
const snapFile = key => path.join(DIR, key.replace(/[^\w.\-]/g, '_') + '.json');

function loadSnap(key) {
  if (!SAVE || snaps.has(key)) return;
  try {
    const raw = fs.readFileSync(snapFile(key), 'utf8');
    const j = JSON.parse(raw);
    if (j && j.doc) snaps.set(key, j.doc);
  } catch (err) { /* 没有历史就算了 */ }
}

/* 任意一类对象有内容即算有内容。
   早先只统计 notes/strokes/images/edges，导致「只放了图形/文本/评论/图框」
   的白板不会生成快照 —— 新成员进来看空板，服务重启后内容消失。 */
const SNAP_BUCKETS = ['notes', 'strokes', 'edges', 'images', 'frames', 'shapes', 'texts', 'comments'];
function hasContent(doc) {
  if (!doc || typeof doc !== 'object') return false;
  for (const k of SNAP_BUCKETS) {
    const v = doc[k];
    if (v && typeof v === 'object' && Object.keys(v).length) return true;
  }
  return false;
}

const snapPending = new Map();     // key -> 待落盘的 JSON（LRU 淘汰内存副本不影响落盘）

function evictSnaps() {
  while (snaps.size > MAX_SNAP_ROOMS) {
    const oldest = snaps.keys().next().value;
    snaps.delete(oldest);
    console.log('[snap] LRU 淘汰 ' + oldest + '（内存仅保留最近 ' + MAX_SNAP_ROOMS + ' 个房间）');
  }
}

function keepSnap(key, doc) {
  if (!doc || typeof doc !== 'object') return;
  if (!hasContent(doc)) return;                 // 空白板不覆盖已有快照
  let json;
  try { json = JSON.stringify({ doc, ts: Date.now() }); } catch (err) { return; }
  if (json.length > MAX_SNAP_BYTES) {           // 超限快照不入库，避免拖垮内存与磁盘
    console.log('[snap] 跳过 ' + key + '：快照 ' + (json.length / 1048576).toFixed(1) + 'MB 超过上限');
    return;
  }
  snaps.delete(key); snaps.set(key, doc);       // delete+set 刷新 LRU 顺序
  evictSnaps();
  snapPending.set(key, json);
  if (!SAVE) return;
  if (saveTimers.has(key)) return;
  saveTimers.set(key, setTimeout(() => {
    saveTimers.delete(key);
    const body = snapPending.get(key);          // 取最新一份，避免写入被覆盖前的旧内容
    snapPending.delete(key);
    if (!body) return;
    try {
      const tmp = snapFile(key) + '.tmp';
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, snapFile(key));        // 原子替换，避免写到一半被读
    } catch (err) {
      console.log('[save] ' + key + ' 失败: ' + err.message);
    }
  }, SAVE_DEBOUNCE));
}

/* ---------- WebSocket 帧编解码 ---------- */
/* 主动发关闭帧：让客户端能读到原因，而不是"连接莫名其妙断了" */
function closeWith(sock, code, reason) {
  if (sock.destroyed) return;
  const r = Buffer.from(String(reason || '').slice(0, 100), 'utf8');
  const payload = Buffer.alloc(2 + r.length);
  payload.writeUInt16BE(code, 0);
  r.copy(payload, 2);
  try {
    sock.write(Buffer.concat([Buffer.from([0x88, payload.length]), payload]));
    sock.end();
  } catch (err) {}
  setTimeout(() => { try { sock.destroy(); } catch (err) {} }, 200);
}

/* 固定窗口限流：单连接每秒的消息数与字节数 */
function allow(peer, bytes) {
  const t = Date.now();
  if (t - peer.wt >= 1000) { peer.wt = t; peer.wn = 0; peer.wb = 0; }
  peer.wn++;
  peer.wb += bytes;
  return peer.wn <= RL_MSG && peer.wb <= RL_BYTES;
}

function send(sock, str) {
  if (sock.destroyed) return;
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x81; head[1] = 126; head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2);
  }
  try { sock.write(Buffer.concat([head, payload])); } catch (err) {}
}

/* 每个连接维护自己的解析缓冲与分片状态 */
function makeParser(onMessage) {
  let buf = Buffer.alloc(0);
  let fragOp = 0, fragParts = [];
  return data => {
    buf = Buffer.concat([buf, data]);
    for (;;) {
      if (buf.length < 2) return;
      const b0 = buf[0], b1 = buf[1];
      const fin = (b0 & 0x80) !== 0;
      const op = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < off + 2) return;
        len = buf.readUInt16BE(off); off += 2;
      } else if (len === 127) {
        if (buf.length < off + 8) return;
        const big = buf.readBigUInt64BE(off); off += 8;
        if (big > BigInt(MAX_PAYLOAD)) { buf = Buffer.alloc(0); return; }
        len = Number(big);
      }
      if (buf.length < off + (masked ? 4 : 0) + len) return;
      let mask = null;
      if (masked) { mask = buf.slice(off, off + 4); off += 4; }
      let payload = buf.slice(off, off + len);
      buf = buf.slice(off + len);
      if (mask) {
        const p = Buffer.from(payload);      // 复制后原地解码，避免改到共享缓冲
        for (let i = 0; i < p.length; i++) p[i] ^= mask[i & 3];
        payload = p;
      }
      if (op === 0x8) { onMessage(null, 'close'); return; }
      if (op === 0x9) { onMessage(payload, 'ping'); continue; }
      if (op === 0xa) continue;
      if (op === 0x0) { fragParts.push(payload); }
      else { fragOp = op; fragParts = [payload]; }
      if (fin && fragParts.length) {
        const full = Buffer.concat(fragParts);
        fragParts = [];
        if (fragOp === 0x1) onMessage(full, 'text');
      }
    }
  };
}

/* ---------- HTTP + 握手 ---------- */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function lanIPs() {
  const out = [];
  const ifs = os.networkInterfaces() || {};
  for (const name in ifs) {
    for (const i of ifs[name] || []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out;
}

const server = http.createServer((req, res) => {
  const p = (req.url || '/').split('?')[0];
  // 反向代理若带路径前缀（/app/xxx/health），也要能应答
  if (p === '/health' || p.endsWith('/health')) {
    const info = [...rooms.entries()].map(([k, v]) => k + ':' + v.size);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      ok: true, auth: !!TOKEN, rooms: info, snaps: [...snaps.keys()],
      limits: { conns: MAX_CONNS, msgPerSec: RL_MSG, snapRooms: MAX_SNAP_ROOMS }
    }));
    return;
  }
  // 直接托管白板页面：别的设备打开网址就能用，不用拷 HTML 文件
  if (p === '/' || p.endsWith('/') || p.endsWith('/index.html') || p.endsWith('/whiteboard.html')) {
    try {
      const html = fs.readFileSync(PAGE, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('读不到白板页面: ' + PAGE);
    }
    return;
  }
  res.writeHead(404); res.end('not found');
});

function rejectUpgrade(sock, status, text) {
  try {
    sock.write('HTTP/1.1 ' + status + '\r\nConnection: close\r\nContent-Length: ' + Buffer.byteLength(text) + '\r\n\r\n' + text);
    sock.end();
  } catch (err) {}
  // 立即 destroy 可能截断刚写出的响应，让客户端只看到"连接被重置"
  setTimeout(() => { try { sock.destroy(); } catch (err) {} }, 300);
}

server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { sock.destroy(); return; }
  const u = new URL(req.url || '/', 'http://x');

  if (conns >= MAX_CONNS) {                       // 连接数上限，避免被刷爆
    console.log('[auth] 拒绝连接：已达上限 ' + MAX_CONNS);
    rejectUpgrade(sock, '503 Service Unavailable', 'too many connections');
    return;
  }
  if (TOKEN && u.searchParams.get('token') !== TOKEN) {   // 口令校验（配置后才启用）
    console.log('[auth] 拒绝连接：口令不正确');
    rejectUpgrade(sock, '401 Unauthorized', 'invalid token');
    return;
  }
  conns++;

  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  sock.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  sock.setNoDelay(true);

  // 房间：URL ?room= 优先，否则留空、由首条消息里的 room 字段决定
  let room = validRoom(u.searchParams.get('room') || '');
  const peer = { sock, room: '', dead: false, wt: Date.now(), wn: 0, wb: 0 };

  const join = key2 => {
    peer.room = key2;
    roomOf(key2).add(peer);
    loadSnap(key2);
    const doc = snaps.get(key2);
    console.log('[join] ' + key2 + ' (在线 ' + roomOf(key2).size + ')' + (doc ? ' → 补发历史快照' : ''));
    if (doc) send(sock, JSON.stringify({ t: 'state', from: '__server__', ts: Date.now(), room: key2, doc }));
  };

  const parse = makeParser((payload, kind) => {
    if (kind === 'close') { try { sock.end(); } catch (e) {} return; }
    if (kind === 'ping') { /* 浏览器不发 ping，留空即可 */ return; }
    if (!allow(peer, payload.length)) {           // 限流：超频直接断开，不进入业务逻辑
      console.log('[limit] 断开 ' + (peer.room || '?') + '：超过 ' + RL_MSG + ' 条/秒 或 4MB/秒');
      closeWith(sock, 1008, 'rate limit exceeded');
      peer.dead = true;
      return;
    }
    let msg = null;
    try { msg = JSON.parse(payload.toString('utf8')); } catch (err) { return; }
    if (!msg || typeof msg !== 'object') return;

    // 首次收到消息时才确定房间（URL 没带 ?room= 的情况）
    if (!peer.room) {
      const r = room || validRoom(msg.room) || 'default';
      join(r);
      if (!room) room = r;
    }

    // 快照：客户端 saveSoon 时推的 sync，或成员互答的 state
    if (msg.t === 'sync' || msg.t === 'state') {
      const d = msg.doc || {};
      const cnt = k => Object.keys(d[k] || {}).length;
      console.log('[msg] ' + msg.t + ' room=' + peer.room +
        ' 便签=' + cnt('notes') +
        ' 笔画=' + cnt('strokes') +
        ' 图片=' + cnt('images') +
        ' 连线=' + cnt('edges') +
        ' 图框=' + cnt('frames') +
        ' 图形=' + cnt('shapes') +
        ' 文本=' + cnt('texts') +
        ' 评论=' + cnt('comments'));
      if (msg.doc) keepSnap(peer.room, msg.doc);
    }

    // 转发给同房间的其他人（不回发给自己）
    const out = JSON.stringify(msg);
    for (const other of roomOf(peer.room)) {
      if (other === peer || other.dead) continue;
      send(other.sock, out);
    }
  });

  sock.on('data', parse);
  sock.on('error', () => { peer.dead = true; });
  sock.on('close', () => {
    peer.dead = true;
    conns = Math.max(0, conns - 1);
    if (peer.room && rooms.has(peer.room)) {
      const set = rooms.get(peer.room);
      set.delete(peer);
      console.log('[left] ' + peer.room + ' (在线 ' + set.size + ')');
      if (!set.size) rooms.delete(peer.room);
    }
  });

  // URL 已带房间则立即加入，这样新成员能马上拿到历史
  if (room) join(room);
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = lanIPs();
  console.log('');
  console.log('  白板服务器已启动，别关这个黑窗口。');
  console.log('');
  console.log('  自己用:   http://localhost:' + PORT);
  ips.forEach(ip => console.log('  同一 Wi-Fi 的同事/手机用: http://' + ip + ':' + PORT));
  if (!ips.length) console.log('  （没查到局域网 IP，请检查网络连接）');
  console.log('');
  console.log('  房间内容保存在: ' + (SAVE ? DIR : '（已关闭落盘）'));
  console.log('  页面文件: ' + PAGE);
  console.log('');
  console.log('  访问口令: ' + (TOKEN ? '已启用（网址需带 ?token=…）' : '未设置（--token 或 RELAY_TOKEN 可开启）'));
  console.log('  连接上限: ' + MAX_CONNS + ' · 单连接限流: ' + RL_MSG + ' 条/秒');
  console.log('  提示: 想要各自独立的白板，网址后面加 #room=房间名');
});
