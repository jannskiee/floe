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

/** Eyebrow is the site's mono all-caps label ("SEND", "SHARE LINK", ...). */
export function Eyebrow({
    children,
    tone,
    className,
}: {
    children: ReactNode;
    tone?: 'ice' | 'muted';
    className?: string;
}) {
    return (
        <p
            className={cn(
                'font-mono text-[10px] font-medium uppercase tracking-[0.2em]',
                tone === 'ice' ? 'text-ice' : 'text-zinc-500',
                className,
            )}
        >
            {children}
        </p>
    );
}

/** StatusDot renders the site's halo dot (soft blur glow + solid core). Pass a
 *  Tailwind background class (e.g. "bg-green-500", "bg-ice") to color it. */
export function StatusDot({className}: {className?: string}) {
    return (
        <span className="relative flex h-2.5 w-2.5 items-center justify-center" aria-hidden>
            <span className={cn('absolute inset-0 rounded-full opacity-40 blur-[2px]', className)}/>
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

export function Button({
    variant = 'primary',
    className,
    children,
    ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {variant?: ButtonVariant}) {
    return (
        <button
            {...props}
            className={cn(
                'inline-flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
                'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ice/40',
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
