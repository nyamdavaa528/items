(() => {
  const el = (id) => document.getElementById(id);
  const statusEl = el("status");
  const chipsEl = el("chips");
  const tbody = el("tbody");

  function esc(s) {
    return String(s ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        }[c])
    );
  }
  function num(x) {
    const n = Number(String(x ?? "").replace(/[^0-9.\-]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  function fmt2(n) {
    return n == null ? "—" : n.toFixed(2);
  }
  function fmtFloat(n) {
    return n == null ? "—" : n.toFixed(6);
  }
  function fmtPct(n) {
    if (n == null) return "—";
    const sign = n > 0 ? "+" : "";
    return sign + n.toFixed(1) + "%";
  }
  function marketUrl(marketName) {
    return (
      "https://steamcommunity.com/market/listings/730/" +
      encodeURIComponent(marketName || "")
    );
  }

  // parse: "7 days ago", "22 hours ago", "37 seconds ago"
  function agoToMinutes(s) {
    if (!s) return null;
    const t = String(s).toLowerCase();
    const m = t.match(
      /(\d+)\s*(second|minute|hour|day|week|month|year)s?\s+ago/
    );
    if (!m) return null;
    const v = Number(m[1]);
    const unit = m[2];
    const mult =
      unit === "second"
        ? 1 / 60
        : unit === "minute"
        ? 1
        : unit === "hour"
        ? 60
        : unit === "day"
        ? 1440
        : unit === "week"
        ? 10080
        : unit === "month"
        ? 43200
        : 525600;
    return v * mult;
  }

  function readState() {
    return {
      q: el("q").value.trim().toLowerCase(),
      cond: el("cond").value.trim(),
      fmin: num(el("fmin").value),
      fmax: num(el("fmax").value),
      pmin: num(el("pmin").value),
      pmax: num(el("pmax").value),
      smin: num(el("smin").value),
      smax: num(el("smax").value),
      dmin: num(el("dmin").value),
      dmax: num(el("dmax").value),
      age: el("age").value ? Number(el("age").value) : null,
      onlyimg: el("onlyimg").checked,
      includeSteam: el("steamprice").checked,
      dealonly: el("dealonly").checked,
      sort: el("sort").value,
      autorefresh: el("autorefresh").checked,
    };
  }

  function buildChips(state) {
    const chips = [];
    if (state.q) chips.push(["Search", state.q]);
    if (state.cond) chips.push(["Cond", state.cond]);
    if (state.fmin != null) chips.push(["Float ≥", state.fmin]);
    if (state.fmax != null) chips.push(["Float ≤", state.fmax]);
    if (state.pmin != null) chips.push(["Sheet ≥", state.pmin]);
    if (state.pmax != null) chips.push(["Sheet ≤", state.pmax]);
    if (state.age != null) chips.push(["Age ≤", state.age + "d"]);
    if (state.onlyimg) chips.push(["Has image", "true"]);
    if (state.includeSteam) chips.push(["Steam price", "on"]);
    if (state.includeSteam && state.dealonly)
      chips.push(["Deals", "Steam < Sheet"]);
    if (state.includeSteam && state.smin != null)
      chips.push(["Steam ≥", state.smin]);
    if (state.includeSteam && state.smax != null)
      chips.push(["Steam ≤", state.smax]);
    if (state.includeSteam && state.dmin != null)
      chips.push(["Diff% ≥", state.dmin]);
    if (state.includeSteam && state.dmax != null)
      chips.push(["Diff% ≤", state.dmax]);

    chipsEl.innerHTML = chips
      .map(([k, v]) => `<span class="chip">${esc(k)}: ${esc(v)}</span>`)
      .join("");
  }

  let data = [];
  let timer = null;

  async function load() {
    const state = readState();
    statusEl.textContent = state.includeSteam
      ? "Fetching (incl. Steam price)…"
      : "Fetching…";

    const url =
      "/api/items?t=" +
      Date.now() +
      (state.includeSteam ? "&include_price=1" : "");
    const r = await fetch(url, { cache: "no-store" });
    const j = await r.json();

    if (j.error) {
      statusEl.textContent = "Error: " + j.error;
      data = [];
      tbody.innerHTML = "";
      return;
    }

    data = Array.isArray(j.items) ? j.items : [];
    statusEl.textContent = `Loaded ${
      data.length
    } items • ${new Date().toLocaleString()}`;
    render();
  }

  function render() {
    const state = readState();
    buildChips(state);

    let items = data.slice();

    // Filters
    if (state.q) {
      items = items.filter((it) => {
        const mn = (it.marketName || "").toLowerCase();
        const n = (it.name || "").toLowerCase();
        const w = (it.wear || "").toLowerCase();
        return (
          mn.includes(state.q) || n.includes(state.q) || w.includes(state.q)
        );
      });
    }

    if (state.cond)
      items = items.filter(
        (it) => (it.row?.[1] || it.wear || "") === state.cond
      );
    if (state.onlyimg) items = items.filter((it) => !!it.imageUrl);

    if (state.fmin != null)
      items = items.filter(
        (it) => num(it.row?.[2]) != null && num(it.row?.[2]) >= state.fmin
      );
    if (state.fmax != null)
      items = items.filter(
        (it) => num(it.row?.[2]) != null && num(it.row?.[2]) <= state.fmax
      );

    // Sheet price (API returns sheetPrice, fallback row[4])
    if (state.pmin != null)
      items = items.filter(
        (it) =>
          (it.sheetPrice ?? num(it.row?.[4])) != null &&
          (it.sheetPrice ?? num(it.row?.[4])) >= state.pmin
      );
    if (state.pmax != null)
      items = items.filter(
        (it) =>
          (it.sheetPrice ?? num(it.row?.[4])) != null &&
          (it.sheetPrice ?? num(it.row?.[4])) <= state.pmax
      );

    if (state.age != null) {
      const maxMin = state.age * 1440;
      items = items.filter((it) => {
        const mins = agoToMinutes(it.row?.[6]);
        return mins != null && mins <= maxMin;
      });
    }

    // Steam filters only if includeSteam
    if (state.includeSteam) {
      if (state.smin != null)
        items = items.filter(
          (it) => it.steamLowest != null && it.steamLowest >= state.smin
        );
      if (state.smax != null)
        items = items.filter(
          (it) => it.steamLowest != null && it.steamLowest <= state.smax
        );

      if (state.dmin != null)
        items = items.filter(
          (it) => it.diffPct != null && it.diffPct >= state.dmin
        );
      if (state.dmax != null)
        items = items.filter(
          (it) => it.diffPct != null && it.diffPct <= state.dmax
        );

      if (state.dealonly) {
        const sp = (it) => it.sheetPrice ?? num(it.row?.[4]);
        items = items.filter(
          (it) =>
            it.steamLowest != null && sp(it) != null && it.steamLowest < sp(it)
        );
      }
    }

    // Sorting
    const receivedKey = (it) => {
      const mins = agoToMinutes(it.row?.[6]);
      return mins == null ? 9e18 : mins; // smaller = newer
    };
    const sheetKey = (it) => it.sheetPrice ?? num(it.row?.[4]);
    const floatKey = (it) => num(it.row?.[2]);
    const nameKey = (it) => it.marketName || it.name || "";

    const steamKey = (it) => it.steamLowest ?? null;
    const diffKey = (it) => it.diffPct ?? null;

    const cmpNum = (x, y, dir = 1) => {
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return (x - y) * dir;
    };
    const cmpStr = (x, y, dir = 1) =>
      String(x ?? "").localeCompare(String(y ?? "")) * dir;

    items.sort((a, b) => {
      const s = state.sort;
      if (s === "received_new")
        return cmpNum(receivedKey(a), receivedKey(b), 1);
      if (s === "received_old")
        return cmpNum(receivedKey(a), receivedKey(b), -1);
      if (s === "sheet_asc") return cmpNum(sheetKey(a), sheetKey(b), 1);
      if (s === "sheet_desc") return cmpNum(sheetKey(a), sheetKey(b), -1);
      if (s === "float_asc") return cmpNum(floatKey(a), floatKey(b), 1);
      if (s === "float_desc") return cmpNum(floatKey(a), floatKey(b), -1);
      if (s === "name_asc") return cmpStr(nameKey(a), nameKey(b), 1);
      if (s === "name_desc") return cmpStr(nameKey(a), nameKey(b), -1);
      if (s === "steam_asc") return cmpNum(steamKey(a), steamKey(b), 1);
      if (s === "steam_desc") return cmpNum(steamKey(a), steamKey(b), -1);
      if (s === "diffpct_best") return cmpNum(diffKey(a), diffKey(b), 1);
      if (s === "diffpct_worst") return cmpNum(diffKey(a), diffKey(b), -1);
      return 0;
    });

    // Render table
    tbody.innerHTML = items
      .map((it) => {
        const r = Array.isArray(it.row) ? it.row : [];
        const condition = r[1] || it.wear || "—";
        const floatV = num(r[2]);
        const seed = r[3] || "—";
        const receivedAgo = r[6] || "—";

        const sheetP = it.sheetPrice ?? num(r[4]);
        const steamLow = it.steamLowest ?? null;
        const steamMed = it.steamMedian ?? null;
        const diffPct = it.diffPct ?? null;

        let diffClass = "";
        if (diffPct != null)
          diffClass = diffPct < 0 ? "good" : diffPct > 0 ? "bad" : "warn";

        const imgHtml = it.imageUrl
          ? `
          <div class="imgwrap">
            <div class="skel"></div>
            <img class="item-img" data-src="${esc(
              it.imageUrl
            )}" alt="" loading="lazy" />
          </div>
        `
          : `<div class="imgwrap"><span style="color:var(--muted);font-size:11px;">no img</span></div>`;

        return `
        <tr>
          <td>
            <div class="itemcell">
              ${imgHtml}
              <div style="min-width:0">
                <div class="name">
                  <a href="${esc(
                    marketUrl(it.marketName)
                  )}" target="_blank" rel="noreferrer">
                    ${esc(it.marketName || it.name || "—")}
                  </a>
                </div>
                <div class="sub">${esc(condition)} • Seed ${esc(seed)}</div>
              </div>
            </div>
          </td>
          <td class="num">${esc(fmtFloat(floatV))}</td>
          <td class="num">${esc(seed)}</td>
          <td class="num">${esc(fmt2(sheetP))}</td>
          <td class="num">${esc(fmt2(steamLow))}</td>
          <td class="num">${esc(fmt2(steamMed))}</td>
          <td class="num ${diffClass}">${esc(fmtPct(diffPct))}</td>
          <td>${esc(receivedAgo)}</td>
        </tr>
      `;
      })
      .join("");

    // CSP-safe image handlers (no inline onload)
    const imgs = document.querySelectorAll("img.item-img");
    imgs.forEach((img) => {
      const src = img.getAttribute("data-src");
      if (!src) return;
      if (img.dataset.bound === "1") return;
      img.dataset.bound = "1";

      img.referrerPolicy = "no-referrer";
      img.crossOrigin = "anonymous";

      img.addEventListener("load", () => {
        img.classList.add("loaded");
        const skel =
          img.parentElement && img.parentElement.querySelector(".skel");
        if (skel) skel.style.display = "none";
      });
      img.addEventListener("error", () => {
        const skel =
          img.parentElement && img.parentElement.querySelector(".skel");
        if (skel) skel.style.display = "none";
        img.style.display = "none";
      });

      img.src = src;
    });

    statusEl.textContent = `Showing ${items.length} / ${
      data.length
    } • ${new Date().toLocaleString()}`;
  }

  function applyAutoRefresh() {
    const state = readState();
    if (timer) clearInterval(timer);
    if (state.autorefresh) timer = setInterval(load, 60000);
  }

  function clearAll() {
    el("q").value = "";
    el("cond").value = "";
    el("fmin").value = "";
    el("fmax").value = "";
    el("age").value = "";
    el("sort").value = "received_new";

    el("pmin").value = "";
    el("pmax").value = "";
    el("smin").value = "";
    el("smax").value = "";
    el("dmin").value = "";
    el("dmax").value = "";

    el("onlyimg").checked = false;
    el("steamprice").checked = false;
    el("dealonly").checked = false;
    el("autorefresh").checked = true;

    applyAutoRefresh();
    load();
  }

  function wire() {
    const rerenderIds = [
      "q",
      "cond",
      "fmin",
      "fmax",
      "age",
      "sort",
      "pmin",
      "pmax",
      "smin",
      "smax",
      "dmin",
      "dmax",
      "onlyimg",
      "dealonly",
    ];
    rerenderIds.forEach((id) => {
      el(id).addEventListener("input", render);
      el(id).addEventListener("change", render);
    });

    el("steamprice").addEventListener("change", load);
    el("autorefresh").addEventListener("change", applyAutoRefresh);
    el("refresh").addEventListener("click", load);
    el("clear").addEventListener("click", clearAll);
  }

  window.addEventListener("DOMContentLoaded", () => {
    wire();
    applyAutoRefresh();
    load();
  });
})();
