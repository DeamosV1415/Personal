# Personal website: Chinmay Bhadoria

Black on white, one monospace font, an ASCII portrait that scatters from the
cursor, and a terminal that works. Plain HTML, CSS and JavaScript: no
framework and no build step. `site/` is the whole website.

## See it

```
cd site
python -m http.server 5712
```

Then open http://127.0.0.1:5712. Opening `site/index.html` straight from
disk also works, but the product screenshots then use their pre-made dither
instead of the sharper in-browser one.

## Where things live

| What | File |
|---|---|
| All the words (hero, man page, products, projects, contact) | `site/index.html` |
| Look | `site/css/site.css` |
| The portrait engine | `site/js/portrait.js` |
| Portrait data (generated, don't edit) | `site/js/portrait-data.js` |
| Terminal commands | `site/js/terminal.js` |
| Everything else that moves | `site/js/main.js` |

The terminal reads its answers from the page itself, so editing
`index.html` updates both. Product copy is word for word from Zextiria Web's
`src/data/products.ts`; keep them in step.

## Regenerating assets

Everything runs on this folder's own Python (`.venv`):

```
# New portrait photo -> site/js/portrait-data.js (+ the explainer in prototype/)
$env:NUMBA_CACHE_DIR = "$PWD\.numba_cache"
.venv\Scripts\python.exe pipeline\make_ascii.py photos\raw\<photo>.jpg

# Link preview image -> site/og.png (run after make_ascii)
.venv\Scripts\python.exe pipeline\make_og.py

# Product screenshots in photos/screens/screen_<name>.png -> site/img/
.venv\Scripts\python.exe pipeline\make_screens.py
```

`make_ascii.py` uses the small `u2netp` background remover by default. For the
final photos, `--model u2net_human_seg` cuts hair more cleanly, but its first
download is 176 MB and GitHub serves it slowly; start it early.

## Before it goes live

- [ ] Real portrait photos (the current one is a stand-in)
- [ ] Domain: then add `<link rel="canonical">` and make `og:image` absolute in `index.html`
- [ ] CV: put the PDF in `site/` and set `data-resume` on `<body>`
- [ ] Confirm the drafted lines: the three other projects and the BUGS line in the man page
