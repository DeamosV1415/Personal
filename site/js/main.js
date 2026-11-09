/*
 * Everything on the page that moves, apart from the terminal.
 * Each piece checks prefers-reduced-motion and, if set, shows its end state.
 */
(() => {
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const SCRAMBLE = "!#$%&*+=?/\\|<>{}[]~^01";
  const EMAIL = document.body.dataset.email;
  window.site = {};

  // Fires once per element, the first time it is mostly on screen.
  function onFirstView(nodes, fn, threshold = 0.5, rootMargin = "0px") {
    const io = new IntersectionObserver(entries => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        io.unobserve(e.target);
        fn(e.target);
      }
    }, { threshold, rootMargin });
    nodes.forEach(n => io.observe(n));
  }

  // ---------- the portrait ----------

  let portrait = null;
  const canvas = document.getElementById("portrait");
  const fontsReady = document.fonts
    ? Promise.all([
        document.fonts.load('16px "JetBrains Mono"'),
        document.fonts.load('700 16px "JetBrains Mono"'),
      ]).catch(() => {})
    : Promise.resolve();

  // The reactions (wave, nod, startled) are a megabyte or so per grid size,
  // so only the grid actually drawn is fetched, and only once the page has
  // finished loading. Until they arrive the portrait simply doesn't react.
  const clipFiles = {};
  function loadClips(density) {
    if (clipFiles[density]) return clipFiles[density];
    clipFiles[density] = new Promise(resolve => {
      const s = document.createElement("script");
      s.src = `js/portrait-clips-${density}.js`;
      s.onload = () => { portrait.setClips(density, window.PORTRAIT_CLIPS); resolve(true); };
      s.onerror = () => resolve(false);
      document.head.append(s);
    });
    return clipFiles[density];
  }
  const pageLoaded = new Promise(r => (document.readyState === "complete" ? r() : window.addEventListener("load", r, { once: true })));

  fontsReady.then(() => {
    if (!canvas || !window.PORTRAIT) return;
    // The grid size is chosen when the portrait first measures its box,
    // which happens a moment after mount; nothing can ask for clips before.
    let sized;
    const firstSize = new Promise(r => (sized = r));
    portrait = AsciiPortrait.mount(canvas, window.PORTRAIT, {
      introMs: 1600,
      // Leave room for the header and the hint line, so the hero fits one screen.
      maxHeight: () => window.innerWidth >= 1024
        ? Math.min(window.innerHeight - 170, 820)
        : Math.min(window.innerWidth * 1.1, window.innerHeight * 0.62, 560),
      onDensity: density => { sized(density); pageLoaded.then(() => loadClips(density)); },
    });
    window.site.portrait = portrait;
    if (reduceMotion) return;

    // Hello: one wave, once the intro has resolved and the clips are here.
    Promise.all([firstSize, pageLoaded])
      .then(([density]) => loadClips(density))
      .then(ok => {
        if (!ok) return;
        const wait = Math.max(0, portrait.introEnd() - performance.now()) + 500;
        setTimeout(() => portrait.play("wave"), wait);
      });

    // Welcome back: a nod when the portrait comes back into view after
    // you had scrolled away from it.
    let away = false;
    new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) { away = true; return; }
      if (away) { away = false; portrait.play("nod"); }
    }, { threshold: 0.5 }).observe(canvas);
  });

  // ---------- headings that decrypt ----------
  //
  // Only text nodes change, and the font is monospace, so nothing reflows
  // while the characters cycle.
  function decrypt(node) {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    const texts = [];
    while (walker.nextNode()) texts.push(walker.currentNode);
    const originals = texts.map(t => t.nodeValue);
    const total = originals.reduce((s, t) => s + t.length, 0) || 1;
    const duration = Math.min(900, 280 + total * 28);
    const start = performance.now();
    node.setAttribute("aria-label", node.textContent.replace(/\s+/g, " ").trim());
    (function frame(now) {
      const p = (now - start) / duration;
      let k = 0;
      texts.forEach((t, i) => {
        const o = originals[i];
        let s = "";
        for (let j = 0; j < o.length; j++, k++) {
          const ch = o[j];
          s += ch.trim() === "" || k / total < p ? ch : SCRAMBLE[(Math.random() * SCRAMBLE.length) | 0];
        }
        t.nodeValue = s;
      });
      if (p < 1) requestAnimationFrame(frame);
      else { texts.forEach((t, i) => (t.nodeValue = originals[i])); node.removeAttribute("aria-label"); }
    })(start);
  }

  if (!reduceMotion) onFirstView(document.querySelectorAll("[data-decrypt]"), decrypt, 0.6);

  // ---------- boxes that draw themselves ----------

  const boxes = document.querySelectorAll(".box");
  if (reduceMotion) boxes.forEach(b => b.classList.add("is-drawn"));
  else onFirstView(boxes, b => b.classList.add("is-drawn"), 0.15);

  // ---------- header: where am I, how far down ----------

  const navLinks = new Map([...document.querySelectorAll(".nav a")].map(a => [a.hash, a]));
  const spy = new IntersectionObserver(entries => {
    for (const e of entries) {
      const a = navLinks.get("#" + e.target.id);
      if (!a) continue;
      if (e.isIntersecting) {
        navLinks.forEach(l => l.removeAttribute("aria-current"));
        a.setAttribute("aria-current", "true");
      } else if (a.getAttribute("aria-current")) {
        a.removeAttribute("aria-current");
      }
    }
  }, { rootMargin: "-45% 0px -50% 0px" });
  document.querySelectorAll("main > section[id]").forEach(s => spy.observe(s));

  const meter = document.querySelector("[data-progress]");
  let ticking = false;
  function updateMeter() {
    ticking = false;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const pct = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
    const filled = Math.round(pct * 10);
    meter.textContent = `[${"#".repeat(filled)}${"-".repeat(10 - filled)}] ${String(Math.round(pct * 100)).padStart(3)}%`;
  }
  if (meter) {
    window.addEventListener("scroll", () => { if (!ticking) { ticking = true; requestAnimationFrame(updateMeter); } }, { passive: true });
    updateMeter();
  }

  // ---------- local time in India ----------

  const clocks = document.querySelectorAll("[data-clock]");
  const fmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });
  const tickClock = () => clocks.forEach(c => (c.textContent = `${fmt.format(new Date())} IST`));
  if (clocks.length) { tickClock(); setInterval(tickClock, 15000); }

  // ---------- copy the email ----------

  document.querySelectorAll("[data-copy]").forEach(b => b.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(b.dataset.copy);
      const was = b.textContent;
      b.textContent = "copied";
      setTimeout(() => (b.textContent = was), 1400);
    } catch {
      location.href = `mailto:${b.dataset.copy}`;
    }
  }));

  // ---------- product screenshots, dithered at the screen's real pixels ----------
  //
  // A dithered image is only crisp when each of its dots covers whole device
  // pixels. The PNG in the page is right at 100% and 200% zoom; at the 125%
  // and 150% most Windows laptops run, it lands between pixels and shimmers.
  // So the dots are redrawn here at a whole number of device pixels each.
  const CARD = { w: 520, h: 325 };

  function dither(src, out) {
    const dpr = window.devicePixelRatio || 1;
    const k = Math.max(1, Math.round(dpr));
    const devW = Math.round(CARD.w * dpr), devH = Math.round(CARD.h * dpr);
    const gw = Math.ceil(devW / k), gh = Math.ceil(devH / k);
    const off = document.createElement("canvas");
    off.width = gw; off.height = gh;
    const o = off.getContext("2d", { willReadFrequently: true });
    o.drawImage(src, 0, 0, gw, gh);
    const img = o.getImageData(0, 0, gw, gh);
    const d = img.data;
    const lum = new Float32Array(gw * gh);
    for (let i = 0; i < lum.length; i++) lum[i] = d[i * 4];
    // Floyd-Steinberg, the same as the PNG fallback.
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const i = y * gw + x;
        const old = lum[i];
        const v = old < 128 ? 0 : 255;
        const err = old - v;
        lum[i] = v;
        if (x + 1 < gw) lum[i + 1] += err * 7 / 16;
        if (y + 1 < gh) {
          if (x > 0) lum[i + gw - 1] += err * 3 / 16;
          lum[i + gw] += err * 5 / 16;
          if (x + 1 < gw) lum[i + gw + 1] += err / 16;
        }
      }
    }
    for (let i = 0; i < lum.length; i++) {
      d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = lum[i];
      d[i * 4 + 3] = 255;
    }
    o.putImageData(img, 0, 0);
    out.width = devW; out.height = devH;
    out.style.width = CARD.w + "px"; out.style.height = CARD.h + "px";
    const c = out.getContext("2d");
    c.imageSmoothingEnabled = false;
    c.drawImage(off, 0, 0, gw * k, gh * k);
  }

  const shots = [...document.querySelectorAll(".shot")];
  const loaded = new Map();
  onFirstView(shots, async fig => {
    const out = fig.querySelector("canvas[data-tone]");
    const src = new Image();
    src.src = out.dataset.tone;
    try {
      await src.decode();
      dither(src, out);
    } catch {
      // Opened from disk (file://), the browser won't let a canvas read image
      // pixels; the pre-dithered PNG underneath stays in view instead.
      return;
    }
    loaded.set(fig, src);
    fig.classList.add("is-live");
  }, 0, "300px");

  let lastDpr = window.devicePixelRatio;
  window.addEventListener("resize", () => {
    if (window.devicePixelRatio === lastDpr) return;
    lastDpr = window.devicePixelRatio;
    loaded.forEach((src, fig) => dither(src, fig.querySelector("canvas[data-tone]")));
  });

  // ---------- rm -rf / ----------
  //
  // Whatever is on screen drops to the bottom of the window, the portrait
  // falls in a heap, and after `ms` everything springs back.
  const FALL = ".top > *, .hero-text > *, .hero-side > *, .portrait-hint, .section-head, .term, .man, .work-intro, .product, .project, .ls-head, .contact-say, .contact-list, .site-footer > *";

  function collapse(ms = 3000) {
    if (reduceMotion) return;
    portrait?.collapse(ms);
    const vh = window.innerHeight;
    const falling = [...document.querySelectorAll(FALL)].filter(n => {
      const r = n.getBoundingClientRect();
      return r.bottom > 0 && r.top < vh && r.height > 0;
    });
    for (const n of falling) {
      const r = n.getBoundingClientRect();
      const drop = Math.max(0, vh - r.bottom) + Math.random() * 10;
      const tilt = (Math.random() - 0.5) * 28;
      n.style.transition = `transform ${650 + Math.random() * 450}ms cubic-bezier(.55,0,1,.45) ${Math.random() * 260}ms`;
      n.style.transform = `translateY(${drop}px) rotate(${tilt}deg)`;
    }
    setTimeout(() => {
      for (const n of falling) {
        n.style.transition = `transform 700ms cubic-bezier(.2,.9,.3,1.25) ${Math.random() * 120}ms`;
        n.style.transform = "";
      }
      setTimeout(() => falling.forEach(n => (n.style.transition = "")), 900);
    }, ms);
  }

  window.site.collapse = collapse;

  // ---------- small things ----------

  document.querySelectorAll("[data-year]").forEach(n => (n.textContent = new Date().getFullYear()));

  const hello = ["hi. you opened the console.", "this site is plain html, css and js.", "no framework, no build step."];
  const w = Math.max(...hello.map(l => l.length)) + 4;
  console.log(
    "%c" + ["┌" + "─".repeat(w) + "┐", ...hello.map(l => "│  " + l.padEnd(w - 2) + "│"), "└" + "─".repeat(w) + "┘"].join("\n"),
    "font-family: monospace; line-height: 1.3"
  );
  console.log(`If you read source for fun, we should talk: ${EMAIL}\nTry typing  rm -rf /  in the terminal on the page.`);
})();
