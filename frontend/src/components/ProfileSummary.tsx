import type { Profile } from '../api/types.js'

/**
 * Profile summary on the search screen.
 *
 * A single quiet row rather than a card: it is orientation, not content, and the
 * results grid immediately below is what the user came for.
 *
 * Brand affinities are shown as bars because that is the part of the profile that
 * visibly moves with use — it is the feedback loop that makes the A/B comparisons
 * feel worth doing.
 */
export function ProfileSummary({
  profile,
  stableAt,
}: {
  profile: Profile
  stableAt: number
  /** Accepted for call-site compatibility; the reset control lives in the masthead. */
  onReset?: () => void
}) {
  const body = [
    profile.body.body_type,
    profile.body.shoulders && `${profile.body.shoulders} shoulders`,
    profile.body.torso && `${profile.body.torso} torso`,
    profile.body.waist && `${profile.body.waist} waist`,
  ].filter(Boolean) as string[]

  const fiber = profile.fiberPreference

  // Only fibres the profile has actually moved on. Listing everything at 0.5
  // would present the neutral default as a learned preference.
  const materials = Object.entries(profile.materialPref)
    .sort(([, a], [, b]) => b - a)
    .filter(([, v]) => v > 0.55)
    .slice(0, 4)
    .map(([m]) => m)

  return (
    <div className="profile">
      <span className="u-label">Your profile</span>

      {profile.styleCluster && (
        <span className="profile__row">
          <span className="profile__k">Taste</span>
          <span>{profile.styleCluster}</span>
        </span>
      )}

      {body.length > 0 && (
        <span className="profile__row">
          <span className="profile__k">Fit</span>
          <span>{body.join(' · ')}</span>
        </span>
      )}

      {fiber !== null && (
        <span className="profile__row">
          <span className="profile__k">Fabric</span>
          <span className="bar">
            <span className="bar__track">
              <span className="bar__fill" style={{ width: `${fiber * 100}%` }} />
            </span>
            {Math.round(fiber * 100)}% natural
          </span>
        </span>
      )}

      {profile.brands.length > 0 && (
        <span className="profile__row">
          <span className="profile__k">Brands</span>
          {/* Name before bar. With the bar first the row reads as a series of
              rules separating the brand names rather than as labelled values. */}
          {profile.brands.slice(0, 4).map((b) => (
            <span className="bar" key={b.brand} title={`affinity ${b.score.toFixed(2)}`}>
              {b.brand}
              <span className="bar__track">
                <span className="bar__fill" style={{ width: `${b.score * 100}%` }} />
              </span>
            </span>
          ))}
        </span>
      )}

      {materials.length > 0 && (
        <span className="profile__row">
          <span className="profile__k">Learned</span>
          <span>{materials.join(' · ')}</span>
        </span>
      )}

      <span className="profile__row u-num">
        <span className="profile__k">Comparisons</span>
        <span>
          {profile.comparisonsCount}
          {profile.profileStable ? ' — profile built' : ` of ${stableAt}`}
        </span>
      </span>
    </div>
  )
}
