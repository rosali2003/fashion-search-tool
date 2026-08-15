/**
 * Builds the Ink design-system preview bundle for claude.ai/design.
 *
 * Each component is one self-contained HTML file whose first line is a
 * `@dsCard` marker — that comment is what the Design System pane reads to build
 * its card index, so it must stay on line 1.
 *
 * Generated rather than hand-written because every preview needs the same token
 * block, and ten hand-copied duplicates would drift the moment a token changes.
 * The tokens below are the single source and are kept identical to
 * frontend/src/styles.css.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, 'components')
mkdirSync(OUT, { recursive: true })

/** Product shots, inlined so a preview never depends on a running backend. */
const IMG_DIR = process.env.IMG_DIR
const img = (id) => {
  if (!IMG_DIR) return ''
  try {
    return `data:image/jpeg;base64,${readFileSync(join(IMG_DIR, `${id}.jpg`)).toString('base64')}`
  } catch {
    return ''
  }
}

const TOKENS = `
  :root {
    --ground:#ffffff; --raised:#faf9f7; --sunken:#f4f2ef;
    --ink:#111110; --muted:#6a6862; --faint:#9c9a94;
    --line:#e5e3df; --line-strong:#c9c6c0;
    --accent:#2f4f43; --accent-soft:#eef2f0;
    --warn-bg:#fdf8ec; --warn-line:#e8dcb8; --warn-ink:#6d5a1f;
    --sans:'Helvetica Neue',-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,system-ui,sans-serif;
    --t-micro:10.5px; --t-small:12.5px; --t-body:14px; --t-lead:17px; --t-display:30px;
    --radius:2px;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--ground);color:var(--ink);font-family:var(--sans);
       font-size:var(--t-body);line-height:1.5;-webkit-font-smoothing:antialiased;padding:28px}
  .u-label{font-size:var(--t-micro);letter-spacing:.14em;text-transform:uppercase;color:var(--faint)}
  .u-num{font-variant-numeric:tabular-nums}
  .spec{margin:0 0 22px;padding-bottom:14px;border-bottom:1px solid var(--line)}
  .spec h1{font-size:var(--t-lead);font-weight:500;margin:0 0 5px}
  .spec p{margin:0;color:var(--muted);font-size:var(--t-small);max-width:64ch}
  .row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:18px}
  .stack{display:flex;flex-direction:column;gap:22px}
  .cap{font-size:var(--t-micro);letter-spacing:.12em;text-transform:uppercase;color:var(--faint);margin-bottom:9px}
  button{font-family:inherit;font-size:var(--t-body);color:inherit;cursor:pointer}
`

const page = ({ card, title, blurb, css = '', body }) => `<!-- @dsCard group="${card.group}" -->
<title>Ink · ${title}</title>
<style>${TOKENS}${css}</style>
<div class="spec"><h1>${title}</h1><p>${blurb}</p></div>
${body}
`

const BTN = `
  .btn{border:1px solid var(--ink);background:var(--ground);color:var(--ink);padding:12px 22px;
       border-radius:var(--radius);font-size:var(--t-small);letter-spacing:.09em;text-transform:uppercase;
       transition:background .15s,color .15s,border-color .15s,opacity .15s}
  .btn:hover:not(:disabled){background:var(--sunken)}
  .btn:disabled{opacity:.35;cursor:not-allowed}
  .btn--primary{background:var(--ink);color:var(--ground)}
  .btn--quiet{border-color:transparent;background:none;color:var(--muted);padding:12px 14px}
  .btn--link{border:0;background:none;padding:0;font-size:var(--t-small);color:var(--muted);
             text-decoration:underline;text-underline-offset:3px;text-decoration-color:var(--line-strong)}
`

const CHIP = `
  .chip{border:1px solid var(--line-strong);background:var(--ground);color:var(--muted);border-radius:999px;
        padding:7px 14px;font-size:var(--t-small);transition:border-color .15s,color .15s,background .15s}
  .chip:hover{border-color:var(--ink);color:var(--ink)}
  .chip[aria-pressed=true]{background:var(--ink);border-color:var(--ink);color:var(--ground)}
`

const CARD = `
  .card{display:flex;flex-direction:column;height:100%;max-width:270px}
  .card__link{display:flex;flex-direction:column;text-decoration:none;color:inherit}
  .card__shot{aspect-ratio:3/4;background:var(--sunken);overflow:hidden;margin-bottom:13px}
  .card__shot img{width:100%;height:100%;object-fit:cover;display:block;transition:transform .6s cubic-bezier(.2,.6,.2,1)}
  .card__link:hover .card__shot img{transform:scale(1.035)}
  .card__shot--empty{display:grid;place-items:center;color:var(--faint);font-size:var(--t-small)}
  .card__brand{font-size:var(--t-micro);letter-spacing:.14em;text-transform:uppercase;color:var(--faint);margin-bottom:5px}
  .card__name{font-size:var(--t-body);line-height:1.35;margin:0 0 6px;font-weight:400}
  .card__foot{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap}
  .card__price{font-size:var(--t-body);font-variant-numeric:tabular-nums}
  .card__fiber{font-size:var(--t-small);color:var(--muted)}
  .card__attrs{display:flex;flex-wrap:wrap;gap:4px 10px;margin-top:9px;font-size:var(--t-micro);
               letter-spacing:.08em;text-transform:uppercase;color:var(--faint)}
  .card__similar{align-self:flex-start;margin-top:auto;padding-top:11px}
  .notes{display:flex;flex-direction:column;gap:6px;margin-top:10px}
  .note{font-size:var(--t-small);line-height:1.45;padding-left:10px;border-left:2px solid var(--line);color:var(--muted);margin:0}
  .note--fit{border-left-color:var(--accent);color:var(--accent)}
  .note--taste{border-left-color:var(--line-strong);color:var(--muted);font-style:italic}
`

const files = {}

/* ---------- foundations ---------- */

files['foundations/color.html'] = page({
  card: { group: 'Foundations' },
  title: 'Colour',
  blurb:
    'Neutrals carry a faint warm bias so they read as chosen rather than inherited. One accent, spent only on the personalisation layer — the annotations no retailer grid has. Light-only by decision: garment photography is shot on white and a dark ground fights every image.',
  css: `
    .sw{display:grid;grid-template-columns:repeat(auto-fill,minmax(158px,1fr));gap:14px}
    .s{border:1px solid var(--line);border-radius:var(--radius);overflow:hidden}
    .s .chipc{height:76px}
    .s .m{padding:9px 11px;font-size:var(--t-small)}
    .s .m b{display:block;font-weight:600}
    .s .m code{color:var(--faint);font-size:11px}
  `,
  body: `<div class="sw">
${[
  ['ground', '#ffffff', 'page'],
  ['raised', '#faf9f7', 'search zone'],
  ['sunken', '#f4f2ef', 'image placeholder'],
  ['ink', '#111110', 'text, primary button'],
  ['muted', '#6a6862', 'secondary text'],
  ['faint', '#9c9a94', 'labels, attributes'],
  ['line', '#e5e3df', 'dividers'],
  ['line-strong', '#c9c6c0', 'inputs, chips'],
  ['accent', '#2f4f43', 'fit annotation only'],
  ['accent-soft', '#eef2f0', 'standing rationale'],
]
  .map(
    ([n, hex, use]) =>
      `<div class="s"><div class="chipc" style="background:${hex}"></div><div class="m"><b>${n}</b><code>${hex}</code><div style="color:var(--muted);margin-top:3px">${use}</div></div></div>`,
  )
  .join('\n')}
</div>`,
})

files['foundations/type.html'] = page({
  card: { group: 'Foundations' },
  title: 'Type scale',
  blurb:
    'Five sizes cover the entire application. A sixth would mean the hierarchy on some screen is unresolved. Uppercase micro-labels carry 0.14em tracking; digits that line up in columns use tabular numerals.',
  css: `
    .r{display:flex;align-items:baseline;gap:22px;padding:13px 0;border-bottom:1px solid var(--line)}
    .r .k{width:120px;flex:none;font-size:var(--t-micro);letter-spacing:.12em;text-transform:uppercase;color:var(--faint)}
  `,
  body: `
    <div class="r"><span class="k">display 30</span><span style="font-size:30px;letter-spacing:-.02em;font-weight:500">Which cut do you reach for?</span></div>
    <div class="r"><span class="k">lead 17</span><span style="font-size:17px">cotton button shirt with a collar</span></div>
    <div class="r"><span class="k">body 14</span><span style="font-size:14px">Denim Big Shirt</span></div>
    <div class="r"><span class="k">small 12.5</span><span style="font-size:12.5px;color:var(--muted)">95% cotton denim button-up with spread collar</span></div>
    <div class="r"><span class="k">micro 10.5</span><span class="u-label">Button front · Oversized · Long</span></div>
    <div class="r"><span class="k">tabular</span><span class="u-num" style="font-size:14px">$88.20 &nbsp; $24.90 &nbsp; $138.00</span></div>
  `,
})

/* ---------- controls ---------- */

files['controls/buttons.html'] = page({
  card: { group: 'Controls' },
  title: 'Buttons',
  blurb:
    'Three weights, deliberately. Primary commits, default is a peer action, quiet recedes into the masthead. The link form exists so "Find similar" never competes with the outbound link to the brand, which is the card\'s real call to action.',
  css: BTN,
  body: `
    <div class="cap">Primary · default · quiet · link</div>
    <div class="row">
      <button class="btn btn--primary">Search</button>
      <button class="btn">Search all brands</button>
      <button class="btn btn--quiet">Edit profile</button>
      <button class="btn btn--link">Find similar</button>
    </div>
    <div class="cap">Disabled</div>
    <div class="row">
      <button class="btn btn--primary" disabled>Searching…</button>
      <button class="btn" disabled>Try again</button>
    </div>
  `,
})

files['controls/chips.html'] = page({
  card: { group: 'Controls' },
  title: 'Chips',
  blurb:
    'One control for every multi-select in the product: brand filters, materials, body answers, example queries. Selected state inverts to solid ink rather than tinting, so a filtered state is unmistakable at a glance across a long filter bar.',
  css: CHIP,
  body: `
    <div class="cap">Brand filter — two active</div>
    <div class="row">
      <span class="u-label">Brands</span>
      <button class="chip" aria-pressed="true">aritzia</button>
      <button class="chip" aria-pressed="true">gap</button>
      <button class="chip">rihoas</button>
      <button class="chip">uniqlo</button>
    </div>
    <div class="cap">Example queries — idle state</div>
    <div class="row">
      <button class="chip">cotton tie-back shirt, high collar, one tie</button>
      <button class="chip">100% linen shirt</button>
      <button class="chip">wool overcoat</button>
    </div>
  `,
})

files['controls/search.html'] = page({
  card: { group: 'Controls' },
  title: 'Search bar',
  blurb:
    'The primary surface for a returning shopper. Plain-language input, no operators, no dropdown — the whole premise is describing a garment the way you would to a person.',
  css: `${BTN}${CHIP}
    .zone{background:var(--raised);border:1px solid var(--line);border-radius:var(--radius);padding:34px 28px}
    .f{display:flex;gap:10px;max-width:800px;margin:0 auto}
    .f input{flex:1;font-family:inherit;font-size:var(--t-lead);color:var(--ink);background:var(--ground);
             border:1px solid var(--line-strong);border-radius:var(--radius);padding:15px 18px;min-width:0}
    .f input::placeholder{color:var(--faint)}
    .f input:focus{outline:none;border-color:var(--ink);box-shadow:0 0 0 3px rgba(17,17,16,.06)}
    .ex{display:flex;flex-wrap:wrap;gap:7px;align-items:baseline;margin:16px auto 0;max-width:800px}
  `,
  body: `<div class="zone">
    <form class="f" onsubmit="return false">
      <input value="cotton button shirt with a collar" aria-label="Describe what you're looking for">
      <button class="btn btn--primary" type="submit">Search</button>
    </form>
    <div class="ex"><span class="u-label">Try</span>
      <button class="chip">black square neck sleeveless midi dress</button>
      <button class="chip">something cozy for the weekend</button>
    </div>
  </div>`,
})

/* ---------- product ---------- */

files['product/card.html'] = page({
  card: { group: 'Product' },
  title: 'Product card',
  blurb:
    'The annotation stack is what distinguishes this from a retailer grid. Three sources, each independently nullable: the query-match reason (null when the reranker is unavailable), the fit note from the styling rules (null when anonymous), and the taste note from the aesthetic rules (null when Q5 was skipped). None is ever filled in — an empty styled block reads as a rendering bug.',
  css: `${BTN}${CARD}
    .g{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:34px;align-items:start}
  `,
  body: `<div class="g">
    <article class="card">
      <a class="card__link" href="#">
        <div class="card__shot">${img(1846) ? `<img src="${img(1846)}" alt="">` : ''}</div>
        <div class="card__brand">Gap</div>
        <h3 class="card__name">Poplin Popover Top</h3>
        <div class="card__foot"><span class="card__price">$41.00</span><span class="card__fiber">100% cotton</span></div>
      </a>
      <div class="notes">
        <p class="note">100% cotton poplin, button placket, three-quarter sleeve</p>
        <p class="note note--fit">a wider neckline and some shoulder structure broaden a narrow shoulder line</p>
        <p class="note note--taste">traditional shirting details and a natural fibre, cut to last</p>
      </div>
      <div class="card__attrs"><span>relaxed</span><span>slit</span><span>three quarter</span></div>
      <button class="btn btn--link card__similar">Find similar</button>
    </article>

    <article class="card">
      <a class="card__link" href="#">
        <div class="card__shot">${img(122) ? `<img src="${img(122)}" alt="">` : ''}</div>
        <div class="card__brand">Rihoas</div>
        <h3 class="card__name">Apricot Short Sleeve Button Shirt</h3>
        <div class="card__foot"><span class="card__price">$25.00</span><span class="card__fiber">65% cotton</span></div>
      </a>
      <div class="notes">
        <p class="note">collared button-front shirt, cotton-dominant blend</p>
      </div>
      <div class="card__attrs"><span>collared</span><span>button front</span><span>short</span></div>
      <button class="btn btn--link card__similar">Find similar</button>
    </article>

    <article class="card">
      <a class="card__link" href="#">
        <div class="card__shot card__shot--empty"><span>no image</span></div>
        <div class="card__brand">Uniqlo</div>
        <h3 class="card__name">Crew Neck T-Shirt</h3>
        <div class="card__foot"><span class="card__price">$24.90</span></div>
      </a>
      <div class="card__attrs"><span>crew</span><span>short</span></div>
      <button class="btn btn--link card__similar">Find similar</button>
    </article>
  </div>`,
})

files['product/annotations.html'] = page({
  card: { group: 'Product' },
  title: 'Annotation layer',
  blurb:
    'Measured problem: the styling rules describe categories, so on a 50-item page the same sentence landed on 38 of 50 cards and stopped being an explanation. A reason carried by a majority of the page is hoisted into a single standing block; below that it stays on the cards, where it genuinely distinguishes some products from others.',
  css: `${CARD}
    .standing{display:flex;align-items:baseline;gap:16px;flex-wrap:wrap;padding:13px 16px;
              border-left:2px solid var(--accent);background:var(--accent-soft);border-radius:0 var(--radius) var(--radius) 0}
    .standing ul{margin:0;padding:0;list-style:none;display:flex;flex-wrap:wrap;gap:4px 20px}
    .standing li{font-size:var(--t-small);color:var(--accent);line-height:1.45}
    .tailmark{display:flex;align-items:center;gap:14px;font-size:var(--t-micro);letter-spacing:.14em;
              text-transform:uppercase;color:var(--faint);margin:26px 0 0}
    .tailmark::after{content:'';flex:1;height:1px;background:var(--line)}
  `,
  body: `
    <div class="cap">Standing rationale — hoisted when a reason covers most of the page</div>
    <div class="standing">
      <span class="u-label">Ranked for you</span>
      <ul>
        <li>high rise and an unbroken vertical line lengthen the leg line</li>
        <li>traditional shirting details and a natural fibre, cut to last</li>
      </ul>
    </div>

    <div class="cap" style="margin-top:30px">The three note kinds, on a card</div>
    <div class="notes" style="max-width:330px">
      <p class="note">95% cotton denim button-up with spread collar</p>
      <p class="note note--fit">a lower waistline and a deeper neckline give a short torso more length</p>
      <p class="note note--taste">pattern and applied detail doing the talking</p>
    </div>

    <div class="cap" style="margin-top:30px">Where curation stops</div>
    <div class="tailmark">Beyond this point, ordered by keyword match only</div>
  `,
})

files['product/grid.html'] = page({
  card: { group: 'Product' },
  title: 'Results grid',
  blurb:
    'Four columns on desktop, three below 1080px, two below 620px. Cards stretch to a shared row height so "Find similar" sits on a common baseline instead of wherever each card\'s notes happen to end. Fixed 3:4 image box so the grid never reflows as photography loads.',
  css: `${BTN}${CARD}
    .grid{display:grid;grid-template-columns:repeat(4,1fr);column-gap:24px;row-gap:44px}
    .card{max-width:none}
  `,
  body: `<div class="grid">
${[
  [1846, 'Gap', 'Poplin Popover Top', '$41.00', '100% cotton'],
  [122, 'Rihoas', 'Apricot Short Sleeve Button Shirt', '$25.00', '65% cotton'],
  [1845, 'Gap', 'Denim Pleated Mini Shirtdress', '$44.00', '100% cotton'],
  [137, 'Rihoas', 'Apricot Square Neck Lace Floral Tee', '$31.00', '85% lyocell'],
  [273, 'Uniqlo', 'Crew Neck T-Shirt', '$24.90', '100% cotton'],
  [1863, 'Gap', 'Organic Cotton VintageSoft T-Shirt', '$24.95', '100% cotton'],
  [24, 'Aritzia', 'Original Contour Optimum Halter Top', '$38.40', '94% nylon'],
  [106, 'Rihoas', 'Yellow V Neck Ruched Textured Tee', '$25.00', '95% polyester'],
]
  .map(
    ([id, brand, name, price, fiber]) => `  <article class="card"><a class="card__link" href="#">
    <div class="card__shot">${img(id) ? `<img src="${img(id)}" alt="">` : ''}</div>
    <div class="card__brand">${brand}</div><h3 class="card__name">${name}</h3>
    <div class="card__foot"><span class="card__price">${price}</span><span class="card__fiber">${fiber}</span></div>
  </a><button class="btn btn--link card__similar">Find similar</button></article>`,
  )
  .join('\n')}
</div>`,
})

files['product/pagination.html'] = page({
  card: { group: 'Product' },
  title: 'Pagination',
  blurb:
    'Fifty per page over a single payload. There is no request behind a page turn: the rerank stage is the expensive, non-deterministic one, and re-running it per page would both cost a call per click and let the same product legitimately appear on two pages.',
  css: `
    .pager{display:flex;align-items:center;justify-content:center;gap:6px;flex-wrap:wrap}
    .pager__btn{min-width:38px;height:38px;padding:0 11px;border:1px solid transparent;background:none;
                border-radius:var(--radius);font-size:var(--t-small);font-variant-numeric:tabular-nums;color:var(--muted)}
    .pager__btn:hover:not(:disabled){color:var(--ink);background:var(--sunken)}
    .pager__btn[aria-current=page]{border-color:var(--ink);color:var(--ink);font-weight:600}
    .pager__btn:disabled{opacity:.3;cursor:not-allowed}
    .pager__gap{color:var(--faint);padding:0 3px}
    .pager__status{width:100%;text-align:center;font-size:var(--t-small);color:var(--faint);margin-top:14px}
  `,
  body: `
    <div class="cap">Three pages</div>
    <nav class="pager">
      <button class="pager__btn" disabled>&larr;</button>
      <button class="pager__btn" aria-current="page">1</button>
      <button class="pager__btn">2</button>
      <button class="pager__btn">3</button>
      <button class="pager__btn">&rarr;</button>
      <div class="pager__status u-num">Showing 1–50 of 120</div>
    </nav>
    <div class="cap" style="margin-top:34px">Elided, deep in a long set</div>
    <nav class="pager">
      <button class="pager__btn">&larr;</button>
      <button class="pager__btn">1</button>
      <span class="pager__gap">…</span>
      <button class="pager__btn">6</button>
      <button class="pager__btn" aria-current="page">7</button>
      <button class="pager__btn">8</button>
      <span class="pager__gap">…</span>
      <button class="pager__btn">14</button>
      <button class="pager__btn">&rarr;</button>
      <div class="pager__status u-num">Showing 301–350 of 700</div>
    </nav>
  `,
})

/* ---------- onboarding ---------- */

const SIL = {
  fitted:
    '<path d="M34 20 L28 27 L30 56 L31 86 L49 86 L50 56 L52 27 L46 20 Z" fill="none" stroke="#111110" stroke-width="1.6" stroke-linejoin="round"/><path d="M34 20 Q40 25 46 20" fill="none" stroke="#111110" stroke-width="1.6"/><path d="M30 56 Q40 59 50 56" fill="none" stroke="#c9c6c0" stroke-width="1.2"/>',
  relaxed:
    '<path d="M34 20 L26 28 L27 57 L26 86 L54 86 L53 57 L54 28 L46 20 Z" fill="none" stroke="#111110" stroke-width="1.6" stroke-linejoin="round"/><path d="M34 20 Q40 25 46 20" fill="none" stroke="#111110" stroke-width="1.6"/>',
  oversized:
    '<path d="M33 20 L20 32 L21 58 L20 86 L60 86 L59 58 L60 32 L47 20 Z" fill="none" stroke="#111110" stroke-width="1.6" stroke-linejoin="round"/><path d="M33 20 Q40 25 47 20" fill="none" stroke="#111110" stroke-width="1.6"/><path d="M20 32 L27 34 M60 32 L53 34" stroke="#c9c6c0" stroke-width="1.2"/>',
  structured:
    '<path d="M33 20 L26 24 L27 30 L30 55 L22 86 L58 86 L50 55 L53 30 L54 24 L47 20 Z" fill="none" stroke="#111110" stroke-width="1.6" stroke-linejoin="round"/><path d="M33 20 Q40 25 47 20" fill="none" stroke="#111110" stroke-width="1.6"/><path d="M26 24 L54 24" stroke="#c9c6c0" stroke-width="1.2"/>',
}

const AES = {
  minimal: '<rect x="22" y="22" width="36" height="56" fill="#111110" opacity=".9"/>',
  classic: `<rect x="22" y="22" width="36" height="56" fill="none" stroke="#111110" stroke-width="1.4"/>${[30, 38, 46, 54, 62, 70].map((y) => `<line x1="22" y1="${y}" x2="58" y2="${y}" stroke="#111110" stroke-width="1.4" opacity=".75"/>`).join('')}<line x1="40" y1="22" x2="40" y2="78" stroke="#faf9f7" stroke-width="4"/><line x1="40" y1="22" x2="40" y2="78" stroke="#111110" stroke-width="1.2"/>${[30, 44, 58, 72].map((y) => `<circle cx="40" cy="${y}" r="1.5" fill="#111110"/>`).join('')}`,
  casual: `<rect x="22" y="22" width="36" height="56" fill="none" stroke="#111110" stroke-width="1.4"/>${[27, 32, 37, 42, 47, 52].map((x) => `<path d="M${x} 22 Q${x + 2} 50 ${x} 78" fill="none" stroke="#111110" stroke-width="1.2" opacity=".55"/>`).join('')}`,
  eclectic: `<rect x="22" y="22" width="18" height="28" fill="#111110" opacity=".9"/><rect x="40" y="22" width="18" height="28" fill="none" stroke="#111110" stroke-width="1.3"/>${[26, 32, 38, 44].map((y) => `<line x1="40" y1="${y}" x2="58" y2="${y}" stroke="#111110" stroke-width="1.3"/>`).join('')}<circle cx="31" cy="64" r="9" fill="none" stroke="#111110" stroke-width="1.3"/><circle cx="31" cy="64" r="3.5" fill="#111110"/><path d="M40 78 L49 50 L58 78 Z" fill="none" stroke="#111110" stroke-width="1.3" stroke-linejoin="round"/>`,
}

const TILE = `
  .tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;max-width:720px}
  .tile{border:1px solid var(--line-strong);background:var(--ground);border-radius:var(--radius);
        padding:0;overflow:hidden;text-align:left;transition:border-color .15s,box-shadow .15s}
  .tile:hover{border-color:var(--muted)}
  .tile[aria-pressed=true]{border-color:var(--ink);box-shadow:inset 0 0 0 1px var(--ink)}
  .tile__art{aspect-ratio:4/5;background:var(--sunken);display:grid;place-items:center}
  .tile__art svg{width:100%;height:100%;display:block}
  .tile__label{padding:11px 12px 13px;font-size:var(--t-small);text-transform:capitalize}
  .tile[aria-pressed=true] .tile__label{font-weight:600}
  .tile__label small{display:block;color:var(--faint);font-size:var(--t-micro);margin-top:3px;text-transform:none;letter-spacing:0}
`

const tile = (label, gloss, art, pressed) =>
  `<button class="tile"${pressed ? ' aria-pressed="true"' : ''}><span class="tile__art"><svg viewBox="0 0 80 100" aria-hidden="true">${art}</svg></span><span class="tile__label">${label}<small>${gloss}</small></span></button>`

files['onboarding/tiles.html'] = page({
  card: { group: 'Onboarding' },
  title: 'Picture tiles',
  blurb:
    'Q1 silhouette and Q5 aesthetic. Drawn rather than photographed on purpose: a real garment standing in for "relaxed" gets read as "I want that item", and the catalog rotates, so the exemplar would go out of stock and become a picture of nothing. The four silhouettes share a neckline and hem height so the only thing varying between tiles is the thing being asked about.',
  css: TILE,
  body: `
    <div class="cap">Q1 · silhouette — multi-select, "fitted" active</div>
    <div class="tiles">
      ${tile('relaxed', 'skims, not clings', SIL.relaxed)}
      ${tile('oversized', 'dropped shoulder, roomy', SIL.oversized)}
      ${tile('fitted', 'follows the body', SIL.fitted, true)}
      ${tile('structured', 'holds its own shape', SIL.structured)}
    </div>
    <div class="cap" style="margin-top:34px">Q5 · aesthetic — single-select, "classic" active</div>
    <div class="tiles">
      ${tile('minimal', 'solids, no ornament', AES.minimal)}
      ${tile('classic', 'shirting, natural fibre', AES.classic, true)}
      ${tile('casual', 'easy, everyday cotton', AES.casual)}
      ${tile('eclectic', 'pattern and detail', AES.eclectic)}
    </div>
  `,
})

files['onboarding/step.html'] = page({
  card: { group: 'Onboarding' },
  title: 'Question step',
  blurb:
    'A new shopper meets this, not the search bar. One question per screen: the whole form on one page reads as a wall to escape rather than a short conversation to finish. Six steps — the plan\'s Q1–Q5 plus the body questions that feed the styling rules, without which result cards lose their fit note entirely.',
  css: `${BTN}${TILE}
    .head{border-bottom:1px solid var(--line);padding:0 0 22px;display:flex;align-items:center;gap:18px;margin-bottom:40px}
    .wordmark{font-size:19px;font-weight:700;letter-spacing:.3em;text-transform:uppercase;text-indent:.3em}
    .progress{display:flex;gap:5px;margin-left:auto}
    .progress__tick{width:26px;height:3px;background:var(--line);border-radius:2px}
    .progress__tick--done{background:var(--ink)}
    .kick{font-size:var(--t-micro);letter-spacing:.16em;text-transform:uppercase;color:var(--faint);margin-bottom:14px}
    .q{font-size:var(--t-display);line-height:1.18;letter-spacing:-.02em;margin:0 0 12px;font-weight:500}
    .hint{color:var(--muted);font-size:var(--t-body);line-height:1.55;margin:0 0 30px;max-width:56ch}
    .foot{display:flex;align-items:center;gap:12px;margin-top:38px;padding-top:26px;border-top:1px solid var(--line);max-width:720px}
    .foot .sp{margin-left:auto}
  `,
  body: `
    <div class="head"><span class="wordmark">Ink</span>
      <span class="progress">${[1, 1, 1, 0, 0, 0].map((d) => `<span class="progress__tick${d ? ' progress__tick--done' : ''}"></span>`).join('')}</span>
    </div>
    <div class="kick">Question 3 of 6</div>
    <h2 class="q">Which comes closest to your taste?</h2>
    <p class="hint">Pick one. This reads a garment's pattern, trims and cut — so a sequinned floral and a plain crew neck sort very differently depending on your answer.</p>
    <div class="tiles">
      ${tile('minimal', 'solids, no ornament', AES.minimal)}
      ${tile('classic', 'shirting, natural fibre', AES.classic, true)}
      ${tile('casual', 'easy, everyday cotton', AES.casual)}
      ${tile('eclectic', 'pattern and detail', AES.eclectic)}
    </div>
    <div class="foot">
      <button class="btn btn--quiet">Back</button><span class="sp"></span>
      <button class="btn btn--link">Skip — search without a profile</button>
      <button class="btn btn--primary">Continue</button>
    </div>
  `,
})

/* ---------- states ---------- */

files['states/states.html'] = page({
  card: { group: 'States' },
  title: 'Empty, error, degraded',
  blurb:
    '"Your filters are too narrow" and "we have nothing like this" are different messages, so the backend reports how many products the filters alone would match and the copy branches on it. Degradation is shown rather than hidden: a silently worse ranking is indistinguishable from a broken one.',
  css: `${BTN}
    .notice{border:1px solid var(--line);border-radius:var(--radius);background:var(--raised);padding:40px 32px;
            text-align:center;color:var(--muted);margin-bottom:20px}
    .notice h3{margin:0 0 8px;font-size:var(--t-lead);color:var(--ink);font-weight:500}
    .notice p{margin:0 auto 6px;max-width:52ch;line-height:1.6}
    .notice__actions{display:flex;gap:10px;justify-content:center;margin-top:20px;flex-wrap:wrap}
    .banner{border:1px solid var(--warn-line);background:var(--warn-bg);color:var(--warn-ink);padding:11px 16px;
            border-radius:var(--radius);font-size:var(--t-small);margin-bottom:20px}
  `,
  body: `
    <div class="cap">Filters too narrow — recoverable, so it offers the recovery</div>
    <div class="notice"><h3>Nothing from aritzia, gap matches that</h3>
      <p>There are 43 products across all brands for “100% linen shirt”. The brand filter is what is holding them back.</p>
      <div class="notice__actions"><button class="btn">Search all brands</button></div></div>

    <div class="cap">Genuinely nothing — no false hope, no action offered</div>
    <div class="notice"><h3>No matches for “wool overcoat”</h3>
      <p>Nothing in the catalog is close enough to return honestly. Try describing the garment more loosely, or in different words.</p></div>

    <div class="cap">Degraded pipeline</div>
    <div class="banner">Ranked by keyword match only — smart ranking is unavailable, so match reasons are hidden.</div>

    <div class="cap">Request failed</div>
    <div class="notice"><h3>That search did not complete</h3><p>Request failed (503)</p>
      <div class="notice__actions"><button class="btn">Try again</button></div></div>
  `,
})

files['states/loading.html'] = page({
  card: { group: 'States' },
  title: 'Loading grid',
  blurb:
    'Skeletons at the real 3:4 ratio so nothing shifts when results land. Twelve rather than ten: the grid is four columns, and a count that is not a multiple of the column count leaves a ragged final row that reads as a partly failed load.',
  css: `
    .grid{display:grid;grid-template-columns:repeat(4,1fr);column-gap:24px;row-gap:44px}
    .sk-img{aspect-ratio:3/4;background:linear-gradient(100deg,var(--sunken) 30%,#ebe8e3 50%,var(--sunken) 70%);
            background-size:200% 100%;animation:sh 1.4s infinite linear;margin-bottom:13px}
    .sk-line{height:9px;border-radius:2px;background:var(--sunken);margin-bottom:7px}
    .sk-line.short{width:45%}
    @keyframes sh{from{background-position:200% 0}to{background-position:-200% 0}}
    @media (prefers-reduced-motion:reduce){.sk-img{animation:none}}
  `,
  body: `<div class="grid" aria-busy="true">${Array.from({ length: 8 })
    .map(() => '<div><div class="sk-img"></div><div class="sk-line"></div><div class="sk-line short"></div></div>')
    .join('')}</div>`,
})

/* ---------- profile ---------- */

files['profile/summary.html'] = page({
  card: { group: 'Profile' },
  title: 'Profile summary',
  blurb:
    'A single quiet row, not a card: orientation rather than content, with the results grid immediately below being what the shopper came for. Brand affinities show as bars because that is the part of the profile that visibly moves with use — the feedback loop that makes the A/B comparisons feel worth doing. Only fibres the profile has actually moved on are listed; showing everything at the 0.5 neutral default would present it as learned.',
  css: `
    .panel{border:1px solid var(--line);border-radius:var(--radius);background:var(--ground);padding:22px 24px}
    .profile{display:flex;align-items:center;gap:18px;flex-wrap:wrap;font-size:var(--t-small)}
    .profile__row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
    .profile__k{color:var(--faint)}
    .bar{display:inline-flex;align-items:center;gap:7px;color:var(--muted)}
    .bar__track{width:64px;height:4px;background:var(--sunken);border-radius:2px;overflow:hidden}
    .bar__fill{height:100%;background:var(--accent)}
  `,
  body: `<div class="panel"><div class="profile">
    <span class="u-label">Your profile</span>
    <span class="profile__row"><span class="profile__k">Taste</span><span>classic</span></span>
    <span class="profile__row"><span class="profile__k">Fit</span><span>petite · wide shoulders · short torso · defined waist</span></span>
    <span class="profile__row"><span class="profile__k">Fabric</span>
      <span class="bar"><span class="bar__track"><span class="bar__fill" style="width:85%"></span></span>85% natural</span></span>
    <span class="profile__row"><span class="profile__k">Brands</span>
      ${[['gap', 70], ['aritzia', 70], ['rihoas', 50], ['uniqlo', 50]]
        .map(([b, s]) => `<span class="bar">${b}<span class="bar__track"><span class="bar__fill" style="width:${s}%"></span></span></span>`)
        .join('')}</span>
    <span class="profile__row"><span class="profile__k">Learned</span><span>linen · cotton</span></span>
    <span class="profile__row u-num"><span class="profile__k">Comparisons</span><span>4 of 20</span></span>
  </div></div>`,
})

files['profile/compare.html'] = page({
  card: { group: 'Profile' },
  title: 'A/B comparison',
  blurb:
    'Shown after the shopper has engaged with results, never as an interruption mid-search. Skip is always available and never penalised — a skip records nothing at all rather than a weak negative. Pairs are chosen cross-brand server-side, because a same-brand pair yields no brand signal and brand is the heaviest term in the affinity blend.',
  css: `${BTN}
    .compare h3{margin:0 0 4px;font-size:var(--t-lead);font-weight:500}
    .compare .sub{color:var(--muted);font-size:var(--t-small);margin-bottom:18px}
    .compare__pair{display:grid;grid-template-columns:1fr 1fr;gap:14px;max-width:460px}
    .compare__opt{border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;background:var(--ground);
                  padding:0;text-align:left;transition:border-color .15s}
    .compare__opt:hover{border-color:var(--ink)}
    .compare__opt img{width:100%;aspect-ratio:3/4;object-fit:cover;display:block}
    .compare__meta{padding:10px 11px 12px}
    .compare__meta .b{font-size:var(--t-micro);text-transform:uppercase;letter-spacing:.12em;color:var(--faint)}
    .compare__meta .n{font-size:var(--t-small);line-height:1.35;margin-top:3px}
  `,
  body: `<div class="compare">
    <h3>Which of these fits your vibe better?</h3>
    <p class="sub">4 of 20 comparisons. Each one sharpens your rankings.</p>
    <div class="compare__pair">
      ${[[1845, 'Gap', 'Denim Pleated Mini Shirtdress', '$44.00 · 100% cotton'], [24, 'Aritzia', 'Original Contour Optimum Halter Top', '$38.40 · 94% nylon']]
        .map(
          ([id, b, n, p]) =>
            `<button class="compare__opt">${img(id) ? `<img src="${img(id)}" alt="">` : ''}<div class="compare__meta"><div class="b">${b}</div><div class="n">${n}</div><div class="n u-num">${p}</div></div></button>`,
        )
        .join('')}
    </div>
    <div style="margin-top:16px"><button class="btn btn--link">Skip this comparison</button></div>
  </div>`,
})

let n = 0
for (const [path, html] of Object.entries(files)) {
  const full = join(OUT, path)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, html)
  n++
}
console.log(`wrote ${n} previews to ${OUT}`)
