---
name: fix-device-flow-refresh
description: Use when a device-authorization (RFC 8628) client is failing on token
  refresh or polling — symptoms are repeated authorization_pending, a sudden
  invalid_grant after a refresh, or the token endpoint rejecting the device.
---

This is for repairing an OAuth device flow that polls or refreshes incorrectly.
Work through it against the client's polling loop and its refresh handler.

## Steps

1. Read the `interval` out of the device authorization response and poll no faster
   than it. If the field is absent, use five seconds.
2. Handle `authorization_pending` as the normal case, not an error. Keep polling.
3. On `slow_down`, add five seconds to the interval and keep it for every
   subsequent request in the run. Do not reset it on the next success.
4. Surface the remaining `expires_in` to the user and restart the flow when it
   elapses, rather than polling a dead `device_code`.
5. Store the rotated refresh token before the previous one is used again. Exchange
   it once and never retry the exchange with the old token.
6. Wrap the polling request in an `AbortController` and drive the timeout from its
   signal, not from a `Promise.race` with `setTimeout`.
7. Back off with exponential delay plus jitter on network failures, capped, so a
   transient outage does not become a self-inflicted flood on the token endpoint.

## Gotchas

- Reusing a rotated refresh token revokes the entire token family. This reads as a
  sudden `invalid_grant` on a request that looks fine in isolation.
- Ignoring `slow_down` can get the device temporarily blocked from the token
  endpoint, which looks like an outage rather than a client bug.
- Device-flow refresh tokens expire after 30 days of inactivity by default. There
  is no interactive session to renew them, so a device idle for a month is logged
  out with no user-visible cause.
- `Promise.race` with `setTimeout` leaves the underlying request running. The
  socket stays open and the retry stacks on top of it.

## Sources

- https://auth0.com/docs/get-started/authentication-and-authorization-flow/device-authorization-flow
  — tab first opened 2024-03-15
- https://datatracker.ietf.org/doc/html/rfc8628 — tab first opened 2024-03-01
- https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch
  — tab first opened 2025-02-19
- IETF errata on cumulative `slow_down` handling — found by search, no open tab
