# Interoperation with the other CONARO applications

CONARO Business AI is a separate application with its own repository, database migrations and deployment. It does not change how the marketplace (`818nexusinc/nexus-marketplace`) or the operating system (`818nexusinc/conaro-autonomous-business-os`, the BOS) are built or deployed. The three talk only over signed, read-only HTTP calls.

```
 marketplace (www.conaro.ca) ──GET /api/bai/v1/provider-feed──► Business AI   (Business AI reads; key: BAI_MARKETPLACE_LINK_SECRET)
 marketplace ──redirect /sso?t=<signed token>──────────────────► Business AI   (sign-in hand-over; same key)
 BOS ───────────GET /api/link/v1/summary────────────────────────► Business AI   (BOS reads counts only; key: BAI_BOS_LINK_SECRET)
 marketplace / BOS ──GET /api/link/v1/handshake?peer=…──────────► Business AI   (check the link)
```

**No application can change another's data through these calls.** Business AI keeps its own copy of what it reads, in its own tables.

## 1. Signing (the existing CONARO link protocol)

`src/interop/protocol.ts` is a byte-for-byte copy of the BOS's `src/link/protocol.ts` (the marketplace has a third copy in `src/lib/link-protocol.ts`). The headers, HMAC-SHA256 canonical string, 5-minute window and one-time codes are the same, and `tests/interop.test.ts` asserts the same test vector as the other two test suites. If the protocol changes, change all three copies and the vector together.

Each pair has its **own key**: a key the marketplace holds cannot read the BOS summary, and the BOS cannot hand over a sign-in. The app refuses to start if the two keys are equal.

## 2. Marketplace → Business AI: provider feed (to be added to the marketplace)

Business AI calls, for each workspace linked to a provider (`npm run link-provider -- --slug … --provider …`), once per cycle:

```
GET {MARKETPLACE_BASE_URL}/api/bai/v1/provider-feed?provider=<provider id>[&since=<cursor>]
x-conaro-link-timestamp / x-conaro-link-nonce / x-conaro-link-signature   (signed with BAI_MARKETPLACE_LINK_SECRET)
```

Response `200 application/json` (validated by `ProviderFeed` in `src/interop/marketplace.ts`):

```json
{
  "version": 1,
  "provider": { "ref": "<provider id>", "status": "pending | active | suspended" },
  "cursor": "<opaque, ≤200 chars; returned as ?since= next time>",
  "requests": [{
    "id": "<request id>", "createdAt": "ISO-8601", "category": "<marketplace category>", "community": "Moncton | null",
    "description": "<text>", "desiredDate": "YYYY-MM-DD | null",
    "customer": null,
    "expressMarketingConsent": false
  }],
  "bookings": [{
    "id": "<booking id>", "requestId": "<request id>", "status": "scheduled | completed | cancelled",
    "startsAt": "ISO-8601", "endsAt": "ISO-8601",
    "customer": { "name": "…", "email": "… | null", "phone": "… | null", "language": "en-CA | fr-CA" }
  }]
}
```

Rules the marketplace endpoint must follow:

- Only requests sent to **this** provider, and only this provider's bookings. Up to 500 of each per page, oldest first, after `since`.
- `customer` is `null` on requests that are not booked (the marketplace hides the customer until a booking exists); fill it on bookings, as the provider's dashboard does.
- `expressMarketingConsent` only when the customer explicitly agreed to marketing from providers; otherwise `false`.
- Answer `401` for a bad signature, `404` for an unknown provider, `503` when no Business AI key is saved.

What Business AI does with it (`applyProviderFeed`):

| Marketplace record | In Business AI |
|---|---|
| New request | An enquiry (channel `conaro-marketplace`); qualified, priced and answered by the agents. The price becomes a **task to enter the quote in the provider dashboard**: the marketplace owns quotes on its requests, so no quote is sent from Business AI. |
| Booking `scheduled` | A confirmed booking (`source = conaro-marketplace`): the workforce agent assigns staff and the operations agent creates the job with its checklist. |
| Booking `completed` | The job is completed. **No invoice** (paid through the marketplace), **no review request** and **no thank-you message** (the marketplace does both). |
| Booking `cancelled` | Booking and job cancelled. |

Each marketplace id is imported once (`bai_external_refs`). The connection shows **operational** on the business's Connections page only after a successful read; a failure shows the reason there and is retried next cycle.

**Who does what for marketplace work:**

| Job | Owner |
|---|---|
| Customer identity, messaging, quotes, payments, refunds, reviews, provider verification | Marketplace |
| Scheduling staff, jobs and checklists, bookkeeping, tax summaries, reports, recommendations | Business AI |
| Customers the business finds itself (phone, website, referrals) | Business AI (all its agents) |

## 3. Marketplace → Business AI: sign-in hand-over

The marketplace's "Open Business AI" button redirects a signed-in provider to:

```
{BAI_PUBLIC_URL}/sso?t=<token>
token = base64url(JSON {"v":1,"providerRef":"…","email":"…","exp":<unix seconds, ≤ now+120>,"nonce":"<random>"})
        "." base64url(HMAC-SHA256(BAI_MARKETPLACE_LINK_SECRET, "bai-sso\n" + <first part>))
```

`signSsoToken()` in `src/interop/sso.ts` is the reference implementation. The token works once and for 2 minutes, and only for a person who is **already a member** of the workspace linked to that provider. It cannot create accounts or grant access.

## 4. BOS → Business AI: summary

```
GET {BAI_PUBLIC_URL}/api/link/v1/summary      (signed with BAI_BOS_LINK_SECRET)
```

It returns counts only (type `BusinessAiSummary` in `src/interop/bos.ts`): workspaces by status, plan and industry; how many are paused or linked to the marketplace; workflow runs and actions in the last 24 hours; approvals and issues waiting; marketplace sync health. It returns no business name, no customer and no business's figures. To show it in the BOS, add a client next to `src/integrations/marketplace-link.ts` that calls this with `signLinkRequest(BAI_BOS_LINK_SECRET, "GET", "/api/link/v1/summary")`; that is a change for the BOS repository, made when the owner wants it.

## 5. Sharing a database (optional)

Business AI may use its own PostgreSQL database (recommended) or the BOS's. Every table, function and policy it creates is prefixed `bai_`, its migration ledger is `bai_schema_migrations`, and the only cluster-wide object is the role `bai_tenant`. `tests/interop.test.ts` migrates into a database that already holds another application's tables and ledger and checks that nothing else changes.

## 6. Setting up the links

1. Generate two different random keys (32+ characters).
2. Business AI host: `BAI_MARKETPLACE_LINK_SECRET`, `BAI_BOS_LINK_SECRET`, `MARKETPLACE_BASE_URL`, `BAI_PUBLIC_URL`.
3. Marketplace: save the first key for Business AI (separate from its BOS key) once the provider-feed endpoint and the "Open Business AI" button exist there.
4. BOS: save the second key once it has the summary client.
5. Check each link: `GET /api/link/v1/handshake?peer=marketplace` or `?peer=bos`, signed with that peer's key, answers `{"ok":true}`.
