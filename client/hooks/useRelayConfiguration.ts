import { useState } from 'react';

/**
 * Owns the sender's "Network Relay Fallback" toggle. Session-only state (defaults
 * on; not persisted). The pure relay policy — the ICE-server filter and the
 * proceed/block gate — lives in `@/lib/relay` so it can be unit-tested without React.
 */
export function useRelayConfiguration() {
    const [relayEnabled, setRelayEnabled] = useState(true);
    return { relayEnabled, setRelayEnabled };
}
