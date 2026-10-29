export function BrandMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <path
        fill="currentColor"
        d="M6.5 7h19A3.5 3.5 0 0 1 29 10.5v8A3.5 3.5 0 0 1 25.5 22H16l-5.2 4.4V22H6.5A3.5 3.5 0 0 1 3 18.5v-8A3.5 3.5 0 0 1 6.5 7z"
      />
    </svg>
  );
}
