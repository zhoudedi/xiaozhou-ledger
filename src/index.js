import { ensureSchema, isDbReady, isNoSchemaError } from './db/schema.js';
import { ensureDemoData, ensureDemoApiKey, setDemoHasher } from './demo.js';

/**
 * 人情录 Web 版后端 —— Cloudflare Worker + D1
 *
 * 身份模型（跨设备一致）：
 *  - 手机号账号：X-Ledger-Phone 头（可选 X-Ledger-Pin），数据按手机号隔离；
 *  - 小程序/第三方客户端：X-Api-Key / X-Token / Bearer（account_keys 或遗留 device_settings）；
 *  - 游客：仅 X-Ledger-Token（localStorage 匿名设备），数据归属 dev:<token>，
 *    注册手机号后可一键并入账号（importDevice）。
 */

const EVENT_TYPES = new Set([
  'wedding',
  'baby',
  'birthday',
  'housewarming',
  'graduation',
  'funeral',
  'other',
]);

const EVENT_LABELS = {
  wedding: '婚礼',
  baby: '满月',
  birthday: '生日',
  housewarming: '乔迁',
  graduation: '升学',
  funeral: '白事',
  other: '其他',
};

const METHOD_LABELS = {
  cash: '现金',
  wechat: '微信',
  alipay: '支付宝',
  other: '其他',
};

const RELATIONS = new Set(['朋友', '亲戚', '同事', '同学', '邻居', '其他']);
const METHODS = new Set(['cash', 'wechat', 'alipay', 'other']);

/* 演示账号保护：部署后自动生成的体验账号（18000000000）供所有人查看效果。
 * 允许增删改账本数据（活动/礼金），但禁止修改账号身份信息（手机号/密码/昵称）、
 * 禁止改接口密钥与端口，防止被人占用后其他人无法登录体验。 */
const DEMO_PHONE = '18000000000';
function isDemoPhone(phone) {
  return String(phone || '') === DEMO_PHONE;
}
const DEMO_LOCKED_MSG = '演示账号为公开体验账号，不允许修改账号信息与接口密钥（账本记录可正常增删改）';

/* 跨域策略：默认反射请求方 Origin。
 * 本 API 的认证全部基于自定义请求头/令牌（X-Ledger-Phone/Pin、X-Api-Key、X-Ledger-Token），
 * 不使用 Cookie 会话，反射 Origin 不会扩大跨站写入面——写操作仍需调用方自己的凭据。
 * 这样任何部署者把本仓库部署到自有 Cloudflare + D1 时无需改代码即可跨域调用。
 * 部署方若希望收紧，可把下方 corsHeaders 改回固定白名单并填入自有域名。 */

function corsHeaders(origin) {
  const headers = {
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type,X-Ledger-Token,X-Ledger-Phone,X-Ledger-Pin,X-Api-Key,X-Token,Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

function jsonRes(data, status = 200, origin = null) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...corsHeaders(origin),
    },
  });
}

function fail(message, status = 400, origin = null) {
  return jsonRes({ error: message }, status, origin);
}

function nowIso() {
  return new Date().toISOString();
}

/* 业务日期按东八区（+08:00）计算：凌晨 0-8 点 UTC 仍是中国的"今天"，
 * 直接用 UTC 会让 AI 解析默认日期、年度统计的"今年"差一天/差一年。 */
const CN_TZ_OFFSET_MIN = 8 * 60;

function cnDate() {
  return new Date(Date.now() + CN_TZ_OFFSET_MIN * 60000).toISOString();
}

function todayStr() {
  return cnDate().slice(0, 10);
}

function thisYear() {
  return cnDate().slice(0, 4);
}

function asString(value, max = 500) {
  if (value === null || value === undefined) return '';
  return String(value).slice(0, max);
}

function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 全栈操作审计日志（logs 表）                                          */
/*                                                                    */
/* 在请求边界统一记录：所有 /api 请求（普通用户 + 管理员）的方法、路径、   */
/* 身份、结果码。best-effort：日志写失败不影响主流程（吞掉异常）。          */
/* 分类规则：写类操作（注册/登录/数据增删改/配置/备份）记细类，读类记 read。   */
/* ------------------------------------------------------------------ */

/** 由方法+路径推断动作细类（用于日志归类；无法判定时回退到 method）。 */
function classifyAction(method, path) {
  const p = path.replace(/^\/api\//, '');
  // 写类细粒度动作
  if (method === 'POST') {
    if (p.startsWith('account/register')) return 'register';
    if (p.startsWith('account/login')) return 'login';
    if (p.startsWith('account/profile')) return 'profile.update';
    if (p.startsWith('account/password')) return 'password.change';
    if (p.startsWith('account/phone')) return 'phone.change';
    if (p.startsWith('account/device')) return 'device.unbind';
    if (p.startsWith('events')) return 'event.create';
    if (p.startsWith('gifts')) return 'gift.create';
    if (p.startsWith('ai/config')) return 'ai.config.save';
    if (p.startsWith('ai/parse')) return 'ai.parse';
    if (p.startsWith('apikey/rotate')) return 'apikey.rotate';
    if (p.startsWith('apikey/port')) return 'apikey.port';
    if (p.startsWith('feedback')) return 'feedback';
    if (p.startsWith('import/backup')) return 'backup.import';
    if (p.startsWith('admin/user/create')) return 'admin.user.create';
    if (p.startsWith('admin/user/update')) return 'admin.user.update';
    if (p.startsWith('admin/user/delete')) return 'admin.user.delete';
    if (p.startsWith('admin/import-all')) return 'admin.import-all';
    if (p.startsWith('admin/export-all')) return 'admin.export-all';
    if (p.startsWith('admin/login')) return 'admin.login';
    if (p.startsWith('admin/reset-password')) return 'admin.reset-password';
    if (p.startsWith('admin/purge-account')) return 'admin.purge-account';
    if (p.startsWith('admin/account')) return 'admin.account';
    if (p.startsWith('admin/feedback')) return 'admin.feedback';
    if (p.startsWith('admin/settings')) return 'admin.settings';
    if (p.startsWith('admin/logs')) return 'admin.logs';
    return 'write';
  }
  if (method === 'PUT') {
    if (p.startsWith('gifts')) return 'gift.update';
    if (p.startsWith('events')) return 'event.update';
    return 'update';
  }
  if (method === 'DELETE') {
    if (p.startsWith('gifts')) return 'gift.delete';
    if (p.startsWith('events')) return 'event.delete';
    if (p.startsWith('account/device')) return 'device.unbind';
    return 'delete';
  }
  // GET / 其余：读
  if (p.startsWith('health')) return 'health';
  if (p.startsWith('admin')) return 'admin.read';
  return 'read';
}

/** 提取日志里的"操作人"：优先手机号/账号，否则 admin / 游客设备。 */
function actorOf(identity, isAdmin) {
  if (isAdmin) return 'admin';
  if (identity && identity.account) {
    // user:<phone> / phone:<phone> / dev:<deviceId>
    if (identity.account.startsWith('dev:')) return identity.account;
    const phone = accountPhone(identity.account);
    return phone ? `user:${phone}` : identity.account;
  }
  return 'anonymous';
}

/** 取请求来源 IP（优先 CF 头，回退通用头，取不到记 '-'）。 */
function clientIp(request) {
  const cf = (request.headers.get('CF-Connecting-IP') || '').trim();
  if (cf) return cf;
  const fwd = request.headers.get('X-Forwarded-For') || '';
  if (fwd) return fwd.split(',')[0].trim();
  const real = (request.headers.get('X-Real-IP') || '').trim();
  return real || '-';
}

/** 取客户端 User-Agent（截断，用于区分人/脚本与事故取证）。 */
function uaOf(request) {
  return asString((request.headers.get('User-Agent') || '').trim(), 80);
}

/**
 * 审计日志降级矩阵：返回 true 表示「跳过不记」。
 *  - 失败请求（status>=400，含 401/403/404/429/5xx，撞库/越权信号）：全记（管理员鉴权失败也记）
 *  - 写类操作（POST/PUT/DELETE，状态变更）：全记
 *  - 纯只读 GET（含 health/session/check/overview/列表/CSV/配置查询、**管理员翻日志页/查列表**等）：
 *    跳过（砍写放大，给真实业务写留配额余量；高频只读刷页面不产生审计价值）
 *  说明：管理员的"翻日志页/查用户列表"这类只读 GET 也跳过，避免每次操作都堆一堆
 *  `GET /api/admin/logs`；管理员的写操作与失败仍会记录，审计不受影响。
 */
function shouldSkipRecord(entry) {
  const m = entry.method || '';
  // 失败请求（含 401/403/404/429/5xx）：全记
  if ((Number(entry.status) || 0) >= 400) return false;
  // 写类操作（非 GET）：全记
  if (m && m !== 'GET') return false;
  // 纯只读 GET（管理员 / 普通用户一致）：跳过
  return true;
}

/** 写一条审计日志（best-effort：任何异常都吞掉，绝不影响主流程；按降级矩阵决定记不记）。 */
async function recordLog(env, entry, request) {
  try {
    if (!env.DB) return;
    if (shouldSkipRecord(entry)) return;
    await env.DB.prepare(
      `INSERT INTO logs (ts, actor, action, target, method, path, status, ok, ip, ua, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      nowIso(),
      entry.actor || '',
      entry.action || '',
      entry.target || '',
      entry.method || '',
      entry.path || '',
      Number(entry.status) || 0,
      entry.ok ? 1 : 0,
      entry.ip || '',
      entry.ua || (request ? uaOf(request) : ''),
      asString(entry.detail || '', 500)
    ).run();
  } catch {
    /* logs 表不存在等情形：跳过，不影响业务 */
  }
}

function getDeviceId(request) {
  const token = (request.headers.get('X-Ledger-Token') || '').trim();
  return /^[A-Za-z0-9_-]{16,64}$/.test(token) ? token : null;
}

function getApiKeyHeader(request) {
  const direct = (request.headers.get('X-Api-Key') || request.headers.get('X-Token') || '').trim();
  if (direct) return direct;
  const auth = (request.headers.get('Authorization') || '').trim();
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m ? m[1].trim() : '';
}

function maskPhone(phone) {
  if (!phone || phone.length < 7) return phone || '';
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

/** D1/SQLite 唯一约束冲突（用于并发竞态兜底：SELECT-then-INSERT 窗口内撞唯一索引）。 */
function isUniqueError(e) {
  return Boolean(e && /unique constraint failed/i.test(String(e.message || '')));
}

/* ------------------------------------------------------------------ */
/* PIN 哈希                                                            */
/* ------------------------------------------------------------------ */

async function hmacSha256Hex(keyText, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(keyText),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 迭代 HMAC 派生 PIN 哈希（盐 + 1000 轮）。 */
async function hashPin(pin, salt) {
  let h = await hmacSha256Hex(pin, `${salt}:init`);
  for (let i = 0; i < 1000; i++) {
    h = await hmacSha256Hex(pin, `${salt}:${i}`);
  }
  return h;
}

/* ------------------------------------------------------------------ */
/* 密码哈希 / JWT（Web 账号体系：手机号 + 密码）                        */
/* ------------------------------------------------------------------ */

/** 密码哈希：盐 + 迭代 HMAC（与 PIN 同一套原语，2000 轮）。 */
async function hashPassword(password, salt) {
  let h = await hmacSha256Hex(password, `${salt}:init`);
  for (let i = 0; i < 2000; i++) {
    h = await hmacSha256Hex(password, `${salt}:${i}`);
  }
  return h;
}

// 演示数据模块复用同一套密码哈希，避免重复实现
setDemoHasher(hashPassword);

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlJson(obj) {
  return b64url(new TextEncoder().encode(JSON.stringify(obj)));
}

async function jwtSign(payload, secret) {
  const enc = b64urlJson({ alg: 'HS256', typ: 'JWT' });
  const head = `${enc}.${b64urlJson(payload)}`;
  const sig = b64url(
    new Uint8Array(await hmacSha256Raw(secret, head))
  );
  return `${head}.${sig}`;
}

async function jwtVerify(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const expected = b64url(new Uint8Array(await hmacSha256Raw(secret, `${parts[0]}.${parts[1]}`)));
  if (expected !== parts[2]) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(
      Uint8Array.from(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
    ));
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp === 'number' && payload.exp < now) return null;
    return payload;
  } catch {
    return null;
  }
}

async function hmacSha256Raw(keyText, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(keyText),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
}

/** 取 Worker 的 JWT 密钥：Secret JWT_SECRET 优先，未设置时回退到内置默认值（部署者可在控制台设置自己的）。 */
let jwtSecretWarned = false;
function jwtSecret(env) {
  if (env.JWT_SECRET) return env.JWT_SECRET;
  if (!jwtSecretWarned) {
    jwtSecretWarned = true;
    console.warn(
      '[security] JWT_SECRET 未设置，正在使用内置默认密钥，公网部署存在 token 伪造风险；请执行 wrangler secret put JWT_SECRET'
    );
  }
  return 'xiaozhou-ledger-web-default-jwt-secret';
}

const JWT_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 天


/* ------------------------------------------------------------------ */
/* 身份解析                                                            */
/* ------------------------------------------------------------------ */

async function resolveIdentity(request, env) {
  const deviceId = getDeviceId(request);

  let account = null;
  let viaKey = false;

  // ① Web 账号 JWT（Authorization: Bearer 或 X-Ledger-Auth）：校验签名与有效期
  const authHeader = (request.headers.get('Authorization') || '').trim();
  const bearer = /^Bearer\s+(.+)$/i.exec(authHeader);
  const jwt = (bearer ? bearer[1] : (request.headers.get('X-Ledger-Auth') || '').trim());
  if (jwt) {
    const payload = await jwtVerify(jwt, jwtSecret(env));
    if (payload && validPhone(payload.phone)) {
      return {
        deviceId,
        phone: payload.phone,
        name: payload.name || null,
        account: `user:${payload.phone}`,
        viaKey: false,
        isPhone: true,
        viaJwt: true,
      };
    }
    // JWT 无效：若是 Bearer 携带，再给它一次机会按旧接口密钥处理；都不行则拒绝（不降级游客）
    if (bearer) {
      account = await legacyKeyAccount(request, env, bearer[1]);
      if (account) viaKey = true;
    }
    if (!account) {
      return { deviceId, phone: null, account: null, viaKey: false, isPhone: false, jwtInvalid: true };
    }
  }

  // ② 旧 PIN 体系（X-Ledger-Phone + PIN）：遗留数据兼容，数据存 phone:<phone>
  const phoneRaw = (request.headers.get('X-Ledger-Phone') || '').trim();
  const phone = /^\d{5,20}$/.test(phoneRaw) ? phoneRaw : null;
  if (!account && phone) {
    const exists = await env.DB.prepare('SELECT 1 AS x FROM accounts WHERE phone = ?')
      .bind(phone)
      .first();
    account = exists ? `phone:${phone}` : null;
  }

  // ③ 小程序/客户端接口密钥（X-Api-Key / X-Token）
  if (!account) {
    const apiKey = getApiKeyHeader(request);
    if (apiKey) {
      account = await legacyKeyAccount(request, env, apiKey);
      if (account) viaKey = true;
    }
  }

  // ④ 游客设备：dev:<deviceId>
  if (!account && deviceId) {
    account = `dev:${deviceId}`;
  }

  return {
    deviceId,
    phone: accountPhone(account) || phone,
    account,
    viaKey,
    isPhone: Boolean(account && account.startsWith('user:')),
  };
}

/** 旧接口密钥 → 账号（user:<phone> / dev:<deviceId>）；无效返回 null。 */
async function legacyKeyAccount(request, env, apiKey) {
  const row1 = await env.DB.prepare('SELECT phone FROM account_keys WHERE key = ?')
    .bind(apiKey)
    .first();
  if (row1) return `user:${row1.phone}`;
  const row2 = await env.DB.prepare('SELECT device_id FROM device_settings WHERE api_key = ?')
    .bind(apiKey)
    .first();
  if (row2 && row2.device_id) {
    const b = await env.DB.prepare('SELECT phone FROM device_bindings WHERE device_id = ?')
      .bind(row2.device_id)
      .first();
    return b ? `user:${b.phone}` : `dev:${row2.device_id}`;
  }
  return null;
}

async function ensureIdentity(env, identity) {
  const { deviceId, account } = identity;
  if (account && (account.startsWith('user:') || account.startsWith('phone:'))) {
    await env.DB.prepare('INSERT OR IGNORE INTO account_settings (account) VALUES (?)')
      .bind(account)
      .run();
  } else if (account && account.startsWith('dev:') && deviceId) {
    await env.DB.prepare('INSERT OR IGNORE INTO devices (id, created_at) VALUES (?, ?)')
      .bind(deviceId, nowIso())
      .run();
    await env.DB.prepare('INSERT OR IGNORE INTO device_settings (device_id) VALUES (?)')
      .bind(deviceId)
      .run();
  }
}

/** 数据作用域：按 account 查；游客账号为 dev:<deviceId>。 */
function accOf(identity) {
  return identity.account;
}

/** 账号手机号：user:<phone>（新体系）或 phone:<phone>（旧 PIN 体系遗留数据）。 */
function accountPhone(account) {
  if (!account) return null;
  // 注意前缀长度：'user:' 为 5，'phone:' 为 6，必须分别取值，
  // 否则 user: 账号的手机号会被截断首位（历史 P0 缺陷）。
  if (account.startsWith('user:')) return account.slice(5);
  if (account.startsWith('phone:')) return account.slice(6);
  return null;
}

/** 游客设备号：dev:<deviceId>。 */
function accountDevice(account) {
  if (account && account.startsWith('dev:')) return account.slice(4);
  return null;
}

/* ------------------------------------------------------------------ */
/* 账号：注册 / 登录（手机号 + 密码，JWT）/ 管理员操作                  */
/* ------------------------------------------------------------------ */

function validPhone(phone) {
  return /^\d{5,20}$/.test(phone);
}

// 登录防爆破（内存级，Worker 实例内有效；重启即清空，属临时缓解而非持久化封禁）：
// 同一手机号 10 分钟失败 20 次 → 封禁 5 分钟。
const loginFailures = new Map(); // phone -> { n, first, blockedUntil }
const LOGIN_MAX_FAILS = 20;
const LOGIN_FAIL_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_BLOCK_MS = 5 * 60 * 1000;

function loginLocked(phone) {
  const rec = loginFailures.get(phone);
  if (!rec) return false;
  const now = Date.now();
  if (rec.blockedUntil && now < rec.blockedUntil) return true;
  if (now - rec.first > LOGIN_FAIL_WINDOW_MS) {
    loginFailures.delete(phone);
    return false;
  }
  return false;
}

function recordLoginFail(phone) {
  const now = Date.now();
  let rec = loginFailures.get(phone);
  if (!rec || now - rec.first > LOGIN_FAIL_WINDOW_MS) {
    rec = { n: 0, first: now, blockedUntil: 0 };
  }
  rec.n += 1;
  if (rec.n >= LOGIN_MAX_FAILS) rec.blockedUntil = now + LOGIN_BLOCK_MS;
  loginFailures.set(phone, rec);
  if (loginFailures.size > 500) {
    const oldest = [...loginFailures.entries()].sort((a, b) => a[1].first - b[1].first)[0];
    if (oldest) loginFailures.delete(oldest[0]);
  }
}

function clearLoginFails(phone) {
  loginFailures.delete(phone);
}

function validPassword(password) {
  return typeof password === 'string' && password.length >= 8 && password.length <= 32;
}

/** 旧 PIN 体系校验（仅用于 phone: 遗留账号访问；新体系用 JWT）。 */
async function verifyPin(env, phone, pin) {
  if (!pin) return false;
  const acc = await env.DB.prepare('SELECT pin_hash FROM accounts WHERE phone = ?')
    .bind(phone)
    .first();
  if (!acc) return false;
  const [salt, hash] = String(acc.pin_hash).split('|');
  const computed = await hashPin(pin, salt);
  return computed === hash;
}

// 把「某手机号名下」的全部数据并入目标账号（游客 / 旧 PIN 账号 / 新用户）
async function importAccountData(env, fromAccounts, toAccount) {
  let importedEvents = 0;
  let importedGifts = 0;
  for (const from of fromAccounts) {
    const e = await env.DB.prepare('UPDATE events SET account = ? WHERE account = ?')
      .bind(toAccount, from)
      .run();
    const g = await env.DB.prepare('UPDATE gifts SET account = ? WHERE account = ?')
      .bind(toAccount, from)
      .run();
    importedEvents += (e.meta && e.meta.changes) || 0;
    importedGifts += (g.meta && g.meta.changes) || 0;
  }
  return { importedEvents, importedGifts };
}

async function handleAccountRegister(request, env, identity, origin) {
  const body = await readJson(request);
  if (!body) return fail('请求内容格式错误', 400, origin);
  const phone = asString(body.phone, 20).trim();
  const name = asString(body.name, 32).trim() || '账本用户';
  const password = asString(body.password, 64);
  if (!validPhone(phone)) return fail('请输入正确的手机号', 400, origin);
  if (!validPassword(password)) return fail('密码需为 8-32 位', 400, origin);

  // 部署者限制（Cloudflare 控制台 Variables 配置，未设置 = 不限制）：
  //  - MAX_ACCOUNTS：本实例可注册账号总数上限，保护免费配额不被刷满；
  //  - REGISTER_COOLDOWN_MINUTES：同一设备两次注册的最小间隔（分钟）。
  const cooldownMin = Number.parseInt(asString(env.REGISTER_COOLDOWN_MINUTES, 10), 10);
  if (Number.isFinite(cooldownMin) && cooldownMin > 0 && identity.deviceId) {
    let last = null;
    try {
      last = await env.DB.prepare('SELECT created_at FROM register_log WHERE device_id = ?')
        .bind(identity.deviceId)
        .first();
    } catch {
      last = null; // register_log 表未建（极旧库）时跳过冷却检查，自愈会补建
    }
    if (last && last.created_at) {
      const elapsedMin = (Date.now() - Date.parse(last.created_at)) / 60000;
      const remainMin = Math.ceil(cooldownMin - elapsedMin);
      if (remainMin > 0) {
        return fail(`本设备注册过于频繁，请 ${remainMin} 分钟后再试`, 429, origin);
      }
    }
  }

  const maxAccounts = Number.parseInt(asString(env.MAX_ACCOUNTS, 10), 10);
  if (Number.isFinite(maxAccounts) && maxAccounts > 0) {
    const countRow = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
    const used = (countRow && Number(countRow.n)) || 0;
    if (used >= maxAccounts) {
      return fail(`本实例注册名额已满（${used}/${maxAccounts}），请联系管理员或部署自己的实例`, 403, origin);
    }
  }

  const userAccount = `user:${phone}`;
  const exists = await env.DB.prepare('SELECT 1 AS x FROM users WHERE phone = ?')
    .bind(phone)
    .first();
  if (exists) return fail('该手机号已注册，请直接登录', 409, origin);

  const salt = crypto.randomUUID();
  const passwordHash = `${salt}|${await hashPassword(password, salt)}`;
  try {
    await env.DB.prepare('INSERT INTO users (phone, name, password_hash, created_at) VALUES (?, ?, ?, ?)')
      .bind(phone, name, passwordHash, nowIso())
      .run();
  } catch (e) {
    // 并发竞态：两个请求同时通过"该手机号已注册"检查，撞 users 主键。
    if (isUniqueError(e)) return fail('该手机号已注册，请直接登录', 409, origin);
    throw e;
  }
  await env.DB.prepare('INSERT OR IGNORE INTO account_settings (account) VALUES (?)')
    .bind(userAccount)
    .run();
  // 记录本次注册（供 REGISTER_COOLDOWN_MINUTES 冷却判断；表缺失/失败不影响注册主流程）
  if (identity.deviceId) {
    try {
      await env.DB.prepare(
        `INSERT INTO register_log (device_id, created_at) VALUES (?, ?)
         ON CONFLICT(device_id) DO UPDATE SET created_at = excluded.created_at`
      )
        .bind(identity.deviceId, nowIso())
        .run();
    } catch {
      /* register_log 表未建（极旧库）时忽略，运行期自愈会补建 */
    }
  }

  // 首次注册：把 ① 本浏览器游客数据 ② 旧 PIN 账号（accounts 表）数据 并入新账号
  let importedEvents = 0;
  let importedGifts = 0;
  if (body.importDevice !== false) {
    const froms = [
      identity.deviceId ? `dev:${identity.deviceId}` : null,
      `phone:${phone}`,
    ].filter(Boolean);
    ({ importedEvents, importedGifts } = await importAccountData(env, froms, userAccount));
  }

  // 遗留设备接口密钥并入账号密钥
  if (identity.deviceId) {
    const legacy = await env.DB.prepare('SELECT api_key, api_port FROM device_settings WHERE device_id = ?')
      .bind(identity.deviceId)
      .first();
    if (legacy && legacy.api_key) {
      await env.DB.prepare('DELETE FROM account_keys WHERE phone = ?').bind(phone).run();
      await env.DB.prepare('INSERT INTO account_keys (key, phone, port, created_at) VALUES (?, ?, ?, ?)')
        .bind(legacy.api_key, phone, legacy.api_port || 0, nowIso())
        .run();
      await env.DB.prepare('UPDATE device_settings SET api_key = ?, api_key_hash = ? WHERE device_id = ?')
        .bind('', '', identity.deviceId)
        .run();
    }
  }

  // 旧 PIN 账号（accounts 表）数据已并入，停用旧体系：删除 PIN 账号与其设备绑定，
  // 之后该手机号只能走新体系（user: 账号 + JWT）。
  // 注意：仅在"并入数据"时才停用旧 PIN 账号——用户选了 importDevice:false（明确不并入）
  // 时保留 phone: 数据的可访问性，否则数据会变成谁也访问不到的孤儿。
  if (body.importDevice !== false) {
    await env.DB.prepare('DELETE FROM device_bindings WHERE phone = ?').bind(phone).run();
    await env.DB.prepare('DELETE FROM accounts WHERE phone = ?').bind(phone).run();
  }

  const now = Math.floor(Date.now() / 1000);
  const token = await jwtSign(
    { phone, name, iat: now, exp: now + JWT_TTL_SECONDS },
    jwtSecret(env)
  );
  return jsonRes(
    {
      phone,
      name,
      registered: true,
      token,
      importedEvents,
      importedGifts,
      hint:
        importedEvents + importedGifts > 0
          ? '已有数据已并入账号'
          : '注册成功，7 天内无需重复登录',
    },
    200,
    origin
  );
}

async function handleAccountLogin(request, env, origin) {
  const body = await readJson(request);
  if (!body) return fail('请求内容格式错误', 400, origin);
  const phone = asString(body.phone, 20).trim();
  const password = asString(body.password, 64);
  if (!validPhone(phone)) return fail('请输入正确的手机号', 400, origin);

  if (loginLocked(phone)) {
    return fail('尝试过于频繁，请 5 分钟后再试或联系管理员重置密码', 429, origin);
  }

  const user = await env.DB.prepare('SELECT * FROM users WHERE phone = ?')
    .bind(phone)
    .first();
  if (!user) {
    recordLoginFail(phone);
    return fail('该手机号未注册，请切换到注册', 404, origin);
  }

  const [salt, stored] = String(user.password_hash).split('|');
  const computed = await hashPassword(password, salt);
  if (computed !== stored) {
    recordLoginFail(phone);
    return fail('手机号或密码不正确', 403, origin);
  }
  clearLoginFails(phone);

  const now = Math.floor(Date.now() / 1000);
  const token = await jwtSign(
    { phone, name: user.name, iat: now, exp: now + JWT_TTL_SECONDS },
    jwtSecret(env)
  );
  return jsonRes({ phone, name: user.name, loggedIn: true, token }, 200, origin);
}

async function handleAccountCheck(request, env, origin) {
  const url = new URL(request.url);
  const phone = url.searchParams.get('phone') || '';
  if (!validPhone(phone)) return fail('请输入手机号', 400, origin);
  const user = await env.DB.prepare('SELECT 1 AS x FROM users WHERE phone = ?')
    .bind(phone)
    .first();
  return jsonRes({ phone, registered: Boolean(user) }, 200, origin);
}

// 忘记 PIN：管理员重置（部署者在 Cloudflare 控制台设置 ADMIN_KEY 密钥）
async function handleAdminResetPassword(request, env, origin) {
  const body = await readJson(request);
  if (!body) return fail('请求内容格式错误', 400, origin);
  const adminKey = (request.headers.get('X-Admin-Key') || '').trim();
  if (!env.ADMIN_KEY || adminKey !== env.ADMIN_KEY) {
    return fail('管理员密钥无效', 403, origin);
  }
  const phone = asString(body.phone, 20).trim();
  const newPassword = asString(body.password, 64);
  if (!validPhone(phone)) return fail('请输入正确的手机号', 400, origin);
  // 注：这是 ADMIN_KEY 管理员接口，允许管理演示账号（供后续更新演示数据用）；
  //     限制只针对用户用 demo 密码登录后的自助修改，见 handlePasswordChange 等。
  if (!validPassword(newPassword)) return fail('密码需为 8-32 位', 400, origin);
  const user = await env.DB.prepare('SELECT 1 AS x FROM users WHERE phone = ?')
    .bind(phone)
    .first();
  if (!user) return fail('该手机号未注册', 404, origin);
  const salt = crypto.randomUUID();
  const passwordHash = `${salt}|${await hashPassword(newPassword, salt)}`;
  await env.DB.prepare('UPDATE users SET password_hash = ? WHERE phone = ?')
    .bind(passwordHash, phone)
    .run();
  return jsonRes({ phone, reset: true }, 200, origin);
}

/** 删除某手机号名下的全部账号数据（user: 新体系 + phone: 旧 PIN 体系）。
 *  供命令行清账号与管理后台删用户共用，避免两处逻辑漂移。 */
async function purgeAccountData(env, phone) {
  for (const account of [`user:${phone}`, `phone:${phone}`]) {
    await env.DB.prepare('DELETE FROM events WHERE account = ?').bind(account).run();
    await env.DB.prepare('DELETE FROM gifts WHERE account = ?').bind(account).run();
    await env.DB.prepare('DELETE FROM account_settings WHERE account = ?').bind(account).run();
  }
  await env.DB.batch([
    env.DB.prepare('DELETE FROM account_keys WHERE phone = ?').bind(phone),
    env.DB.prepare('DELETE FROM device_bindings WHERE phone = ?').bind(phone),
    env.DB.prepare('DELETE FROM users WHERE phone = ?').bind(phone),
    env.DB.prepare('DELETE FROM accounts WHERE phone = ?').bind(phone),
  ]);
}

// 清空账号：删除用户及名下全部数据（命令行接口）
async function handleAdminPurge(request, env, origin) {
  const body = await readJson(request);
  if (!body) return fail('请求内容格式错误', 400, origin);
  const adminKey = (request.headers.get('X-Admin-Key') || '').trim();
  if (!env.ADMIN_KEY || adminKey !== env.ADMIN_KEY) {
    return fail('管理员密钥无效', 403, origin);
  }
  const phone = asString(body.phone, 20).trim();
  if (!validPhone(phone)) return fail('请输入正确的手机号', 400, origin);
  await purgeAccountData(env, phone);
  return jsonRes({ phone, purged: true }, 200, origin);
}

/* ------------------------------------------------------------------ */
/* 管理后台：ADMIN_KEY 登录 + 用户管理 + 全站备份还原                     */
/*                                                                    */
/* 管理员凭证来自 Cloudflare Secret：ADMIN_KEY（与命令行接口同一个）。     */
/* 登录页输入该 key → 签发 role:'admin' 的 JWT（12 小时），               */
/* 后续请求头 X-Admin-Token 携带，无需再记第二套账号密码。                */
/* ------------------------------------------------------------------ */

const ADMIN_TOKEN_TTL = 12 * 60 * 60; // 管理会话 12 小时

function adminConfigured(env) {
  return Boolean(env.ADMIN_KEY);
}

/** 校验 X-Admin-Token：必须是本服务签发、未过期、role='admin' 的 JWT。 */
async function verifyAdminToken(request, env) {
  const token = (request.headers.get('X-Admin-Token') || '').trim();
  if (!token) return false;
  const payload = await jwtVerify(token, jwtSecret(env));
  return Boolean(payload && payload.role === 'admin');
}

/** 管理员登录：校验 ADMIN_KEY（与命令行接口同一把密钥），签发 admin JWT。 */
async function handleAdminLogin(request, env, origin) {
  if (!adminConfigured(env)) {
    return fail('管理后台未启用：请先在 Cloudflare 配置 ADMIN_KEY 密钥', 503, origin);
  }
  const body = await readJson(request);
  if (!body) return fail('请求内容格式错误', 400, origin);
  // 兼容两种字段名：adminKey（新）、X-Admin-Key 头（老脚本习惯）
  const supplied = (asString(body.adminKey, 256) || (request.headers.get('X-Admin-Key') || '').trim());
  if (supplied !== env.ADMIN_KEY) {
    return fail('管理员密钥不正确', 403, origin);
  }
  const now = Math.floor(Date.now() / 1000);
  const token = await jwtSign(
    { role: 'admin', iat: now, exp: now + ADMIN_TOKEN_TTL },
    jwtSecret(env)
  );
  return jsonRes({ token, expiresIn: ADMIN_TOKEN_TTL }, 200, origin);
}

/** 用户列表（分页 + 手机号/昵称搜索）：本页用户 + 每个账号的数据量统计 + 接口密钥状态。 */
async function handleAdminUsers(request, env, origin) {
  const url = new URL(request.url);
  let size = Number.parseInt(url.searchParams.get('size') || '10', 10);
  if (!Number.isFinite(size) || size < 1) size = 10;
  size = Math.min(size, 200);
  let page = Number.parseInt(url.searchParams.get('page') || '1', 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  const q = asString(url.searchParams.get('q'), 40).trim();
  const like = q ? ['%' + q + '%', '%' + q + '%'] : [];

  const countRes = await env.DB.prepare(
    q ? 'SELECT COUNT(*) AS n FROM users WHERE phone LIKE ? OR name LIKE ?'
      : 'SELECT COUNT(*) AS n FROM users'
  ).bind(...like).first();
  const total = (countRes && Number(countRes.n)) || 0;

  const off = (page - 1) * size;
  const { results } = await env.DB.prepare(
    q
      ? 'SELECT phone, name, created_at FROM users WHERE phone LIKE ? OR name LIKE ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
      : 'SELECT phone, name, created_at FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).bind(...like, size, off).all();
  const users = results || [];
  // 逐账号统计（仅本页，量级小，顺序查询足够；避免对全量用户做逐账号 COUNT）
  for (const u of users) {
    const account = `user:${u.phone}`;
    const [ev, gf, key] = await Promise.all([
      env.DB.prepare('SELECT COUNT(*) AS n FROM events WHERE account = ?').bind(account).first(),
      env.DB.prepare('SELECT COUNT(*) AS n FROM gifts WHERE account = ?').bind(account).first(),
      env.DB.prepare('SELECT 1 AS x FROM account_keys WHERE phone = ? LIMIT 1').bind(u.phone).first(),
    ]);
    u.eventCount = (ev && Number(ev.n)) || 0;
    u.giftCount = (gf && Number(gf.n)) || 0;
    u.hasApiKey = Boolean(key);
  }
  return jsonRes({ users, total, page, size }, 200, origin);
}

/** 管理员新增用户（手机号+密码+昵称）。 */
async function handleAdminUserCreate(request, env, origin) {
  const body = await readJson(request);
  if (!body) return fail('请求内容格式错误', 400, origin);
  const phone = asString(body.phone, 20).trim();
  const name = asString(body.name, 32).trim() || '账本用户';
  const password = asString(body.password, 64);
  if (!validPhone(phone)) return fail('请输入正确的手机号', 400, origin);
  if (!validPassword(password)) return fail('密码需为 8-32 位', 400, origin);
  if (await env.DB.prepare('SELECT 1 AS x FROM users WHERE phone = ?').bind(phone).first()) {
    return fail('该手机号已存在', 409, origin);
  }
  const salt = crypto.randomUUID();
  const hash = `${salt}|${await hashPassword(password, salt)}`;
  await env.DB.batch([
    env.DB.prepare('INSERT INTO users (phone, name, password_hash, created_at) VALUES (?, ?, ?, ?)')
      .bind(phone, name, hash, nowIso()),
    env.DB.prepare('INSERT OR IGNORE INTO account_settings (account) VALUES (?)').bind(`user:${phone}`),
  ]);
  return jsonRes({ phone, name, created: true }, 200, origin);
}

/** 管理员改用户信息：昵称 / 密码 / 手机号（均按传入字段可选；改手机号会原子迁移全部账号数据）。 */
async function handleAdminUserUpdate(request, env, origin) {
  const body = await readJson(request);
  if (!body) return fail('请求内容格式错误', 400, origin);
  const phone = asString(body.phone, 20).trim();
  if (!validPhone(phone)) return fail('请输入正确的手机号', 400, origin);
  const user = await env.DB.prepare('SELECT * FROM users WHERE phone = ?').bind(phone).first();
  if (!user) return fail('用户不存在', 404, origin);
  const name = body.name !== undefined ? (asString(body.name, 32).trim() || '账本用户') : user.name;
  let passwordHash = user.password_hash;
  if (body.password !== undefined && body.password !== '') {
    const password = asString(body.password, 64);
    if (!validPassword(password)) return fail('密码需为 8-32 位', 400, origin);
    const salt = crypto.randomUUID();
    passwordHash = `${salt}|${await hashPassword(password, salt)}`;
  }

  // 改手机号：校验新号 → 冲突检测 → 原子迁移全部账号数据
  const newPhone = asString(body.newPhone, 20).trim();
  if (newPhone) {
    if (!validPhone(newPhone)) return fail('请输入正确的新手机号', 400, origin);
    if (newPhone === phone) return fail('新手机号不能与当前手机号相同', 400, origin);
    const dup = await env.DB.prepare('SELECT 1 AS x FROM users WHERE phone = ?').bind(newPhone).first();
    if (dup) return fail('该手机号已被使用', 409, origin);
    const oldAccount = `user:${phone}`;
    const newAccount = `user:${newPhone}`;
    // 全部迁移在一个 batch 内原子执行：任一步失败则整体回滚，避免半迁移状态。
    await env.DB.batch([
      env.DB.prepare('INSERT INTO users (phone, name, password_hash, created_at) VALUES (?, ?, ?, ?)')
        .bind(newPhone, name, passwordHash, user.created_at),
      env.DB.prepare('DELETE FROM users WHERE phone = ?').bind(phone),
      env.DB.prepare('UPDATE events SET account = ? WHERE account = ?').bind(newAccount, oldAccount),
      env.DB.prepare('UPDATE gifts SET account = ? WHERE account = ?').bind(newAccount, oldAccount),
      env.DB.prepare(
        `INSERT OR REPLACE INTO account_settings (account, ai_base_url, ai_api_key, ai_model)
         SELECT ?, ai_base_url, ai_api_key, ai_model FROM account_settings WHERE account = ?`
      ).bind(newAccount, oldAccount),
      env.DB.prepare('DELETE FROM account_settings WHERE account = ?').bind(oldAccount),
      env.DB.prepare('UPDATE account_keys SET phone = ? WHERE phone = ?').bind(newPhone, phone),
      env.DB.prepare('UPDATE device_bindings SET phone = ? WHERE phone = ?').bind(newPhone, phone),
      env.DB.prepare('UPDATE feedback SET account = ? WHERE account = ?').bind(newAccount, oldAccount),
    ]);
    return jsonRes({ phone: newPhone, oldPhone: phone, name, changed: true }, 200, origin);
  }

  await env.DB.prepare('UPDATE users SET name = ?, password_hash = ? WHERE phone = ?')
    .bind(name, passwordHash, phone)
    .run();
  return jsonRes({ phone, name, updated: true }, 200, origin);
}

/** 管理员删除用户及其名下全部数据（管理后台接口）。 */
async function handleAdminUserDelete(request, env, origin) {
  const body = await readJson(request);
  if (!body) return fail('请求内容格式错误', 400, origin);
  const phone = asString(body.phone, 20).trim();
  if (!validPhone(phone)) return fail('请输入正确的手机号', 400, origin);
  await purgeAccountData(env, phone);
  return jsonRes({ phone, deleted: true }, 200, origin);
}

// 全站备份包含的全部表（顺序：先主体后配置；导入时同序）
const ADMIN_BACKUP_TABLES = [
  'users', 'accounts', 'device_bindings', 'account_keys',
  'devices', 'device_settings', 'events', 'gifts',
  'account_settings', 'feedback', 'register_log',
];

/** 全站导出：所有表所有行，明文 JSON。 */
async function handleAdminExportAll(env, origin) {
  const data = {};
  let totalRows = 0;
  for (const table of ADMIN_BACKUP_TABLES) {
    const { results } = await env.DB.prepare(`SELECT * FROM ${table}`).all();
    data[table] = results || [];
    totalRows += data[table].length;
  }
  const doc = {
    app: 'gift-ledger',
    kind: 'admin-full',
    version: 1,
    exportedAt: nowIso(),
    tables: ADMIN_BACKUP_TABLES,
    totalRows,
    data,
  };
  return new Response(JSON.stringify(doc, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="gift-ledger-site-backup-${todayStr()}.json"`,
      'Cache-Control': 'no-store',
      ...corsHeaders(origin),
    },
  });
}

/** 全站导入：按表清空后重建（可选 merge 模式则不清空）。明文 JSON。 */
async function handleAdminImportAll(request, env, origin) {
  let form;
  try { form = await request.formData(); } catch { return fail('请求格式错误', 400, origin); }
  const file = form.get('file');
  if (!file || typeof file === 'string') return fail('请选择备份文件', 400, origin);
  const merge = String(form.get('merge') || '') === '1';
  let doc;
  try { doc = JSON.parse(await file.text()); } catch { return fail('备份文件不是有效的 JSON', 400, origin); }
  if (!doc || doc.kind !== 'admin-full' || !doc.data || typeof doc.data !== 'object') {
    return fail('不是有效的管理后台全站备份文件', 400, origin);
  }

  const stats = {};
  try {
    // 逐表处理：清空（可选）后分批 INSERT OR REPLACE，单表每批 40 条控制语句数
    for (const table of ADMIN_BACKUP_TABLES) {
      const rows = Array.isArray(doc.data[table]) ? doc.data[table] : [];
      if (!merge) {
        await env.DB.prepare(`DELETE FROM ${table}`).run();
      }
      let inserted = 0;
      for (let i = 0; i < rows.length; i += 40) {
        const batch = [];
        for (const row of rows.slice(i, i + 40)) {
          if (!row || typeof row !== 'object') continue;
          // 列名只允许字母/数字/下划线，防止从上载文件注入 SQL
          const cols = Object.keys(row).filter((k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k));
          if (!cols.length) continue;
          const sql = `INSERT OR REPLACE INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
          batch.push(env.DB.prepare(sql).bind(...cols.map((k) => row[k] ?? null)));
        }
        if (batch.length) await env.DB.batch(batch);
        inserted += batch.length;
      }
      stats[table] = inserted;
    }
  } catch (e) {
    console.error('admin import failed', e && e.stack ? e.stack : e);
    return fail('导入失败：数据结构与当前版本不兼容或文件损坏', 500, origin);
  }
  return jsonRes({ ok: true, merge, stats }, 200, origin);
}

/* ------------------------------------------------------------------ */
/* 管理员：按账号管理（编辑任意用户的数据/配置 + 单账号导入导出）          */
/*                                                                    */
/* 全部复用普通用户那套 handler（传 account = user:<phone>），保证数据     */
/* 结构与普通端一致、无逻辑漂移。分页默认 20 条/页。                        */
/* ------------------------------------------------------------------ */

const ADMIN_PAGE_DEFAULT = 20;
const ADMIN_PAGE_MAX = 200;

/** 构造一个仅满足 readJson 的最小 request（供复用 handler）。 */
function fakeReq(body) {
  return { json: async () => body, url: 'http://local' };
}

/** 校验目标手机号并确认该账号存在；成功返回 {account, phone}，失败返回 {error: Response}。 */
async function adminTargetAccount(env, phone, origin) {
  const p = asString(phone, 20).trim();
  if (!validPhone(p)) return { error: fail('请输入正确的手机号', 400, origin) };
  const exists = await env.DB.prepare('SELECT 1 AS x FROM users WHERE phone = ?').bind(p).first();
  if (!exists) return { error: fail('该用户不存在', 404, origin) };
  return { account: 'user:' + p, phone: p };
}

/** 查看某账号数据。kind: gifts/events → 分页列表；settings/apikey/device → 配置对象。 */
async function handleAdminAccountData(request, env, origin) {
  const url = new URL(request.url);
  const target = await adminTargetAccount(env, url.searchParams.get('phone'), origin);
  if (target.error) return target.error;
  const kind = url.searchParams.get('kind') || 'gifts';
  let page = Number.parseInt(url.searchParams.get('page') || '1', 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  let size = Number.parseInt(url.searchParams.get('size') || String(ADMIN_PAGE_DEFAULT), 10);
  if (!Number.isFinite(size) || size < 1) size = ADMIN_PAGE_DEFAULT;
  size = Math.min(size, ADMIN_PAGE_MAX);
  const acc = target.account;

  if (kind === 'settings' || kind === 'apikey' || kind === 'device') {
    const aiRow = await env.DB
      .prepare('SELECT ai_base_url, ai_api_key, ai_model FROM account_settings WHERE account = ?')
      .bind(acc).first();
    // 小程序接口密钥：一个密钥 = 一个能连进来的小程序客户端。取全部（最多 50 条）以反映绑定数量；
    // apikey 字段仍给"最新一条"以兼容「配置/密钥」tab 的单密钥编辑 UI。
    const keysRes = await env.DB
      .prepare('SELECT key, port, created_at FROM account_keys WHERE phone = ? ORDER BY created_at DESC LIMIT 50')
      .bind(target.phone).all();
    const allKeys = (keysRes.results || []).map((k) => ({ key: k.key, apiPort: k.port, createdAt: k.created_at }));
    // 密钥总数（不受上面 50 条展示上限影响，用于「绑了几个小程序」的准确计数）
    const keyCountRes = await env.DB
      .prepare('SELECT COUNT(*) AS n FROM account_keys WHERE phone = ?').bind(target.phone).first();
    const miniKeyCount = (keyCountRes && Number(keyCountRes.n)) || 0;
    const keyRow = allKeys[0] || null;
    const devRes = await env.DB
      .prepare(
        `SELECT ip, ua, MAX(ts) AS last_seen, COUNT(*) AS hits
         FROM logs WHERE actor = ?
         GROUP BY ip, ua ORDER BY last_seen DESC LIMIT 30`
      ).bind(acc).all();
    // 旧 PIN 体系遗留的设备绑定（现行体系一般无行；保留以兼容历史账号的解绑能力）
    const legacyRes = await env.DB
      .prepare('SELECT device_id, created_at FROM device_bindings WHERE phone = ?').bind(target.phone).all();
    return jsonRes({
      phone: target.phone,
      kind,
      settings: aiRow
        ? { baseUrl: aiRow.ai_base_url, model: aiRow.ai_model, hasKey: Boolean(aiRow.ai_api_key) }
        : null,
      apikey: keyRow ? { key: keyRow.key, apiPort: keyRow.port, createdAt: keyRow.createdAt } : null,
      // 该账号全部小程序密钥（每个代表一个可连接的小程序设备）
      miniKeys: allKeys,
      miniKeyCount,
      // 真实访问设备：从该账号的操作日志按 IP+UA 去重统计（浏览器/小程序访问痕迹）
      deviceAccess: (devRes.results || []).map((d) => ({ ip: d.ip || '—', ua: d.ua || '', lastSeen: d.last_seen, hits: Number(d.hits) || 0 })),
      // 遗留旧 PIN 体系绑定（可解绑；现行体系多为空）
      devices: (legacyRes.results || []).map((d) => ({ deviceId: d.device_id, createdAt: d.created_at })),
    }, 200, origin);
  }

  // 分页列表：gifts / events
  const table = kind === 'events' ? 'events' : 'gifts';
  const cols = kind === 'events' ? 'id, name, type, date, created_at AS createdAt' : GIFT_COLUMNS;
  const countRes = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE account = ?`)
    .bind(acc).first();
  const total = (countRes && Number(countRes.n)) || 0;
  const off = (page - 1) * size;
  const dataRes = await env.DB.prepare(
    `SELECT ${cols} FROM ${table} WHERE account = ? ORDER BY date DESC, created_at DESC LIMIT ? OFFSET ?`
  ).bind(acc, size, off).all();
  return jsonRes({ phone: target.phone, kind, page, size, total, data: dataRes.results || [] }, 200, origin);
}

/** 在某账号下新增/更新活动（body: {phone, id?, name, type, date}）。 */
async function handleAdminAccountEvent(request, env, origin) {
  const body = await readJson(request);
  if (!body) return fail('请求内容格式错误', 400, origin);
  const target = await adminTargetAccount(env, body.phone, origin);
  if (target.error) return target.error;
  const id = asString(body.id, 64).trim();
  const req2 = fakeReq(body);
  if (id) return handleEventUpdate(req2, env, target.account, id, origin);
  return handleEventsCreate(req2, env, target.account, origin);
}

/** 删除某账号下的活动（级联删礼金）。 */
async function handleAdminAccountEventDelete(request, env, origin) {
  const body = await readJson(request);
  if (!body) return fail('请求内容格式错误', 400, origin);
  const target = await adminTargetAccount(env, body.phone, origin);
  if (target.error) return target.error;
  const id = asString(body.id, 64).trim();
  if (!id) return fail('缺少活动 ID', 400, origin);
  return handleEventDelete(env, target.account, id, origin);
}

/** 在某账号下新增/更新礼金（body: {phone, id?, eventId, person, direction, amountFen, ...}）。 */
async function handleAdminAccountGift(request, env, origin) {
  const body = await readJson(request);
  if (!body) return fail('请求内容格式错误', 400, origin);
  const target = await adminTargetAccount(env, body.phone, origin);
  if (target.error) return target.error;
  const id = asString(body.id, 64).trim();
  const req2 = fakeReq(body);
  if (id) return handleGiftsUpdate(req2, env, target.account, id, origin);
  return handleGiftsCreate(req2, env, target.account, origin);
}

/** 删除某账号下的一笔礼金。 */
async function handleAdminAccountGiftDelete(request, env, origin) {
  const body = await readJson(request);
  if (!body) return fail('请求内容格式错误', 400, origin);
  const target = await adminTargetAccount(env, body.phone, origin);
  if (target.error) return target.error;
  const id = asString(body.id, 64).trim();
  if (!id) return fail('缺少礼金 ID', 400, origin);
  return handleGiftsDelete(env, target.account, id, origin);
}

/** 管理员改某账号的 AI 配置（不做连通性测试，避免占用配额；apiKey 留空则保留原值）。 */
async function handleAdminAccountSettings(request, env, origin) {
  const body = await readJson(request);
  if (!body) return fail('请求内容格式错误', 400, origin);
  const target = await adminTargetAccount(env, body.phone, origin);
  if (target.error) return target.error;
  const baseUrl = asString(body.baseUrl, 300).trim().replace(/\/+$/, '');
  const model = asString(body.model, 120).trim();
  const apiKey = asString(body.apiKey, 500).trim();
  if (baseUrl && !/^https?:\/\/[^\s]+$/i.test(baseUrl)) {
    return fail('接口地址需以 http:// 或 https:// 开头', 400, origin);
  }
  await env.DB.prepare('INSERT OR IGNORE INTO account_settings (account) VALUES (?)').bind(target.account).run();
  await env.DB.prepare(
    `UPDATE account_settings SET ai_base_url = ?, ai_model = ?,
       ai_api_key = CASE WHEN ? = '' THEN ai_api_key ELSE ? END WHERE account = ?`
  ).bind(baseUrl, model, apiKey, apiKey, target.account).run();
  return jsonRes({ phone: target.phone, baseUrl, model, saved: true }, 200, origin);
}

/** 管理员管理某账号的小程序接口密钥。action: ''/get 查看、rotate 换、port 改端口、clear 清空。 */
async function handleAdminAccountApiKey(request, env, origin) {
  const body = await readJson(request);
  if (!body) return fail('请求内容格式错误', 400, origin);
  const target = await adminTargetAccount(env, body.phone, origin);
  if (target.error) return target.error;
  const action = asString(body.action, 20).trim();
  const acc = target.account;
  if (action === 'rotate') return handleApiKeyRotate(env, acc, origin, true); // 管理员可管理演示账号
  if (action === 'port') return handleApiKeyPort(fakeReq(body), env, acc, origin, true);
  if (action === 'clear') {
    await env.DB.prepare('DELETE FROM account_keys WHERE phone = ?').bind(target.phone).run();
    return jsonRes({ phone: target.phone, cleared: true }, 200, origin);
  }
  return handleApiKeyGet(env, acc, origin);
}

/** 管理员解除某账号的某台设备绑定。 */
async function handleAdminAccountDevice(request, env, origin) {
  const body = await readJson(request);
  if (!body) return fail('请求内容格式错误', 400, origin);
  const target = await adminTargetAccount(env, body.phone, origin);
  if (target.error) return target.error;
  const deviceId = asString(body.deviceId, 120).trim();
  if (!deviceId) return fail('缺少设备 ID', 400, origin);
  await env.DB.prepare('DELETE FROM device_bindings WHERE device_id = ? AND phone = ?')
    .bind(deviceId, target.phone).run();
  return jsonRes({ phone: target.phone, deviceId, unbound: true }, 200, origin);
}

/** 单账号导出（复用账号级备份，明文 JSON，含 AI 配置与接口密钥）。 */
async function handleAdminAccountExport(request, env, origin) {
  const url = new URL(request.url);
  const target = await adminTargetAccount(env, url.searchParams.get('phone'), origin);
  if (target.error) return target.error;
  return handleExportBackup(env, target.account, origin);
}

/** 单账号导入（multipart 上传，目标账号由 ?phone= 指定；数据归属该账号）。 */
async function handleAdminAccountImport(request, env, origin) {
  const url = new URL(request.url);
  const target = await adminTargetAccount(env, url.searchParams.get('phone'), origin);
  if (target.error) return target.error;
  return handleImportBackup(request, env, target.account, origin);
}

/** 管理员查看全栈操作日志（分页 + 按 actor/action/起止日期 过滤）。 */
async function handleAdminLogs(request, env, origin) {
  const url = new URL(request.url);
  let limit = Number.parseInt(url.searchParams.get('limit') || '50', 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 50;
  limit = Math.min(limit, 200);
  let page = Number.parseInt(url.searchParams.get('page') || '1', 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  const actor = asString(url.searchParams.get('actor'), 40).trim();
  const action = asString(url.searchParams.get('action'), 40).trim();
  const from = asString(url.searchParams.get('from'), 12).trim(); // YYYY-MM-DD 或 ISO
  const to = asString(url.searchParams.get('to'), 12).trim();
  const clauses = [];
  const params = [];
  if (actor) { clauses.push('actor LIKE ?'); params.push('%' + actor + '%'); }
  if (action) { clauses.push('action = ?'); params.push(action); }
  if (from) { clauses.push('ts >= ?'); params.push(from); }
  if (to) { clauses.push('ts <= ?'); params.push(to.length === 10 ? to + 'T23:59:59.999Z' : to); }
  const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
  const totalRes = await env.DB.prepare(`SELECT COUNT(*) AS n FROM logs${where}`).bind(...params).first();
  const total = (totalRes && Number(totalRes.n)) || 0;
  const off = (page - 1) * limit;
  const rowsRes = await env.DB.prepare(
    `SELECT id, ts, actor, action, target, method, path, status, ok, ip, ua, detail
     FROM logs${where} ORDER BY id DESC LIMIT ? OFFSET ?`
  ).bind(...params, limit, off).all();
  return jsonRes({ page, limit, total, logs: rowsRes.results || [] }, 200, origin);
}

/** 清理日志：days 为正整数 → 删 N 天前的旧日志（自动瘦身）；days 为 0 / 缺省 → 清空全部日志（手动）。 */
async function handleAdminLogsPurge(request, env, origin) {
  const body = await readJson(request);
  if (!body) return fail('请求内容格式错误', 400, origin);
  const raw = body.days === undefined || body.days === null || body.days === '' ? 0 : Number.parseInt(asString(body.days, 10), 10);
  const days = Number.isFinite(raw) ? raw : 0;
  if (days === 0) {
    const res = await env.DB.prepare('DELETE FROM logs').run();
    return jsonRes({ purged: (res && res.meta && res.meta.changes) || 0, all: true }, 200, origin);
  }
  if (days < 1) return fail('days 需为 0（清空全部）或正整数', 400, origin);
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const res = await env.DB.prepare('DELETE FROM logs WHERE ts < ?').bind(cutoff).run();
  return jsonRes({ purged: (res && res.meta && res.meta.changes) || 0, days }, 200, origin);
}

/* ---------- 管理员运行参数（admin_settings key/value）与日志生命周期管理 ---------- */

const LOG_RETENTION_DEFAULT = 30; // 日志默认保留 30 天
const LOG_PURGE_THROTTLE_MS = 3600000; // 惰性清理节流：每小时最多 1 次

/** 读 admin_settings；表/键缺失返回 def。 */
async function getAdminSetting(env, key, def) {
  try {
    const row = await env.DB.prepare('SELECT value FROM admin_settings WHERE key = ?').bind(key).first();
    return row ? row.value : def;
  } catch {
    return def;
  }
}

/** 写 admin_settings（upsert）。 */
async function setAdminSetting(env, key, value) {
  await env.DB.prepare(
    `INSERT INTO admin_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).bind(key, String(value)).run();
}

/** 日志保留天数（正整数，1–365，非法回退默认 30）。 */
async function logRetentionDays(env) {
  const raw = Number.parseInt(await getAdminSetting(env, 'log_retention_days', String(LOG_RETENTION_DEFAULT)), 10);
  if (!Number.isFinite(raw) || raw < 1 || raw > 365) return LOG_RETENTION_DEFAULT;
  return raw;
}

/** 惰性自动清理：距上次清理 >= 1 小时才删一次"保留天数以外"的旧日志。best-effort。 */
async function maybeLazyPurgeLogs(env, request) {
  try {
    if (!env.DB) return;
    const last = await getAdminSetting(env, 'last_log_purge_at', '0');
    const lastMs = Date.parse(last) || 0;
    if (Date.now() - lastMs < LOG_PURGE_THROTTLE_MS) return; // 节流：一小时最多 1 次
    const days = await logRetentionDays(env);
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    await env.DB.prepare('DELETE FROM logs WHERE ts < ?').bind(cutoff).run();
    await setAdminSetting(env, 'last_log_purge_at', nowIso());
  } catch {
    /* 清理失败不影响业务 */
  }
}

/** 查看管理员运行参数（含日志保留天数 + 联系邮箱 + 上次惰性清理时间 + 当前日志条数）。 */
async function handleAdminSettingsGet(env, origin) {
  const days = await logRetentionDays(env);
  const last = await getAdminSetting(env, 'last_log_purge_at', '');
  const contactEmail = (await getAdminSetting(env, 'contact_email', '')).trim();
  let count = 0;
  try {
    const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM logs').first();
    count = (r && Number(r.n)) || 0;
  } catch {}
  return jsonRes({ logRetentionDays: days, lastLogPurgeAt: last, logCount: count, contactEmail }, 200, origin);
}

/** 保存管理员运行参数（logRetentionDays 1–365；contactEmail 可选，忘记密码引导邮箱）。 */
async function handleAdminSettingsSave(request, env, origin) {
  const body = await readJson(request);
  if (!body) return fail('请求内容格式错误', 400, origin);
  let days;
  if (body.logRetentionDays !== undefined) {
    days = Number.parseInt(asString(body.logRetentionDays, 10), 10);
    if (!Number.isFinite(days) || days < 1 || days > 365) return fail('保留天数需为 1–365 的正整数', 400, origin);
    await setAdminSetting(env, 'log_retention_days', String(days));
  } else {
    days = await logRetentionDays(env);
  }
  if (body.contactEmail !== undefined) {
    const email = asString(body.contactEmail, 120).trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('请填写正确的邮箱地址', 400, origin);
    await setAdminSetting(env, 'contact_email', email);
  }
  return jsonRes({ logRetentionDays: days, saved: true }, 200, origin);
}

/** 导出日志（可按 from/to/actor 过滤）为可下载 JSON 文件。 */
async function handleAdminLogsExport(request, env, origin) {
  const url = new URL(request.url);
  const from = asString(url.searchParams.get('from'), 12).trim();
  const to = asString(url.searchParams.get('to'), 12).trim();
  const actor = asString(url.searchParams.get('actor'), 40).trim();
  const clauses = [];
  const params = [];
  if (actor) { clauses.push('actor LIKE ?'); params.push('%' + actor + '%'); }
  if (from) { clauses.push('ts >= ?'); params.push(from); }
  if (to) { clauses.push('ts <= ?'); params.push(to.length === 10 ? to + 'T23:59:59.999Z' : to); }
  const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
  const res = await env.DB.prepare(
    `SELECT ts, actor, action, target, method, path, status, ok, ip, ua, detail
     FROM logs${where} ORDER BY id ASC LIMIT 20000`
  ).bind(...params).all();
  const rows = (res.results || []).map((l) => ({
    ...l,
    ok: Boolean(l.ok),
  }));
  const payload = {
    service: 'xiaozhou-ledger-web',
    exportedAt: nowIso(),
    filter: { from: from || null, to: to || null, actor: actor || null },
    count: rows.length,
    logs: rows,
  };
  const body = JSON.stringify(payload, null, 2);
  const fname = '人情录-操作日志-' + new Date().toISOString().slice(0, 10) + '.json';
  return new Response(body, {
    status: 200,
    headers: Object.assign(corsHeaders(origin), {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(fname),
    }),
  });
}


async function handleAccountUnbindDevice(request, env, identity, origin) {
  // 登出/退出：只清除本地登录态。Web 账号的"信任本设备"即 JWT（localStorage 存了 7 天），
  // 清掉即退出；设备密钥/绑定关系保留，便于再次登录免输密码前快速恢复。
  const phone = accountPhone(identity.account);
  if (!identity.deviceId) return fail('无设备标识', 400, origin);
  if (phone) {
    await env.DB.prepare('DELETE FROM device_bindings WHERE device_id = ? AND phone = ?')
      .bind(identity.deviceId, phone)
      .run();
  }
  return jsonRes({ unbound: true }, 200, origin);
}

/* ------------------------------------------------------------------ */
/* 个人中心：修改昵称 / 密码 / 绑定手机号                               */
/* ------------------------------------------------------------------ */

/** 仅登录账号（手机号+密码体系）可改个人信息；游客无账号可改。 */
function requirePhoneAccount(identity, origin) {
  if (!identity.isPhone) return { error: fail('请先登录账号后再操作', 401, origin) };
  return { phone: accountPhone(identity.account) };
}

/** 发新 JWT（token 内含 phone/name，改完信息后必须换发）。 */
async function reissueToken(env, phone, name) {
  const now = Math.floor(Date.now() / 1000);
  return jwtSign({ phone, name, iat: now, exp: now + JWT_TTL_SECONDS }, jwtSecret(env));
}

/** 改昵称 */
async function handleProfileUpdate(request, env, identity, origin) {
  const guard = requirePhoneAccount(identity, origin);
  if (guard.error) return guard.error;
  const body = await readJson(request);
  if (!body) return fail('请求内容格式错误', 400, origin);
  const name = asString(body.name, 32).trim() || '账本用户';
  const phone = guard.phone;
  if (isDemoPhone(phone)) return fail(DEMO_LOCKED_MSG, 403, origin);
  await env.DB.prepare('UPDATE users SET name = ? WHERE phone = ?').bind(name, phone).run();
  return jsonRes({ phone, name, token: await reissueToken(env, phone, name) }, 200, origin);
}

/** 改密码：验证当前密码 */
async function handlePasswordChange(request, env, identity, origin) {
  const guard = requirePhoneAccount(identity, origin);
  if (guard.error) return guard.error;
  const body = await readJson(request);
  if (!body) return fail('请求内容格式错误', 400, origin);
  const phone = guard.phone;
  if (isDemoPhone(phone)) return fail(DEMO_LOCKED_MSG, 403, origin);
  const oldPassword = asString(body.oldPassword, 64);
  const newPassword = asString(body.newPassword, 64);
  if (!validPassword(newPassword)) return fail('新密码需为 8-32 位', 400, origin);
  const user = await env.DB.prepare('SELECT password_hash, name FROM users WHERE phone = ?')
    .bind(phone)
    .first();
  if (!user) return fail('账号不存在', 404, origin);
  const [salt, stored] = String(user.password_hash).split('|');
  if ((await hashPassword(oldPassword, salt)) !== stored) return fail('当前密码不正确', 403, origin);
  const newSalt = crypto.randomUUID();
  const passwordHash = `${newSalt}|${await hashPassword(newPassword, newSalt)}`;
  await env.DB.prepare('UPDATE users SET password_hash = ? WHERE phone = ?').bind(passwordHash, phone).run();
  return jsonRes({ phone, changed: true }, 200, origin);
}

/** 改绑定手机号：验证密码 → 校验新号 → 原子迁移全部账号数据 → 换发 JWT。 */
async function handlePhoneChange(request, env, identity, origin) {
  const guard = requirePhoneAccount(identity, origin);
  if (guard.error) return guard.error;
  const body = await readJson(request);
  if (!body) return fail('请求内容格式错误', 400, origin);
  const phone = guard.phone;
  if (isDemoPhone(phone)) return fail(DEMO_LOCKED_MSG, 403, origin);
  const newPhone = asString(body.newPhone, 20).trim();
  const password = asString(body.password, 64);
  if (!validPhone(newPhone)) return fail('请输入正确的手机号', 400, origin);
  if (newPhone === phone) return fail('新手机号不能与当前手机号相同', 400, origin);

  const user = await env.DB.prepare('SELECT * FROM users WHERE phone = ?').bind(phone).first();
  if (!user) return fail('账号不存在', 404, origin);
  const [salt, stored] = String(user.password_hash).split('|');
  if ((await hashPassword(password, salt)) !== stored) return fail('当前密码不正确', 403, origin);
  const dup = await env.DB.prepare('SELECT 1 AS x FROM users WHERE phone = ?').bind(newPhone).first();
  if (dup) return fail('该手机号已被注册', 409, origin);

  const oldAccount = `user:${phone}`;
  const newAccount = `user:${newPhone}`;
  // 全部迁移在一个 batch 内原子执行：任一步失败则整体回滚，不会出现半迁移状态。
  await env.DB.batch([
    env.DB.prepare('INSERT INTO users (phone, name, password_hash, created_at) VALUES (?, ?, ?, ?)')
      .bind(newPhone, user.name, user.password_hash, user.created_at),
    env.DB.prepare('DELETE FROM users WHERE phone = ?').bind(phone),
    env.DB.prepare('UPDATE events SET account = ? WHERE account = ?').bind(newAccount, oldAccount),
    env.DB.prepare('UPDATE gifts SET account = ? WHERE account = ?').bind(newAccount, oldAccount),
    env.DB.prepare(
      `INSERT OR REPLACE INTO account_settings (account, ai_base_url, ai_api_key, ai_model)
       SELECT ?, ai_base_url, ai_api_key, ai_model FROM account_settings WHERE account = ?`
    ).bind(newAccount, oldAccount),
    env.DB.prepare('DELETE FROM account_settings WHERE account = ?').bind(oldAccount),
    env.DB.prepare('UPDATE account_keys SET phone = ? WHERE phone = ?').bind(newPhone, phone),
    env.DB.prepare('UPDATE device_bindings SET phone = ? WHERE phone = ?').bind(newPhone, phone),
    env.DB.prepare('UPDATE feedback SET account = ? WHERE account = ?').bind(newAccount, oldAccount),
  ]);
  return jsonRes(
    { phone: newPhone, name: user.name, changed: true, token: await reissueToken(env, newPhone, user.name) },
    200,
    origin
  );
}

/* ------------------------------------------------------------------ */
/* 会话                                                                */
/* ------------------------------------------------------------------ */

async function handleSession(env, identity, origin) {
  const { account, phone, isPhone, name } = identity;
  let username = '访客';
  let auth = { loggedIn: false, guest: true };

  if (isPhone) {
    username = name || maskPhone(phone);
    auth = { loggedIn: true, phone, guest: false, name: name || null };
  } else if (account && account.startsWith('phone:')) {
    // 旧 PIN 体系遗留身份
    username = maskPhone(account.slice(6));
    auth = { loggedIn: true, phone: account.slice(6), guest: false };
  }

  const loggedIn = isPhone || Boolean(account && account.startsWith('phone:'));

  return jsonRes(
    {
      username,
      uid: account ? account : `dev-${(identity.deviceId || '').slice(0, 8)}`,
      // 前端设置页判断 mode==='gateway' 显示「云端网关」（其余显示「开发模式」），
      // 本部署即云端服务，返回 gateway 让面板文案原生正确。
      mode: 'gateway',
      gateway: {
        configured: true,
        username: loggedIn ? username : undefined,
        loggedIn,
        error: loggedIn ? '' : '未登录账号（当前为游客模式）',
      },
      // 网页版由自建 Worker 提供完整功能，直接视为已开通永久版。
      membership: { lifetime: true, priceFen: 1990 },
      // 前端设置页「云端服务：已连接（gateway.username）」——登录账号显示完整手机号，
      // 便于用户确认当前数据归属哪个账号；游客不显示。
      gatewayPhone: loggedIn ? phone : null,
      auth,
    },
    200,
    origin
  );
}

/* ------------------------------------------------------------------ */
/* 活动 / 礼金（按 account 作用域）                                    */
/* ------------------------------------------------------------------ */

const GIFT_COLUMNS = `gifts.id, gifts.event_id AS eventId, gifts.person, gifts.relation, gifts.direction,
  COALESCE((SELECT e2.type FROM events e2 WHERE e2.id = gifts.event_id AND e2.account = gifts.account), 'other') AS eventType,
  gifts.amount_fen AS amountFen, gifts.method, gifts.date, gifts.note, gifts.created_at AS createdAt`;

const EVENT_COLUMNS = `id, name, type, date, created_at AS createdAt`;

/** 金额分 → 元（去掉整数值的末尾 .00，便于日志可读）。 */
function fenYuan(fen) {
  const v = (Number(fen) || 0) / 100;
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
}

/** 礼金的可读详情片段：谁（关系）收/随 N 元 · 方式。 */
function giftDataDetail(g) {
  const dir = g.direction === 'in' ? '收礼' : '随礼';
  let s = `${g.person}（${g.relation || '未知关系'}）${dir} ${fenYuan(g.amountFen)}元`;
  const m = METHOD_LABELS[g.method];
  if (m) s += ` · ${m}`;
  if (g.date) s += ` @${g.date}`;
  return s;
}

/** 活动的可读详情片段：名称（类型）日期。 */
function eventDataDetail(ev) {
  const label = EVENT_LABELS[ev.type] || ev.type || '';
  let s = ev.name ? `${ev.name}${label && ev.name !== label ? `（${label}）` : ''}` : label;
  if (ev.date) s += ` @${ev.date}`;
  return s || '未知活动';
}

/** 把"改了什么数据"的可读详情挂到响应上，路由层写日志时优先采用。best-effort。 */
function withLogDetail(res, detail) {
  try { res.__logDetail = String(detail || ''); } catch { /* 只读响应忽略 */ }
  return res;
}

async function handleEventsGet(env, account, origin) {
  const { results } = await env.DB.prepare(
    `SELECT ${EVENT_COLUMNS} FROM events WHERE account = ?
     ORDER BY date DESC, created_at DESC, id DESC`
  )
    .bind(account)
    .all();
  return jsonRes(results || [], 200, origin);
}

async function handleEventsCreate(request, env, account, origin) {
  const body = await readJson(request);
  if (!body) return fail('请求内容格式错误', 400, origin);

  const type = EVENT_TYPES.has(body.type) ? body.type : 'other';
  const date = isValidDate(body.date) ? body.date : null;
  if (!date) return fail('活动日期格式需为 YYYY-MM-DD', 400, origin);
  const name = asString(body.name, 60).trim() || EVENT_LABELS[type];

  const existing = await env.DB.prepare(
    `SELECT ${EVENT_COLUMNS} FROM events WHERE account = ? AND type = ? AND date = ? LIMIT 1`
  )
    .bind(account, type, date)
    .first();
  if (existing) return withLogDetail(jsonRes(existing, 200, origin), '活动已存在，未重复创建 ' + eventDataDetail(existing));

  const event = {
    id: crypto.randomUUID(),
    name,
    type,
    date,
    createdAt: nowIso(),
  };
  try {
    await env.DB.prepare(
      `INSERT INTO events (id, device_id, account, name, type, date, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(event.id, '', account, event.name, event.type, event.date, event.createdAt)
      .run();
  } catch (e) {
    // 并发竞态：两个请求同时通过上方"已存在"检查，撞 (account, type, date) 唯一索引。
    // 回读已存在的那条返回，保持接口幂等语义（与上方 existing 分支一致）。
    if (isUniqueError(e)) {
      const raced = await env.DB.prepare(
        `SELECT ${EVENT_COLUMNS} FROM events WHERE account = ? AND type = ? AND date = ? LIMIT 1`
      )
        .bind(account, type, date)
        .first();
      if (raced) return withLogDetail(jsonRes(raced, 200, origin), '活动已存在，未重复创建 ' + eventDataDetail(raced));
    }
    throw e;
  }
  return withLogDetail(jsonRes(event, 200, origin), '新增活动 ' + eventDataDetail(event));
}

async function handleEventUpdate(request, env, account, eventId, origin) {
  const body = await readJson(request);
  if (!body) return fail('请求内容格式错误', 400, origin);
  const type = EVENT_TYPES.has(body.type) ? body.type : null;
  const date = isValidDate(body.date) ? body.date : null;
  if (!type) return fail('活动类型不正确', 400, origin);
  if (!date) return fail('活动日期格式需为 YYYY-MM-DD', 400, origin);
  const name = asString(body.name, 60).trim() || EVENT_LABELS[type];

  const clash = await env.DB.prepare(
    'SELECT id FROM events WHERE account = ? AND type = ? AND date = ? AND id <> ? LIMIT 1'
  )
    .bind(account, type, date, eventId)
    .first();
  if (clash) return fail('已存在相同类型与日期的活动', 400, origin);

  const before = await env.DB.prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE id = ? AND account = ?`)
    .bind(eventId, account)
    .first();
  const result = await env.DB.prepare(
    'UPDATE events SET name = ?, type = ?, date = ? WHERE id = ? AND account = ?'
  )
    .bind(name, type, date, eventId, account)
    .run();
  if (!result.meta || result.meta.changes === 0) return fail('活动不存在', 404, origin);
  const event = await env.DB.prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE id = ? AND account = ?`)
    .bind(eventId, account)
    .first();
  const detail = before
    ? `改活动：${eventDataDetail(before)} → ${eventDataDetail(event)}`
    : `改活动 ${eventDataDetail(event)}`;
  return withLogDetail(jsonRes(event, 200, origin), detail);
}

async function handleEventDelete(env, account, eventId, origin) {
  // 先确认活动存在（且属于本账号），再级联删除礼金：
  // 否则活动不存在时礼金已被误删（历史顺序缺陷）。
  const exists = await env.DB.prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE id = ? AND account = ?`)
    .bind(eventId, account)
    .first();
  if (!exists) return fail('活动不存在', 404, origin);

  const gres = await env.DB.prepare('SELECT COUNT(*) AS n FROM gifts WHERE event_id = ? AND account = ?')
    .bind(eventId, account)
    .first();
  const giftCount = (gres && Number(gres.n)) || 0;
  await env.DB.prepare('DELETE FROM gifts WHERE event_id = ? AND account = ?')
    .bind(eventId, account)
    .run();
  await env.DB.prepare('DELETE FROM events WHERE id = ? AND account = ?')
    .bind(eventId, account)
    .run();
  return withLogDetail(
    jsonRes({ deleted: true }, 200, origin),
    `删活动 ${eventDataDetail(exists)}，级联删除其下 ${giftCount} 条礼金`
  );
}

async function handleGiftsGet(request, env, account, origin) {
  const url = new URL(request.url);
  const clauses = ['account = ?'];
  const params = [account];

  const eventId = url.searchParams.get('eventId');
  if (eventId) {
    clauses.push('event_id = ?');
    params.push(eventId);
  }
  const person = url.searchParams.get('person');
  if (person) {
    clauses.push('person = ?');
    params.push(person);
  }
  const direction = url.searchParams.get('direction');
  if (direction === 'in' || direction === 'out') {
    clauses.push('direction = ?');
    params.push(direction);
  }
  const q = url.searchParams.get('q');
  if (q) {
    const like = `%${q}%`;
    clauses.push('(person LIKE ? OR note LIKE ? OR relation LIKE ?)');
    params.push(like, like, like);
  }

  let limit = Number.parseInt(url.searchParams.get('limit') || '', 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 5000;
  limit = Math.min(limit, 10000);

  const { results } = await env.DB.prepare(
    `SELECT ${GIFT_COLUMNS} FROM gifts WHERE ${clauses.join(' AND ')}
     ORDER BY date DESC, created_at DESC, id DESC LIMIT ?`
  )
    .bind(...params, limit)
    .all();

  const gifts = results || [];
  return jsonRes({ gifts, total: gifts.length }, 200, origin);
}

async function validateGiftBody(body, env, account) {
  if (!body) return { error: '请求内容格式错误' };
  const person = asString(body.person, 80).trim();
  if (!person) return { error: '请填写往来对象' };

  const eventId = asString(body.eventId, 64);
  if (!eventId) return { error: '缺少活动信息' };
  const event = await env.DB.prepare('SELECT id FROM events WHERE id = ? AND account = ?')
    .bind(eventId, account)
    .first();
  if (!event) return { error: '活动不存在，请刷新后重试' };

  const direction = body.direction === 'in' || body.direction === 'out' ? body.direction : null;
  if (!direction) return { error: '收支方向不正确' };

  const amountFen = Number(body.amountFen);
  if (!Number.isFinite(amountFen) || !Number.isInteger(amountFen) || amountFen <= 0) {
    return { error: '请输入正确的金额' };
  }
  if (amountFen > 100000000000) return { error: '金额超出范围' };

  const date = isValidDate(body.date) ? body.date : null;
  if (!date) return { error: '日期格式需为 YYYY-MM-DD' };

  return {
    value: {
      eventId,
      person,
      relation: RELATIONS.has(body.relation) ? body.relation : '朋友',
      direction,
      amountFen,
      method: METHODS.has(body.method) ? body.method : 'cash',
      date,
      note: asString(body.note, 500).trim(),
    },
  };
}

async function handleGiftsCreate(request, env, account, origin) {
  const body = await readJson(request);
  const { error, value } = await validateGiftBody(body, env, account);
  if (error) return fail(error, 400, origin);

  const gift = {
    id: crypto.randomUUID(),
    ...value,
    createdAt: nowIso(),
  };
  const ev = await env.DB.prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE id = ? AND account = ?`)
    .bind(gift.eventId, account)
    .first();
  await env.DB.prepare(
    `INSERT INTO gifts
     (id, device_id, account, event_id, person, relation, direction, amount_fen, method, date, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      gift.id,
      '',
      account,
      gift.eventId,
      gift.person,
      gift.relation,
      gift.direction,
      gift.amountFen,
      gift.method,
      gift.date,
      gift.note,
      gift.createdAt
    )
    .run();
  const evLabel = ev ? ev.name || EVENT_LABELS[ev.type] : '';
  return withLogDetail(
    jsonRes(gift, 200, origin),
    `新增礼金 ${giftDataDetail(gift)}${evLabel ? ` · 活动「${evLabel}」` : ''}${gift.note ? ` · 备注 ${gift.note}` : ''}`
  );
}

async function handleGiftGet(env, account, giftId, origin) {
  const gift = await env.DB.prepare(`SELECT ${GIFT_COLUMNS} FROM gifts WHERE id = ? AND account = ?`)
    .bind(giftId, account)
    .first();
  if (!gift) return fail('记录不存在', 404, origin);
  return jsonRes(gift, 200, origin);
}

async function handleGiftsUpdate(request, env, account, giftId, origin) {
  const body = await readJson(request);
  const { error, value } = await validateGiftBody(body, env, account);
  if (error) return fail(error, 400, origin);

  const before = await env.DB.prepare(`SELECT ${GIFT_COLUMNS} FROM gifts WHERE id = ? AND account = ?`)
    .bind(giftId, account)
    .first();

  const result = await env.DB.prepare(
    `UPDATE gifts SET event_id = ?, person = ?, relation = ?, direction = ?,
       amount_fen = ?, method = ?, date = ?, note = ?
     WHERE id = ? AND account = ?`
  )
    .bind(
      value.eventId,
      value.person,
      value.relation,
      value.direction,
      value.amountFen,
      value.method,
      value.date,
      value.note,
      giftId,
      account
    )
    .run();
  if (!result.meta || result.meta.changes === 0) {
    return fail('记录不存在或无权限修改', 404, origin);
  }
  const gift = await env.DB.prepare(`SELECT ${GIFT_COLUMNS} FROM gifts WHERE id = ? AND account = ?`)
    .bind(giftId, account)
    .first();
  const detail = before ? `改礼金：${giftDataDetail(before)} → ${giftDataDetail(gift)}` : `改礼金 ${giftDataDetail(gift)}`;
  return withLogDetail(jsonRes(gift, 200, origin), detail);
}

async function handleGiftsDelete(env, account, giftId, origin) {
  const before = await env.DB.prepare(`SELECT ${GIFT_COLUMNS} FROM gifts WHERE id = ? AND account = ?`)
    .bind(giftId, account)
    .first();
  const result = await env.DB.prepare('DELETE FROM gifts WHERE id = ? AND account = ?')
    .bind(giftId, account)
    .run();
  if (!result.meta || result.meta.changes === 0) return fail('记录不存在或无权限删除', 404, origin);
  return withLogDetail(jsonRes({ deleted: true }, 200, origin), before ? `删礼金 ${giftDataDetail(before)}` : '删礼金（记录已不存在）');
}

/* ------------------------------------------------------------------ */
/* 统计 / 联系人 / 年度报告 / CSV                                       */
/* ------------------------------------------------------------------ */

function buildPersonSummaries(gifts, events) {
  const eventById = new Map((events || []).map((e) => [e.id, e]));
  const map = new Map();
  for (const g of gifts) {
    const key = g.person;
    let p = map.get(key);
    if (!p) {
      p = {
        person: g.person,
        relation: g.relation || '',
        totalInFen: 0,
        totalOutFen: 0,
        giftCount: 0,
        inCount: 0,
        outCount: 0,
        firstDate: g.date,
        lastDate: g.date,
        maxIn: 0,
        maxOut: 0,
        events: new Set(),
      };
      map.set(key, p);
    }
    p.giftCount++;
    if (g.direction === 'in') {
      p.totalInFen += g.amountFen;
      p.inCount++;
      p.maxIn = Math.max(p.maxIn, g.amountFen);
    } else {
      p.totalOutFen += g.amountFen;
      p.outCount++;
      p.maxOut = Math.max(p.maxOut, g.amountFen);
    }
    if (g.date < p.firstDate) p.firstDate = g.date;
    if (g.date > p.lastDate) p.lastDate = g.date;
    const ev = eventById.get(g.eventId);
    if (ev && ev.name) p.events.add(ev.name);
  }
  const list = [...map.values()].map((p) => {
    const totalFen = p.totalInFen + p.totalOutFen;
    return {
      person: p.person,
      relation: p.relation,
      events: [...p.events],
      lastDate: p.lastDate,
      totalFen,
      totalInFen: p.totalInFen,
      totalOutFen: p.totalOutFen,
      inFen: p.totalInFen,
      outFen: p.totalOutFen,
      netFen: p.totalInFen - p.totalOutFen,
      count: p.giftCount,
      giftCount: p.giftCount,
      inCount: p.inCount,
      outCount: p.outCount,
      firstDate: p.firstDate,
      maxIn: p.maxIn,
      maxOut: p.maxOut,
    };
  });
  list.sort((a, b) => b.totalFen - a.totalFen);
  return list;
}

async function loadAccountData(env, account) {
  const [eventsRes, giftsRes] = await Promise.all([
    env.DB.prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE account = ? ORDER BY date ASC`)
      .bind(account)
      .all(),
    env.DB.prepare(`SELECT ${GIFT_COLUMNS} FROM gifts WHERE account = ? ORDER BY date ASC, created_at ASC`)
      .bind(account)
      .all(),
  ]);
  return { events: eventsRes.results || [], gifts: giftsRes.results || [] };
}

async function handleOverview(env, account, origin) {
  const { events, gifts } = await loadAccountData(env, account);
  const year = thisYear();

  let totalInFen = 0;
  let totalOutFen = 0;
  let yearInFen = 0;
  let yearOutFen = 0;
  let maxIn = 0;
  let maxOut = 0;
  let firstDate = '';
  for (const g of gifts) {
    if (g.direction === 'in') {
      totalInFen += g.amountFen;
      if (g.date.startsWith(year)) yearInFen += g.amountFen;
      maxIn = Math.max(maxIn, g.amountFen);
    } else {
      totalOutFen += g.amountFen;
      if (g.date.startsWith(year)) yearOutFen += g.amountFen;
      maxOut = Math.max(maxOut, g.amountFen);
    }
    if (!firstDate || g.date < firstDate) firstDate = g.date;
  }
  const people = buildPersonSummaries(gifts, events);

  return jsonRes(
    {
      eventCount: events.length,
      giftCount: gifts.length,
      totalInFen,
      totalOutFen,
      netFen: totalInFen - totalOutFen,
      yearInFen,
      yearOutFen,
      personCount: people.length,
      topPersons: people.slice(0, 5),
      maxIn,
      maxOut,
      firstDate,
    },
    200,
    origin
  );
}

async function handlePeople(env, account, origin) {
  const { events, gifts } = await loadAccountData(env, account);
  return jsonRes(buildPersonSummaries(gifts, events), 200, origin);
}

async function handleYearlyReport(request, env, account, origin) {
  const url = new URL(request.url);
  const nowYear = thisYear();
  const rawYear = url.searchParams.get('year') || '';
  const year = /^\d{4}$/.test(rawYear) ? rawYear : nowYear;

  const { events, gifts } = await loadAccountData(env, account);
  const eventType = new Map(events.map((e) => [e.id, e.type]));
  const years = [...new Set(gifts.map((g) => g.date.slice(0, 4)))].sort().reverse();
  const yearGifts = gifts.filter((g) => g.date.startsWith(year));

  const byTypeMap = new Map();
  const byMonthMap = new Map();
  let totalInFen = 0;
  let totalOutFen = 0;

  for (const g of yearGifts) {
    const type = eventType.get(g.eventId) || g.eventType || 'other';
    let t = byTypeMap.get(type);
    if (!t) {
      t = { type, inFen: 0, outFen: 0, count: 0 };
      byTypeMap.set(type, t);
    }
    const month = g.date.slice(0, 7);
    let m = byMonthMap.get(month);
    if (!m) {
      m = { month, inFen: 0, outFen: 0, count: 0 };
      byMonthMap.set(month, m);
    }
    if (g.direction === 'in') {
      totalInFen += g.amountFen;
      t.inFen += g.amountFen;
      m.inFen += g.amountFen;
    } else {
      totalOutFen += g.amountFen;
      t.outFen += g.amountFen;
      m.outFen += g.amountFen;
    }
    t.count++;
    m.count++;
  }

  const byType = [...byTypeMap.values()]
    .map((t) => ({
      type: t.type,
      label: EVENT_LABELS[t.type] || t.type,
      inFen: t.inFen,
      outFen: t.outFen,
      netFen: t.inFen - t.outFen,
      totalFen: t.inFen + t.outFen,
      count: t.count,
    }))
    .sort((a, b) => b.totalFen - a.totalFen);
  const byMonth = [...byMonthMap.values()]
    .map((m) => ({
      month: m.month,
      inFen: m.inFen,
      outFen: m.outFen,
      netFen: m.inFen - m.outFen,
      totalFen: m.inFen + m.outFen,
      count: m.count,
    }))
    .sort((a, b) => a.month.localeCompare(b.month));

  return jsonRes(
    {
      year: Number(year),
      count: yearGifts.length,
      years,
      inFen: totalInFen,
      outFen: totalOutFen,
      netFen: totalInFen - totalOutFen,
      totalFen: totalInFen + totalOutFen,
      totalInFen,
      totalOutFen,
      byType,
      byMonth,
      topPersons: buildPersonSummaries(yearGifts, events).slice(0, 5),
      recent: yearGifts.slice(0, 10),
    },
    200,
    origin
  );
}

function csvEscape(value) {
  const text = String(value === null || value === undefined ? '' : value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function xmlEscape(value) {
  const text = String(value === null || value === undefined ? '' : value);
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** 生成 SpreadsheetML 2003（Excel 原生 .xls，纯 XML 零依赖）。
 *  Excel/WPS 双击即以真正表格打开，含表头样式，金额等纯数字列为数值类型可参与计算。 */
function buildSpreadsheetML(rows, sheetName) {
  const safeName = String(sheetName || '账本').replace(/[\\/?*\[\]:]/g, '_').slice(0, 31) || '账本';
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<?mso-application progid="Excel.Sheet"?>',
    '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">',
    '<Styles>',
    '<Style ss:ID="Header"><Font ss:Bold="1"/><Interior ss:Color="#E7F2EA" ss:Pattern="Solid"/></Style>',
    '<Style ss:ID="Num"><NumberFormat ss:Format="0.00"/></Style>',
    '</Styles>',
    `<Worksheet ss:Name="${xmlEscape(safeName)}"><Table>`,
  ];
  rows.forEach((row, ri) => {
    lines.push('<Row>');
    row.forEach((cell) => {
      const text = String(cell === null || cell === undefined ? '' : cell);
      const isNum = ri > 0 && /^-?\d+(\.\d+)?$/.test(text);
      if (isNum) lines.push(`<Cell ss:StyleID="Num"><Data ss:Type="Number">${text}</Data></Cell>`);
      else if (ri === 0) lines.push(`<Cell ss:StyleID="Header"><Data ss:Type="String">${xmlEscape(text)}</Data></Cell>`);
      else lines.push(`<Cell><Data ss:Type="String">${xmlEscape(text)}</Data></Cell>`);
    });
    lines.push('</Row>');
  });
  lines.push('</Table></Worksheet></Workbook>');
  return lines.join('\r\n');
}

async function handleExportCsv(request, env, account, origin) {
  const url = new URL(request.url);
  const kind = url.searchParams.get('type') || url.searchParams.get('kind') || 'gifts';
  const format = (url.searchParams.get('format') || url.searchParams.get('fmt') || 'csv').toLowerCase();
  const { events, gifts } = await loadAccountData(env, account);
  const eventById = new Map(events.map((e) => [e.id, e]));

  const rows = [];
  let filename = '礼金明细.csv';

  if (kind === 'events') {
    filename = '活动列表.csv';
    rows.push(['名称', '类型', '日期', '笔数']);
    for (const e of [...events].sort((a, b) => b.date.localeCompare(a.date))) {
      const count = gifts.filter((g) => g.eventId === e.id).length;
      rows.push([e.name, EVENT_LABELS[e.type] || e.type, e.date, count]);
    }
  } else if (kind === 'people') {
    filename = '人情往来.csv';
    rows.push(['姓名', '关系', '收礼(元)', '随礼(元)', '结余(元)', '笔数', '最近日期']);
    for (const p of buildPersonSummaries(gifts, events)) {
      rows.push([
        p.person,
        p.relation,
        (p.totalInFen / 100).toFixed(2),
        (p.totalOutFen / 100).toFixed(2),
        (p.netFen / 100).toFixed(2),
        p.giftCount,
        p.lastDate,
      ]);
    }
  } else {
    rows.push(['日期', '姓名', '关系', '方向', '活动', '方式', '金额(元)', '备注']);
    for (const g of [...gifts].sort((a, b) => b.date.localeCompare(a.date))) {
      const event = eventById.get(g.eventId);
      rows.push([
        g.date,
        g.person,
        g.relation,
        g.direction === 'in' ? '收礼' : '随礼',
        event ? event.name : '',
        METHOD_LABELS[g.method] || g.method,
        (g.amountFen / 100).toFixed(2),
        g.note,
      ]);
    }
  }

  const csv = '﻿' + rows.map((row) => row.map(csvEscape).join(',')).join('\r\n');
  const disposition = `attachment; filename="export-${kind}.csv"; filename*=UTF-8''${encodeURIComponent(filename)}`;
  // format=xls → Excel 原生表格（SpreadsheetML）；默认仍是 CSV，向后兼容
  if (format === 'xls' || format === 'xlsx') {
    const xlsName = filename.replace(/\.csv$/, '.xls');
    const xls = buildSpreadsheetML(rows, xlsName.replace(/\.xls$/, ''));
    const xlsDisp = `attachment; filename="export-${kind}.xls"; filename*=UTF-8''${encodeURIComponent(xlsName)}`;
    return new Response(xls, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.ms-excel; charset=utf-8',
        'Content-Disposition': xlsDisp,
        'Cache-Control': 'no-store',
        ...corsHeaders(origin),
      },
    });
  }
  return new Response(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': disposition,
      'Cache-Control': 'no-store',
      ...corsHeaders(origin),
    },
  });
}

/* ------------------------------------------------------------------ */
/* AI 模型（按账号保存，登录后多设备一致）                             */
/* ------------------------------------------------------------------ */

function chatEndpoint(baseUrl) {
  const base = baseUrl.replace(/\/+$/, '');
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 429/连接抖动自动重试：最多 3 次尝试（首次 + 2 次退避重试），
// 429 优先遵循服务端 Retry-After；总耗时控制在 Worker 墙钟限制内。
// 失败时尽量带上提供方原始响应片段，方便定位是限流、余额还是参数问题。
async function callChat(baseUrl, apiKey, model, messages, maxTokens) {
  const payload = { model, messages, temperature: 0.2, stream: false };
  if (maxTokens) payload.max_tokens = maxTokens;

  let lastDetail = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    try {
      res = await fetch(chatEndpoint(baseUrl), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });
    } catch (e) {
      lastDetail = `AI 服务连接失败：${e && e.message ? e.message : e}`;
      if (attempt < 2) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      return { ok: false, error: lastDetail };
    }

    // 读取响应（429 与非 429 都需要原始文本；429 中间轮次读完即重试）
    const raw = await res.text();
    let parsed = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch { /* 非 JSON 响应 */ }
    const detail =
      (parsed && (
        (parsed.error && (typeof parsed.error === 'string' ? parsed.error : parsed.error.message)) ||
        parsed.message ||
        (typeof parsed.error === 'object' && parsed.error.detail)
      )) ||
      (raw ? raw.slice(0, 200) : '');

    if (res.status === 429 && attempt < 2) {
      lastDetail = detail || 'AI 服务返回 429（请求过于频繁）';
      const ra = Number(res.headers.get('retry-after'));
      const waitMs = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 10000) : 1000 * (attempt + 1);
      await sleep(waitMs);
      continue;
    }

    if (!res.ok) {
      if (res.status === 429) {
        return {
          ok: false,
          error: `AI 服务返回 429（请求过于频繁/配额不足）${detail ? `：${detail}` : ''}，稍后再试；持续出现请检查该模型服务的限流与余额`,
        };
      }
      return { ok: false, error: `AI 服务返回 ${res.status}${detail ? `：${detail}` : ''}` };
    }

    if (!parsed) {
      return { ok: false, error: `AI 服务返回内容不是有效 JSON${raw ? `（开头：${raw.slice(0, 120)}…）` : ''}` };
    }
    return { ok: true, data: parsed };
  }
  return { ok: false, error: `AI 服务返回 429（请求过于频繁/配额不足）${lastDetail ? `：${lastDetail}` : ''}，稍后再试；持续出现请检查该模型服务的限流与余额` };
}

async function getAiSettings(env, account) {
  if (account.startsWith('user:') || account.startsWith('phone:')) {
    return env.DB.prepare('SELECT * FROM account_settings WHERE account = ?')
      .bind(account)
      .first();
  }
  const deviceId = accountDevice(account);
  return env.DB.prepare('SELECT * FROM device_settings WHERE device_id = ?')
    .bind(deviceId)
    .first();
}

function aiView(s) {
  const baseUrl = (s && s.ai_base_url) || '';
  const model = (s && s.ai_model) || '';
  const key = (s && s.ai_api_key) || '';
  return { baseUrl, model, configured: Boolean(baseUrl && model && key) };
}

async function handleAiConfigGet(env, account, origin) {
  return jsonRes(aiView(await getAiSettings(env, account)), 200, origin);
}

async function handleAiConfigSave(request, env, account, origin) {
  const body = await readJson(request);
  if (!body) return fail('请求内容格式错误', 400, origin);

  const baseUrl = asString(body.baseUrl, 300).trim().replace(/\/+$/, '');
  const model = asString(body.model, 120).trim();
  const apiKeyInput = asString(body.apiKey, 500).trim();

  if (!/^https?:\/\/[^\s]+$/i.test(baseUrl)) {
    return fail('接口地址需以 http:// 或 https:// 开头', 400, origin);
  }
  if (!model) return fail('请填写模型名称', 400, origin);

  const s = await getAiSettings(env, account);
  const apiKey = apiKeyInput || (s && s.ai_api_key) || '';
  if (!apiKey) return fail('首次配置需填写 API Key', 400, origin);

  const test = await callChat(baseUrl, apiKey, model, [
    { role: 'user', content: '请只回复两个字：正常' },
  ]);

  if (account.startsWith('user:') || account.startsWith('phone:')) {
    await env.DB.prepare(
      'UPDATE account_settings SET ai_base_url = ?, ai_api_key = ?, ai_model = ? WHERE account = ?'
    )
      .bind(baseUrl, apiKey, model, account)
      .run();
  } else {
    await env.DB.prepare(
      'UPDATE device_settings SET ai_base_url = ?, ai_api_key = ?, ai_model = ? WHERE device_id = ?'
    )
      .bind(baseUrl, apiKey, model, accountDevice(account))
      .run();
  }

  // 429（限流/配额窗口）不阻止保存：配置先存好，解析时走浏览器直连兜底；
  // 其他失败（401 key 错、404 地址错、连不通等）才报错不保存，避免存下坏配置。
  if (!test.ok && test.error.indexOf('429') !== -1) {
    return jsonRes(
      {
        baseUrl,
        model,
        configured: true,
        warning:
          '配置已保存，但该模型服务当前限流（429），连通性测试未通过。稍后重试保存可完成测试；「AI 记账」解析时会自动尝试浏览器直连兜底。',
      },
      200,
      origin
    );
  }
  if (!test.ok) return fail(test.error, 400, origin);

  return jsonRes({ baseUrl, model, configured: true, warning: '' }, 200, origin);
}

function buildParsePrompt() {
  const today = todayStr();
  return `你是「人情录」(份子钱/礼金账本)的记录解析器。把用户的描述提取为礼金记录,只输出 JSON,不要任何解释或 markdown。
输出格式:{"records":[{"direction":"in|out","person":"姓名","relation":"朋友|亲戚|同事|同学|邻居|其他","amountYuan":600,"eventType":"wedding|baby|birthday|housewarming|graduation|funeral|other","date":"YYYY-MM-DD","note":""}]}
规则:收到=in,送出/随礼=out;金额单位元(数字);eventType 按场合映射(婚礼=wedding,满月/百日=baby,生日/寿宴=birthday,乔迁=housewarming,升学=graduation,白事/丧事=funeral,其余=other);日期未提及时用今天(${today})。无法解析的内容放到 errors 数组。`;
}

function stripCodeFence(text) {
  return String(text || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}

function normalizeAiRecords(parsed) {
  const records = [];
  const errors = [];
  const sourceRecords = Array.isArray(parsed && parsed.records) ? parsed.records : [];
  const sourceErrors = Array.isArray(parsed && parsed.errors) ? parsed.errors : [];

  const today = todayStr();
  for (const raw of sourceRecords) {
    if (!raw || typeof raw !== 'object') continue;
    const person = asString(raw.person, 80).trim();
    if (!person) {
      errors.push('有一条记录缺少姓名，已跳过');
      continue;
    }
    const direction = raw.direction === 'in' || raw.direction === 'out' ? raw.direction : null;
    if (!direction) {
      errors.push(`「${person}」的收支方向无法识别，已跳过`);
      continue;
    }
    const amount =
      typeof raw.amountYuan === 'number'
        ? raw.amountYuan
        : Number(String(raw.amountYuan || '').replace(/[^\d.]/g, ''));
    if (!Number.isFinite(amount) || amount <= 0) {
      errors.push(`「${person}」的金额无法识别，已跳过`);
      continue;
    }
    const amountYuan = amount.toFixed(2).replace(/\.00$/, '');
    const eventType = EVENT_TYPES.has(raw.eventType) ? raw.eventType : 'other';
    const relation = RELATIONS.has(raw.relation) ? raw.relation : '朋友';
    const date = isValidDate(raw.date) ? raw.date : today;
    records.push({ direction, person, relation, amountYuan, eventType, date, note: asString(raw.note, 500).trim() });
  }

  for (const item of sourceErrors) {
    const msg = asString(item, 300).trim();
    if (msg) errors.push(msg);
  }
  return { records, errors };
}

async function handleAiParse(request, env, account, origin) {
  const body = await readJson(request);
  if (!body) return fail('请求内容格式错误', 400, origin);
  const text = asString(body.text, 4000).trim();
  if (!text) return fail('请先输入要解析的内容', 400, origin);

  const s = await getAiSettings(env, account);
  const view = aiView(s);
  if (!view.configured) return fail('请先在「设置 → AI 模型」中配置模型', 400, origin);

  const result = await callChat(view.baseUrl, s.ai_api_key, view.model, [
    { role: 'system', content: buildParsePrompt() },
    { role: 'user', content: text },
  ]);
  if (!result.ok) {
    // Worker 出口 IP（Cloudflare）常被 AI 服务商限流（429/配额）。
    // 把完整 AI 配置带进响应，前端检测到 429 后会用浏览器（用户本机 IP）直连重试；
    // 这是该账号自己的 key，只回到该账号自己的浏览器，不产生新的泄露面。
    if (result.error.indexOf('429') !== -1) {
      return jsonRes(
        {
          error: result.error,
          direct: {
            baseUrl: view.baseUrl,
            apiKey: s.ai_api_key,
            model: view.model,
            system: buildParsePrompt(),
            user: text,
          },
        },
        502,
        origin
      );
    }
    return fail(result.error, 502, origin);
  }

  const choice = result.data && result.data.choices && result.data.choices[0];
  let content = choice && choice.message ? choice.message.content : '';
  if (Array.isArray(content)) {
    content = content.map((part) => (typeof part === 'string' ? part : (part && part.text) || '')).join('');
  }
  if (!content && choice && typeof choice.text === 'string') content = choice.text;
  if (!content) return fail('AI 未返回解析结果', 502, origin);

  let parsed;
  try {
    parsed = JSON.parse(stripCodeFence(content));
  } catch {
    return fail('AI 返回内容不是有效 JSON，请换个说法再试', 502, origin);
  }

  const normalized = normalizeAiRecords(parsed);
  if (!normalized.records.length && !normalized.errors.length) {
    normalized.errors.push('没有解析出记录，换个说法试试');
  }
  const detail = `AI 解析出 ${normalized.records.length} 条待记记录${normalized.errors.length ? `，${normalized.errors.length} 条异常` : ''}（原文 ${text.length} 字）`;
  return withLogDetail(jsonRes(normalized, 200, origin), detail);
}

/* ------------------------------------------------------------------ */
/* 接口密钥（小程序绑定）                                              */
/* ------------------------------------------------------------------ */

async function handleApiKeyGet(env, account, origin) {
  let configured = false;
  let key = '';
  let port = 0;
  let createdAt = '';

  if (account.startsWith('user:') || account.startsWith('phone:')) {
    const phone = accountPhone(account);
    const row = await env.DB.prepare(
      'SELECT key, port, created_at FROM account_keys WHERE phone = ? ORDER BY created_at DESC LIMIT 1'
    )
      .bind(phone)
      .first();
    if (row) {
      configured = true;
      key = row.key;
      port = row.port;
      createdAt = row.created_at;
    }
  } else {
    const legacy = await env.DB.prepare('SELECT api_key, api_port FROM device_settings WHERE device_id = ?')
      .bind(accountDevice(account))
      .first();
    if (legacy && legacy.api_key) {
      configured = true;
      key = legacy.api_key;
      port = legacy.api_port || 0;
    }
  }

  // 原应用的「绑定二维码」用这里的 key 生成配置码，因此返回明文。
  return jsonRes({ configured, key, apiPort: port, createdAt }, 200, origin);
}

async function handleApiKeyRotate(env, account, origin, allowDemo) {
  if (!allowDemo && isDemoPhone(accountPhone(account))) return fail(DEMO_LOCKED_MSG, 403, origin);
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const key = `gl_${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;

  if (account.startsWith('user:') || account.startsWith('phone:')) {
    const phone = accountPhone(account);
    await env.DB.prepare('DELETE FROM account_keys WHERE phone = ?').bind(phone).run();
    await env.DB.prepare('INSERT INTO account_keys (key, phone, port, created_at) VALUES (?, ?, 0, ?)')
      .bind(key, phone, nowIso())
      .run();
  } else {
    const deviceId = accountDevice(account);
    await env.DB.prepare(
      'UPDATE device_settings SET api_key = ?, api_key_hash = ?, api_key_created_at = ? WHERE device_id = ?'
    )
      .bind(key, '', nowIso(), deviceId)
      .run();
  }
  return jsonRes({ key }, 200, origin);
}

async function handleApiKeyPort(request, env, account, origin, allowDemo) {
  if (!allowDemo && isDemoPhone(accountPhone(account))) return fail(DEMO_LOCKED_MSG, 403, origin);
  const body = await readJson(request);
  if (!body) return fail('请求内容格式错误', 400, origin);
  const raw = asString(body.port, 10).trim();
  let port = 0;
  if (raw && raw !== '0') {
    port = Number.parseInt(raw, 10);
    if (!Number.isFinite(port) || port < 1 || port > 65535) return fail('端口需为 1-65535 的数字', 400, origin);
  }
  if (account.startsWith('user:') || account.startsWith('phone:')) {
    await env.DB.prepare('UPDATE account_keys SET port = ? WHERE phone = ?')
      .bind(port, accountPhone(account))
      .run();
  } else {
    await env.DB.prepare('UPDATE device_settings SET api_port = ? WHERE device_id = ?')
      .bind(port, accountDevice(account))
      .run();
  }
  return jsonRes({ apiPort: port }, 200, origin);
}

/* ------------------------------------------------------------------ */
/* 意见反馈 / 会员                                                     */
/* ------------------------------------------------------------------ */

async function handleFeedback(request, env, account, origin) {
  const body = await readJson(request);
  if (!body) return fail('请求内容格式错误', 400, origin);
  const content = asString(body.content, 1000).trim();
  const contact = asString(body.contact, 200).trim();
  if (!content) return fail('反馈内容不能为空', 400, origin);
  // 来源区分（web / miniapp，小程序端可传 source）；类型默认建议，密码重置申请走独立的公开接口
  const source = asString(body.source, 16).trim() || 'web';

  await env.DB.prepare(
    `INSERT INTO feedback (account, content, contact, created_at, kind, status, source)
     VALUES (?, ?, ?, ?, 'suggestion', 'new', ?)`
  )
    .bind(account, content, contact, nowIso(), source)
    .run();
  return jsonRes({ ok: true }, 200, origin);
}

/** 忘记密码：公开接口（无需登录）。返回管理员设置的联系邮箱（未设置则引导到管理后台）。 */
async function handleForgotInfo(env, origin) {
  const email = (await getAdminSetting(env, 'contact_email', '')).trim();
  return jsonRes({ contactEmail: email, configured: Boolean(email) }, 200, origin);
}

/** 忘记密码：提交密码重置申请（公开，无需登录）。只记录目标手机号，不存明文新密码；
 *  由管理员在后台看到申请后，用 /api/admin/reset-password 帮用户设新密码，再告知用户。 */
async function handleForgotRequest(request, env, origin) {
  const body = await readJson(request);
  if (!body) return fail('请求内容格式错误', 400, origin);
  const phone = asString(body.phone, 20).trim();
  const note = asString(body.note, 200).trim();
  if (!validPhone(phone)) return fail('请输入正确的手机号', 400, origin);
  const user = await env.DB.prepare('SELECT 1 AS x FROM users WHERE phone = ?').bind(phone).first();
  // 不存在也返回成功（避免被探测哪些手机号已注册），统一口径
  await env.DB.prepare(
    `INSERT INTO feedback (account, content, contact, created_at, kind, status, source, ref_phone)
     VALUES (?, ?, ?, ?, 'reset', 'new', 'web', ?)`
  )
    .bind('user:' + phone, note ? `密码重置申请：${note}` : '密码重置申请', '', nowIso(), phone)
    .run();
  return jsonRes({ ok: true, exists: Boolean(user), message: '重置申请已提交，管理员会尽快处理并通过你的注册手机或联系邮箱联系你。' }, 200, origin);
}

/* ---------- 管理员：意见反馈查看 / 标记已处理 ---------- */

/** 管理员查看全部反馈（分页 + 按 kind/status 过滤）。 */
async function handleAdminFeedbacks(request, env, origin) {
  const url = new URL(request.url);
  let limit = Number.parseInt(url.searchParams.get('limit') || '50', 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 50;
  limit = Math.min(limit, 500);
  let page = Number.parseInt(url.searchParams.get('page') || '1', 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  const kind = asString(url.searchParams.get('kind'), 16).trim();
  const status = asString(url.searchParams.get('status'), 16).trim();
  const clauses = [];
  const params = [];
  if (kind) { clauses.push('kind = ?'); params.push(kind); }
  if (status) { clauses.push('status = ?'); params.push(status); }
  const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
  const totalRes = await env.DB.prepare(`SELECT COUNT(*) AS n FROM feedback${where}`).bind(...params).first();
  const total = (totalRes && Number(totalRes.n)) || 0;
  const off = (page - 1) * limit;
  const rowsRes = await env.DB.prepare(
    `SELECT id, account, content, contact, created_at, kind, status, source, ref_phone
     FROM feedback${where} ORDER BY (status = 'new') DESC, id DESC LIMIT ? OFFSET ?`
  ).bind(...params, limit, off).all();
  return jsonRes({ page, limit, total, items: (rowsRes.results || []).map((r) => ({ ...r, isReset: r.kind === 'reset' })) }, 200, origin);
}

/** 标记某条反馈为已处理。 */
async function handleAdminFeedbackResolve(request, env, origin) {
  const url = new URL(request.url);
  const id = Number.parseInt(url.searchParams.get('id') || '0', 10);
  if (!Number.isFinite(id) || id < 1) return fail('缺少反馈 id', 400, origin);
  await env.DB.prepare(`UPDATE feedback SET status = 'done' WHERE id = ?`).bind(id).run();
  return jsonRes({ id, resolved: true }, 200, origin);
}

/** 删除单条反馈记录（防止反馈积压占用 D1 存储）。 */
async function handleAdminFeedbackDelete(request, env, origin) {
  const url = new URL(request.url);
  const id = Number.parseInt(url.searchParams.get('id') || '0', 10);
  if (!Number.isFinite(id) || id < 1) return fail('缺少反馈 id', 400, origin);
  const res = await env.DB.prepare(`DELETE FROM feedback WHERE id = ?`).bind(id).run();
  const deleted = (res && res.meta && res.meta.changes) || 0;
  return jsonRes({ id, deleted }, 200, origin);
}

/** 批量清理反馈记录：默认只删「已处理」(done)；all=true 时删除全部（用于彻底腾出 D1 空间）。 */
async function handleAdminFeedbackPurge(request, env, origin) {
  const body = await readJson(request);
  const all = body && body.all === true;
  const sql = all ? `DELETE FROM feedback` : `DELETE FROM feedback WHERE status = 'done'`;
  const res = await env.DB.prepare(sql).run();
  const purged = (res && res.meta && res.meta.changes) || 0;
  return jsonRes({ purged, all }, 200, origin);
}

async function handleMembership(origin) {
  return jsonRes({ lifetime: true, priceFen: 1990 }, 200, origin);
}

/* ------------------------------------------------------------------ */
/* 备份导出 / 导入                                                     */
/*                                                                    */
/* 备份为明文 JSON：导出/导入都不依赖任何服务端密钥，用户换账号、换实例    */
/* 都能直接导入。注意备份文件内含 AI API Key 与小程序接口密钥（完整还原    */
/* 所需），请像保管密码一样保管备份文件，不要发到公开渠道。               */
/* ------------------------------------------------------------------ */

/** 组装明文备份文档（无加密、无密钥依赖）。 */
function buildPayload(account, events, gifts, ai, apiKey) {
  return {
    app: 'gift-ledger',
    kind: 'full',
    alg: 'plain',
    version: 2,
    exportedAt: nowIso(),
    account,
    events,
    gifts,
    // 全栈备份附加项：AI 模型配置与接口密钥（旧备份无这两个字段时按 undefined 处理）
    ai: ai
      ? {
          baseUrl: ai.ai_base_url || '',
          apiKey: ai.ai_api_key || '',
          model: ai.ai_model || '',
        }
      : undefined,
    apiKey,
  };
}

/** 读取明文备份文档。备份全程无加密、无密钥依赖。 */
function openPayload(doc) {
  if (!doc || typeof doc !== 'object') throw new Error('无法识别的备份文件格式');
  if (Array.isArray(doc.events) || Array.isArray(doc.gifts)) return doc;
  throw new Error('无法识别的备份文件格式');
}

async function handleExportBackup(env, account, origin) {
  const { events, gifts } = await loadAccountData(env, account);

  // 全栈备份：连同该账号的 AI 配置与（明文）接口密钥一起导出，
  // 换实例部署后可一键恢复（AI 模型服务/小程序绑定），不必重新配置。
  let ai = null;
  let apiKey = null;
  if (account.startsWith('user:') || account.startsWith('phone:')) {
    const aiRow = await env.DB.prepare(
      'SELECT ai_base_url, ai_api_key, ai_model FROM account_settings WHERE account = ?'
    )
      .bind(account)
      .first();
    // 仅当确有配置时才写入备份（注册时生成的全空默认行不备份）
    if (aiRow && (aiRow.ai_base_url || aiRow.ai_api_key || aiRow.ai_model)) ai = aiRow;
    const keyRow = await env.DB.prepare(
      'SELECT key, port, created_at FROM account_keys WHERE phone = ? ORDER BY created_at DESC LIMIT 1'
    )
      .bind(accountPhone(account))
      .first();
    if (keyRow) apiKey = { key: keyRow.key, apiPort: keyRow.port, createdAt: keyRow.created_at };
  } else {
    const deviceId = accountDevice(account);
    const s = await env.DB.prepare(
      'SELECT ai_base_url, ai_api_key, ai_model, api_key, api_port, api_key_created_at FROM device_settings WHERE device_id = ?'
    )
      .bind(deviceId)
      .first();
    // 仅当确有配置时才写入备份（全空行不备份）
    ai = s && (s.ai_base_url || s.ai_api_key || s.ai_model) ? s : null;
    if (s && s.api_key) apiKey = { key: s.api_key, apiPort: s.api_port || 0, createdAt: s.api_key_created_at || '' };
  }

  const payload = buildPayload(account, events, gifts, ai, apiKey);
  return new Response(JSON.stringify(payload, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="gift-ledger-backup-${todayStr()}.json"`,
      'Cache-Control': 'no-store',
      ...corsHeaders(origin),
    },
  });
}

async function handleImportBackup(request, env, account, origin) {
  let form;
  try {
    form = await request.formData();
  } catch {
    return fail('请求格式错误', 400, origin);
  }
  const file = form.get('file');
  if (!file || typeof file === 'string') return fail('请选择备份文件', 400, origin);

  let doc;
  try {
    doc = JSON.parse(await file.text());
  } catch {
    return fail('备份文件不是有效的 JSON', 400, origin);
  }

  let payload;
  try {
    payload = openPayload(doc);
  } catch (e) {
    return fail(e && e.message ? e.message : '备份文件无法解析', 400, origin);
  }
  if (!payload) return fail('备份文件内容不完整', 400, origin);

  const now = nowIso();
  const incomingEvents = Array.isArray(payload.events) ? payload.events : [];
  const incomingGifts = Array.isArray(payload.gifts) ? payload.gifts : [];

  const existingEvents = await env.DB.prepare('SELECT id, type, date FROM events WHERE account = ?')
    .bind(account)
    .all();
  const eventByKey = new Map((existingEvents.results || []).map((e) => [`${e.type}\u0000${e.date}`, e.id]));

  const statements = [];
  const eventIdMap = new Map();
  let importedEvents = 0;
  let skippedEvents = 0;

  for (const ev of incomingEvents) {
    if (!ev || typeof ev !== 'object') continue;
    const type = EVENT_TYPES.has(ev.type) ? ev.type : 'other';
    const date = isValidDate(ev.date) ? ev.date : null;
    if (!date) continue;
    const key = `${type}\u0000${date}`;
    let targetId = eventByKey.get(key);
    if (targetId) {
      skippedEvents++;
    } else {
      targetId = crypto.randomUUID();
      eventByKey.set(key, targetId);
      statements.push(
        env.DB.prepare(
          `INSERT INTO events (id, device_id, account, name, type, date, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).bind(targetId, '', account, asString(ev.name, 60).trim() || EVENT_LABELS[type], type, date, now)
      );
      importedEvents++;
    }
    if (ev.id) eventIdMap.set(String(ev.id), targetId);
  }

  const existingGifts = await env.DB.prepare(
    `SELECT event_id, person, direction, amount_fen, date, note, relation FROM gifts WHERE account = ?`
  )
    .bind(account)
    .all();
  const giftKeys = new Set(
    (existingGifts.results || []).map((g) =>
      [g.event_id, g.person, g.direction, g.amount_fen, g.date, g.note || '', g.relation || ''].join('\u0001')
    )
  );

  let importedGifts = 0;
  let skippedGifts = 0;

  for (const g of incomingGifts) {
    if (!g || typeof g !== 'object') continue;
    const person = asString(g.person, 80).trim();
    const direction = g.direction === 'in' || g.direction === 'out' ? g.direction : null;
    const amountFen = Number(g.amountFen);
    const date = isValidDate(g.date) ? g.date : null;
    if (!person || !direction || !Number.isInteger(amountFen) || amountFen <= 0 || !date) {
      skippedGifts++;
      continue;
    }

    let eventId = eventIdMap.get(String(g.eventId));
    if (!eventId) eventId = eventByKey.get(`other\u0000${date}`) || null;
    if (!eventId) {
      skippedGifts++;
      continue;
    }

    const relation = RELATIONS.has(g.relation) ? g.relation : '朋友';
    const note = asString(g.note, 500).trim();
    const method = METHODS.has(g.method) ? g.method : 'cash';
    const dedupeKey = [eventId, person, direction, amountFen, date, note, relation].join('\u0001');
    if (giftKeys.has(dedupeKey)) {
      skippedGifts++;
      continue;
    }
    giftKeys.add(dedupeKey);

    statements.push(
      env.DB.prepare(
        `INSERT INTO gifts
         (id, device_id, account, event_id, person, relation, direction, amount_fen, method, date, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(crypto.randomUUID(), '', account, eventId, person, relation, direction, amountFen, method, date, note, now)
    );
    importedGifts++;
  }

  for (let i = 0; i < statements.length; i += 50) {
    await env.DB.batch(statements.slice(i, i + 50));
  }

  // 全栈备份恢复：AI 配置与接口密钥（仅当备份内含对应字段；旧备份无则跳过）
  let restored = 0;
  const isPhoneAccount = account.startsWith('user:') || account.startsWith('phone:');
  if (payload.ai && (payload.ai.baseUrl || payload.ai.model || payload.ai.apiKey)) {
    const ai = payload.ai;
    const base = asString(ai.baseUrl, 300).trim();
    const model = asString(ai.model, 120).trim();
    const aiKey = asString(ai.apiKey, 500).trim();
    if (isPhoneAccount) {
      await env.DB.prepare(
        `INSERT INTO account_settings (account, ai_base_url, ai_api_key, ai_model) VALUES (?, ?, ?, ?)
         ON CONFLICT(account) DO UPDATE SET
           ai_base_url = excluded.ai_base_url,
           ai_api_key = excluded.ai_api_key,
           ai_model = excluded.ai_model`
      )
        .bind(account, base, aiKey, model)
        .run();
    } else {
      const deviceId = accountDevice(account);
      await env.DB.prepare(
        `INSERT INTO device_settings (device_id, ai_base_url, ai_api_key, ai_model) VALUES (?, ?, ?, ?)
         ON CONFLICT(device_id) DO UPDATE SET
           ai_base_url = excluded.ai_base_url,
           ai_api_key = excluded.ai_api_key,
           ai_model = excluded.ai_model`
      )
        .bind(deviceId, base, aiKey, model)
        .run();
    }
    restored++;
  }
  if (payload.apiKey && payload.apiKey.key) {
    const ak = payload.apiKey;
    const port = Number(ak.apiPort) || 0;
    if (isPhoneAccount) {
      // key 是全局主键：备份里的密钥可能仍属于导出方账号，先清掉其它账号的同名记录，
      // 否则跨账号导入会撞主键（UNIQUE constraint failed: account_keys.key）。
      await env.DB.prepare('DELETE FROM account_keys WHERE key = ?').bind(ak.key).run();
      await env.DB.prepare('DELETE FROM account_keys WHERE phone = ?')
        .bind(accountPhone(account))
        .run();
      await env.DB.prepare('INSERT INTO account_keys (key, phone, port, created_at) VALUES (?, ?, ?, ?)')
        .bind(ak.key, accountPhone(account), port, nowIso())
        .run();
    } else {
      const deviceId = accountDevice(account);
      await env.DB.prepare(
        `INSERT INTO device_settings (device_id, api_key, api_port, api_key_created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(device_id) DO UPDATE SET
           api_key = excluded.api_key,
           api_port = excluded.api_port,
           api_key_created_at = excluded.api_key_created_at`
      )
        .bind(deviceId, ak.key, port, nowIso())
        .run();
    }
    restored++;
  }

  return jsonRes({ importedEvents, importedGifts, skippedEvents, skippedGifts, restored }, 200, origin);
}

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */

// 演示数据引导：每个 isolate 只跑一次。先幂等建表（全新部署首请求表可能还没建），
// 再 seed；ensureDemoData 内部用 admin_settings 标记保证跨 isolate 幂等。
let demoBooted = false;
async function bootDemo(env) {
  if (demoBooted || !env || !env.DB) return;
  demoBooted = true;
  try { await ensureSchema(env.DB); } catch { /* 建表失败交给后续自愈 */ }
  await ensureDemoData(env);
  // 固定演示账号的接口密钥：无论是否本次 seed，每个 isolate 启动时都幂等校正一次，
  // 保证老版本 seed 已存在、或被人轮换过的 demo 账号都回到固定 key + 443。
  try { await ensureDemoApiKey(env); } catch { /* best-effort */ }
}

export default {
  async fetch(request, env) {
    // 演示数据：best-effort，不阻塞主流程；内部全部 try/catch
    await bootDemo(env);

    // 保留一份 body 克隆：body 流只能被消费一次。自愈"缺表/缺列"后重试时，
    // 用克隆体重建 Request，避免"流已消费"导致旧库升级后首次写操作 500、二次才成功。
    let bodyClone = null;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      try { bodyClone = request.clone(); } catch { bodyClone = null; }
    }
    try {
      return await apiRequest(request, env);
    } catch (e) {
      // 兜底自愈：请求触发"数据库缺表/缺列/缺索引"（全新部署或旧库升级）时，
      // 自动执行 ensureSchema 补建并重试一次，无需进控制台。
      if (isNoSchemaError(e) && env.DB) {
        try {
          await ensureSchema(env.DB);
          let retryReq = request;
          if (bodyClone) {
            const t = await bodyClone.text();
            retryReq = new Request(request, { method: request.method, headers: request.headers, body: t });
          }
          return await apiRequest(retryReq, env);
        } catch (e2) {
          console.error('auto-ensureSchema retry failed', e2 && e2.stack ? e2.stack : e2);
        }
      }
      console.error('unhandled error', e && e.stack ? e.stack : e);
      const origin = request.headers.get('Origin');
      return fail('服务暂时不可用，请稍后再试', 500, origin);
    }
  },
};

async function apiRequest(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const path = url.pathname.replace(/\/+$/, '') || '/';

    // 审计日志：记录请求来源 IP（best-effort，不影响主流程）
    const ip = clientIp(request);

    // 非 /api/* 的请求由静态资源（Worker Assets）处理；这里做兜底。
    if (!url.pathname.startsWith('/api/')) {
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return fail('页面不存在', 404, origin);
    }

    try {
      if (path === '/api/health' && request.method === 'GET') {
        // 数据库体检：dbReady=false 表示核心表尚未建好（全新部署且自愈未跑过）。
        // 任意 /api 请求遇到缺表会自动 ensureSchema 补建，这里仅用于部署后快速确认。
        let dbReady = true;
        if (env.DB) {
          try {
            dbReady = await isDbReady(env.DB);
          } catch {
            dbReady = false;
          }
        }
        const res = jsonRes(
          {
            ok: true,
            service: 'xiaozhou-ledger-web',
            time: nowIso(),
            dbReady,
          },
          200,
          origin
        );
        return res;
      }

      // ---- 账号管理（无需已有身份）----
      if (path === '/api/account/register' && request.method === 'POST') {
        const identity = await resolveIdentity(request, env);
        const res = await handleAccountRegister(request, env, identity, origin);
        const regPhone = (res.status < 400 && identity && identity.phone) ? String(identity.phone) : '';
        const regActor = regPhone ? `user:${regPhone}` : 'anonymous';
        await recordLog(env, { actor: regActor, action: 'register', target: regPhone, method: 'POST', path, status: res.status, ok: res.status < 400, ip, detail: res.status >= 400 ? '注册失败 ' + res.status : (regPhone ? '新注册 ' + regPhone : '') }, request);
        return res;
      }
      if (path === '/api/account/login' && request.method === 'POST') {
        const res = await handleAccountLogin(request, env, origin);
        let actor = 'anonymous';
        let phoneForLog = '';
        try {
          const b = await request.json();
          if (b && b.phone) { actor = `user:${String(b.phone)}`; phoneForLog = String(b.phone); }
        } catch {}
        const loginDetail = res.status < 400 ? '登录成功 ' + phoneForLog : ({ 404: '未注册', 403: '密码错误', 429: '频繁锁定' }[res.status] || '失败') + ' ' + phoneForLog;
        await recordLog(env, { actor, action: 'login', target: phoneForLog, method: 'POST', path, status: res.status, ok: res.status < 400, ip, detail: loginDetail }, request);
        return res;
      }
      if (path === '/api/account/check' && request.method === 'GET') {
        const res = await handleAccountCheck(request, env, origin);
        await recordLog(env, { actor: 'anonymous', action: 'read', target: '', method: 'GET', path, status: res.status, ok: res.status < 400, ip, detail: '' }, request);
        return res;
      }
      // ---- 忘记密码（公开，无需登录）----
      if (path === '/api/account/forgot' && request.method === 'GET') {
        return handleForgotInfo(env, origin);
      }
      if (path === '/api/account/forgot/request' && request.method === 'POST') {
        const res = await handleForgotRequest(request, env, origin);
        await recordLog(env, { actor: 'anonymous', action: 'feedback', target: '', method: 'POST', path, status: res.status, ok: res.status < 400, ip, detail: '提交密码重置申请' }, request);
        return res;
      }
      // ---- 管理后台（账号密码登录，独立于普通用户体系）----
      if (path === '/api/admin/login' && request.method === 'POST') {
        const res = await handleAdminLogin(request, env, origin);
        await recordLog(env, { actor: 'admin', action: 'admin.login', target: '', method: 'POST', path, status: res.status, ok: res.status < 400, ip, detail: res.status < 400 ? 'admin 登录成功' : 'admin 登录失败/未配置' }, request);
        return res;
      }
      // 命令行管理接口：用 X-Admin-Key 鉴权，必须放在下面 X-Admin-Token 拦截之前
      if (path === '/api/admin/reset-password' && request.method === 'POST') {
        const res = await handleAdminResetPassword(request, env, origin);
        await recordLog(env, { actor: 'admin', action: 'admin.reset-password', target: '', method: 'POST', path, status: res.status, ok: res.status < 400, ip, detail: '重置账号密码' }, request);
        return res;
      }
      if (path === '/api/admin/purge-account' && request.method === 'POST') {
        const res = await handleAdminPurge(request, env, origin);
        await recordLog(env, { actor: 'admin', action: 'admin.purge-account', target: '', method: 'POST', path, status: res.status, ok: res.status < 400, ip, detail: '清空账号全部数据' }, request);
        return res;
      }

      // 网页管理后台接口：统一用 X-Admin-Token 鉴权
      if (path.startsWith('/api/admin/')) {
        const isAdmin = await verifyAdminToken(request, env);
        if (!isAdmin) {
          const res = fail('管理员身份无效或已过期，请重新登录', 401, origin);
          await recordLog(env, { actor: 'admin', action: classifyAction(request.method, path), target: '', method: request.method, path, status: 401, ok: false, ip, detail: '鉴权失败' }, request);
          return res;
        }
        // 惰性清理：admin 请求时顺手把超过保留天数的旧日志删掉（内部 1 小时节流，best-effort）
        await maybeLazyPurgeLogs(env, request);
        const adminLog = async (resOrPromise, detail, target) => {
          const res = await resOrPromise;
          await recordLog(env, { actor: 'admin', action: classifyAction(request.method, path), target: target || '', method: request.method, path, status: res.status, ok: res.status < 400, ip, detail: (res && res.__logDetail) || detail || '' }, request);
          return res;
        };
        if (path === '/api/admin/users' && request.method === 'GET') {
          return adminLog(handleAdminUsers(request, env, origin));
        }
        if (path === '/api/admin/user/create' && request.method === 'POST') {
          return adminLog(await handleAdminUserCreate(request, env, origin));
        }
        if (path === '/api/admin/user/update' && request.method === 'POST') {
          return adminLog(await handleAdminUserUpdate(request, env, origin));
        }
        if (path === '/api/admin/user/delete' && request.method === 'POST') {
          return adminLog(await handleAdminUserDelete(request, env, origin));
        }
        if (path === '/api/admin/export-all' && request.method === 'GET') {
          return adminLog(handleAdminExportAll(env, origin));
        }
        if (path === '/api/admin/import-all' && request.method === 'POST') {
          return adminLog(await handleAdminImportAll(request, env, origin));
        }
        // ---- 按账号管理（编辑任意用户的数据/配置 + 单账号导入导出）----
        const qPhone = path.includes('/api/admin/') ? (new URL(request.url).searchParams.get('phone') || '') : '';
        if (path === '/api/admin/account/data' && request.method === 'GET') {
          return adminLog(await handleAdminAccountData(request, env, origin), '查 ' + qPhone, qPhone);
        }
        if (path === '/api/admin/account/event' && request.method === 'POST') {
          return adminLog(await handleAdminAccountEvent(request, env, origin), '改活动 ' + qPhone, qPhone);
        }
        if (path === '/api/admin/account/event/delete' && request.method === 'POST') {
          return adminLog(await handleAdminAccountEventDelete(request, env, origin), '删活动 ' + qPhone, qPhone);
        }
        if (path === '/api/admin/account/gift' && request.method === 'POST') {
          return adminLog(await handleAdminAccountGift(request, env, origin), '改礼金 ' + qPhone, qPhone);
        }
        if (path === '/api/admin/account/gift/delete' && request.method === 'POST') {
          return adminLog(await handleAdminAccountGiftDelete(request, env, origin), '删礼金 ' + qPhone, qPhone);
        }
        if (path === '/api/admin/account/settings' && request.method === 'POST') {
          return adminLog(await handleAdminAccountSettings(request, env, origin), '改配置 ' + qPhone, qPhone);
        }
        if (path === '/api/admin/account/apikey' && request.method === 'POST') {
          return adminLog(await handleAdminAccountApiKey(request, env, origin), '改密钥 ' + qPhone, qPhone);
        }
        if (path === '/api/admin/account/device' && request.method === 'POST') {
          return adminLog(await handleAdminAccountDevice(request, env, origin), '解绑设备 ' + qPhone, qPhone);
        }
        if (path === '/api/admin/account/export' && request.method === 'GET') {
          return adminLog(handleAdminAccountExport(request, env, origin), '导出 ' + qPhone, qPhone);
        }
        if (path === '/api/admin/account/import' && request.method === 'POST') {
          return adminLog(await handleAdminAccountImport(request, env, origin), '导入 ' + qPhone, qPhone);
        }
        // ---- 全栈操作日志 ----
        if (path === '/api/admin/logs' && request.method === 'GET') {
          return adminLog(handleAdminLogs(request, env, origin));
        }
        if (path === '/api/admin/logs/purge' && request.method === 'POST') {
          return adminLog(await handleAdminLogsPurge(request, env, origin), '清理日志');
        }
        if (path === '/api/admin/logs/export' && request.method === 'GET') {
          return adminLog(handleAdminLogsExport(request, env, origin), '导出日志');
        }
        // ---- 管理员运行参数（日志保留天数等）----
        if (path === '/api/admin/settings' && request.method === 'GET') {
          return adminLog(handleAdminSettingsGet(env, origin));
        }
        if (path === '/api/admin/settings' && request.method === 'POST') {
          return adminLog(await handleAdminSettingsSave(request, env, origin), '保存运行参数');
        }
        // ---- 意见反馈（查看 / 标记已处理 / 删除 / 批量清理）----
        if (path === '/api/admin/feedbacks' && request.method === 'GET') {
          return adminLog(handleAdminFeedbacks(request, env, origin), '查反馈');
        }
        if (path === '/api/admin/feedback/resolve' && request.method === 'POST') {
          return adminLog(handleAdminFeedbackResolve(request, env, origin), '标记反馈已处理');
        }
        if (path === '/api/admin/feedback/delete' && request.method === 'POST') {
          return adminLog(handleAdminFeedbackDelete(request, env, origin), '删除反馈');
        }
        if (path === '/api/admin/feedback/purge' && request.method === 'POST') {
          return adminLog(await handleAdminFeedbackPurge(request, env, origin), '批量清理反馈');
        }
      }

      const identity = await resolveIdentity(request, env);
      const actor = actorOf(identity, false);
      if (!identity.account) {
        const res = fail('未登录或接口密钥无效', 401, origin);
        await recordLog(env, { actor, action: classifyAction(request.method, path), target: '', method: request.method, path, status: 401, ok: false, ip, detail: '未认证' });
        return res;
      }
      // 旧 PIN 体系账号（phone:）访问需继续校验 PIN（X-Ledger-Pin）；新体系（user:）靠 JWT。
      if (identity.account.startsWith('phone:') && !identity.viaKey) {
        const pin = (request.headers.get('X-Ledger-Pin') || '').trim();
        const ok = await verifyPin(env, identity.phone, pin);
        if (!ok) {
          const res = fail('PIN 不正确', 403, origin);
          await recordLog(env, { actor, action: classifyAction(request.method, path), target: '', method: request.method, path, status: 403, ok: false, ip, detail: 'PIN 校验失败' });
          return res;
        }
      }
      await ensureIdentity(env, identity);
      const account = accOf(identity);

      // 普通用户请求统一走日志：记录操作人/动作/目标/状态码（纯只读 GET 会被降级矩阵跳过）
      const userLog = async (resOrPromise, detail) => {
        const res = await resOrPromise;
        await recordLog(env, { actor, action: classifyAction(request.method, path), target: account || '', method: request.method, path, status: res.status, ok: res.status < 400, ip, detail: (res && res.__logDetail) || detail || '' }, request);
        return res;
      };

      if (path === '/api/session' && request.method === 'GET') {
        return userLog(handleSession(env, identity, origin));
      }

      if (path === '/api/account/device' && request.method === 'DELETE') {
        return userLog(await handleAccountUnbindDevice(request, env, identity, origin), '解绑设备');
      }

      // 个人中心：修改昵称 / 密码 / 绑定手机号（均需已登录账号）
      if (path === '/api/account/profile' && request.method === 'POST') {
        return userLog(await handleProfileUpdate(request, env, identity, origin), '改昵称');
      }
      if (path === '/api/account/password' && request.method === 'POST') {
        return userLog(await handlePasswordChange(request, env, identity, origin), '改密码');
      }
      if (path === '/api/account/phone' && request.method === 'POST') {
        return userLog(await handlePhoneChange(request, env, identity, origin), '换手机号');
      }

      if (path === '/api/events') {
        if (request.method === 'GET') return userLog(handleEventsGet(env, account, origin));
        if (request.method === 'POST') return userLog(await handleEventsCreate(request, env, account, origin), '新增活动');
      }

      if (path.startsWith('/api/events/')) {
        const eventId = decodeURIComponent(path.slice('/api/events/'.length));
        if (eventId) {
          if (request.method === 'POST') return userLog(await handleEventUpdate(request, env, account, eventId, origin), '改活动 ' + eventId);
          if (request.method === 'DELETE') return userLog(handleEventDelete(env, account, eventId, origin), '删活动 ' + eventId);
        }
      }

      if (path === '/api/gifts') {
        if (request.method === 'GET') return userLog(handleGiftsGet(request, env, account, origin));
        if (request.method === 'POST') return userLog(await handleGiftsCreate(request, env, account, origin), '新增礼金');
      }

      if (path.startsWith('/api/gifts/')) {
        const giftId = decodeURIComponent(path.slice('/api/gifts/'.length));
        if (giftId) {
          if (request.method === 'GET') return userLog(handleGiftGet(env, account, giftId, origin));
          if (request.method === 'PUT') return userLog(await handleGiftsUpdate(request, env, account, giftId, origin), '改礼金 ' + giftId);
          if (request.method === 'DELETE') return userLog(handleGiftsDelete(env, account, giftId, origin), '删礼金 ' + giftId);
        }
      }

      if (path === '/api/overview' && request.method === 'GET') {
        return userLog(handleOverview(env, account, origin));
      }
      if (path === '/api/people' && request.method === 'GET') {
        return userLog(handlePeople(env, account, origin));
      }
      if (path === '/api/report/yearly' && request.method === 'GET') {
        return userLog(await handleYearlyReport(request, env, account, origin));
      }
      if (path === '/api/export/csv' && request.method === 'GET') {
        return userLog(handleExportCsv(request, env, account, origin));
      }

      if (path === '/api/ai/config') {
        if (request.method === 'GET') return userLog(handleAiConfigGet(env, account, origin));
        if (request.method === 'POST') return userLog(await handleAiConfigSave(request, env, account, origin), '保存 AI 配置');
      }
      if (path === '/api/ai/parse' && request.method === 'POST') {
        return userLog(await handleAiParse(request, env, account, origin), 'AI 解析');
      }

      if (path === '/api/apikey' && request.method === 'GET') {
        return userLog(handleApiKeyGet(env, account, origin));
      }
      if (path === '/api/apikey/rotate' && request.method === 'POST') {
        return userLog(await handleApiKeyRotate(env, account, origin), '重新生成密钥');
      }
      if (path === '/api/apikey/port' && request.method === 'POST') {
        return userLog(await handleApiKeyPort(request, env, account, origin), '改密钥端口');
      }

      if (path === '/api/feedback' && request.method === 'POST') {
        return userLog(await handleFeedback(request, env, account, origin), '意见反馈');
      }

      if (path === '/api/export/backup' && request.method === 'GET') {
        return userLog(handleExportBackup(env, account, origin), '导出备份');
      }
      if (path === '/api/import/backup' && request.method === 'POST') {
        return userLog(await handleImportBackup(request, env, account, origin), '导入备份');
      }

      if (path === '/api/membership' && request.method === 'GET') {
        return userLog(handleMembership(origin));
      }
      if (
        (path === '/api/membership/order' || path === '/api/membership/order/status') &&
        request.method === 'POST'
      ) {
        const res = fail('当前为永久完整版，无需购买', 400, origin);
        await userLog(res);
        return res;
      }

      const nfRes = fail('接口不存在', 404, origin);
      await recordLog(env, { actor, action: classifyAction(request.method, path), target: account || '', method: request.method, path, status: 404, ok: false, ip, detail: '接口不存在 ' + path }, request);
      return nfRes;
    } catch (e) {
      // 让错误冒到外层 fetch：缺表(1101)时由外层自动 ensureSchema 并重试一次
      throw e;
    }
  }
