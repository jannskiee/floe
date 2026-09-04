// The three shapes every settings row is built from.

import type {ReactNode} from 'react';
import {cn, rowDescClass, rowLabelClass} from './ui';

/** Switch is the settings toggle: a small track/thumb pair driven by an
 *  sr-only checkbox so keyboard and screen-reader behavior come for free.
 *  32x18 with a 14px thumb (travel 32 - 14 - 2*2 = 14px = translate-x-3.5),
 *  desktop proportions rather than the chunkier mobile 36x20. Deliberately no
 *  group-hover coupling: the primitive stays context-free, and the row's own
 *  hover fill already signals interactivity. */
export function Switch({checked, onChange}: {checked: boolean; onChange: (v: boolean) => void}) {
    return (
        <span className="relative inline-flex shrink-0">
            <input
                type="checkbox"
                checked={checked}
                onChange={(e) => onChange(e.target.checked)}
                className="peer sr-only"
            />
            <span
                className={cn(
                    'relative h-[18px] w-8 rounded-full transition-colors peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ice/60',
                    checked ? 'bg-white' : 'bg-white/10 ring-1 ring-inset ring-white/15',
                )}
            >
                <span
                    className={cn(
                        'absolute left-0.5 top-0.5 size-3.5 rounded-full transition-transform duration-150 ease-out',
                        checked ? 'translate-x-3.5 bg-zinc-950' : 'bg-zinc-400',
                    )}
                />
            </span>
        </span>
    );
}

/** SettingRow is one settings entry: stacked label and one-line description with
 *  a trailing switch. The hover fill is the row's interactivity signal (the card
 *  clips it to the rounded corners); the whole row stays one click target. */
export function SettingRow({checked, onChange, label, description}: {
    checked: boolean;
    onChange: (v: boolean) => void;
    label: string;
    description?: string;
}) {
    return (
        <label className="flex cursor-pointer select-none items-center justify-between gap-4 px-3.5 py-2.5 transition-colors hover:bg-white/[0.04]">
            <span className="min-w-0">
                <span className={rowLabelClass}>{label}</span>
                {description && <span className={rowDescClass}>{description}</span>}
            </span>
            <Switch checked={checked} onChange={onChange}/>
        </label>
    );
}

/** SettingField is the text-input counterpart to SettingRow: the same label and
 *  description treatment, but the control sits underneath, because a settings row
 *  is too narrow to hold a description and a usable text field side by side.
 *
 *  This used to render its label as a <span>, which looks identical but is not a
 *  label, so both address inputs had no accessible name at all and announced as
 *  "edit text, blank".
 *
 *  children is a render prop rather than a plain node so the wiring cannot be got
 *  wrong. aria-describedby has to sit on the control itself; on a wrapping element
 *  it associates with nothing and silently does nothing. Handing the ids to the
 *  caller means a new field is spelled the same way as the existing ones or it
 *  does not compile.
 *
 *  description is optional under the 12-word copy rule; when absent the ids
 *  object OMITS the aria-describedby key entirely, never a dangling id. Padding
 *  comes from the caller, so the same field works inside a card row and inside
 *  the Advanced panel. */
export function SettingField({htmlFor, label, description, className, children}: {
    htmlFor: string;
    label: string;
    description?: string;
    className?: string;
    children: (ids: {id: string; 'aria-describedby'?: string}) => ReactNode;
}) {
    const descId = `${htmlFor}-description`;
    return (
        <div className={className}>
            <label htmlFor={htmlFor} className={rowLabelClass}>{label}</label>
            {description && <p id={descId} className={rowDescClass}>{description}</p>}
            <div className="mt-2">
                {children(description ? {id: htmlFor, 'aria-describedby': descId} : {id: htmlFor})}
            </div>
        </div>
    );
}
