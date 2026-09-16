import * as oidc from 'openid-client'
import { appOrigin, normalizeEmail } from './security.js'

export const googleEnabled = () => Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)
export const emailEnabled = () => Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_VERIFY_SERVICE_SID)
export const redirectUri = () => `${appOrigin()}/api/auth/google/callback`

let googleConfiguration: Promise<oidc.Configuration> | undefined

async function googleConfig() {
  if (!googleEnabled()) throw new Error('Google is not configured')
  googleConfiguration ??= oidc.discovery(new URL('https://accounts.google.com'),
    process.env.GOOGLE_CLIENT_ID!, process.env.GOOGLE_CLIENT_SECRET!, undefined, { timeout: 10 })
    .then(config => {
      oidc.enableNonRepudiationChecks(config)
      return config
    }).catch(error => {
      googleConfiguration = undefined
      throw error
    })
  return googleConfiguration
}

export const providers = {
  async googleStart(state: string, verifier: string, nonce: string): Promise<string> {
    return oidc.buildAuthorizationUrl(await googleConfig(), {
      redirect_uri: redirectUri(), scope: 'openid email profile', response_type: 'code', state, nonce,
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256',
      prompt: 'select_account',
    }).href
  },

  async googleFinish(url: URL, state: string, verifier: string, nonce: string) {
    const tokens = await oidc.authorizationCodeGrant(await googleConfig(), url, {
      expectedState: state, pkceCodeVerifier: verifier, expectedNonce: nonce, idTokenExpected: true,
    })
    const claims = tokens.claims()
    const email = normalizeEmail(claims?.email)
    if (!claims?.sub || !email || claims.email_verified !== true) throw new Error('Verified Google email required')
    return { subject: claims.sub, email, name: typeof claims.name === 'string' ? claims.name.slice(0, 80) : null }
  },

  async sendCode(email: string): Promise<string> {
    const result = await twilioRequest('Verifications', { To: email, Channel: 'email' })
    if (result.status !== 'pending' || typeof result.sid !== 'string') throw new Error('Email delivery failed')
    return result.sid
  },

  async checkCode(sid: string, code: string, email: string): Promise<boolean> {
    const result = await twilioRequest('VerificationCheck', { VerificationSid: sid, Code: code })
    return result.status === 'approved' && result.sid === sid && normalizeEmail(result.to) === email
  },
}

async function twilioRequest(resource: string, fields: Record<string, string>): Promise<Record<string, unknown>> {
  if (!emailEnabled()) throw new Error('Email is not configured')
  const service = encodeURIComponent(process.env.TWILIO_VERIFY_SERVICE_SID!)
  const response = await fetch(`https://verify.twilio.com/v2/Services/${service}/${resource}`, {
    method: 'POST', signal: AbortSignal.timeout(10_000),
    headers: { Authorization: `Basic ${Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64')}` },
    body: new URLSearchParams(fields),
  })
  if (resource === 'VerificationCheck' && [400, 404, 429].includes(response.status)) return { status: 'invalid' }
  if (!response.ok) throw new Error('Email provider unavailable')
  return await response.json() as Record<string, unknown>
}
