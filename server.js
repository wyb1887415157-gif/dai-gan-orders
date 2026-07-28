"use strict";

// ==================== 代肝订单管理 - 后端服务 ====================
// 启动: npm start   (默认端口 3456)
// 环境变量: ADMIN_KEY  PHONE_KEY  SMTP_USER  SMTP_PASS  NOTIFY_EMAIL  PORT

const express    = require("express");
const cors       = require("cors");
const helmet     = require("helmet");
const rateLimit  = require("express-rate-limit");
const crypto     = require("crypto");
const fs         = require("fs");
const path       = require("path");
const nodemailer = require("nodemailer");

// ==================== 邮件配置 ====================
const SMTP_USER   = process.env.SMTP_USER   || "3532368834@qq.com";
const SMTP_PASS   = process.env.SMTP_PASS   || "";   // QQ 邮箱授权码
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
      subject: `🛒 新订单通知 — ¥${order.price.toFixed(2)}`,
      html: `
        <div style="max-width:500px;margin:0 auto;font-family:sans-serif;">
          <h2 style="color:#5b9bd5;">🌸 代肝鹤临 — 新订单通知</h2>
          <table style="width:100%;border-collapse:collapse;">
            <tr><td style="padding:8px;border-bottom:1px solid #eee;color:#888;">日期</td><td style="padding:8px;border-bottom:1px solid #eee;"><strong>${order.date}</strong></td></tr>
            <tr><td style="padding:8px;border-bottom:1px solid #eee;color:#888;">内容</td><td style="padding:8px;border-bottom:1px solid #eee;">${content}</td></tr>
            <tr><td style="padding:8px;border-bottom:1px solid #eee;color:#888;">价格</td><td style="padding:8px;border-bottom:1px solid #eee;font-size:1.2em;color:#e07070;"><strong>¥${order.price.toFixed(2)}</strong></td></tr>
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
const PORT       = process.env.PORT       || 3456;
const ADMIN_KEY  = process.env.ADMIN_KEY  || "1887415157";
const PHONE_KEY  = process.env.PHONE_KEY  || "phone-encrypt-key32!"; // ⚠️ 32字节密钥
const DATA_DIR   = process.env.DATA_DIR   || __dirname;

// 确保 phone key 是 32 字节
const PHONE_KEY_BUF = Buffer.alloc(32);
const keyRaw = Buffer.from(PHONE_KEY.slice(0, 32), "utf-8");
for (let i = 0; i < Math.min(keyRaw.length, 32); i++) PHONE_KEY_BUF[i] = keyRaw[i];

// 数据文件路径
const ORDERS_FILE    = path.join(DATA_DIR, "data_orders.json");
const PRICEIMG_FILE  = path.join(DATA_DIR, "data_price_imgs.json");
const PRICELIST_FILE = path.join(DATA_DIR, "data_price_list.json");

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

// ==================== JSON 文件存储 ====================
function readJSON(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw);
  } catch (e) {
    console.error(`读取 ${filePath} 失败:`, e.message);
    return [];
  }
}

function writeJSON(filePath, data) {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmp, filePath);  // 原子写入，防止写一半崩溃
}

// ==================== Express ====================
const app = express();

// 安全头
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

// CORS
app.use(cors({
  origin: process.env.CORS_ORIGIN || "*",
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
  allowedHeaders: ["Content-Type", "X-Admin-Key"],
  maxAge: 86400,
}));

// 请求体大小限制
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

// ==================== API 路由 ====================

// 健康检查
app.get("/api/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ==================== 价格表图片 ====================
app.get("/api/price-images", (req, res) => {
  try {
    const data = readJSON(PRICEIMG_FILE);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: "服务器错误" });
  }
});

app.post("/api/price-images", adminAuth, (req, res) => {
  try {
    const { dataUrl, name } = req.body;
    if (!dataUrl || !dataUrl.startsWith("data:image/")) {
      return res.status(400).json({ error: "请上传有效的图片" });
    }
    if (dataUrl.length > 10 * 1024 * 1024) {
      return res.status(400).json({ error: "图片太大（最大 10MB）" });
    }
    const data = readJSON(PRICEIMG_FILE);
    const item = { id: generateId(), dataUrl, name: sanitize(name) || "价格表", created: new Date().toISOString() };
    data.push(item);
    writeJSON(PRICEIMG_FILE, data);
    res.json({ ok: true, id: item.id });
  } catch (e) {
    res.status(500).json({ error: "上传失败" });
  }
});

app.delete("/api/price-images/:id", adminAuth, (req, res) => {
  try {
    let data = readJSON(PRICEIMG_FILE);
    data = data.filter(p => p.id !== req.params.id);
    writeJSON(PRICEIMG_FILE, data);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "删除失败" });
  }
});

// ==================== 文字价格表 ====================
app.get("/api/price-list", (req, res) => {
  try {
    const data = readJSON(PRICELIST_FILE);
    data.sort((a, b) => (a.game || "").localeCompare(b.game || ""));
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: "服务器错误" });
  }
});

app.post("/api/price-list", adminAuth, (req, res) => {
  try {
    const { game, name, price } = req.body;
    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return res.status(400).json({ error: "项目名称不能为空" });
    }
    if (typeof price !== "number" || price <= 0) {
      return res.status(400).json({ error: "价格必须大于 0" });
    }
    const data = readJSON(PRICELIST_FILE);
    const item = { id: generateId(), game: sanitize(game), name: sanitize(name), price, created: new Date().toISOString() };
    data.push(item);
    writeJSON(PRICELIST_FILE, data);
    res.json({ ok: true, id: item.id });
  } catch (e) {
    res.status(500).json({ error: "添加失败" });
  }
});

app.put("/api/price-list/:id", adminAuth, (req, res) => {
  try {
    const { game, name, price } = req.body;
    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return res.status(400).json({ error: "项目名称不能为空" });
    }
    const data = readJSON(PRICELIST_FILE);
    const idx = data.findIndex(p => p.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: "项目不存在" });
    data[idx].game = sanitize(game);
    data[idx].name = sanitize(name);
    data[idx].price = price || 0;
    writeJSON(PRICELIST_FILE, data);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "更新失败" });
  }
});

app.delete("/api/price-list/:id", adminAuth, (req, res) => {
  try {
    let data = readJSON(PRICELIST_FILE);
    data = data.filter(p => p.id !== req.params.id);
    writeJSON(PRICELIST_FILE, data);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "删除失败" });
  }
});

// ==================== 订单 ====================
app.post("/api/orders", orderLimiter, (req, res) => {
  try {
    const errors = validateOrder(req.body);
    if (errors.length > 0) {
      return res.status(400).json({ error: errors.join("；") });
    }

    let images = [];
    if (Array.isArray(req.body.images)) {
      images = req.body.images
        .filter(img => typeof img === "string" && img.startsWith("data:image/") && img.length < 5 * 1024 * 1024)
        .slice(0, 3);
    }

    const data = readJSON(ORDERS_FILE);
    const order = {
      id: generateId(),
      date: req.body.date,
      phone_enc: encryptPhone(req.body.phone.trim()),
      price: req.body.price,
      content: sanitize(req.body.content),
      is_completed: req.body.isCompleted ? 1 : 0,
      images: JSON.stringify(images),
      created: new Date().toISOString(),
    };
    data.push(order);
    writeJSON(ORDERS_FILE, data);

    // 异步发送邮件通知（不阻塞响应）
    sendOrderNotify(order).catch(() => {});

    res.json({ ok: true, id: order.id });
  } catch (e) {
    console.error("下单失败:", e);
    res.status(500).json({ error: "下单失败，请稍后重试" });
  }
});

// 管理员：查看所有订单（含完整手机号）
app.get("/api/orders", adminAuth, (req, res) => {
  try {
    let rows = readJSON(ORDERS_FILE);
    const { month } = req.query;
    if (month) {
      rows = rows.filter(r => r.date.startsWith(month));
    }
    rows.sort((a, b) => b.date.localeCompare(a.date) || b.created.localeCompare(a.created));
    const result = rows.map(r => ({
      id: r.id,
      date: r.date,
      phone: decryptPhone(r.phone_enc),
      price: r.price,
      content: r.content,
      isCompleted: !!r.is_completed,
      images: safeParseJSON(r.images, []),
      created: r.created,
    }));
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: "查询失败" });
  }
});

// 公开：查看最近订单（手机号脱敏）
app.get("/api/orders/public", (req, res) => {
  try {
    let rows = readJSON(ORDERS_FILE);
    rows.sort((a, b) => b.date.localeCompare(a.date) || b.created.localeCompare(a.created));
    rows = rows.slice(0, 50);
    const result = rows.map(r => ({
      id: r.id,
      date: r.date,
      phone: maskPhone(decryptPhone(r.phone_enc)),
      price: r.price,
      content: r.content,
      isCompleted: !!r.is_completed,
      images: safeParseJSON(r.images, []),
      created: r.created,
    }));
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: "查询失败" });
  }
});

// 管理员：更新订单
app.put("/api/orders/:id", adminAuth, (req, res) => {
  try {
    const errors = validateOrder(req.body);
    if (errors.length > 0) return res.status(400).json({ error: errors.join("；") });

    let images = [];
    if (Array.isArray(req.body.images)) {
      images = req.body.images
        .filter(img => typeof img === "string" && img.startsWith("data:image/") && img.length < 5 * 1024 * 1024)
        .slice(0, 3);
    }

    const data = readJSON(ORDERS_FILE);
    const idx = data.findIndex(o => o.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: "订单不存在" });

    data[idx].date         = req.body.date;
    data[idx].phone_enc    = encryptPhone(req.body.phone.trim());
    data[idx].price        = req.body.price;
    data[idx].content      = sanitize(req.body.content);
    data[idx].is_completed = req.body.isCompleted ? 1 : 0;
    data[idx].images       = JSON.stringify(images);
    writeJSON(ORDERS_FILE, data);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "更新失败" });
  }
});

// 管理员：删除订单
app.delete("/api/orders/:id", adminAuth, (req, res) => {
  try {
    let data = readJSON(ORDERS_FILE);
    data = data.filter(o => o.id !== req.params.id);
    writeJSON(ORDERS_FILE, data);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "删除失败" });
  }
});

// 管理员：切换完成状态
app.patch("/api/orders/:id/toggle", adminAuth, (req, res) => {
  try {
    const data = readJSON(ORDERS_FILE);
    const idx = data.findIndex(o => o.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: "订单不存在" });
    data[idx].is_completed = data[idx].is_completed ? 0 : 1;
    writeJSON(ORDERS_FILE, data);
    res.json({ ok: true, isCompleted: !!data[idx].is_completed });
  } catch (e) {
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

// ==================== 辅助 ====================
function safeParseJSON(str, fallback) {
  try { return JSON.parse(str); } catch(e) { return fallback; }
}

// ==================== 前端静态文件 ====================
app.use(express.static(__dirname));

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
app.listen(PORT, () => {
  const isDefaultKey = ADMIN_KEY === "daigan-admin-2026";
  console.log("╔══════════════════════════════════════╗");
  console.log("║   🌸 代肝订单管理服务已启动         ║");
  console.log("╠══════════════════════════════════════╣");
  console.log(`║   地址:    http://localhost:${PORT}     ║`);
  console.log(`║   前端:    代肝订单管理.html          ║`);
  console.log(`║   管理员:  ${isDefaultKey ? "daigan-admin-2026 (默认!)" : "已自定义"}     ║`);
  if (isDefaultKey) console.log("║   ⚠️  请通过环境变量 ADMIN_KEY 修改! ║");
  console.log("╚══════════════════════════════════════╝");
});
