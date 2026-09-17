import { useEffect, useRef, useState } from 'react'
import type { AuthSession } from '../api/types.js'
import { requestEmailCode, verifyEmailCode, updateName } from '../api/client.js'

export function AccountDialog({ session, onClose, onChanged }: {
  session: AuthSession
  onClose: () => void
  onChanged: () => Promise<void>
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [email, setEmail] = useState(session.linkingEmail ?? '')
  const [code, setCode] = useState('')
  const [name, setName] = useState(session.user?.name ?? '')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [retryAt, setRetryAt] = useState(0)
  const [now, setNow] = useState(Date.now())
  const signedIn = session.user?.authenticated
  const linking = Boolean(session.linkingEmail)
  const remaining = Math.max(0, Math.ceil((retryAt - now) / 1000))

  useEffect(() => {
    dialog.current?.showModal()
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  async function send() {
    setBusy(true)
    setError(null)
    try {
      await requestEmailCode(email, linking)
      setSent(true)
      setCode('')
      setRetryAt(Date.now() + 60_000)
      setNow(Date.now())
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not send your code')
    } finally { setBusy(false) }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!signedIn && !sent) return send()
    setBusy(true)
    setError(null)
    try {
      if (signedIn) await updateName(name)
      else await verifyEmailCode(code)
      await onChanged()
      if (signedIn) onClose()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not complete sign-in')
    } finally { setBusy(false) }
  }

  return (
    <dialog className="account-dialog" ref={dialog} aria-labelledby="account-title" onCancel={event => {
      event.preventDefault()
      if (!busy) onClose()
    }}>
      <div className="account-dialog__heading">
        <h2 id="account-title">{signedIn ? 'Your account' : linking ? 'Confirm your email' : 'Save your profile'}</h2>
        <button className="btn btn--quiet" onClick={onClose} disabled={busy} aria-label="Close account dialog">Close</button>
      </div>
      <p>{signedIn ? 'Your profile is saved across devices. What should we call you?' : linking
        ? 'Verify your email to connect Google to your saved account.'
        : 'Sign in or create an account to keep your preferences across devices. You can always continue as a guest.'}</p>
      {!signedIn && !linking && session.googleEnabled && (
        <a className="btn btn--primary account-dialog__google" href="/api/auth/google">Continue with Google</a>
      )}
      {(signedIn || session.emailEnabled) && (
        <form onSubmit={submit}>
          {signedIn ? (
            <label>Your name (optional)
              <input autoFocus autoComplete="name" value={name} maxLength={80} onChange={event => setName(event.target.value)} disabled={busy} />
            </label>
          ) : (
            <>
              <label>Email address
                <input autoFocus type="email" autoComplete="email" required value={email}
                  onChange={event => setEmail(event.target.value)} disabled={busy || sent || linking} />
              </label>
              {sent && <label>Six-digit code
                <input autoFocus inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6}
                  value={code} onChange={event => setCode(event.target.value)} required disabled={busy} />
              </label>}
              {sent && <p role="status">Check your inbox for the code. It expires after 10 minutes.</p>}
            </>
          )}
          <button className="btn btn--primary" disabled={busy} type="submit">
            {busy ? 'Please wait…' : signedIn ? 'Save name' : sent ? 'Verify and continue' : 'Email me a code'}
          </button>
          {sent && !signedIn && <div className="account-dialog__actions">
            <button className="btn btn--quiet" type="button" disabled={busy || remaining > 0} onClick={() => void send()}>
              {remaining > 0 ? `Resend in ${remaining}s` : 'Resend code'}
            </button>
            {!linking && <button className="btn btn--quiet" type="button" disabled={busy} onClick={() => { setSent(false); setCode(''); setError(null) }}>Change email</button>}
          </div>}
        </form>
      )}
      {error && <p className="account-error" role="alert">{error}</p>}
      <button className="btn btn--quiet" onClick={onClose} disabled={busy}>{signedIn ? 'Done' : 'Continue as guest'}</button>
    </dialog>
  )
}
