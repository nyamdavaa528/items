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
// Илүү удаан хадгалвал Render cold start үед ч илүү хурдан
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 цаг

const priceCache = new Map(); // key: marketName, val: { data, ts }
const PRICE_TTL_MS = 30 * 60 * 1000; // 30 минут

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

function priceCacheGet(key) {
  const v = priceCache.get(key);
  if (!v) return null;
  if (now() - v.ts > PRICE_TTL_MS) {
    priceCache.delete(key);
    return null;
  }
  return v.data;
}

function priceCacheSet(key, data) {
  priceCache.set(key, { data, ts: now() });
}

// ===== Fix blurry images =====
// Steam economy image URL төгсгөлдөө /62fx62f мэт жижиг size-тэй ирдэг.
// Үүнийг /360fx360f (эсвэл /256fx256f) болгон солино.
function upgradeSteamImageSize(url) {
  if (!url) return url;
  return String(url).replace(/\/\d+fx\d+f$/, "/360fx360f");
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
async function fetchSteamImage(marketName) {
  const cached = cacheGet(marketName);
  // cached утга null байж болно (өмнө нь олдохгүй байсан гэсэн үг)
  if (cached !== null && cached !== undefined) return cached;

  const query = encodeURIComponent(marketName);
  const url = `https://steamcommunity.com/market/search/render/?query=${query}&appid=${STEAM_APPID}&count=1&start=0`;

  const resp = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Render; Node.js)",
      Accept: "application/json,text/plain,*/*",
    },
  });

  if (!resp.ok) {
    throw new Error(`Steam search failed: ${resp.status} ${resp.statusText}`);
  }

  const data = await resp.json();

  // --- Attempt A: assets-аас icon_url хайх ---
  let iconUrl = null;
  try {
    const assets = data?.assets;
    if (assets) {
      const stack = [assets];
      while (stack.length) {
        const node = stack.pop();
        if (!node) continue;
        if (typeof node === "object") {
          if (node.icon_url_large && typeof node.icon_url_large === "string") {
            iconUrl = node.icon_url_large;
            break;
          }
          if (node.icon_url && typeof node.icon_url === "string") {
            iconUrl = node.icon_url;
            break;
          }
          for (const k of Object.keys(node)) stack.push(node[k]);
        }
      }
    }
  } catch (_) {}

  if (iconUrl) {
    const full = iconUrl.startsWith("http")
      ? iconUrl
      : `https://community.cloudflare.steamstatic.com/economy/image/${iconUrl}`;

    const upgraded = upgradeSteamImageSize(full);
    cacheSet(marketName, upgraded);
    return upgraded;
  }

  // --- Attempt B: results_html-оос src сугална ---
  const html = data?.results_html || "";
  const m =
    html.match(/<img[^>]+src="([^"]+steamstatic[^"]+)"[^>]*>/i) ||
    html.match(/<img[^>]+src="([^"]+)"[^>]*>/i);

  if (m && m[1]) {
    const src = m[1].replace(/&amp;/g, "&");
    const upgraded = upgradeSteamImageSize(src);
    cacheSet(marketName, upgraded);
    return upgraded;
  }

  cacheSet(marketName, null);
  return null;
}

// ===== Steam priceoverview =====
async function fetchSteamPrice(marketName) {
  const cached = priceCacheGet(marketName);
  if (cached) return cached;

  const url = `https://steamcommunity.com/market/priceoverview/?appid=${STEAM_APPID}&currency=1&market_hash_name=${encodeURIComponent(
    marketName
  )}`;

  const r = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Render; Node.js)",
      Accept: "application/json,text/plain,*/*",
    },
  });

  if (!r.ok) throw new Error(`priceoverview failed: ${r.status}`);

  const j = await r.json();
  priceCacheSet(marketName, j);
  return j;
}

function moneyToNumber(x) {
  if (!x) return null;
  const n = Number(String(x).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

// ===== Market name builder =====
function toMarketName(itemName, wear) {
  if (!wear) return itemName;
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
  return parseCsv(text);
}

// ===== API: items with images (+ optional Steam price) =====
app.get("/api/items", async (req, res) => {
  try {
    const includePrice = String(req.query.include_price || "0") === "1";

    const rows = await readSheetRows();
    if (!rows.length) return res.json({ items: [] });

    const header = rows[0];
    const body = rows.slice(1);

    // Таны sheet багануудын дараалал:
    // 0: ItemName, 1: Condition, 2: Float, 3: Paint Seed, 4: Price, 5: Received At, 6: Received Ago, 7: Timestamp ...
    const IDX_NAME = 0;
    const IDX_WEAR = 1;
    const IDX_SHEET_PRICE = 4;

    const items = body
      .filter((r) => r[IDX_NAME])
      .map((r) => {
        const name = r[IDX_NAME];
        const wear = r[IDX_WEAR];
        const marketName = toMarketName(name, wear);
        return { row: r, name, wear, marketName };
      });

    // Steam рүү хэт олон хүсэлт явуулахгүйн тулд concurrency-г жижиг байлгана
    const enriched = await mapLimit(items, includePrice ? 2 : 3, async (it) => {
      let imageUrl = null;
      try {
        imageUrl = await fetchSteamImage(it.marketName);
      } catch {
        imageUrl = null;
      }

      // Sheet price
      const sheetPriceRaw = it.row?.[IDX_SHEET_PRICE];
      const sheetPriceNum = Number(
        String(sheetPriceRaw ?? "").replace(/[^0-9.\-]/g, "")
      );
      const sheetPrice = Number.isFinite(sheetPriceNum) ? sheetPriceNum : null;

      // Steam price (optional)
      let steamLowest = null;
      let steamMedian = null;
      let steamVolume = null;
      let diff = null;
      let diffPct = null;

      if (includePrice) {
        try {
          const p = await fetchSteamPrice(it.marketName);
          steamLowest = moneyToNumber(p.lowest_price);
          steamMedian = moneyToNumber(p.median_price);
          steamVolume = moneyToNumber(p.volume);

          if (steamLowest != null && sheetPrice != null) {
            diff = steamLowest - sheetPrice;
            diffPct = sheetPrice !== 0 ? (diff / sheetPrice) * 100 : null;
          }
        } catch {
          // үлдэгдэл нь null хэвээр
        }
      }

      return {
        name: it.name,
        wear: it.wear,
        marketName: it.marketName,
        imageUrl,
        row: it.row,

        // нэмэлт талбарууд (frontend-д filter/sort хийхэд хэрэгтэй)
        sheetPrice,
        steamLowest,
        steamMedian,
        steamVolume,
        diff,
        diffPct,
      };
    });

    res.json({ header, items: enriched });
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
