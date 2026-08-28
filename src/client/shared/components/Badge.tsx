import type { ReactNode } from 'react';

// Shared pill badge primitive: the `px-2 py-0.5 inline-flex items-center
// gap-1 text-xs rounded-full` skeleton that EscalationInbox, NotesPanel and
// the severity chips all hand-rolled. Pass a named `tone`, or `toneClass`
// with raw color classes (e.g. from shared/severity's severityBadgeClass).

export type BadgeTone = 'red' | 'amber' | 'green' | 'blue' | 'yellow' | 'gray' | 'indigo';

const TONE_CLASSES: Record<BadgeTone, string> = {
  red: 'bg-red-100 text-red-800',
  amber: 'bg-amber-100 text-amber-800',
  green: 'bg-green-100 text-green-800',
  blue: 'bg-blue-100 text-blue-800',
  yellow: 'bg-yellow-100 text-yellow-800',
  gray: 'bg-gray-100 text-gray-600',
  indigo: 'bg-indigo-100 text-indigo-800',
};

interface BadgeProps {
  tone?: BadgeTone;
  /** Raw color classes; overrides `tone` (for severity-derived chips). */
  toneClass?: string;
  /** Status pills are semibold; inline info chips use normal weight. */
  weight?: 'semibold' | 'normal';
  className?: string;
  title?: string;
  children: ReactNode;
}

export default function Badge({ tone = 'gray', toneClass, weight = 'semibold', className, title, children }: BadgeProps) {
  return (
    <span
      title={title}
      className={`px-2 py-0.5 inline-flex items-center gap-1 text-xs rounded-full${
        weight === 'semibold' ? ' font-semibold' : ''
      } ${toneClass ?? TONE_CLASSES[tone]}${className ? ` ${className}` : ''}`}
    >
      {children}
    </span>
  );
}
