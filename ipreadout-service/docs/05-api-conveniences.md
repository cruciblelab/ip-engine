# API conveniences (customer-facing behavior, not infra)

Started 2026-08-25. Small, real product-behavior decisions that don't fit
the rate-limiting/architecture/monitoring docs — things a customer
actually experiences when calling the API.

## Auto-detect the caller's own IP

Calling the lookup endpoint with **no IP specified** returns information
about the caller's own address — the same convenience pattern
"what is my IP"-style APIs (ipinfo.io and similar) already use. Real
value: a customer doesn't need to independently figure out their own
public IP before calling us, which is otherwise a genuinely annoying
first step (NAT, proxies, etc. make "what's my own IP" non-trivial from
inside a script).

**Open:**
- Exact endpoint shape — is this the same `/lookup/ip/{ip}` route with
  the path param made optional, or a distinct route entirely?
- Interacts with rate limiting: does an unspecified-IP call cost the
  same as a normal lookup, or does detecting-then-looking-up count as
  one request either way? (Almost certainly the latter — flagging only
  because it wasn't stated explicitly.)

## IPv4 / IPv6 selector

For the self-detection case above specifically: a caller often has both
an IPv4 and an IPv6 address at once, so "your own IP" is ambiguous
without a way to pick. Proposed shape: a parameter, something like
`?family=v4` / `?family=v6` (or flag-style `-v4`/`-v6` — exact syntax not
picked). **Open:** parameter name and syntax; default behavior when
omitted (return both? prefer one? require the caller to specify?).
