import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";

const app = express();

// ===== ENV =====
const PORT = process.env.PORT || 3000;
const SHEET_CSV_URL = process.env.SHEET_CSV_URL;
const STEAM_APPID = process.env.STEAM_APPID || "730";
const MONGODB_URI = process.env.MONGODB_URI;

if (!SHEET_CSV_URL) throw new Error("Missing SHEET_CSV_URL env var");
if (!MONGODB_URI) throw new Error("Missing MONGODB_URI env var");

// ===== Mongo connect =====
await mongoose.connect(MONGODB_URI, {
  serverSelectionTimeoutMS: 15000,
});

const ItemSchema = new mongoose.Schema(
  {
    marketName: { type: String, unique: true, index: true },
    name: String,
    wear: String,

    // Sheet latest snapshot
    sheetPrice: Number,
    floatValue: Number,
    paintSeed: Number,
    sheetTimestamp: Date, // derived from row[7]
    row: [String],
    lastSeenAt: { type: Date, default: Date.now, index: true },

    // Cached Steam fields
    imageUrl: String,
    steamLowest: Number,
    steamMedian: Number,
    steamVolume: Number,

    // Refresh bookkeeping
    imageUpdatedAt: Date,
    steamUpdatedAt: Date,
    imageError: String,
    steamError: String,
  },
  { timestamps: true }
);

const Item = mongoose.model("Item", ItemSchema);

// ===== Utility: CSV parser (quote-aware) =====
function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  return lines.map(parseCsvLine);
}
function parseCsvLine(line) {
  const out = [];
  let cur = "",
    inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function toMarketName(itemName, wear) {
  const n = String(itemName || "").trim();
  const w = String(wear || "").trim();
  if (!w) return n;
  return `${n} (${w})`;
}

function numOrNull(x) {
  const s0 = String(x ?? "").trim();
  if (!s0) return null;
  const s = s0.replace(/[^0-9.\-]/g, "");
  if (!s || s === "-" || s === "." || s === "-.") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function intOrNull(x) {
  const n = numOrNull(x);
  return n == null ? null : Math.trunc(n);
}

// row[7] = "11/2/2025" → Date (00:00 local)
function parseMDYDate(s) {
  if (!s) return null;
  const t = String(s).trim();
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const mm = Number(m[1]);
  const dd = Number(m[2]);
  const yy = Number(m[3]);
  if (!mm || !dd || !yy) return null;
  const d = new Date(yy, mm - 1, dd, 0, 0, 0, 0);
  return Number.isFinite(d.getTime()) ? d : null;
}

// ===== Sheet read =====
async function readSheetRows() {
  const r = await fetch(SHEET_CSV_URL, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!r.ok) throw new Error(`Sheet CSV fetch failed: ${r.status}`);
  const text = await r.text();
  return parseCsv(text);
}

// ===== Steam image =====
function upgradeSteamImageSize(url) {
  if (!url) return url;
  // bump /62fx62f → /360fx360f
  return url.replace(/\/\d+fx\d+f/g, "/360fx360f");
}

async function fetchSteamImage(marketName) {
  const query = encodeURIComponent(marketName);
  const url = `https://steamcommunity.com/market/search/render/?query=${query}&appid=${STEAM_APPID}&count=1&start=0`;

  const resp = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Render; Node.js)",
      Accept: "application/json,text/plain,*/*",
    },
  });

  if (!resp.ok)
    throw new Error(`Steam search failed: ${resp.status} ${resp.statusText}`);
  const data = await resp.json();

  // Attempt A: assets icon_url(_large)
  let iconUrl = null;
  try {
    const assets = data?.assets;
    if (assets) {
      const stack = [assets];
      while (stack.length) {
        const node = stack.pop();
        if (!node || typeof node !== "object") continue;
        if (typeof node.icon_url_large === "string") {
          iconUrl = node.icon_url_large;
          break;
        }
        if (typeof node.icon_url === "string") {
          iconUrl = node.icon_url;
          break;
        }
        for (const k of Object.keys(node)) stack.push(node[k]);
      }
    }
  } catch (_) {}

  if (iconUrl) {
    const full = iconUrl.startsWith("http")
      ? iconUrl
      : `https://community.fastly.steamstatic.com/economy/image/${iconUrl}`;
    return upgradeSteamImageSize(full);
  }

  // Attempt B: results_html scrape
  const html = data?.results_html || "";
  const m =
    html.match(/<img[^>]+src="([^"]+steamstatic[^"]+)"[^>]*>/i) ||
    html.match(/<img[^>]+src="([^"]+)"[^>]*>/i);

  if (m && m[1]) return upgradeSteamImageSize(m[1].replace(/&amp;/g, "&"));
  return null;
}

// ===== Steam price (stub — your current API returns nulls) =====
// Энэ функцийг дараа нь бодитоор хэрэгжүүлнэ.
// Гол нь: DB кэш бүтэц бэлэн болсон. UI нь cached утгаа шууд харуулна.
async function fetchSteamPrice(_marketName) {
  return { lowest: null, median: null, volume: null };
}

// ===== Background refresh control =====
const PRICE_TTL_MS = 30 * 60 * 1000; // 30 min
const IMAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_CONCURRENCY = 1;

const inFlight = new Set();

function isStale(dateObj, ttlMs) {
  if (!dateObj) return true;
  return Date.now() - new Date(dateObj).getTime() > ttlMs;
}

async function refreshOne(marketName, { refreshPrice, refreshImage }) {
  if (inFlight.has(marketName)) return;
  inFlight.add(marketName);

  try {
    const doc = await Item.findOne({ marketName }).lean();
    if (!doc) return;

    // Image refresh
    if (
      refreshImage &&
      (isStale(doc.imageUpdatedAt, IMAGE_TTL_MS) || !doc.imageUrl)
    ) {
      try {
        const imageUrl = await fetchSteamImage(marketName);
        await Item.updateOne(
          { marketName },
          { $set: { imageUrl, imageUpdatedAt: new Date(), imageError: null } }
        );
      } catch (e) {
        await Item.updateOne(
          { marketName },
          { $set: { imageError: String(e) } }
        );
      }
    }

    // Price refresh
    if (refreshPrice && isStale(doc.steamUpdatedAt, PRICE_TTL_MS)) {
      try {
        const p = await fetchSteamPrice(marketName);
        await Item.updateOne(
          { marketName },
          {
            $set: {
              steamLowest: p.lowest,
              steamMedian: p.median,
              steamVolume: p.volume,
              steamUpdatedAt: new Date(),
              steamError: null,
            },
          }
        );
      } catch (e) {
        await Item.updateOne(
          { marketName },
          { $set: { steamError: String(e) } }
        );
      }
    }
  } finally {
    inFlight.delete(marketName);
  }
}

async function refreshLoop() {
  try {
    // хамгийн сүүлд үзэгдсэн item-үүдээс эхэлж refresh хийе
    const docs = await Item.find({})
      .sort({ lastSeenAt: -1 })
      .limit(200)
      .select("marketName imageUrl imageUpdatedAt steamUpdatedAt")
      .lean();

    const candidates = docs
      .filter(
        (d) =>
          !d.imageUrl ||
          isStale(d.imageUpdatedAt, IMAGE_TTL_MS) ||
          isStale(d.steamUpdatedAt, PRICE_TTL_MS)
      )
      .slice(0, 60);

    let idx = 0;
    const workers = Array.from({ length: MAX_CONCURRENCY }, async () => {
      while (idx < candidates.length) {
        const cur = candidates[idx++];
        await refreshOne(cur.marketName, {
          refreshPrice: true,
          refreshImage: true,
        });
      }
    });

    await Promise.all(workers);
  } catch (e) {
    console.error("refreshLoop error:", e);
  } finally {
    setTimeout(refreshLoop, 30_000); // 30 секунд тутам дахин
  }
}

// ===== Upsert from sheet into Mongo =====
async function upsertFromSheet(rows) {
  if (!rows?.length) return { header: [], count: 0 };

  const header = rows[0] || [];
  const body = rows.slice(1);

  const IDX_NAME = 0;
  const IDX_WEAR = 1;
  const IDX_FLOAT = 2;
  const IDX_SEED = 3;
  const IDX_PRICE = 4;
  const IDX_TS = 7;

  let count = 0;

  // bulkWrite for speed
  const ops = [];

  for (const r of body) {
    const name = r[IDX_NAME];
    if (!name) continue;

    const wear = r[IDX_WEAR];
    const marketName = toMarketName(name, wear);

    const floatValue = numOrNull(r[IDX_FLOAT]);
    const paintSeed = intOrNull(r[IDX_SEED]);
    const sheetPrice = numOrNull(r[IDX_PRICE]);
    const sheetTimestamp = parseMDYDate(r[IDX_TS]);

    ops.push({
      updateOne: {
        filter: { marketName },
        update: {
          $set: {
            marketName,
            name,
            wear,
            sheetPrice,
            floatValue,
            paintSeed,
            sheetTimestamp,
            row: r,
            lastSeenAt: new Date(),
          },
          $setOnInsert: {
            // steam fields initially empty; will be populated by background loop
            imageUrl: null,
            steamLowest: null,
            steamMedian: null,
            steamVolume: null,
            imageUpdatedAt: null,
            steamUpdatedAt: null,
            imageError: null,
            steamError: null,
          },
        },
        upsert: true,
      },
    });

    count++;
  }

  if (ops.length) await Item.bulkWrite(ops, { ordered: false });
  return { header, count };
}

// ===== API: return cached results fast =====
app.get("/api/items", async (req, res) => {
  try {
    const includePrice = req.query.include_price === "1";

    // 1) Sync from sheet → Mongo (fast bulk upsert)
    const rows = await readSheetRows();
    const { header } = await upsertFromSheet(rows);

    // 2) Read cached docs from Mongo and respond immediately
    const items = await Item.find({})
      .sort({ lastSeenAt: -1 })
      .limit(500)
      .lean();

    // 3) Fire-and-forget refresh for the currently served set
    //    (Do NOT await)
    // зөвхөн хамгийн сүүлд харагдсан N item дээр refresh ажиллуул
const N = 20; // 20–50 хооронд тохируул
for (const it of items.slice(0, N)) {
  refreshOne(it.marketName, { refreshPrice: includePrice, refreshImage: true });
}


    res.json({ header, items });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ===== Static frontend =====
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  refreshLoop();
});

