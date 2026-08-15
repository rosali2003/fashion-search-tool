import { type Kysely } from 'kysely'

/**
 * Q5 — the aesthetic answer from the style questionnaire.
 *
 * The other four questions already had somewhere to land. Q1 and Q2 seed the
 * existing `silhouette_pref` and `material_pref` jsonb dictionaries, Q3 writes the
 * price band, and Q4 writes `brand_scores` — so this is the only column the
 * questionnaire actually needed.
 *
 * It is a single text value rather than a jsonb weight map, unlike its two
 * neighbours, and the asymmetry is deliberate. `silhouette_pref` and
 * `material_pref` are dictionaries because ELO updates them per comparison, one
 * key at a time. Aesthetic is not learnable that way: a comparison between two
 * garments says something about a silhouette or a fibre, but nothing legible
 * about whether the shopper is "minimal" or "eclectic", since either could
 * plausibly have won. Storing it as a declared answer keeps the honest shape —
 * this is what the shopper said about themselves, not something inferred.
 *
 * Nullable because the whole questionnaire is skippable, and an unanswered Q5
 * scores every garment neutral rather than filtering anything out.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('user_preferences')
    .addColumn('style_cluster', 'text')
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('user_preferences').dropColumn('style_cluster').execute()
}
