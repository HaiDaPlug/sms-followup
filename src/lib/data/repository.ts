import { unstable_cache } from "next/cache";
import { readStore } from "@/lib/storage/store";

export {
  addReminderLog,
  addReviewItem,
  bulkAddReviewItems,
  bulkUpsertBookings,
  bulkUpsertPatients,
  cancelScheduledSms,
  claimDueScheduledSms,
  completeScheduledSms,
  createId,
  createScheduledSms,
  getDailySnapshots,
  getActiveScheduledSmsPatientIds,
  getIncomingSms,
  getIncomingSmsForPatient,
  getSettings,
  insertDailySnapshot,
  insertIncomingSms,
  listScheduledSms,
  markIncomingSmsReplied,
  linkScheduledSmsReservation,
  nowIso,
  readStore,
  readStoreForImport,
  resetPatientCycle,
  touchBooking,
  touchPatient,
  updatePatient,
  updateReminderLog,
  updateReviewItem,
  updateSettings,
  upsertBooking,
  upsertPatient,
  writeStore,
  updateStore
} from "@/lib/storage/store";

/**
 * Read-only app pages can tolerate a few seconds of staleness. Sharing this
 * snapshot prevents every navbar transition from downloading the same five
 * complete tables again. Mutation and delivery paths continue to use the
 * uncached readStore export above so safety checks always see live data.
 */
export const readStoreForUi = unstable_cache(
  readStore,
  ["clinic-store-ui"],
  { revalidate: 3 }
);
