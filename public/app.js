(() => {
  const scriptStatus = document.getElementById("scriptStatus");
  const apiStatus = document.getElementById("apiStatus");
  const out = document.getElementById("out");
  const reloadBtn = document.getElementById("reload");

  function setText(el, text, cls) {
    el.textContent = text;
    el.className = cls || "";
  }

  // If this runs, app.js is loaded
  setText(scriptStatus, "loaded", "ok");

  async function load() {
    try {
      setText(apiStatus, "fetching /api/items …", "muted");
      out.textContent = "Fetching…";

      const r = await fetch("/api/items?t=" + Date.now(), {
        cache: "no-store",
      });
      if (!r.ok) throw new Error("HTTP " + r.status + " " + r.statusText);

      const j = await r.json();
      if (j.error) throw new Error(j.error);

      const items = Array.isArray(j.items) ? j.items : [];
      setText(apiStatus, "OK • items=" + items.length, "ok");

      // Show first 2 items to confirm structure
      out.textContent = JSON.stringify(items.slice(0, 2), null, 2);
    } catch (e) {
      setText(apiStatus, "FAILED", "bad");
      out.textContent = String(e && e.stack ? e.stack : e);
    }
  }

  reloadBtn.addEventListener("click", load);
  window.addEventListener("DOMContentLoaded", load);
})();
