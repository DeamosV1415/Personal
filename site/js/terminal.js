/*
 * The terminal. Every answer is read from the page itself (the man page, the
 * product rows, the project list, the contact list), so the words live in one
 * place: index.html. Change the page and the terminal follows.
 */
(() => {
  const root = document.getElementById("terminal");
  if (!root) return;
  const screen = root.querySelector(".term-screen");
  const out = root.querySelector(".term-out");
  const form = root.querySelector(".term-line");
  const input = root.querySelector(".term-in");
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const EMAIL = document.body.dataset.email;
  const RESUME = document.body.dataset.resume || "";

  // ---------- printing ----------

  function el(tag, props = {}, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const kid of kids) if (kid != null) node.append(kid);
    return node;
  }

  function print(...parts) {
    const line = el("div", { class: "ln" });
    for (const p of parts) line.append(typeof p === "string" ? document.createTextNode(p) : p);
    out.append(line);
    screen.scrollTop = screen.scrollHeight;
    return line;
  }

  const blank = () => print(" ");
  const dim = text => el("span", { class: "dim", text });

  function link(text, href, external = !href.startsWith("#")) {
    const a = el("a", { href, text });
    if (external && !href.startsWith("mailto:")) { a.target = "_blank"; a.rel = "noopener"; }
    if (href.startsWith("#")) a.addEventListener("click", e => { e.preventDefault(); jump(href); });
    return a;
  }

  function jump(hash) {
    const target = document.querySelector(hash);
    if (!target) return;
    target.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
    history.replaceState(null, "", hash);
  }

  // A line with a left column; a long right part wraps under itself rather
  // than back under the left column, the way `ls` output reads.
  function cols(left, ...right) {
    const line = el("div", { class: "ln cols" });
    const l = el("span", { class: "left" });
    const r = el("span");
    l.append(...left);
    r.append(...right);
    line.append(l, r);
    out.append(line);
    screen.scrollTop = screen.scrollHeight;
  }
  const gap = (used, width) => " ".repeat(Math.max(1, width - used));

  // A two-column row: a fixed-width key and its value.
  const row = (key, ...value) => cols([el("span", { class: "key", text: key })], ...value);

  function echo(cmd) {
    print(el("span", { class: "ps1", text: "visitor@deamosV:~$ " }), el("span", { text: cmd }));
  }

  const wait = ms => new Promise(r => setTimeout(r, reduceMotion ? 0 : ms));

  // ---------- reading the page ----------

  const text = (scope, sel) => (scope.querySelector(sel)?.textContent || "").replace(/\s+/g, " ").trim();

  function products() {
    return [...document.querySelectorAll(".product")].map(p => ({
      id: p.id,
      name: text(p, ".product-name"),
      line: text(p, ".product-line"),
      href: p.querySelector(".product-link")?.href,
    }));
  }

  function projects() {
    return [...document.querySelectorAll(".project")].map(p => ({
      name: text(p, ".project-name"),
      line: text(p, ".project-line"),
      href: p.querySelector("a.project-name")?.href || "",
      year: text(p, ".project-year"),
    }));
  }

  function contacts() {
    return [...document.querySelectorAll("[data-contact]")].map(r => {
      const a = r.querySelector("a");
      return { key: r.dataset.contact, value: text(r, "dd"), href: a?.getAttribute("href") || "" };
    });
  }

  // ---------- commands ----------

  const VISIBLE = [
    ["help", "list these commands"],
    ["about", "who I am"],
    ["zextiria", "the company and what we've built"],
    ["projects", "other things I've made"],
    ["contact", "email and links"],
    ["resume", "download my CV"],
    ["clear", "clear the screen"],
  ];
  // Offered by Tab, never listed. Finding them is the point.
  const HIDDEN = ["whoami", "ls", "cd", "pwd", "date", "echo", "history", "sudo", "exit", "man", "wave", "nod"];

  // Scroll up to the portrait, then have it play a reaction.
  async function react(name, line) {
    const p = window.site?.portrait;
    print(line);
    jump("#top");
    await wait(700);
    if (!p?.play(name)) print(dim("(still loading, try again in a second)"));
  }

  const commands = {
    help() {
      for (const [name, desc] of VISIBLE) row(name, desc);
      blank();
      print(dim("Click a command below or type one. A few more are hidden."));
    },

    about() {
      const summary = document.querySelector("[data-term-summary]");
      print(el("strong", { text: text(document, ".man-name") }));
      if (summary) print(summary.textContent.replace(/\s+/g, " ").trim());
      blank();
      print(link("read the full man page ↓", "#about"));
    },

    zextiria() {
      const items = products();
      print(el("strong", { text: "zextiria-ai/" }), dim("   co-founder, since April 2026"));
      items.forEach((p, i) => {
        const branch = i === items.length - 1 ? "└── " : "├── ";
        cols([dim(branch), link(`${p.id}/`, p.href), gap(p.id.length + 1, 15)], p.line);
      });
      blank();
      print(link("see them on this page ↓", "#work"));
    },

    projects() {
      const items = projects();
      print(dim(`total ${items.length}`));
      for (const p of items) {
        const name = p.href ? link(p.name, p.href) : el("span", { text: p.name });
        cols([dim(`${p.year}  `), name, gap(p.name.length, 13)], p.line);
      }
      blank();
      print(link("see them on this page ↓", "#projects"));
    },

    contact() {
      for (const c of contacts()) {
        const value = c.href ? link(c.value, c.href) : dim(c.value);
        row(c.key, value);
      }
    },

    resume() {
      if (RESUME) {
        print("Opening the CV…");
        window.open(RESUME, "_blank", "noopener");
        return;
      }
      print("The CV is being updated.");
      print("Ask for a copy: ", link(EMAIL, `mailto:${EMAIL}?subject=${encodeURIComponent("Your CV")}`));
    },

    clear() { out.replaceChildren(); },

    // ----- hidden -----

    whoami() { print("visitor"); print(dim("You're the guest here. The host is "), link("Chinmay", "#about"), dim(".")); },
    pwd() { print("/home/visitor"); },
    ls() {
      print(link("about/", "#about"), "  ", link("zextiria/", "#work"), "  ", link("projects/", "#projects"), "  ", link("contact.txt", "#contact"));
    },
    cd(arg) {
      const map = { about: "#about", zextiria: "#work", projects: "#projects", contact: "#contact", "~": "#top", "/": "#top", "": "#top" };
      const key = (arg || "").replace(/\/$/, "");
      if (key in map) jump(map[key]);
      else print(`cd: no such file or directory: ${arg}`);
    },
    date() {
      const now = new Intl.DateTimeFormat("en-IN", { dateStyle: "full", timeStyle: "short", timeZone: "Asia/Kolkata" }).format(new Date());
      print(`${now} (Gwalior)`);
    },
    echo(arg) { print(arg || " "); },
    history() { past.forEach((c, i) => print(dim(String(i + 1).padStart(4) + "  "), c)); },
    man(arg) {
      if (!arg || /^chinmay/i.test(arg)) { jump("#about"); return; }
      print(`No manual entry for ${arg}`);
    },
    cat(arg) {
      if (/contact/.test(arg || "")) return commands.contact();
      print(`cat: ${arg || ""}: No such file or directory`);
    },
    async wave() { await react("wave", "Waving back at you ↑"); },
    async nod() { await react("nod", "Nodding along ↑"); },
    exit() { print("There is no exit. Only the scroll bar."); },
    vim() { print("Not on this machine. You'd never get out."); },
    hello() { print("Hey! Type ", el("strong", { text: "help" }), " to see what I can do."); },

    async sudo(arg) {
      if (/^hire[- ]?me/.test(arg || "")) {
        print("[sudo] password for visitor: ");
        const pw = out.lastChild;
        for (let i = 0; i < 8; i++) { await wait(70); pw.append("*"); }
        await wait(300);
        print("Access granted. Opening your mail app…");
        await wait(500);
        location.href = `mailto:${EMAIL}?subject=${encodeURIComponent("Let's work together")}`;
        return;
      }
      if (/^rm\s+-rf\s+\/?\*?$/.test(arg || "")) return commands.rm("-rf /");
      print("visitor is not in the sudoers file. This incident will be reported.");
    },

    async rm(arg) {
      if (!/^-rf\s+\/\*?$/.test(arg || "")) { print("rm: permission denied"); return; }
      for (const dir of ["/about", "/zextiria", "/projects", "/contact.txt", "/portrait"]) {
        print(dim(`removing ${dir}…`));
        await wait(110);
      }
      window.site?.collapse(3200);
      await wait(3800);
      print("Kernel panic averted. Restored everything from backup.");
      print(dim("Please don't do that again."));
    },
  };
  commands.hi = commands.hey = commands.hello;
  commands.vi = commands.nano = commands.emacs = commands.vim;
  commands.quit = commands.exit;
  commands.work = commands.zextiria;
  commands.cv = commands.resume;
  commands["sudo-hire-me"] = () => commands.sudo("hire-me");
  commands["hire-me"] = () => commands.sudo("hire-me");

  // ---------- running ----------

  const past = [];
  let cursor = 0;
  let booted = false;

  async function run(raw) {
    booted = true;
    const line = raw.trim();
    echo(line);
    if (!line) return;
    past.push(line);
    cursor = past.length;
    const [name, ...rest] = line.split(/\s+/);
    const fn = commands[name.toLowerCase()];
    if (!fn) {
      print(`command not found: ${name}`);
      print(dim("Type help to see the commands."));
      return;
    }
    input.disabled = true;
    try { await fn(rest.join(" ")); }
    finally {
      input.disabled = false;
      screen.scrollTop = screen.scrollHeight;
    }
  }

  form.addEventListener("submit", e => {
    e.preventDefault();
    const value = input.value;
    input.value = "";
    run(value).then(() => input.focus({ preventScroll: true }));
  });

  input.addEventListener("keydown", e => {
    if (e.key === "ArrowUp" && past.length) {
      e.preventDefault();
      cursor = Math.max(0, cursor - 1);
      input.value = past[cursor];
    } else if (e.key === "ArrowDown" && past.length) {
      e.preventDefault();
      cursor = Math.min(past.length, cursor + 1);
      input.value = past[cursor] || "";
    } else if (e.key === "Tab" && input.value.trim()) {
      const start = input.value.trim().toLowerCase();
      const hits = [...VISIBLE.map(v => v[0]), ...HIDDEN].filter(c => c.startsWith(start));
      if (hits.length === 1) { e.preventDefault(); input.value = hits[0] + " "; }
      else if (hits.length > 1) { e.preventDefault(); print(dim(hits.join("  "))); }
    } else if (e.key === "Escape") {
      input.blur();
    }
  });

  root.querySelectorAll("[data-cmd]").forEach(b => b.addEventListener("click", () => {
    run(b.dataset.cmd);
  }));

  // Clicking anywhere in the output (but not on a link) puts you on the prompt.
  screen.addEventListener("click", e => {
    if (!e.target.closest("a") && !getSelection().toString()) input.focus({ preventScroll: true });
  });

  // "/" from anywhere on the page opens the terminal.
  document.addEventListener("keydown", e => {
    if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target.closest("input, textarea, [contenteditable]")) return;
    e.preventDefault();
    root.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
    input.focus({ preventScroll: true });
  });

  // The first time the terminal comes into view, it types `help` by itself,
  // so a visitor who has never used a terminal sees what to do.
  async function boot() {
    if (booted) return;
    booted = true;
    const ps1 = el("span", { class: "ps1", text: "visitor@deamosV:~$ " });
    const typed = el("span");
    print(ps1, typed);
    for (const ch of "help") { await wait(90); typed.append(ch); }
    await wait(180);
    commands.help();
  }

  print(dim("Welcome. This terminal works: type a command or click one below."));
  blank();
  new IntersectionObserver((entries, io) => {
    if (entries.some(e => e.isIntersecting)) { io.disconnect(); boot(); }
  }, { threshold: 0.4 }).observe(root);
})();
