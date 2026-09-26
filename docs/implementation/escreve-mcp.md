# escreve.ai MCP — implementation checkpoint

Status: **incomplete; not approved for production rollout**. This branch implements the knowledge and user-bound connection foundation. It does not yet meet the approved full-product coverage criterion.

## Implemented in this branch

- Organizational knowledge pages in `/app/knowledge`: BlockNote, Markdown plus structured Markdown AST in Postgres, hierarchy, individual favorites, revision history, autosave, trash and restore.
- Shared `/api/v1/knowledge` services for reads, writes, imports and search. Revision preconditions and operation IDs prevent stale writes and duplicate page mutations.
- Private PDF originals and public HTTPS capture with DNS/IP checks, pinned resolution, redirect validation and body limits. PDF extraction runs in an isolated process.
- Persistent existing indexing events, existing embedding metering, revision-checked activation and immediate exclusion of archived or stale semantic sources. Agents still need explicit source selection.
- OAuth discovery, dynamic client registration, authorization landing, session consent, PKCE, atomic code consumption, refresh rotation and revocation, plus personal token fallback.
- User/org/client-bound connections; live membership and organization status checks; granted role capped by current role; no support-mode issuance.
- MCP knowledge list/read/search/save/archive tools. New connections expose knowledge, visibility-filtered WhatsApp conversation/history reads, CRM contacts/leads/pipelines reads, and separately authorized WhatsApp sending. Legacy contracts remain usable; the new page tools are not implicitly granted to legacy agents.
- Destructive knowledge archiving requires session approval of exact hashed arguments. A bearer cannot approve. Execution is claimed once; changed parameters need a fresh approval. Interrupted/failed execution is surfaced, not blindly retried.
- WhatsApp sending reserves a persistent service-only receipt before dispatch. Concurrent calls execute once; changed arguments conflict, and interrupted/failed effects remain uncertain without automatic retries. Existing provider pre-go-live, opt-out and pacing services remain in the sending path.
- Initial route-export inventory in `escreve-mcp-coverage.json`. Rows marked `pending_review` are not a claim that no legacy MCP tool exists: mappings still need manual review.

## Evidence obtained locally

- Baseline clean install and strict reapplication on disposable Postgres; 97 database assertions (including the complete RLS inventory) passed after merging current main for isolation, stale writes, archive retrieval exclusion, OAuth PKCE, code/refresh replay, membership removal and revocation.
- The previous checkpoint passed 267 selected assertions; the latest operations change passed 42 targeted unit/structural assertions, including receipt concurrency, changed-argument conflicts, storage failure and resource visibility.
- Production build and TypeScript check passed. Targeted ESLint: no errors, four React-hook warnings remain.
- Four persisted Playwright journeys passed in an isolated local Supabase stack: editor save/reload/network-failure recovery/trash/restore; PDF upload and private-URL rejection; MCP archive approval, denial of bearer self-approval, exact-argument binding, single execution and revocation; live conversation/lead visibility changes, read-only denial of sending, explicit send scope, blocked-contact refusal and uncertain-receipt replay.
- Additional local HTTP smoke verified read-only tools/list, lexical source retrieval and the complete OAuth code/refresh exchange. This is **not** evidence of ChatGPT or Claude interoperability.

## Required before the approved plan can be declared complete

1. Review every inventory action against UI, service, role, scope, enabled module and a behavioral test. Add missing domain handlers without arbitrary HTTP, SQL or shell tools.
2. Enable granular WhatsApp/CRM and remaining domains only after conversation/lead visibility, idempotency and external-effect policies are enforced. Only the explicit allowlist is enabled. CRM mutations, new-conversation sending and the remaining domain tools still need these adapters.
3. Extend human approvals to remaining destructive operations and privilege/credential grants. Add an explicit legacy-token migration UI.
4. Add import idempotency, capture timestamp, full rich-block fidelity, search pagination beyond Supabase's 1,000-row default, and richer indexing/retry status. Review OAuth refresh-family replay revocation and client metadata/consent hardening.
5. Verify semantic retrieval with actual embeddings and the live persistent worker. No embedding-backed retrieval proof yet; local QA used lexical fallback.
6. Complete viewer/agent/manager/admin and restricted-conversation browser journeys, simultaneous save conflict journeys, SSRF redirect/DNS-rebinding tests and broader route integration tests.
7. Complete OAuth/MCP interoperability in ChatGPT and Claude.
8. Verify WhatsApp in Saraiva (the user authorized that organization, including real data). No real WhatsApp message has been sent by this branch. Select an identifiable internal destination and retain actual delivery evidence.
9. Run all required CI/build/performance checks, regenerate schema types, review security, publish through the existing backup/rollback pipeline. Current main was merged into this work branch; migrations were assigned 0411/0412/0413. No merge into main, production migration or deploy has occurred.

The explicit connection-tool allowlist in `lib/mcp/permissions.ts` must grow only alongside authorization and visibility tests. No real outbound WhatsApp delivery is claimed by the blocked-contact test.
