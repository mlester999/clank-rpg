import { SkeletonBlock } from "@/components/ui/bits";

export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-[1500px] space-y-4 px-3 py-6 sm:px-6" aria-busy="true" aria-label="Loading">
      <SkeletonBlock className="h-8 w-72" />
      <SkeletonBlock className="aspect-[5/3] w-full" />
    </div>
  );
}
