# Optional accounts

Ink supports Google sign-in and email sign-up/sign-in using a six-digit code.
Both are optional. A user can skip the questionnaire, search anonymously, or save
a guest profile without providing an email address. Accounts persist the existing
fit/style preferences, comparison history, and learned preferences in Postgres.

## Configure Google

1. Create an OAuth client of type **Web application** in Google Cloud and configure
   its consent screen with the `openid`, `email`, and `profile` scopes. Add test
   users while the Google app is in testing mode.
2. Register `http://localhost:5173/api/auth/google/callback` for development and
   `https://YOUR_FRONTEND_DOMAIN/api/auth/google/callback` for production as
   authorized redirect URIs. Use the frontend domain, not the Railway API domain.
3. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` on the backend. Set `APP_ORIGIN`
   to the frontend origin, without a path. This is required in production and
   must use HTTPS except on localhost.

The backend uses openid-client to validate state, nonce, PKCE, the ID token's
issuer/audience/expiry, and its signature. Google access and refresh tokens are
not retained. See [Google's OpenID Connect documentation](https://developers.google.com/identity/openid-connect/openid-connect).

## Configure Twilio email codes

1. Create a Twilio Verify service with **six-digit codes** and the standard
   **10-minute validity period**.
2. Configure SendGrid sender/domain authentication and create a dynamic email
   template containing `{{twilio_code}}`. Include the Ink name and a note to
   ignore the email if the recipient did not request sign-in.
3. Create a Verify email integration with the SendGrid API key, verified sender,
   and template. Attach it to the Verify service's email channel.
4. Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_VERIFY_SERVICE_SID`
   on the backend. The SendGrid API key lives in the Twilio integration and is
   not needed by Ink itself.

Follow [Twilio's Verify email setup](https://www.twilio.com/docs/verify/email).
There is no password database, password-reset flow, SMS request, or development
backdoor code. Automated tests mock the providers; normal development requires
configured providers to complete sign-in. Missing credentials hide the relevant
option; invalid credentials produce a retryable error while guests can browse.

## Profile and session behavior

- A new account inherits the browser's current guest profile, including comparison
  history. Existing accounts restore their saved profile; guest preferences do not
  overwrite it. An abandoned guest row may remain in Postgres.
- Google accounts are identified by provider subject. If an unfamiliar Google
  subject has the same email as an existing account, Ink asks for an email code
  before linking. This requires the Twilio integration. Signing in with an email
  code also restores a Google-created account with that email.
- Email addresses are trimmed and lowercased. Dots and plus aliases are preserved.
  A Google email must be verified. Name changes are explicit through “Your account”
  (or the greeting); later Google sign-ins do not overwrite a chosen name.
- Session cookies are host-only, HttpOnly, SameSite=Lax, Secure on HTTPS, and expire
  after 30 days. Only token hashes are stored in Postgres. Guest-to-account
  conversion revokes the guest sessions and issues a new token. Logout revokes
  this browser's session and pending challenges; other devices remain signed in.
- The client refreshes its session when the tab regains focus. Profile and search
  authorization always comes from the server's cookie session, never a body,
  path, or localStorage user ID.
- **Legacy guests:** old `ink.userId` localStorage values no longer establish
  ownership. Their database rows are preserved, but they must recreate their
  profile. There is no safe automatic account claim from a public UUID alone.

## Deploy

1. Back up the database and run `pnpm migrate` before deploying the new backend.
   Migration `009_auth` adds account, session, challenge, and rate-limit tables;
   it does not rewrite existing users or preferences.
2. Deploy the backend and frontend together, setting provider secrets only on the
   backend. Keep the existing Vercel `/api` rewrite and Vite development proxy.
   Old frontends using UUIDs as credentials must be refreshed after deployment.
3. Check sign-in on the actual public frontend hostname: Google callback URLs,
   `Set-Cookie` forwarding, cookie storage, refresh, sign-out, and a second browser.
   Authentication/profile responses must retain `Cache-Control: no-store` through
   the proxy. Do not add a cookie Domain or share cookies with the Railway domain.
4. Leave `AUTH_TRUSTED_IP_HEADER` unset unless the backend is restricted to a proxy
   which overwrites that header. The default uses the socket peer, which may group
   users behind a proxy. Never trust a client-supplied forwarding header on a
   publicly reachable backend. Email and global limits still apply independently.

Email send limits are persisted and atomic: five/hour per address, 20/hour per
socket peer, 200/hour globally, plus a 60-second resend cooldown. Verification
checks allow five attempts per challenge, 20/10 minutes per email, 60/10 minutes
per peer, and 1,000/hour globally. Configure Twilio account spending alerts too.
Temporary records are pruned during authentication requests. Logs record generic
provider failure events, not email addresses, codes, tokens, or OAuth parameters.

To disable one method, remove its credentials. Existing sessions continue to
work. To roll back application code, preserve the auth tables and avoid restoring
the old UUID-based profile endpoints on an authenticated deployment.

## Validate

```bash
pnpm --filter backend typecheck
pnpm --filter backend test
pnpm --filter frontend build
AUTH_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5433/ink \
  pnpm --filter backend exec node --import tsx --test src/auth/integration.test.ts
```

The integration suite needs a dedicated local Postgres database with permission
to create schemas. It creates and removes a unique schema, runs the actual user
and auth migrations, and does not need ParadeDB or external provider credentials.
Without `AUTH_TEST_DATABASE_URL`, this suite is skipped. Tests cover guest access,
profile authorization, session rotation/expiry/logout, email sign-up, Google
registration, account linking, returning-profile precedence, challenge replay,
rate limits, and migration rollback/reapply. Complete a real Google and Twilio
sign-in on the deployed hostname before treating provider/proxy setup as verified.
