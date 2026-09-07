// The product strings /how-it-works quotes, each beside the file that prints
// it. The page describes what the app shows, so a rename in any of these
// sources must reach the page in the same change; the test next door pins the
// values, and the claim map (.claude/skills/docs-verify/references/claim-map.md)
// lists this module as a mirror of each source.
import { RELAY_SIZE_LIMIT } from './relay';
import { formatBytes } from './utils';

/** "2 GB", derived from the gate's own constant so the figure cannot drift
 *  from client/lib/relay.ts (RelaySizeLimit in cli/engine/transfer/relay.go
 *  is the same number; the docs and the CLI error both say "2 GB"). */
export const RELAY_CAP = formatBytes(RELAY_SIZE_LIMIT);

/** The connection badge's route words: client/components/ConnectionStatusBadge.tsx
 *  and desktop/frontend/src/App.tsx render exactly these, green and amber. */
export const BADGE_DIRECT = 'Direct';
export const BADGE_RELAY = 'Relay';
