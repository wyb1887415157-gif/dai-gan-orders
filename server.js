"use strict";

// ==================== 代肝订单管理 - 后端服务 ====================
// 启动: npm start   (默认端口 3456)
// 环境变量: ADMIN_KEY  PHONE_KEY  SMTP_USER  SMTP_PASS  NOTIFY_EMAIL  PORT
//           DB_HOST  DB_PORT  DB_USER  DB_PASSWORD  DB_NAME  (MySQL 模式)
//           未设置 DB_HOST 时自动使用本地 SQLite，无需任何配置

const express    = require("express");
const cors       = require("cors");
const helmet     = require("helmet");
const rateLimit  = require("express-rate-limit");
const crypto     = require("crypto");
const path       = require("path");
const nodemailer = require("nodemailer");

// ==================== 邮件配置 ====================
const SMTP_USER    = process.env.SMTP_USER    || "3532368834@qq.com";
const SMTP_PASS    = process.env.SMTP_PASS    || "";
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || "3532368834@qq.com";

let mailer = null;
if (SMTP_PASS) {
  mailer = nodemailer.createTransport({
    host: "smtp.qq.com",
    port: 465,
    secure: true,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  console.log("📧 邮件通知已配置 → " + NOTIFY_EMAIL);
} else {
  console.log("⚠️  未设置 SMTP_PASS，邮件通知暂不可用");
}

async function sendOrderNotify(order) {
  if (!mailer) return;
  try {
    const status = order.is_completed ? "已完成" : "进行中";
    const content = order.content.length > 100 ? order.content.slice(0, 100) + "..." : order.content;
    await mailer.sendMail({
      from: SMTP_USER,
      to: NOTIFY_EMAIL,
      subject: `🛒 新订单通知 — ¥${Number(order.price).toFixed(2)}`,
      html: `
        <div style="max-width:500px;margin:0 auto;font-family:sans-serif;">
          <h2 style="color:#5b9bd5;">🌸 代肝鹤临 — 新订单通知</h2>
          <table style="width:100%;border-collapse:collapse;">
            <tr><td style="padding:8px;border-bottom:1px solid #eee;color:#888;">日期</td><td style="padding:8px;border-bottom:1px solid #eee;"><strong>${order.date}</strong></td></tr>
            <tr><td style="padding:8px;border-bottom:1px solid #eee;color:#888;">内容</td><td style="padding:8px;border-bottom:1px solid #eee;">${content}</td></tr>
            <tr><td style="padding:8px;border-bottom:1px solid #eee;color:#888;">价格</td><td style="padding:8px;border-bottom:1px solid #eee;font-size:1.2em;color:#e07070;"><strong>¥${Number(order.price).toFixed(2)}</strong></td></tr>
            <tr><td style="padding:8px;border-bottom:1px solid #eee;color:#888;">状态</td><td style="padding:8px;border-bottom:1px solid #eee;">${status}</td></tr>
            <tr><td style="padding:8px;color:#888;">时间</td><td style="padding:8px;">${new Date().toLocaleString("zh-CN")}</td></tr>
          </table>
          <p style="color:#aaa;font-size:12px;margin-top:20px;">登录管理后台查看手机号等详细信息</p>
        </div>`,
    });
    console.log("📧 邮件已发送 → " + NOTIFY_EMAIL);
  } catch (e) {
    console.error("📧 邮件发送失败:", e.message);
  }
}

// ==================== 配置 ====================
const PORT      = process.env.PORT      || 3456;
const ADMIN_KEY = process.env.ADMIN_KEY || "1887415157";
const PHONE_KEY = process.env.PHONE_KEY || "phone-encrypt-key32!";

// 确保 phone key 是 32 字节
const PHONE_KEY_BUF = Buffer.alloc(32);
const keyRaw = Buffer.from(PHONE_KEY.slice(0, 32), "utf-8");
for (let i = 0; i < Math.min(keyRaw.length, 32); i++) PHONE_KEY_BUF[i] = keyRaw[i];

// ==================== 数据库（MySQL 优先，SQLite 降级）====================
let db = null;       // { execute(sql, params): Promise<[rows, meta?]> }
let dbType = "";

async function createMySQLBackend() {
  const mysql = require("mysql2/promise");
  const cfg = {
    host:     process.env.DB_HOST || "localhost",
    port:     Number(process.env.DB_PORT) || 3306,
    user:     process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "dai_gan",
    waitForConnections: true,
    connectionLimit: 5,
    charset: "utf8mb4",
    connectTimeout: 10000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 30000,
  };
  const pool = mysql.createPool(cfg);
  // 处理空闲连接被服务端关闭导致的 EPIPE
  pool.on('error', (err) => {
    if (err.code === 'EPIPE' || err.code === 'ECONNRESET') {
      console.log('⚠️  连接池空闲连接失效（正常现象，已自动重建）');
    } else {
      console.error('MySQL 连接池错误:', err.message);
    }
  });
  // 测试连接
  const conn = await pool.getConnection();
  conn.release();

  // 建表
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS orders (
      id VARCHAR(32) PRIMARY KEY,
      date VARCHAR(10) NOT NULL,
      phone_enc VARCHAR(255) NOT NULL DEFAULT '',
      content TEXT NOT NULL,
      price DECIMAL(10,2) NOT NULL DEFAULT 0,
      is_completed TINYINT(1) NOT NULL DEFAULT 0,
      images JSON,
      created DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS price_list (
      id VARCHAR(32) PRIMARY KEY,
      game VARCHAR(100) NOT NULL DEFAULT '',
      name VARCHAR(255) NOT NULL,
      category VARCHAR(100) NOT NULL DEFAULT '',
      price DECIMAL(10,2) NOT NULL DEFAULT 0,
      is_deleted TINYINT(1) NOT NULL DEFAULT 0,
      created DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS price_images (
      id VARCHAR(32) PRIMARY KEY,
      data_url MEDIUMTEXT NOT NULL,
      name VARCHAR(100) NOT NULL DEFAULT '价格表',
      game VARCHAR(100) NOT NULL DEFAULT '',
      created DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // 迁移：老库补字段（price_list: category/is_deleted；price_images: game）
  try {
    const [cols] = await pool.execute(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'price_list'"
    );
    const has = (c) => cols.some((r) => r.COLUMN_NAME === c);
    if (!has("category")) {
      await pool.execute("ALTER TABLE price_list ADD COLUMN category VARCHAR(100) NOT NULL DEFAULT ''");
    }
    if (!has("is_deleted")) {
      await pool.execute("ALTER TABLE price_list ADD COLUMN is_deleted TINYINT(1) NOT NULL DEFAULT 0");
    }
  } catch (e) {
    console.error("price_list 迁移失败:", e.message);
  }
  try {
    const [icols] = await pool.execute(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'price_images'"
    );
    if (!icols.some((r) => r.COLUMN_NAME === "game")) {
      await pool.execute("ALTER TABLE price_images ADD COLUMN game VARCHAR(100) NOT NULL DEFAULT ''");
    }
  } catch (e) {
    console.error("price_images 迁移失败:", e.message);
  }

  return {
    type: "MySQL",
    info: `${cfg.host}:${cfg.port}/${cfg.database}`,
    pool,  // 供优雅关闭使用
    execute: (sql, params) => pool.execute(sql, params),
  };
}

function createSQLiteBackend() {
  const Database = require("better-sqlite3");
  const dbFile = path.join(__dirname, "data.db");
  const sqlite = new Database(dbFile);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  // 建表（SQLite 语法）
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      phone_enc TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL,
      price REAL NOT NULL DEFAULT 0,
      is_completed INTEGER NOT NULL DEFAULT 0,
      images TEXT DEFAULT '[]',
      created TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )
  `);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS price_list (
      id TEXT PRIMARY KEY,
      game TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT '',
      price REAL NOT NULL DEFAULT 0,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      created TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )
  `);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS price_images (
      id TEXT PRIMARY KEY,
      data_url TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '价格表',
      game TEXT NOT NULL DEFAULT '',
      created TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )
  `);

  // 迁移：老库补字段（price_list: category/is_deleted；price_images: game）
  const pCols = sqlite.prepare("PRAGMA table_info(price_list)").all();
  if (!pCols.some((c) => c.name === "category")) {
    sqlite.exec("ALTER TABLE price_list ADD COLUMN category TEXT NOT NULL DEFAULT ''");
  }
  if (!pCols.some((c) => c.name === "is_deleted")) {
    sqlite.exec("ALTER TABLE price_list ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0");
  }
  const iCols = sqlite.prepare("PRAGMA table_info(price_images)").all();
  if (!iCols.some((c) => c.name === "game")) {
    sqlite.exec("ALTER TABLE price_images ADD COLUMN game TEXT NOT NULL DEFAULT ''");
  }

  function doExec(sql, params = []) {
    const trimmed = sql.trim().toUpperCase();
    if (trimmed.startsWith("SELECT")) {
      const stmt = sqlite.prepare(sql);
      const rows = params.length ? stmt.all(...params) : stmt.all();
      return Promise.resolve([rows]);
    } else {
      const stmt = sqlite.prepare(sql);
      const result = params.length ? stmt.run(...params) : stmt.run();
      return Promise.resolve([{ affectedRows: result.changes, insertId: result.lastInsertRowid }]);
    }
  }

  return {
    type: "SQLite",
    info: dbFile,
    execute: doExec,
  };
}

async function initDB() {
  // 生产环境（设置了 DB_HOST）：必须用 MySQL，失败则重试，绝不降级
  if (process.env.DB_HOST) {
    for (let retry = 0; retry < 10; retry++) {
      try {
        db = await createMySQLBackend();
        dbType = "MySQL";
        console.log(`✅ MySQL 已连接 → ${db.info}`);
        return;
      } catch (e) {
        console.log(`⚠️  MySQL 连接失败 (${e.message})，${5 * (retry + 1)}秒后重试...`);
        await new Promise(r => setTimeout(r, 5000));
      }
    }
    console.error("❌ MySQL 连接失败超过 10 次，退出");
    process.exit(1);
  }

  // 本地开发：没有 DB_HOST 才用 SQLite
  db = createSQLiteBackend();
  dbType = "SQLite";
  console.log(`✅ SQLite 已就绪 → ${db.info}`);
}

// ==================== 加密工具 ====================
function encryptPhone(plain) {
  if (!plain) return "";
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", PHONE_KEY_BUF, iv);
  let enc = cipher.update(plain, "utf-8", "hex");
  enc += cipher.final("hex");
  const tag = cipher.getAuthTag();
  return iv.toString("hex") + ":" + tag.toString("hex") + ":" + enc;
}

function decryptPhone(ciphertext) {
  if (!ciphertext) return "";
  try {
    const parts = ciphertext.split(":");
    if (parts.length !== 3) return "";
    const iv  = Buffer.from(parts[0], "hex");
    const tag = Buffer.from(parts[1], "hex");
    const decipher = crypto.createDecipheriv("aes-256-gcm", PHONE_KEY_BUF, iv);
    decipher.setAuthTag(tag);
    let dec = decipher.update(parts[2], "hex", "utf-8");
    dec += decipher.final("utf-8");
    return dec;
  } catch (e) {
    return "";
  }
}

function maskPhone(phone) {
  if (!phone || phone.length !== 11) return phone;
  return phone.slice(0, 3) + "****" + phone.slice(7);
}

// ==================== Express ====================
const app = express();
app.set('trust proxy', 1);  // Render 使用反向代理，必须启用

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

app.use(cors({
  origin: process.env.CORS_ORIGIN || "*",
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
  allowedHeaders: ["Content-Type", "X-Admin-Key"],
  maxAge: 86400,
}));

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: false, limit: "50mb" }));

// ==================== 限流 ====================
const publicLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "请求太频繁，请稍后再试。" },
});

const orderLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "下单太频繁，请稍后再试。" },
});

app.use(publicLimiter);

// ==================== 鉴权中间件 ====================
function adminAuth(req, res, next) {
  const key = req.headers["x-admin-key"] || "";
  if (key !== ADMIN_KEY) {
    return res.status(401).json({ error: "管理员密钥无效" });
  }
  next();
}

// ==================== 输入校验 ====================
function validatePhone(phone) {
  return /^1[3-9]\d{9}$/.test(phone);
}

function validateOrder(body) {
  const errors = [];
  if (!body.date || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) errors.push("日期格式无效");
  if (!body.phone || !validatePhone(body.phone)) errors.push("手机号格式无效（需11位）");
  if (typeof body.price !== "number" || body.price < 0) errors.push("价格无效");
  if (!body.content || typeof body.content !== "string" || body.content.trim().length === 0) errors.push("内容不能为空");
  if (body.content && body.content.length > 2000) errors.push("内容过长（最多2000字）");
  return errors;
}

function sanitize(str) {
  if (typeof str !== "string") return "";
  return str.replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").trim();
}

function generateId() {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 9);
}

function safeParseJSON(str, fallback) {
  try { return JSON.parse(str); } catch(e) { return fallback; }
}

// 统一转换 DB 行 → 前端需要的订单格式
function rowToOrder(r) {
  return {
    id: r.id,
    date: r.date,
    phone: decryptPhone(r.phone_enc),
    price: Number(r.price),
    content: r.content,
    isCompleted: !!r.is_completed,
    images: safeParseJSON(r.images, []),
    created: r.created,
  };
}

// ==================== API 路由 ====================

// 健康检查
app.get("/api/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ==================== 价格表图片 ====================
app.get("/api/price-images", async (req, res) => {
  try {
    // 去掉 ORDER BY，避免大图片排序撑爆 SQLPub 免费版 sort buffer
    const [rows] = await db.execute("SELECT id, data_url, name, game, created FROM price_images");
    rows.sort((a, b) => String(b.created || '').localeCompare(String(a.created || '')));
    // 只返回 dataUrl，不重复返回 data_url（减少响应体积）
    const result = rows.map(r => ({ id: r.id, dataUrl: r.data_url, name: r.name, game: r.game || '', created: r.created }));
    const totalSize = JSON.stringify(result).length;
    console.log(`📸 返回 ${result.length} 张价格图片，响应大小 ${(totalSize / 1024 / 1024).toFixed(2)} MB`);
    res.json(result);
  } catch (e) {
    console.error("查询价格图片失败:", e.message);
    res.status(500).json({ error: "服务器错误" });
  }
});

app.post("/api/price-images", adminAuth, async (req, res) => {
  try {
    const { dataUrl, name, game } = req.body;
    if (!dataUrl || typeof dataUrl !== "string") {
      return res.status(400).json({ error: "请上传有效的图片数据" });
    }
    if (!dataUrl.startsWith("data:image/")) {
      return res.status(400).json({ error: "图片格式无效，仅支持 data:image/ 格式" });
    }
    const sizeMB = (dataUrl.length / 1024 / 1024).toFixed(2);
    console.log(`📤 收到价格图片上传: name="${name}", game="${game}", base64 大小 ${sizeMB} MB`);
    // 手机截图 base64 通常 5-15MB，放宽到 15MB
    if (dataUrl.length > 15 * 1024 * 1024) {
      return res.status(400).json({ error: `图片太大（${sizeMB} MB，最大 15 MB），请压缩后再上传` });
    }
    const id = generateId();
    await db.execute(
      "INSERT INTO price_images (id, data_url, name, game) VALUES (?, ?, ?, ?)",
      [id, dataUrl, sanitize(name) || "价格表", sanitize(game)]
    );
    console.log(`✅ 价格图片已入库: id=${id}, size=${sizeMB} MB`);
    res.json({ ok: true, id });
  } catch (e) {
    // 打印完整错误（含 code, errno 等），方便定位 MySQL packet 超限等问题
    console.error("上传价格图片失败:", e);
    const msg = e.code === "ER_NET_PACKET_TOO_LARGE"
      ? "图片太大，超过数据库允许的包大小上限，请压缩图片"
      : "上传失败: " + (e.message || "未知错误");
    res.status(500).json({ error: msg });
  }
});

app.delete("/api/price-images/:id", adminAuth, async (req, res) => {
  try {
    await db.execute("DELETE FROM price_images WHERE id = ?", [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error("删除价格图片失败:", e.message);
    res.status(500).json({ error: "删除失败" });
  }
});

// ==================== 文字价格表 ====================
app.get("/api/price-list", async (req, res) => {
  try {
    const [rows] = await db.execute("SELECT id, game, name, category, price, is_deleted FROM price_list");
    rows.sort((a, b) => {
      const g = String(a.game || '').localeCompare(String(b.game || ''));
      if (g !== 0) return g;
      return String(a.created || '').localeCompare(String(b.created || ''));
    });
    res.json(rows.map(r => ({ ...r, price: Number(r.price) })));
  } catch (e) {
    console.error("查询价格表失败:", e.message);
    res.status(500).json({ error: "服务器错误" });
  }
});

app.post("/api/price-list", adminAuth, async (req, res) => {
  try {
    const { game, name, price, category, tombstone } = req.body;
    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return res.status(400).json({ error: "项目名称不能为空" });
    }
    const id = generateId();
    if (tombstone) {
      // 墓碑记录：软删除"默认价格条目"（无 DB id 的条目）时插入，
      // 前端合并逻辑据此隐藏同名默认条目
      await db.execute(
        "INSERT INTO price_list (id, game, name, category, price, is_deleted) VALUES (?, ?, ?, '', 0, 1)",
        [id, sanitize(game), sanitize(name)]
      );
      return res.json({ ok: true, id });
    }
    if (typeof price !== "number" || price <= 0) {
      return res.status(400).json({ error: "价格必须大于 0" });
    }
    await db.execute(
      "INSERT INTO price_list (id, game, name, category, price) VALUES (?, ?, ?, ?, ?)",
      [id, sanitize(game), sanitize(name), sanitize(category), price]
    );
    res.json({ ok: true, id });
  } catch (e) {
    console.error("添加价格项目失败:", e.message);
    res.status(500).json({ error: "添加失败" });
  }
});

app.put("/api/price-list/:id", adminAuth, async (req, res) => {
  try {
    const { game, name, price, category } = req.body;
    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return res.status(400).json({ error: "项目名称不能为空" });
    }
    const [result] = await db.execute(
      "UPDATE price_list SET game = ?, name = ?, category = ?, price = ? WHERE id = ?",
      [sanitize(game), sanitize(name), sanitize(category), price || 0, req.params.id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: "项目不存在" });
    res.json({ ok: true });
  } catch (e) {
    console.error("更新价格项目失败:", e.message);
    res.status(500).json({ error: "更新失败" });
  }
});

app.delete("/api/price-list/:id", adminAuth, async (req, res) => {
  try {
    // 软删除：记录保留（is_deleted=1），同时挡住同名默认条目
    await db.execute("UPDATE price_list SET is_deleted = 1 WHERE id = ?", [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error("删除价格项目失败:", e.message);
    res.status(500).json({ error: "删除失败" });
  }
});

// ==================== 订单 ====================
app.post("/api/orders", orderLimiter, async (req, res) => {
  try {
    const errors = validateOrder(req.body);
    if (errors.length > 0) {
      return res.status(400).json({ error: errors.join("；") });
    }

    let images = [];
    if (Array.isArray(req.body.images)) {
      const raw = req.body.images.length;
      images = req.body.images
        .filter(img => {
          if (typeof img !== "string" || !img.startsWith("data:image/")) return false;
          if (img.length > 15 * 1024 * 1024) {
            console.log(`⚠️  跳过超大证明图: ${(img.length/1024/1024).toFixed(1)} MB`);
            return false;
          }
          return true;
        })
        .slice(0, 3);
      if (images.length < raw) {
        console.log(`📸 订单证明图: ${raw} 张提交 → ${images.length} 张入库（${images.map(i=>(i.length/1024/1024).toFixed(1)+'MB').join(', ')}）`);
      }
    }

    const id = generateId();
    const order = {
      id,
      date: req.body.date,
      phone_enc: encryptPhone(req.body.phone.trim()),
      price: req.body.price,
      content: sanitize(req.body.content),
      is_completed: req.body.isCompleted ? 1 : 0,
    };

    await db.execute(
      "INSERT INTO orders (id, date, phone_enc, price, content, is_completed, images) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [order.id, order.date, order.phone_enc, order.price, order.content, order.is_completed, JSON.stringify(images)]
    );

    sendOrderNotify(order).catch(() => {});

    res.json({ ok: true, id: order.id });
  } catch (e) {
    console.error("下单失败:", e);
    res.status(500).json({ error: "下单失败，请稍后重试" });
  }
});

// 管理员：查看所有订单（含完整手机号）
app.get("/api/orders", adminAuth, async (req, res) => {
  try {
    let sql = "SELECT * FROM orders";
    const params = [];
    if (req.query.month) {
      sql += " WHERE date LIKE ?";
      params.push(req.query.month + "%");
    }
    // 去掉 ORDER BY，避免大字段排序撑爆 SQLPub 免费版 sort buffer
    const [rows] = await db.execute(sql, params);
    rows.sort((a, b) => {
      const d = String(b.date || '').localeCompare(String(a.date || ''));
      if (d !== 0) return d;
      return String(b.created || '').localeCompare(String(a.created || ''));
    });
    res.json(rows.map(rowToOrder));
  } catch (e) {
    console.error("查询订单失败:", e.message);
    res.status(500).json({ error: "查询失败" });
  }
});

// 公开：查看最近订单（手机号脱敏）
app.get("/api/orders/public", async (req, res) => {
  try {
    const [rows] = await db.execute(
      "SELECT * FROM orders LIMIT 50"
    );
    rows.sort((a, b) => {
      const d = String(b.date || '').localeCompare(String(a.date || ''));
      if (d !== 0) return d;
      return String(b.created || '').localeCompare(String(a.created || ''));
    });
    res.json(rows.map(r => {
      const o = rowToOrder(r);
      o.phone = maskPhone(o.phone);
      return o;
    }));
  } catch (e) {
    console.error("查询订单失败:", e.message);
    res.status(500).json({ error: "查询失败" });
  }
});

// 管理员：更新订单
app.put("/api/orders/:id", adminAuth, async (req, res) => {
  try {
    const errors = validateOrder(req.body);
    if (errors.length > 0) return res.status(400).json({ error: errors.join("；") });

    let images = [];
    if (Array.isArray(req.body.images)) {
      images = req.body.images
        .filter(img => typeof img === "string" && img.startsWith("data:image/") && img.length <= 15 * 1024 * 1024)
        .slice(0, 3);
    }

    const [result] = await db.execute(
      "UPDATE orders SET date = ?, phone_enc = ?, price = ?, content = ?, is_completed = ?, images = ? WHERE id = ?",
      [req.body.date, encryptPhone(req.body.phone.trim()), req.body.price, sanitize(req.body.content), req.body.isCompleted ? 1 : 0, JSON.stringify(images), req.params.id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: "订单不存在" });
    res.json({ ok: true });
  } catch (e) {
    console.error("更新订单失败:", e.message);
    res.status(500).json({ error: "更新失败" });
  }
});

// 管理员：删除订单
app.delete("/api/orders/:id", adminAuth, async (req, res) => {
  try {
    await db.execute("DELETE FROM orders WHERE id = ?", [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error("删除订单失败:", e.message);
    res.status(500).json({ error: "删除失败" });
  }
});

// 管理员：切换完成状态
app.patch("/api/orders/:id/toggle", adminAuth, async (req, res) => {
  try {
    const [rows] = await db.execute("SELECT is_completed FROM orders WHERE id = ?", [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: "订单不存在" });
    const newVal = rows[0].is_completed ? 0 : 1;
    await db.execute("UPDATE orders SET is_completed = ? WHERE id = ?", [newVal, req.params.id]);
    res.json({ ok: true, isCompleted: !!newVal });
  } catch (e) {
    console.error("切换状态失败:", e.message);
    res.status(500).json({ error: "操作失败" });
  }
});

// ==================== 鉴权测试 ====================
app.post("/api/auth", (req, res) => {
  const { key } = req.body;
  if (key === ADMIN_KEY) {
    res.json({ ok: true, role: "admin" });
  } else {
    res.status(401).json({ ok: false, error: "密钥无效" });
  }
});

// ==================== 前端静态文件 ====================
app.use(express.static(__dirname, { etag: false, setHeaders: (res) => { res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate"); res.setHeader("Pragma", "no-cache"); res.setHeader("Expires", "0"); } }));

// body-parser 错误（JSON 格式错误 / 超过大小限制）
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large' || err.status === 413) {
    return res.status(413).json({ error: "请求体过大，图片请压缩到 15 MB 以内" });
  }
  if (err.type === 'entity.parse.failed' || err.status === 400) {
    return res.status(400).json({ error: "请求格式错误" });
  }
  next(err);
});

// ==================== 404 ====================
app.use((req, res) => {
  res.status(404).json({ error: "接口不存在" });
});

// ==================== 全局错误处理 ====================
app.use((err, req, res, next) => {
  console.error("未捕获错误:", err.message);
  res.status(500).json({ error: "服务器内部错误" });
});

// ==================== 启动 ====================
async function start() {
  await initDB();

  const server = app.listen(PORT, () => {
    console.log("╔══════════════════════════════════════╗");
    console.log("║   🌸 代肝订单管理服务已启动         ║");
    console.log("╠══════════════════════════════════════╣");
    console.log(`║   地址:    http://localhost:${PORT}     ║`);
    console.log(`║   前端:    代肝订单管理.html          ║`);
    console.log(`║   数据库:  ${dbType} → ${db.info}`);
    console.log("╚══════════════════════════════════════╝");
  });

  // 优雅退出：关闭数据库连接和 HTTP 服务
  async function shutdown(signal) {
    console.log(`\n🛑 收到 ${signal}，正在关闭...`);
    server.close();
    if (db && db.pool) {
      try { await db.pool.end(); console.log("🔌 数据库连接已关闭"); } catch(e) {}
    }
    process.exit(0);
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT",  () => shutdown("SIGINT"));
}

start();
