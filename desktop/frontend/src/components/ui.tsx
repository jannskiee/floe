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

type ButtonVariant = 'primary' | 'outline' | 'ghost' | 'secondary';

const buttonVariants: Record<ButtonVariant, string> = {
    primary:   'bg-white text-black hover:bg-zinc-200 font-semibold',
    secondary: 'bg-zinc-800 text-white hover:bg-zinc-700 border border-zinc-700',
    outline:   'border border-zinc-700 bg-transparent text-zinc-300 hover:bg-zinc-800 hover:text-white',
    ghost:     'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800',
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
                'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
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
                'w-full rounded-md border border-white/15 bg-white/5 px-3 py-2 text-sm text-zinc-100',
                'outline-none transition-[color,box-shadow] placeholder:text-zinc-500',
                'focus-visible:border-white/30 focus-visible:ring-[3px] focus-visible:ring-ring/50',
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
                'w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-900/50 p-6 shadow-2xl ring-1 ring-white/5 backdrop-blur-xl',
                className,
            )}
        >
            {children}
        </div>
    );
}
