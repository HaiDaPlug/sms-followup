import { unstable_cache } from "next/cache";
import { readStore } from "@/lib/storage/store";

/**
 * Read-only app pages can tolerate a few seconds of staleness. Sharing this
 * snapshot prevents every navbar transition from downloading the same five
 * complete tables again. Mutation and delivery paths use the uncached
 * readStore so safety checks always see live data.
 *
 * This lives outside repository.ts on purpose: repository.ts is a re-export
 * barrel, and defining a value export alongside those re-exports made Next's
 * build-time module analysis drop it for importers that resolve through the
 * barrel (eligibility.ts hit "has no exported member 'readStoreForUi'" during
 * `next build`, though `tsc --noEmit` accepted it). Library code should import
 * from here directly; repository.ts re-exports it for page-level callers.
 */
export const readStoreForUi = unstable_cache(
  readStore,
  ["clinic-store-ui"],
  { revalidate: 3 }
);
