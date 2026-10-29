import {
  platformMarks,
  platformNames,
  type PlatformId,
} from '../../../../../../packages/contracts/src/platform';
export function PlatformMark({ platform }: { platform: string }) {
  return (
    <span
      className={`shop-platform shop-platform-${platform}`}
      aria-label={platformNames[platform as PlatformId]}
    >
      {platformMarks[platform as PlatformId] ?? platform.slice(0, 1)}
    </span>
  );
}
