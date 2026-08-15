import { sql, type Kysely } from 'kysely'

/**
 * Corrects a wrong assumption in 002.
 *
 * `vendor_sku` is captured from Gap descriptions ("Product #544347") and was
 * given a unique index on (brand, vendor_sku) as a second identity net behind
 * product_url. That is wrong: Gap's "Product #" is a *style* number shared
 * across colourways, not a product identifier. Measured in the current corpus,
 * 50 Gap products carry only 45 distinct numbers — three separate CloseKnit
 * Jersey T-Shirt pages (pid 544347352, 544347292, 544347332) all report
 * #544347, and three other styles are doubled up the same way.
 *
 * The unique index therefore rejected legitimate rows. Replaced with a plain
 * index, which is what the column is actually useful for: grouping colourways of
 * one style together.
 *
 * product_url remains the sole identity key.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS products_brand_sku_idx`.execute(db)
  await sql`
    CREATE INDEX products_brand_sku_idx ON products (brand, vendor_sku)
    WHERE vendor_sku IS NOT NULL
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS products_brand_sku_idx`.execute(db)
  await sql`
    CREATE UNIQUE INDEX products_brand_sku_idx ON products (brand, vendor_sku)
    WHERE vendor_sku IS NOT NULL
  `.execute(db)
}
