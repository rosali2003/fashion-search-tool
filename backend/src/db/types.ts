import type { ColumnType, Generated } from 'kysely'

/** One fibre component parsed out of a brand's material string. */
export interface Fiber {
  fiber: string
  pct: number | null
  /** 'main' (shell/body), 'lining', 'cup', etc. Only 'main' feeds natural_ratio. */
  component: string
  recycled?: boolean
  organic?: boolean
}

/**
 * A disagreement between the text-derived and vision-derived value for a facet.
 * Stored rather than resolved away — e.g. the Rihoas product named "Apricot
 * ... Pearl Satin Midi Dress" photographs as cream and matte.
 */
export interface AttributeConflict {
  field: string
  text_value: string | null
  vision_value: string | null
}

/**
 * jsonb: parsed object on read, serialised string on write.
 *
 * Written as a single ColumnType rather than `Generated<Json<T>>` — nesting one
 * ColumnType inside another does not compose, and produces the confusing error
 * that `string` is not assignable to the column type on insert. Insert is
 * optional because every jsonb column has a database default.
 */
type JsonCol<T> = ColumnType<T, string | undefined, string>

/**
 * numeric. pg returns NUMERIC as a string to protect precision; db/index.ts
 * installs a type parser that converts it to number, so the select type here is
 * number to match runtime reality.
 */
type NumericCol<Null extends boolean = false> = ColumnType<
  Null extends true ? number | null : number,
  Null extends true ? number | string | null | undefined : number | string | undefined,
  number | string | null
>

export interface ProductsTable {
  id: Generated<number>

  product_url: string
  brand: string
  vendor_sku: string | null
  content_hash: string
  source_run: string
  scraped_at: Date | null
  first_seen_at: Generated<Date>
  last_seen_at: Generated<Date>
  is_active: Generated<boolean>

  raw_name: string
  raw_description: string | null
  raw_material: string | null
  price_cents: number | null
  image_urls: Generated<string[]>
  image_hashes: Generated<string[]>

  name: string
  name_variant: string | null
  description_clean: string | null
  material_clean: string | null
  fibers: JsonCol<Fiber[]>
  fiber_names: Generated<string[]>
  natural_ratio: NumericCol<true>
  primary_fiber: string | null
  fibers_incomplete: Generated<boolean>
  fabric: Generated<string[]>

  category: string | null
  subcategory: string | null
  silhouette: string | null
  neckline: string | null
  sleeve_length: string | null
  length: string | null
  rise: string | null
  fit: string | null
  pattern: string | null
  colors: Generated<string[]>
  details: Generated<string[]>
  occasion: Generated<string[]>
  season: Generated<string[]>

  size_range: Generated<string[]>
  model_height_cm: number | null
  model_size: string | null
  fit_notes: string | null

  attributes_source: string | null
  attributes_model: string | null
  attributes_version: Generated<number>
  attributes_at: Date | null

  v_category: string | null
  v_silhouette: string | null
  v_neckline: string | null
  v_sleeve_length: string | null
  v_length: string | null
  v_pattern: string | null
  v_colors: Generated<string[]>
  v_details: Generated<string[]>
  v_rise: string | null
  v_waist_position: string | null
  v_hem_break: string | null
  v_shoulder_treatment: string | null
  v_neckline_width: string | null
  v_volume: string | null
  v_vertical_line: string | null
  v_waist_definition: string | null
  v_drape: string | null
  v_structure: string | null
  v_finish_cues: Generated<string[]>
  v_confidence: NumericCol<true>
  /** Maintained by ingest: hash of the CURRENT image set. */
  image_set_hash: string | null
  /** Written by the vision pass: the image set it actually extracted from. */
  vision_image_set_hash: string | null
  vision_version: Generated<number>
  vision_at: Date | null
  /** Which model produced the v_* columns. Null for pre-migration rows. */
  vision_model: string | null
  attribute_conflicts: JsonCol<AttributeConflict[]>

  search_title: Generated<string>
  search_attrs: Generated<string>
  search_material: Generated<string>
  search_body: Generated<string>
}

export interface ExpansionCacheTable {
  query_hash: string
  query_text: string
  expansion: JsonCol<unknown>
  model: string
  hits: Generated<number>
  created_at: Generated<Date>
}

export interface IngestRunsTable {
  id: Generated<number>
  run_dir: string
  brand: string
  seen: Generated<number>
  inserted: Generated<number>
  updated: Generated<number>
  deactivated: Generated<number>
  skipped_unchanged: Generated<number>
  llm_calls: Generated<number>
  vision_calls: Generated<number>
  cost_usd: NumericCol
  duration_ms: number | null
  created_at: Generated<Date>
}

export interface UsersTable {
  id: Generated<string>
  display_name: string | null
  created_at: Generated<Date>
}

export interface UserPreferencesTable {
  user_id: string
  height_cm: number | null
  body_type: string | null
  shoulders: string | null
  torso: string | null
  waist: string | null
  fiber_preference: NumericCol<true>
  quality_tier: string | null
  /** Q5 of the style questionnaire. Declared, not learned — see migration 008. */
  style_cluster: string | null
  price_min_cents: number | null
  price_max_cents: number | null
  excluded_brands: Generated<string[]>
  brand_scores: JsonCol<Record<string, number>>
  material_pref: JsonCol<Record<string, number>>
  silhouette_pref: JsonCol<Record<string, number>>
  comparisons_count: Generated<number>
  onboarded_at: Date | null
  updated_at: Generated<Date>
}

export interface AbComparisonsTable {
  id: Generated<number>
  user_id: string
  winner_product_id: number
  loser_product_id: number
  source: Generated<string>
  created_at: Generated<Date>
}

export interface Database {
  products: ProductsTable
  expansion_cache: ExpansionCacheTable
  ingest_runs: IngestRunsTable
  users: UsersTable
  user_preferences: UserPreferencesTable
  ab_comparisons: AbComparisonsTable
}
