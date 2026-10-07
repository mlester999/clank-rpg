import Link from "next/link";

import { EmptyState } from "@/components/ui/bits";

export default function NotFound() {
  return (
    <div className="px-3 py-16">
      <EmptyState title="That corridor leads nowhere" body="The page you were looking for doesn't exist. The arena is still running, though." action={<Link href="/" className="btn btn-sm">Back to the Arena</Link>} />
    </div>
  );
}
