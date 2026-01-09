import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const app = express();

// ===== Config (Render дээр ENV-ээр тохируулна) =====
const PORT = process.env.PORT || 3000;

// Таны sheet publish линк (pubhtml) → бид /pub?output=csv болгон ашиглана
// Жишээ: https://docs.google.com/spreadsheets/d/e/.../pub?output=csv
const SHEET_CSV_URL = process.env.SHEET_CSV_URL;

// Steam appid: CS:GO/CS2 items ихэвчлэн 730
const STEAM_APPID = process.env.STEAM_APPID || "730";

// ===== Simple in-memory cache =====
const imageCache = new Map(); // key: marketName, val: { imageUrl, ts }
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 цаг

function now() {
  return Date.now();
}

function cacheGet(key) {
  const v = imageCache.get(key);
  if (!v) return null;
  if (now() - v.ts > CACHE_TTL_MS) {
    imageCache.delete(key);
    return null;
  }
  return v.imageUrl;
}

function cacheSet(key, imageUrl) {
  imageCache.set(key, { imageUrl, ts: now() });
}

// ===== CSV parser (ишлэлтэй утга дэмжинэ) =====
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
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

// ===== Utility: concurrency limit =====
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;

  async function worker() {
    while (idx < items.length) {
      const my = idx++;
      results[my] = await fn(items[my], my);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

// ===== Steam market image lookup =====
// Strategy:
// 1) market/search/render JSON endpoint (зарим тохиолдолд assets өгдөг, icon_url гарна)
// 2) Хэрэв JSON-оос олдохгүй бол results_html доторх image src-ийг regex-ээр сугална
// Note: Steam response өөрчлөгдвөл энд тааруулна.
async function fetchSteamImage(marketName) {
  const cached = cacheGet(marketName);
  if (cached) return cached;

  const query = encodeURIComponent(marketName);
  const url = `https://steamcommunity.com/market/search/render/?query=${query}&appid=${STEAM_APPID}&count=1&start=0`;

  const resp = await fetch(url, {
    headers: {
      // User-Agent байхгүй бол заримдаа блоклогддог
      "User-Agent": "Mozilla/5.0 (Render; Node.js)",
      Accept: "application/json,text/plain,*/*",
    },
  });

  if (!resp.ok) {
    throw new Error(`Steam search failed: ${resp.status} ${resp.statusText}`);
  }

  const data = await resp.json();

  // --- Attempt A: assets-аас icon_url хайх ---
  // data.assets нь заримдаа аппid/контекстээр бүлэглэгддэг.
  let iconUrl = null;
  try {
    const assets = data?.assets;
    if (assets) {
      // Нэлээн олон хэлбэртэй ирж болно. Бид бүх давхаргыг тойрно.
      const stack = [assets];
      while (stack.length) {
        const node = stack.pop();
        if (!node) continue;
        if (typeof node === "object") {
          // description объект байж магадгүй
          if (node.icon_url && typeof node.icon_url === "string") {
            iconUrl = node.icon_url;
            break;
          }
          if (node.icon_url_large && typeof node.icon_url_large === "string") {
            iconUrl = node.icon_url_large;
            break;
          }
          for (const k of Object.keys(node)) stack.push(node[k]);
        }
      }
    }
  } catch (_) {}

  // iconUrl нь ихэвчлэн relative/token байдаг тул Steam static домэйнээр бүрэн болгоно
  if (iconUrl) {
    const full = iconUrl.startsWith("http")
      ? iconUrl
      : `https://community.cloudflare.steamstatic.com/economy/image/${iconUrl}`;
    cacheSet(marketName, full);
    return full;
  }

  // --- Attempt B: results_html-оос зурагны src сугална ---
  const html = data?.results_html || "";
  // results_html доторх img tag-уудын src ихэвчлэн steamstatic домэйнтэй байдаг
  const m =
    html.match(/<img[^>]+src="([^"]+steamstatic[^"]+)"[^>]*>/i) ||
    html.match(/<img[^>]+src="([^"]+)"[^>]*>/i);

  if (m && m[1]) {
    const src = m[1].replace(/&amp;/g, "&");
    cacheSet(marketName, src);
    return src;
  }

  // Олдохгүй бол null буцаана (frontend дээр placeholder харуулна)
  cacheSet(marketName, null);
  return null;
}

// ===== Market name builder =====
// Таны мөр: "AK-47 | Slate", "Well-Worn" гэх мэт.
// Market дээр ихэнхдээ "AK-47 | Slate (Well-Worn)" хэлбэртэй.
function toMarketName(itemName, wear) {
  if (!wear) return itemName;
  // wear дотор хоосон, таб, гэх мэтийг цэвэрлэнэ
  const w = String(wear).trim();
  const n = String(itemName).trim();
  return `${n} (${w})`;
}

// ===== Read sheet (CSV) =====
async function readSheetRows() {
  if (!SHEET_CSV_URL) {
    throw new Error("Missing SHEET_CSV_URL env var");
  }
  const r = await fetch(SHEET_CSV_URL, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!r.ok) throw new Error(`Sheet CSV fetch failed: ${r.status}`);
  const text = await r.text();
  const rows = parseCsv(text);
  return rows;
}

// ===== API: items with images =====
app.get("/api/items", async (req, res) => {
  try {
    const rows = await readSheetRows();
    if (!rows.length) return res.json({ items: [] });

    const header = rows[0];
    const body = rows.slice(1);

    // Танай sheet багануудын дараалал одоогоор:
    // 0: ItemName, 1: Wear, 2: Float, 3: ???, 4: Price, ...
    // Хэрвээ өөр байвал index-уудыг тохируулна.
    const IDX_NAME = 0;
    const IDX_WEAR = 1;

    const items = body
      .filter((r) => r[IDX_NAME])
      .map((r) => {
        const name = r[IDX_NAME];
        const wear = r[IDX_WEAR];
        const marketName = toMarketName(name, wear);
        return { row: r, name, wear, marketName };
      });

    // Steam рүү хэт олон хүсэлт явуулахгүйн тулд 3 concurrency
    const enriched = await mapLimit(items, 3, async (it) => {
      let imageUrl = null;
      try {
        imageUrl = await fetchSteamImage(it.marketName);
      } catch (e) {
        // Steam тал алдаа гарвал шууд null үлдээнэ
        imageUrl = null;
      }
      return {
        name: it.name,
        wear: it.wear,
        marketName: it.marketName,
        imageUrl,
        row: it.row,
      };
    });

    res.json({
      header,
      items: enriched,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ===== Serve static frontend =====
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
