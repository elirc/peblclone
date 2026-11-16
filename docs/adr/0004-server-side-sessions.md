# ADR 0004 — Server-side sessions in an httpOnly cookie (not JWT)

**Status:** accepted

## Context
The web app is first-party and same-site with the API. Users include people who approve
payroll; "deactivate this account now" must take effect immediately.

## Decision
- On login the API creates a random 256-bit token, stores its SHA-256 in `sessions`, and
  sets the token in a cookie: `HttpOnly`, `SameSite=Lax`, `Secure` in production.
- Each request looks the session up and re-reads the user row (role, active flag).
- Logout and deactivation delete session rows.
- CSRF: `SameSite=Lax` plus an `Origin` allow-list check on all non-GET requests.

## Consequences
- Immediate revocation and immediate effect of role changes.
- The token is unreachable from JavaScript, so an XSS bug cannot exfiltrate it.
- A leaked database cannot be replayed as cookies (only hashes are stored).
- One indexed lookup (plus one user read) per request. Fine at this scale; cache later if
  it ever shows up in a profile.
- Not suitable as-is for third-party API clients; those would get API keys or OAuth, added
  alongside rather than instead.
