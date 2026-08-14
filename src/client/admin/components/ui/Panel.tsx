import type { FC, ReactNode } from 'react';
import type { IconProps } from 'react-feather';

interface PanelProps {
  title?: string;
  icon?: FC<IconProps>;
  className?: string;
  children: ReactNode;
}

// Shared white rounded-shadow container (ai-therapist-120): the
// 'bg-white p-6 rounded-lg shadow' tile was re-implemented across the admin
// views. Optional title row with a react-feather icon.
export default function Panel({ title, icon: Icon, className, children }: PanelProps) {
  return (
    <div className={`bg-white p-6 rounded-lg shadow${className ? ` ${className}` : ''}`}>
      {title && (
        <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
          {Icon && <Icon size={20} />}
          {title}
        </h3>
      )}
      {children}
    </div>
  );
}
