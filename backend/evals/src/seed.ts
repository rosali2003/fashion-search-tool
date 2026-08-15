/**
 * Golden-set seeder.
 *
 * Judgments are keyed on `product_url` — never on `id`, which is a serial that
 * changes whenever the catalog is re-ingested from scratch. But URLs are long and
 * error-prone to transcribe by hand (Aritzia percent-encodes ™ in its paths, Gap
 * identifies products by query parameter), so the cases below are written against
 * product *names* and this script resolves them to canonical URLs from the
 * database.
 *
 * It writes evals/golden/queries.json. A name that resolves to zero or multiple
 * products is reported and the run fails, so the committed golden set can never
 * silently reference a product that does not exist.
 *
 *   pnpm --filter backend exec tsx evals/src/seed.ts
 *
 * After generating, the file is human-owned: edit grades there, not here. The
 * rubric lives in evals/golden/README.md.
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { db } from '../../src/db/index.js'
import { REPO_ROOT } from '../../src/ingest/load.js'

/** grade 3 = right garment type AND >=2 distinctive query attributes.
 *  grade 2 = right type AND >=1.  grade 1 = adjacent.  unlisted = 0. */
type Grade = 3 | 2 | 1

interface SeedCase {
  id: string
  query: string
  /** Which query slice this belongs to. Reported separately — see run.ts. */
  slice: 'attribute' | 'material' | 'vague' | 'brand' | 'negation' | 'zero' | 'canary'
  brands?: string[]
  note?: string
  /** [product name, grade]. Names are resolved to URLs against the database. */
  judgments: [string, Grade][]
  /** Hard boolean gate: this product must appear within the first k results. */
  gate?: { name: string; k: number }
}

const CASES: SeedCase[] = [
  // ---- attribute-precise -------------------------------------------------
  {
    id: 'attr-black-square-midi',
    query: 'black square neck sleeveless midi dress',
    slice: 'attribute',
    judgments: [
      ['Black Square Neck Sleeveless Button Midi Dress', 3],
      ['Green Square Neck Lace Slip Midi Dress', 2],
      ['Red Square Neck Lace A-Line Midi Dress', 2],
      ['Black Sweetheart Neck Slit Ruffle Maxi Dress', 1],
      ['Black V Neck Sleeveless Contrasting Mini Dress', 1],
    ],
    gate: { name: 'Black Square Neck Sleeveless Button Midi Dress', k: 3 },
  },
  {
    id: 'attr-sweetheart-floral-lace-mini',
    query: 'sweetheart neckline floral lace mini dress',
    slice: 'attribute',
    judgments: [
      ['Apricot Sweetheart Neck Floral Lace Mini Dress', 3],
      ['Blue V Neck Lace Splicing Floral Mini Dress', 2],
      ['Blue Sweetheart Neck Chiffon Mini Dress', 2],
      ['Off White V Neck Lace Floral Mini Dress', 2],
      ['Blue Sweetheart Neck Lace Maxi Dress', 1],
    ],
    gate: { name: 'Apricot Sweetheart Neck Floral Lace Mini Dress', k: 3 },
  },
  {
    id: 'attr-mandarin-collar-slit-maxi',
    query: 'mandarin collar maxi dress with a slit',
    slice: 'attribute',
    judgments: [
      ['Purple Mandarin Collar Slit Satin Maxi Dress', 3],
      ['Purple Mandarin Collar Slit Mermaid Midi Dress', 2],
      ['Purple Mandarin Collar Single Breasted Vest', 1],
      ['Blue Boat Neck Slit Chiffon Maxi Dress', 1],
    ],
    gate: { name: 'Purple Mandarin Collar Slit Satin Maxi Dress', k: 3 },
  },
  {
    // Re-authored: the boatneck crop tank rotated out of the Gap catalog.
    id: 'attr-cropped-scoop-cami',
    query: 'cropped scoop neck cami',
    slice: 'attribute',
    judgments: [
      ['Modern Crop Cami', 3],
      ['Pointelle Shell Tank Top', 2],
      ['Knit Oversized Crop T-Shirt', 1],
    ],
    gate: { name: 'Modern Crop Cami', k: 3 },
  },
  {
    // Re-authored: "High Rise Stride Wide-Leg Ankle Jeans" rotated out.
    id: 'attr-high-rise-slim-crop-jeans',
    query: 'high rise slim straight cropped jeans',
    slice: 'attribute',
    judgments: [
      // Gap uses a CURLY apostrophe in this name and a straight one in
      // "Cuffed '90s" below — mixed within one brand's own naming. This is why
      // the seeder resolves names against the database and fails loudly.
      ['High Rise ’90s Slim Straight Crop Jeans', 3],
      ["High Rise Cuffed '90s Slim Straight Jeans", 2],
      ['365 High Rise Pleated Trousers', 1],
    ],
    gate: { name: 'High Rise ’90s Slim Straight Crop Jeans', k: 3 },
  },
  {
    id: 'adjacent-leather-biker-jacket',
    query: 'black leather biker jacket',
    slice: 'attribute',
    note: 'No leather outerwear exists. The denim jacket is the closest real garment.',
    judgments: [['Denim Barn Jacket', 1]],
  },

  // ---- material-led ------------------------------------------------------
  {
    // Re-authored: linen disappeared from the catalog entirely between the June
    // and August crawls. Cashmere appeared in the same rotation, so the slice
    // still tests a pure single-fibre query.
    id: 'mat-cashmere-sweater',
    query: '100% cashmere sweater',
    slice: 'material',
    judgments: [
      ['Bare Cashmere Opus Mockneck', 3],
      ['Essential Cashmere Relic Sweater', 3],
      ['Bare Cashmere Noteworthy Shortsleeve Cardigan', 2],
      ['Essential Cashmere Acclaim Cardigan', 2],
      ['Peggy Sweater', 1],
    ],
    gate: { name: 'Bare Cashmere Opus Mockneck', k: 5 },
  },
  {
    // Re-authored: "Linen-Blend Maxi Slip Skirt" rotated out.
    id: 'mat-satin-midi-skirt',
    query: 'satin midi skirt',
    slice: 'material',
    judgments: [
      ['Henrietta Satin Skirt', 3],
      ['Rosehip Skirt', 2],
      ['Touchpoint Satin Short', 1],
    ],
    gate: { name: 'Henrietta Satin Skirt', k: 3 },
  },
  {
    id: 'mat-cotton-gauze-pants',
    query: 'cotton gauze barrel pants',
    slice: 'material',
    judgments: [
      ['Cotton Gauze Easy Barrel Pants', 3],
      ['Easy Double-Knee Barrel Pants', 2],
      ['Mid Rise Twill Easy Barrel Utility Pants', 2],
      ['Low Rise Barrel Jeans', 1],
    ],
    gate: { name: 'Cotton Gauze Easy Barrel Pants', k: 3 },
  },
  {
    id: 'mat-cotton-oversized-sweater',
    query: '100% cotton oversized sweater',
    slice: 'material',
    judgments: [
      ['100% Cotton Oversized Sweater', 3],
      ['100% Cotton Rollneck Sweater', 2],
      ['Textured Cotton Oversized Half-Zip Pullover', 2],
      ['100% Cotton Pocket Sweater Vest', 1],
    ],
    gate: { name: '100% Cotton Oversized Sweater', k: 3 },
  },
  {
    id: 'mat-satin-camisole',
    query: 'satin camisole',
    slice: 'material',
    judgments: [
      ['Serif Satin Camisole', 3],
      ['Familiar Satin Camisole', 3],
      ['Nominee Satin Blouse', 1],
      ['Dover Satin Shirt', 1],
    ],
    gate: { name: 'Serif Satin Camisole', k: 3 },
  },

  // ---- vague -------------------------------------------------------------
  {
    id: 'vague-cozy-weekend',
    query: 'something cozy for the weekend',
    slice: 'vague',
    note: 'Relies on occasion=lounge/everyday synonyms; no lexical overlap otherwise.',
    judgments: [
      ['Cozy Sweatfleece Mega Straight™ Sweatpant', 3],
      ['Adult Heavyweight Oversized Hoodie', 3],
      ['VintageSoft Terry Oversized Wedge Zip Hoodie', 2],
      ['SoftMade Modal PJ Pants', 2],
      ['VintageSoft Terry Raglan Sweatshirt', 2],
      ['100% Cotton Oversized Sweater', 1],
    ],
  },
  {
    id: 'vague-beach-vacation-dress',
    query: 'beach vacation dress',
    slice: 'vague',
    judgments: [
      ['White Cut Out Tie Strap Beach Dress', 3],
      ['Blue Striped Textured Beach Dress', 3],
      ['Blue Sleeveless Floral Chiffon Maxi Dress', 1],
    ],
    gate: { name: 'White Cut Out Tie Strap Beach Dress', k: 5 },
  },
  {
    id: 'vague-flowy-summer-dress',
    query: 'flowy summer dress',
    slice: 'vague',
    judgments: [
      ['Apricot Pleated Flowy Slip Midi Dress', 3],
      ['Red Jacquard Flowy Chiffon Mini Dress', 3],
      ['Blue Sleeveless Floral Chiffon Maxi Dress', 2],
      ['Pink Lace Button Slip Chiffon Maxi Dress', 1],
    ],
  },
  {
    id: 'vague-office-appropriate',
    query: 'something smart to wear to the office',
    slice: 'vague',
    note: 'Deliberately hard. Tests that occasion=work surfaces at all.',
    judgments: [
      ['365 High Rise Pleated Trousers', 2],
      ['Somerset Pant', 2],
      ['Nominee Satin Blouse', 2],
      ['Purple Mandarin Collar Single Breasted Vest', 2],
      ['Organic Cotton Poplin Big Shirt', 1],
    ],
  },
  {
    id: 'vague-stretchy-tshirt',
    query: 'stretchy fitted t-shirt',
    slice: 'vague',
    note: '"stretchy" must reach elastane through the fibre synonym chain.',
    judgments: [
      ['HomeStretch™ Rib Location T-Shirt', 3],
      ['CloseKnit Jersey T-Shirt', 2],
      ['Modern Rib T-Shirt', 2],
      ['InterLock Cotton Major T-Shirt', 1],
    ],
  },

  // ---- brand-scoped ------------------------------------------------------
  {
    id: 'brand-uniqlo-heattech-high-neck',
    query: 'heattech high neck long sleeve top',
    slice: 'brand',
    brands: ['uniqlo'],
    judgments: [
      ['HEATTECH Ultra Warm High Neck T-Shirt', 3],
      ['HEATTECH Ultra Warm T-Shirt', 2],
    ],
    gate: { name: 'HEATTECH Ultra Warm High Neck T-Shirt', k: 3 },
  },
  {
    id: 'brand-gap-denim-jacket',
    query: 'denim jacket',
    slice: 'brand',
    brands: ['gap'],
    judgments: [
      ['Denim Barn Jacket', 3],
      ['Denim Big Shirt', 1],
    ],
    gate: { name: 'Denim Barn Jacket', k: 3 },
  },
  {
    id: 'brand-aritzia-halter-top',
    query: 'halter top',
    slice: 'brand',
    brands: ['aritzia'],
    judgments: [
      ['Honours Halter Top - Crepette™', 3],
      ['Lexicon Halter Top - Eversential™', 3],
      ['Convention Halter Top - Eversential™', 3],
      ['Martini Satin Halter Top', 3],
      ['Fallaway Satin Top', 2],
    ],
  },
  {
    id: 'brand-rihoas-triangle-bikini',
    query: 'triangle bikini set',
    slice: 'brand',
    brands: ['rihoas'],
    judgments: [
      ['White Halter Rhinestones Triangle Bikini Set', 3],
      ['White Tie Strap Triangle Bikini Set', 3],
      ['Blue Solid Tie Triangle Bikini Set', 3],
      ['Black Halter Textured Triangle Bikini Set', 3],
      ['Wine Red Textured Triangle Bikini Set', 3],
      ['Blue V Neck Textured Bralette Bikini Set', 2],
    ],
  },

  // ---- negation ----------------------------------------------------------
  {
    id: 'neg-no-sleeves-dress',
    query: 'dress with no sleeves',
    slice: 'negation',
    note: 'BM25 scores "sleeve" positively. Expect poor results until expansion rewrites this.',
    judgments: [
      ['Red Backless Slit Chiffon Maxi Dress', 2],
      ['Blue Sleeveless Floral Chiffon Maxi Dress', 3],
      ['Pink Round Neck Sleeveless Floral Maxi Dress', 3],
      ['Black Square Neck Sleeveless Button Midi Dress', 3],
    ],
  },
  {
    id: 'neg-not-floral-maxi',
    query: 'maxi dress that is not floral',
    slice: 'negation',
    note: 'Solid maxi dresses are correct; floral ones are the trap.',
    judgments: [
      ['Red Backless Slit Chiffon Maxi Dress', 3],
      ['Green Mock Neck Slit Chiffon Maxi Dress', 3],
      ['Black Sweetheart Neck Slit Ruffle Maxi Dress', 3],
      ['White Solid Tie Strap A-Line Maxi Dress', 3],
      ['Yellow X Cross Ruched Tunic Maxi Dress', 3],
    ],
  },
  {
    id: 'neg-shirt-without-buttons',
    query: 'shirt without buttons',
    slice: 'negation',
    judgments: [
      ['Off White Turtle Tie Regular Sleeve Shirt', 3],
      ['Archive Shirt', 1],
    ],
  },

  // ---- zero-result -------------------------------------------------------
  {
    // RECLASSIFIED. This was a zero-result case in the June catalog, which had no
    // wool at all. The August crawl introduced two wool garments, so "wool" now
    // matches and the query is answerable-adjacent rather than unanswerable: the
    // results are genuinely wool, just not coats. Kept as an adjacency case
    // because it documents a real catalog rotation rather than a ranking change.
    id: 'adjacent-wool-overcoat',
    query: 'wool overcoat',
    slice: 'attribute',
    note: 'No outerwear is wool. The two wool knits are the closest real garments.',
    judgments: [
      ['Peggy Sweater', 1],
      ['Somerset Pant', 1],
    ],
  },
  {
    // Replacement true zero. Verified against the live catalog: 0 results.
    // "leather ankle boots" and "silk kimono robe" are NOT usable here — leather
    // and silk both exist now, so they return adjacent garments.
    id: 'zero-swimming-goggles',
    query: 'swimming goggles',
    slice: 'zero',
    note: 'No eyewear or swim accessories exist, and none of these terms appear anywhere.',
    judgments: [],
  },
  {
    id: 'zero-hiking-boots',
    query: 'waterproof hiking boots',
    slice: 'zero',
    note:
      'The catalog has no footwear at all, and none of these terms appear anywhere, ' +
      'so a correct system returns nothing.',
    judgments: [],
  },

  // ---- canary ------------------------------------------------------------
  {
    id: 'canary-tie-back-high-collar',
    query: 'cotton tie-back shirt, high collar, one tie',
    slice: 'canary',
    note:
      'The product plan\'s headline success criterion. NOTE: no perfect answer exists — ' +
      'the best match is 100% polyester, not cotton, and nothing in the catalog is ' +
      'literally tie-back. Graded 3 because it is the right garment type with two of the ' +
      'three distinctive attributes (turtle = high collar, tie).',
    judgments: [
      ['Off White Turtle Tie Regular Sleeve Shirt', 3],
      ['Apricot Turtle Drop Shoulder Tie Tee', 2],
      ['Apricot Turtle Pearls Button Tank Top', 2],
      ['Apricot Turtle Cowl Sleeve Ruched Tee', 2],
      ['Denim Big Shirt', 1],
      ['Green Mock Neck Slit Chiffon Maxi Dress', 1],
    ],
    gate: { name: 'Off White Turtle Tie Regular Sleeve Shirt', k: 3 },
  },
]

async function main(): Promise<void> {
  const rows = await db
    .selectFrom('products')
    .select(['name', 'brand', 'product_url'])
    .where('is_active', '=', true)
    .execute()

  const byName = new Map<string, string[]>()
  for (const r of rows) {
    const key = r.name.toLowerCase()
    byName.set(key, [...(byName.get(key) ?? []), r.product_url])
  }

  const problems: string[] = []
  const resolve = (name: string, caseId: string): string | null => {
    const urls = byName.get(name.toLowerCase())
    if (!urls || urls.length === 0) {
      problems.push(`${caseId}: no product named "${name}"`)
      return null
    }
    if (urls.length > 1) {
      // Colourways of one style share a name (three Gap CloseKnit T-shirts).
      // Taking the first is fine for a judgment, but say so out loud.
      console.warn(`  note  ${caseId}: "${name}" matches ${urls.length} products; using the first`)
    }
    return urls[0]
  }

  const out = CASES.map((c) => {
    const judgments = c.judgments
      .map(([name, grade]) => {
        const url = resolve(name, c.id)
        return url ? { url, grade, name } : null
      })
      .filter((j): j is { url: string; grade: Grade; name: string } => j !== null)

    let gate: { url: string; k: number } | undefined
    if (c.gate) {
      const url = resolve(c.gate.name, c.id)
      if (url) gate = { url, k: c.gate.k }
    }

    return {
      id: c.id,
      query: c.query,
      slice: c.slice,
      ...(c.brands ? { brands: c.brands } : {}),
      ...(c.note ? { note: c.note } : {}),
      judgments,
      ...(gate ? { gate } : {}),
    }
  })

  if (problems.length > 0) {
    console.error('\nUnresolved product names — fix these before committing:')
    for (const p of problems) console.error(`  ${p}`)
    process.exitCode = 1
    return
  }

  const dir = path.join(REPO_ROOT, 'backend/evals/golden')
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'queries.json')
  writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`)

  const bySlice = out.reduce<Record<string, number>>((a, c) => {
    a[c.slice] = (a[c.slice] ?? 0) + 1
    return a
  }, {})
  const judged = out.reduce((n, c) => n + c.judgments.length, 0)
  console.log(`\nwrote ${out.length} cases, ${judged} judgments -> ${path.relative(REPO_ROOT, file)}`)
  console.log(`slices: ${Object.entries(bySlice).map(([k, v]) => `${k} ${v}`).join(', ')}`)
}

try {
  await main()
} finally {
  await db.destroy()
}
