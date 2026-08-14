import type { FC } from 'react';
import type { IconProps } from 'react-feather';

interface StatCardProps {
  label: string;
  value: string | number;
  sub?: string;
  icon?: FC<IconProps>;
}

// Shared KPI tile (ai-therapist-120): label + big value + optional sub line,
// with an optional react-feather icon badge. Replaces the per-view MetricCard
// and OpsStatCard clones.
export default function StatCard({ label, value, sub, icon: Icon }: StatCardProps) {
  return (
    <div className="bg-white p-6 rounded-lg shadow">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-gray-600">{label}</p>
          <p className="text-3xl font-bold text-navy mt-2">{value}</p>
          {sub && <p className="text-xs text-gray-500 mt-1">{sub}</p>}
        </div>
        {Icon && (
          <div className="bg-lightBlue p-3 rounded-full">
            <Icon size={24} className="text-navy" />
          </div>
        )}
      </div>
    </div>
  );
}
