# Buzz audit for RIFT

Source reviewed: `C:\Users\FSOS\Desktop\buzz-main` (Block Buzz, Apache-2.0).

Buzz is a large self-hosted collaboration platform, not a serverless Discord clone. Its relay is the source of truth and depends on a Rust service, PostgreSQL, Redis, media storage, and server-side audio transport. RIFT therefore cannot copy Buzz networking wholesale while keeping the current P2P/no-paid-server goal.

## What is useful now

### Voice lifecycle

- Voice is entered only through explicit start/join actions.
- A monotonically increasing token invalidates stale async start/join work.
- Media cleanup reads current objects from stable refs, so React rerenders do not accidentally tear down a live call.
- Failed starts clean up every partially created resource.
- Leave is idempotent and also runs on provider unmount.
- Reconnect has one in-flight guard and bounded backoff; it eventually leaves instead of showing a fake connected state forever.
- A compact persistent voice bar exposes mic state, participants, device controls, and leave.
- Audio devices are refreshed on `devicechange`; input selection and mic gain are kept separately from the active track.
- Buzz asks for 48 kHz audio with browser echo cancellation and noise suppression.

RIFT has already adopted the explicit join, stable cleanup, stale-handler guards, compact call bar, and connection grace period. Next voice work should add bounded ICE restart, device selection, gain, and push-to-talk.

### Messages and navigation

- Typing events are ephemeral and throttled to once every three seconds per channel.
- Message actions are contextual: reply, edit, delete, reactions, copy text/link, mark unread, follow thread, reminder, and report.
- Drafts, pending messages, thread panels, day dividers, unread anchors, and older-message pagination are separate state units.
- Sidebar state separates starred, muted, unread, direct-message, forum, and custom channel sections.
- Notification preferences are validated when loaded from storage and scoped per identity.

For RIFT, the useful order is: delivery state and retry, typing indicator, edit/delete/reply/reactions, unread counters, drafts, then search and threads. Server moderation, workflows, forums, and multi-tenant communities are intentionally deferred.

### Desktop reliability

- Update checks have separate in-flight guards for check/download/install and close old update handles before replacing them.
- Background update checks avoid interrupting an update already in progress.
- UI settings sanitize persisted data instead of trusting arbitrary local-storage JSON.
- Buzz has Playwright screenshot helpers with a mock bridge, but those helpers are tied to Buzz fixtures and are not reusable as-is.

RIFT already uses a blocking Tauri updater. It should adopt the same in-flight/cleanup discipline and retain its real two-client Playwright voice test.

## What should not be copied

- Buzz huddles relay audio through Rust/WebSocket infrastructure. This violates RIFT's P2P target and still requires always-on servers.
- PostgreSQL/Redis search, presence, workflows, audit logs, S3 media, hosted communities, and agent orchestration require a backend.
- Buzz's `sprout-cli` skill operates Buzz relays and cannot build or test RIFT.
- Buzz's screenshot skill is specific to its `just` commands, mock channels, and GitHub PR workflow.
- Visual components depend heavily on Buzz's Tailwind/Radix component library. Copying components would pull in a large design system; RIFT should reproduce interaction patterns in its existing CSS instead.

## Adopted architecture rule

Keep three layers separate:

1. Durable/local product state: profile, rooms, drafts, preferences, message history.
2. Signaling/control: encrypted Nostr pairing and encrypted WebRTC data-channel control packets.
3. Live media: WebRTC tracks with explicit negotiation, cleanup, and recovery.

This separation preserves the no-account P2P model and makes a future optional community relay or TURN service replaceable without rewriting the interface.

## Practical roadmap taken from the audit

1. RNNoise audio processing with browser processing as fallback.
2. Audio input/output selection, gain, and push-to-talk.
3. ICE restart with bounded retry and truthful connection status.
4. Message delivery state/retry, typing, drafts, reactions, reply/edit/delete.
5. Unread counts, notifications, and search.
6. Optional relay/TURN configuration for users who need reliable cross-NAT calls.

