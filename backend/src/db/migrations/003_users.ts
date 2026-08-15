import { sql, type Kysely } from 'kysely'

/**
 * Users, their preferences, and the A/B comparison log.
 *
 * No passwords and no sessions: a generated uuid lives in the browser's
 * localStorage and identifies the profile. That is deliberate for an invite-only
 * MVP, and real auth slots in later without changing the shape of these tables —
 * it only adds a credential table alongside.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('users')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('display_name', 'text')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute()

  await db.schema
    .createTable('user_preferences')
    .addColumn('user_id', 'uuid', (c) =>
      c.primaryKey().references('users.id').onDelete('cascade'),
    )

    // --- declared at onboarding --------------------------------------------
    // Body proportions. These only became meaningful once vision extraction
    // supplied garment geometry to match them against — the scraped text has
    // zero size or fit data (0/298 products mention petite or tall).
    .addColumn('height_cm', 'integer')
    .addColumn('body_type', 'text')
    .addColumn('shoulders', 'text')
    .addColumn('torso', 'text')
    .addColumn('waist', 'text')

    // 0.0 = synthetics fine, 1.0 = natural fibres only. A slider, not a
    // checkbox, precisely because it must act as a soft ranking boost: natural
    // fibre content correlates hard with brand (Gap 86%, Uniqlo 83%, Aritzia
    // 54%, Rihoas 21%), so a hard filter here would silently delete a third of
    // the catalog without the user ever excluding a brand.
    .addColumn('fiber_preference', 'numeric')
    .addColumn('quality_tier', 'text')
    .addColumn('price_min_cents', 'integer')
    .addColumn('price_max_cents', 'integer')
    // The single hard filter in the whole system. Explicit deselection is the
    // one preference the user means absolutely.
    .addColumn('excluded_brands', sql`text[]`, (c) => c.notNull().defaultTo(sql`'{}'::text[]`))

    // --- learned via ELO ----------------------------------------------------
    // Selected brands are seeded at 0.7 and unselected at 0.5, so onboarding
    // choices act as a warm prior rather than a cold start.
    .addColumn('brand_scores', 'jsonb', (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('material_pref', 'jsonb', (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('silhouette_pref', 'jsonb', (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('comparisons_count', 'integer', (c) => c.notNull().defaultTo(0))

    .addColumn('onboarded_at', 'timestamptz')
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute()

  /**
   * Append-only log of every comparison.
   *
   * The ELO scores in user_preferences are a derived projection of this table.
   * Keeping the raw events means a badly chosen K-factor can be re-simulated
   * from history instead of re-collected from users — which matters because the
   * product plan wants K validated against real behaviour, and 20 comparisons
   * per beta user is expensive to gather twice.
   */
  await db.schema
    .createTable('ab_comparisons')
    .addColumn('id', 'bigserial', (c) => c.primaryKey())
    .addColumn('user_id', 'uuid', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('winner_product_id', 'bigint', (c) => c.notNull().references('products.id'))
    .addColumn('loser_product_id', 'bigint', (c) => c.notNull().references('products.id'))
    // 'ab' for an explicit comparison, 'find_similar' for an implicit positive.
    .addColumn('source', 'text', (c) => c.notNull().defaultTo('ab'))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute()

  await db.schema
    .createIndex('ab_comparisons_user_idx')
    .on('ab_comparisons')
    .columns(['user_id', 'created_at'])
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('ab_comparisons').ifExists().execute()
  await db.schema.dropTable('user_preferences').ifExists().execute()
  await db.schema.dropTable('users').ifExists().execute()
}
