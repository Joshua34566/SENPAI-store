const express = require("express");
const path = require("path");
const { randomUUID, createHash, timingSafeEqual } = require("crypto");
const { Pool } = require("pg");

const app = express();
const port = Number(process.env.PORT || 3000);
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL must be configured.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
  max: 5
});
const allowedOrigins = new Set(
  (process.env.CORS_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
);

app.use((req, res, next) => {
  const origin = req.get("Origin");
  if (origin && !allowedOrigins.has(origin)) {
    return res.status(403).json({ error: "This website is not allowed to access the store API." });
  }
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: "32kb" }));

function adminOnly(req, res, next) {
  const configured = process.env.ADMIN_PASSWORD;
  if (!configured) return res.status(503).json({ error: "Seller access is not configured." });
  const header = req.get("Authorization") || "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
  const expectedHash = createHash("sha256").update(configured).digest();
  const suppliedHash = createHash("sha256").update(supplied).digest();
  if (!timingSafeEqual(expectedHash, suppliedHash)) {
    return res.status(401).json({ error: "The seller password is incorrect." });
  }
  next();
}

function validateProduct(body, partial = false) {
  const product = {};
  if (!partial || Object.hasOwn(body, "title")) {
    const title = String(body.title || "").trim();
    if (!title || title.length > 60) throw new Error("Poster name must be between 1 and 60 characters.");
    product.title = title;
  }
  if (!partial || Object.hasOwn(body, "category")) {
    const category = String(body.category || "");
    if (!["anime", "cars"].includes(category)) throw new Error("Choose Anime or Cars.");
    product.category = category;
  }
  if (!partial || Object.hasOwn(body, "price")) {
    const price = Number(body.price);
    if (!Number.isInteger(price) || price < 1 || price > 10000000) throw new Error("Enter a valid price in rupees.");
    product.price = price;
  }
  for (const field of ["size", "description", "art", "tone"]) {
    if (!partial || Object.hasOwn(body, field)) {
      const value = String(body[field] ?? "").trim();
      const max = field === "description" ? 140 : field === "size" ? 35 : 24;
      if (value.length > max) throw new Error(field + " is too long.");
      if (field === "tone" && value && !/^#[0-9a-fA-F]{6}$/.test(value)) throw new Error("Use a six-digit hex colour.");
      product[field] = value;
    }
  }
  if (partial && Object.keys(product).length === 0) throw new Error("No product details were provided.");
  return product;
}

app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/api/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch (error) {
    console.error("Health check failed:", error.message);
    res.status(503).json({ ok: false });
  }
});
app.get("/api/products", async (_req, res) => {
  try {
    const result = await pool.query("SELECT id, title, category, price, size, description, art, tone FROM products ORDER BY created_at DESC, title ASC");
    res.json(result.rows);
  } catch (error) {
    console.error("Could not load products:", error.message);
    res.status(500).json({ error: "The catalogue could not be loaded." });
  }
});
app.get("/api/admin/check", adminOnly, (_req, res) => res.json({ ok: true }));

app.post("/api/products", adminOnly, async (req, res) => {
  try {
    const p = validateProduct(req.body);
    const result = await pool.query(
      "INSERT INTO products (id, title, category, price, size, description, art, tone) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, title, category, price, size, description, art, tone",
      [randomUUID(), p.title, p.category, p.price, p.size, p.description, p.art || p.title.toUpperCase().slice(0, 14), p.tone || (p.category === "cars" ? "#e68748" : "#d53155")]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(400).json({ error: error.message || "Poster could not be added." });
  }
});

app.patch("/api/products/:id", adminOnly, async (req, res) => {
  try {
    const p = validateProduct(req.body, true);
    const columns = { title: "title", category: "category", price: "price", size: "size", description: "description", art: "art", tone: "tone" };
    const fields = Object.keys(p);
    const values = fields.map((key) => p[key]);
    const assignments = fields.map((key, index) => columns[key] + " = $" + (index + 1));
    values.push(req.params.id);
    const result = await pool.query(
      "UPDATE products SET " + assignments.join(", ") + " WHERE id = $" + values.length + " RETURNING id, title, category, price, size, description, art, tone",
      values
    );
    if (!result.rowCount) return res.status(404).json({ error: "Poster not found." });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(400).json({ error: error.message || "Poster could not be updated." });
  }
});

app.delete("/api/products/:id", adminOnly, async (req, res) => {
  try {
    const result = await pool.query("DELETE FROM products WHERE id = $1", [req.params.id]);
    if (!result.rowCount) return res.status(404).json({ error: "Poster not found." });
    res.status(204).end();
  } catch (error) {
    console.error("Could not remove poster:", error.message);
    res.status(500).json({ error: "Poster could not be removed." });
  }
});

async function start() {
  await pool.query("CREATE TABLE IF NOT EXISTS products (id text PRIMARY KEY, title varchar(60) NOT NULL, category varchar(12) NOT NULL CHECK (category IN ('anime', 'cars')), price integer NOT NULL CHECK (price > 0), size varchar(35) NOT NULL DEFAULT '', description varchar(140) NOT NULL DEFAULT '', art varchar(24) NOT NULL DEFAULT '', tone varchar(7) NOT NULL DEFAULT '#d53155', created_at timestamptz NOT NULL DEFAULT now())");
  const count = await pool.query("SELECT count(*)::int AS count FROM products");
  if (count.rows[0].count === 0) {
    const seed = [
      ["moon", "Moonlit Samurai", "anime", 499, "A3 · Matte finish", "A quiet moment before the next great adventure.", "侍", "#d53155"],
      ["redline", "Redline Legend", "cars", 599, "A3 · Matte finish", "For the ones who hear the road calling.", "REDLINE", "#f08349"],
      ["spirit", "Spirit Awakens", "anime", 499, "A3 · Matte finish", "Bold colour and a little supernatural magic.", "魂", "#a84dd6"],
      ["midnight", "Midnight Drive", "cars", 599, "A3 · Matte finish", "Neon reflections. Empty roads. One more run.", "MIDNIGHT", "#7359d2"],
      ["crimson", "Crimson Horizon", "anime", 499, "A3 · Matte finish", "A striking red horizon for your favourite corner.", "紅", "#e44457"],
      ["apex", "Apex Mode", "cars", 599, "A3 · Matte finish", "Track-day attitude for your garage walls.", "APEX", "#e9a34f"]
    ];
    for (const p of seed) {
      await pool.query("INSERT INTO products (id,title,category,price,size,description,art,tone) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING", p);
    }
  }
  app.listen(port, "0.0.0.0", () => console.log("SENPAI store API listening on " + port));
}
start().catch((error) => {
  console.error("Backend startup failed:", error);
  process.exit(1);
});
