'use client';

import React from 'react';
import NumberFlow, { continuous } from '@number-flow/react';
import * as Sentry from '@sentry/nextjs';
import { BYTE_COUNT_FORMAT, formatSplitBytes } from '@/lib/utils';

/**
 * The global byte counter, and a guarantee that it cannot take the page with it.
 *
 * @number-flow/react renders a <number-flow-react> custom element and, on every
 * value change, calls `this.el?.willUpdate()` from getSnapshotBeforeUpdate. That
 * optional chain is a NULL check only. If the element was created but never
 * UPGRADED, the node is a plain HTMLElement, the method does not exist, and the
 * call throws in React's commit phase.
 *
 * Registration is a silent module side effect in number-flow/dist/lite.mjs:
 *
 *   BROWSER && typeof HTMLElement < "u" && typeof customElements < "u"
 *     && !customElements.get(n) && customElements.define(n, t)
 *
 * Four guards, every one of them a no-op that reports nothing. And because the
 * library's own componentDidMount only writes plain properties, which land as
 * inert expandos on an un-upgraded element, nothing fails until the first value
 * CHANGES. GlobalStats renders 0 until /api/stats resolves, so in an affected
 * environment that change is guaranteed on every single page load.
 *
 * '/' has no error.tsx, so before this component the throw reached
 * app/global-error.tsx and the whole homepage became the default Next.js error
 * page, with a "Try again" button that remounts straight back into the same
 * crash. FLOE-G is one of those, reported through global-error's own
 * captureException.
 *
 * Two independent mechanisms, because neither covers the other:
 *
 *   - componentDidMount checks whether the element is going to upgrade at all.
 *     That is the common case and it avoids the throw entirely.
 *   - getDerivedStateFromError catches what the check cannot see, such as the
 *     tag being registered to some other class, or a host node that never
 *     upgrades despite a valid registration.
 *
 * Deliberately NOT Sentry.ErrorBoundary: it implements only componentDidCatch,
 * so React renders null for one commit (a visible blank) before the fallback
 * appears, and it lands in legacyErrorBoundariesThatAlreadyFailed, after which a
 * second error at the same boundary escalates to global-error anyway.
 *
 * Deliberately no reset()/retry either. Re-arming the boundary re-arms the crash.
 */

// The tag @number-flow/react registers. Hardcoded because the package exports no
// name constant; e2e/animated-byte-count.spec.ts pins it so a rename in a future
// release fails CI instead of silently degrading every visitor to a static number.
const NUMBER_FLOW_TAG = 'number-flow-react';

// One report per page load. The fallback is a recovery, not a crash, so it must
// not be able to flood the project if it ever turns out to be common.
let reported = false;

type Props = { value: number; unit: string; className?: string };
type State = { staticOnly: boolean };

export class AnimatedByteCount extends React.Component<Props, State> {
    state: State = { staticOnly: false };

    static getDerivedStateFromError(): State {
        return { staticOnly: true };
    }

    componentDidCatch(error: Error, info: React.ErrorInfo) {
        if (reported) return;
        reported = true;
        // Warning, not error: the page is fine and the number is still correct,
        // only the animation is gone. Same treatment the stale-bundle reloads
        // get in sentry.client.config.ts. A fixed fingerprint keeps every
        // occurrence in one issue instead of one per wording.
        //
        // Reported explicitly because nothing else would: @sentry/nextjs wires
        // no onCaughtError, and Next's own production handler for a boundary
        // that is not GlobalError is a bare console.error, which Sentry records
        // as a breadcrumb and never as an event.
        Sentry.captureException(error, {
            level: 'warning',
            fingerprint: ['number-flow-unavailable'],
            tags: { auto_recovered: true },
            contexts: { react: { componentStack: info.componentStack } },
        });
    }

    componentDidMount() {
        // The exact negation of the library's own registration guard, so it
        // covers all four of its silent bail-outs at once: esm-env's BROWSER
        // resolving false, a missing HTMLElement, a missing or stubbed
        // customElements, and the tag already belonging to something else.
        //
        // In componentDidMount rather than in render(): the first client render
        // has to emit what the server emitted or hydration mismatches. This runs
        // after that, and being a layout effect it also runs before GlobalStats'
        // passive effect issues the fetch, so it can never race the value change
        // it exists to get ahead of.
        if (!globalThis.customElements?.get(NUMBER_FLOW_TAG)) {
            this.setState({ staticOnly: true });
        }
    }

    render() {
        const { value, unit, className } = this.props;

        if (this.state.staticOnly) {
            const text = formatSplitBytes({ value, unit });
            // role and aria-label mirror what NumberFlowElement publishes about
            // itself through ElementInternals, so both branches read the same to
            // assistive technology.
            return (
                <span role="img" aria-label={text} className={className}>
                    {text}
                </span>
            );
        }

        return (
            <NumberFlow
                value={value}
                format={BYTE_COUNT_FORMAT}
                suffix={' ' + unit}
                plugins={[continuous]}
                spinTiming={{ duration: 900, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' }}
                transformTiming={{ duration: 750, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' }}
                opacityTiming={{ duration: 350, easing: 'ease-out' }}
                className={className}
            />
        );
    }
}
