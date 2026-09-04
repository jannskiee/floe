import type {ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SVGProps} from 'react';

/** cn joins truthy class strings. A one-liner replaces clsx/tailwind-merge for this small app. */
export const cn = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

/** BoltMark is the real Floe lightning-bolt logo mark as an inline SVG. */
export function BoltMark({className, ...props}: SVGProps<SVGSVGElement>) {
    return (
        <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden {...props}>
            <path d="M13 2L3 14H12L11 22L21 10H12L13 2Z"/>
        </svg>
    );
}

/** Eyebrow is the site's mono all-caps label ("SEND", "SHARE LINK", ...).
 *
 *  `as` is opt-in and defaults to <p> on purpose. Most Eyebrows label a control or
 *  a panel region, not a document section: the ice "Peer to peer" hero label,
 *  "Code or link", "Save to", "Files", "Room code", "Share link". Promoting all of
 *  them to headings would litter the accessibility tree with a dozen same-level
 *  headings that mean nothing to someone navigating by heading. Only the Settings
 *  section labels are genuine headings, so only they pass as="h3". */
export function Eyebrow({
    children,
    tone,
    className,
    as: Tag = 'p',
}: {
    children: ReactNode;
    tone?: 'ice' | 'muted';
    className?: string;
    as?: 'p' | 'h3';
}) {
    return (
        <Tag
            className={cn(
                'font-mono text-[10px] font-medium uppercase tracking-[0.2em]',
                tone === 'ice' ? 'text-ice' : 'text-zinc-500',
                className,
            )}
        >
            {children}
        </Tag>
    );
}

/** StatusDot renders the site's halo dot (soft blur glow + solid core). Pass a
 *  Tailwind background class (e.g. "bg-green-500", "bg-ice") to color it.
 *  `pulse` animates the halo only — pulsing the solid core reads as flicker. */
export function StatusDot({className, pulse}: {className?: string; pulse?: boolean}) {
    return (
        <span className="relative flex h-2.5 w-2.5 items-center justify-center" aria-hidden>
            <span className={cn('absolute inset-0 rounded-full opacity-40 blur-[2px]', pulse && 'animate-pulse', className)}/>
            <span className={cn('h-1.5 w-1.5 rounded-full', className)}/>
        </span>
    );
}

type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost';

const buttonVariants: Record<ButtonVariant, string> = {
    primary:   'bg-white text-black hover:bg-zinc-200 font-semibold',
    secondary: 'bg-white/[0.04] text-zinc-300 hover:bg-white/10 hover:text-white border border-white/10',
    outline:   'border border-white/15 bg-transparent text-zinc-300 hover:bg-white/[0.06] hover:text-white',
    ghost:     'text-zinc-400 hover:bg-white/10 hover:text-zinc-100',
};

type ButtonSize = 'md' | 'lg';

/** Size owns the padding and the corner, because cn is a plain join with no
 *  tailwind-merge: a px-* or rounded-* passed through className cannot beat the
 *  same property coming from the base string, so the only way to have two
 *  sizes is to keep them out of the base. `md` is what every button in the app
 *  rendered before this prop existed, character for character, so adding it
 *  changed nothing on screen. `lg` is for the send card's committing row, where
 *  the file rows' own radius and a little more room make the pair read as one
 *  deliberate row rather than two leftovers. 38px tall reads as a committing
 *  control without the slab quality 40px gave it beside a 40px file row.
 *
 *  That height is set outright rather than left to padding, and the reason is
 *  worth keeping. Padding alone made the number depend on the variant:
 *  `secondary` and `outline` carry a 1px border, which sits outside a padding
 *  box and made them 40px, and flex's default align-items:stretch then dragged
 *  the borderless `primary` up to match. The row was 40px with Clear beside
 *  Send and 38px with Send alone. An explicit height is absorbed by border-box,
 *  so every variant is the same 38px in every state. */
const buttonSizes: Record<ButtonSize, string> = {
    md: 'rounded-md px-3 py-2',
    lg: 'h-[38px] rounded-lg px-4',
};

export function Button({
    variant = 'primary',
    size = 'md',
    className,
    children,
    ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {variant?: ButtonVariant; size?: ButtonSize}) {
    return (
        <button
            {...props}
            className={cn(
                'inline-flex items-center justify-center gap-2 text-sm transition-colors',
                buttonSizes[size],
                // ice/60, not /40: measured from rendered pixels, /40 paints
                // #516269 for 2.96:1 against the card and fails 1.4.11's 3:1,
                // while /60 measures 5.23:1. Every hand-rolled focusable in the
                // app already uses /60; this shared component was the outlier.
                'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ice/60',
                'disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
                buttonVariants[variant],
                className,
            )}
        >
            {children}
        </button>
    );
}

export function Input({className, ...props}: InputHTMLAttributes<HTMLInputElement>) {
    return (
        <input
            {...props}
            className={cn(
                'w-full rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-zinc-100',
                'outline-none transition-[color,box-shadow] placeholder:text-zinc-500',
                'focus-visible:border-ice/50 focus-visible:ring-[3px] focus-visible:ring-ice/25',
                'disabled:opacity-50',
                className,
            )}
        />
    );
}

export function Card({className, children}: {className?: string; children: ReactNode}) {
    return (
        <div
            className={cn(
                'w-full rounded-xl border border-white/10 bg-zinc-900/60 shadow-2xl ring-1 ring-white/5 backdrop-blur-xl',
                className,
            )}
        >
            {children}
        </div>
    );
}


// One geometry, three call sites: SettingRow, SettingField, and the Advanced
// disclosure button. Kept as consts so the three cannot drift apart.
//
// 13px labels match the TitleBar wordmark; 12/16 descriptions are one line under
// the 12-word copy rule. About rows flip the emphasis: dim key, legible mono
// value, with the label at zinc-400 rather than zinc-500 so it keeps AA contrast.
export const rowLabelClass = 'block text-[13px] font-medium leading-5 text-zinc-200';
export const rowDescClass = 'mt-0.5 block text-xs leading-4 text-zinc-500';
