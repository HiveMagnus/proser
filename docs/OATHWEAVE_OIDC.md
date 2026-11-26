# Oathweave sign-in with OpenID Connect

Proser can sign writers in through Oathweave with OpenID Connect: the
authorization code flow with S256 PKCE. The browser goes to Oathweave to sign
in, and Proser exchanges the one-time code from its server. Passwords and
second factors are entered at Oathweave and never pass through Proser.

The password relay (`IAM_CORE_URL`) remains available as a fallback. It posts
the username and password the writer types into Proser to Oathweave's login
API. Once OIDC sign-in works, turn the relay off as described in
[Stop relaying passwords](#stop-relaying-passwords).

## How accounts are matched

Proser keys an Oathweave account on the ID token's `sub`, which is Oathweave's
stable user ID.

- **First OIDC sign-in of an existing writer:** Factory finds the account the
  password relay created for the same Oathweave username (`iam:<username>`,
  taken from `preferred_username`). It records the `sub` on that account. Books,
  drafts and settings stay where they are. Drafts kept in the browser stay
  available too, because the relay already used the Oathweave user ID as the
  session user.
- **Later sign-ins** resolve by `sub`, so a username renamed in Oathweave
  still reaches the same account.
- **New writers** get a new account.
- **Reused usernames:** an account already linked to one `sub` is never given
  to another. When a different Oathweave user signs in with a username whose
  account belongs to someone else, that user gets a separate account, and
  Factory logs a warning.
- **Unchanged:** local accounts (`LOCAL_AUTH_*`), GitHub accounts and relay
  sign-ins resolve exactly as before. A linked account keeps its
  `iam:<username>` handle, so relay sign-ins and Hermes owner delegations still
  reach it.

Local accounts (`LOCAL_AUTH_USERNAME`) use the same `iam:<username>` handle as
relay accounts. Before you enable OIDC on an installation that used local
credentials, make sure the local username either matches the intended writer's
Oathweave username or differs from every Oathweave username. The first OIDC
sign-in with that username links the local account and its books, as switching
to the password relay already did.

The link is stored in the `users.oathweave_subject` column, added by the
`20261127100000_oathweave_subject` migration. Earlier Proser releases ignore it.

## Register Proser in Oathweave

Use the callback URL that matches `PROSER_ORIGIN`, the exact origin writers
open:

```text
https://proser.example.com/api/auth/callback/oathweave
```

Proser requests the scopes `openid profile email`. `profile` is required
because it provides `preferred_username`, which links existing accounts.

### Through the HiveXUI sign-in portal (suite installations)

In a suite installation, HiveXUI's `/auth/authorize` page is the interactive
Oathweave sign-in and consent portal. It accepts public clients whose IDs start
with `hivexui-`, Code with S256 PKCE, and the `openid` scope. Proser supports
all of these.

1. Add a browser policy for the client to Oathweave's
   `IAM_BROWSER_CLIENT_POLICIES` and restart Oathweave. Proser uses only the ID
   token, so the permission list can stay empty:

   ```json
   { "hivexui-proser": { "audience": "proser", "permissions": [] } }
   ```

   Keep the existing entries in that object. Browser discovery also needs
   `IAM_BROWSER_ISSUER`, `IAM_BROWSER_AUTHORIZATION_URL` and
   `IAM_BROWSER_API_BASE_URL`. See Oathweave's `docs/BROWSER_SSO.md`.

2. Register the client with an identity administrator's token
   (`iam:clients:write`) using `POST /api/v1/clients`:

   ```json
   {
     "name": "hivexui-proser",
     "description": "Proser writing studio",
     "clientType": "public",
     "redirectUris": ["https://proser.example.com/api/auth/callback/oathweave"],
     "grantTypes": ["authorization_code"],
     "firstParty": true
   }
   ```

   Oathweave allocates the client ID `hivexui-proser` because the name matches
   the browser policy. A public client has no secret. `firstParty: true` skips
   the consent screen when you operate both applications. Leave it `false` if
   writers should approve access the first time.

3. Configure Proser (`.env.compose`), then recreate Author:

   ```dotenv
   OATHWEAVE_OIDC_ISSUER=https://identity.example.com
   OATHWEAVE_OIDC_CLIENT_ID=hivexui-proser
   OATHWEAVE_OIDC_DISCOVERY_URL=https://identity.example.com/api/oathweave/oauth/.well-known/openid-configuration?client_id=hivexui-proser
   ```

   `OATHWEAVE_OIDC_ISSUER` must equal Oathweave's `IAM_BROWSER_ISSUER`
   character for character. Proser compares it with the `iss` of each ID token.
   The discovery URL is `IAM_BROWSER_API_BASE_URL` followed by
   `/oauth/.well-known/openid-configuration?client_id=<client ID>`.

   Explicit endpoints can be used instead of discovery. Set all three
   (`USERINFO` is optional):

   ```dotenv
   OATHWEAVE_OIDC_AUTHORIZATION_URL=https://identity.example.com/auth/authorize
   OATHWEAVE_OIDC_TOKEN_URL=https://identity.example.com/api/oathweave/oauth/token
   OATHWEAVE_OIDC_JWKS_URL=https://identity.example.com/api/oathweave/oauth/jwks
   OATHWEAVE_OIDC_USERINFO_URL=https://identity.example.com/api/oathweave/oauth/userinfo
   ```

The writer's browser must reach the authorization URL. The Author container
must reach the discovery, token and JWKS URLs.

### As a native confidential client

Oathweave 2.5 publishes native discovery at
`<JWT_ISSUER>/.well-known/openid-configuration` and
`/api/v1/oauth/.well-known/openid-configuration` only when `IAM_PUBLIC_URL`
(or an HTTPS `JWT_ISSUER`) is set on the Oathweave side. Otherwise discovery
answers `503 DISCOVERY_UNCONFIGURED`. Without discovery, use the explicit
endpoint settings.

Register a confidential client:

```json
{
  "name": "proser",
  "clientType": "confidential",
  "redirectUris": ["https://proser.example.com/api/auth/callback/oathweave"],
  "grantTypes": ["authorization_code"],
  "firstParty": true
}
```

Oathweave returns the generated secret once. Store it as
`OATHWEAVE_OIDC_CLIENT_SECRET` in the owner-only `.env.compose`. Proser sends it
with HTTP Basic authentication and also uses PKCE. Set `OATHWEAVE_OIDC_ISSUER` to
Oathweave's `JWT_ISSUER`.

Oathweave's native `/api/v1/oauth/authorize` endpoint has no sign-in page of
its own. It completes only when the browser already holds an Oathweave
sign-in session for that origin, and otherwise answers `LOGIN_REQUIRED`. Use
this profile only when your deployment puts a sign-in page in front of it, and
point `OATHWEAVE_OIDC_AUTHORIZATION_URL` at that page. The HiveXUI portal
accepts only public `hivexui-*` clients.

## Proser settings

| Variable                           | Required      | Description                                                                           |
| ---------------------------------- | ------------- | ------------------------------------------------------------------------------------- |
| `OATHWEAVE_OIDC_ISSUER`            | For OIDC      | Exact `iss` of Oathweave's ID tokens                                                  |
| `OATHWEAVE_OIDC_CLIENT_ID`         | For OIDC      | Client ID registered in Oathweave                                                     |
| `OATHWEAVE_OIDC_CLIENT_SECRET`     | Confidential  | Client secret; leave unset for a public client                                        |
| `OATHWEAVE_OIDC_SCOPES`            | No            | Defaults to `openid profile email`; must include `openid` and `profile`               |
| `OATHWEAVE_OIDC_DISCOVERY_URL`     | No            | Discovery document when it is not at `<issuer>/.well-known/openid-configuration`      |
| `OATHWEAVE_OIDC_AUTHORIZATION_URL` | No            | Explicit endpoints instead of discovery; set together with `TOKEN_URL` and `JWKS_URL` |
| `OATHWEAVE_OIDC_TOKEN_URL`         | With explicit | Token endpoint                                                                        |
| `OATHWEAVE_OIDC_JWKS_URL`          | With explicit | ID-token signing keys                                                                 |
| `OATHWEAVE_OIDC_USERINFO_URL`      | No            | UserInfo endpoint; Proser reads the ID token's claims                                 |
| `OATHWEAVE_PASSWORD_RELAY`         | No            | `false` turns the password relay off once OIDC is configured; ignored without OIDC    |

All URLs must use HTTPS. Plain HTTP is accepted only for `localhost` and
`127.0.0.1`. An incomplete or invalid set of OIDC settings is logged at
startup and leaves OIDC off. The other sign-in methods keep working.

## Check the sign-in

1. Recreate Author with the same Compose files. The sign-in page shows
   **Sign in with Oathweave** above the password form.
2. Sign in with an existing Oathweave writer. The Dashboard shows that writer's
   existing books. Factory logs `Linked account to its Oathweave subject on
first OIDC sign-in` once for that account.
3. Sign out and sign in again. No new link is logged.

A refused sign-in returns to the sign-in page with a message. Author logs the
reason, for example an ID-token signature or issuer mismatch.

## Stop relaying passwords

After every writer has signed in through OIDC at least once, or once you have
confirmed that OIDC works for new sign-ins:

```dotenv
OATHWEAVE_PASSWORD_RELAY=false
```

Recreate Author. The sign-in page then offers only **Sign in with Oathweave**,
and Proser no longer sends passwords to Oathweave. Keep `IAM_CORE_URL` set:
without it, Author offers the local credentials from `LOCAL_AUTH_*`, which
Compose enables by default. Sessions signed in through the relay before the
change stay valid until they expire or are revoked.

The setting is ignored, and the relay stays on, while OIDC is not configured
or its settings are invalid. Turning it off can therefore never leave Oathweave
writers without a way to sign in.

## Rollback

Remove the `OATHWEAVE_OIDC_*` settings and `OATHWEAVE_PASSWORD_RELAY`, then
recreate Author. Sign-in returns to the password relay, and every linked
account is reached through its unchanged `iam:<username>` handle. An earlier
Proser image works with the migrated database because it ignores the
`oathweave_subject` column.

## Security notes

- Proser checks the ID token's issuer, audience, expiry and nonce, and verifies
  its RS256 signature against Oathweave's published keys.
- The S256 PKCE verifier is kept in an encrypted, HttpOnly cookie for the
  duration of the sign-in. It binds the callback to the browser that started
  it.
- Proser sends a random `state` that the HiveXUI portal accepts, because the
  portal rejects the encoded state Auth.js would otherwise send. Protection
  against forged callbacks comes from PKCE and the nonce (RFC 9700 §2.1).
- Oathweave's ID, access and refresh tokens are not stored in the Proser
  session.
- Signing out of Proser ends the Proser session only. It does not sign the
  browser out of Oathweave.
