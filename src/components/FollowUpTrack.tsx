import type { TrackState, TrackStep } from "@/lib/patients/followupTrack";
import { formatDate } from "./ui/format";

export const TRACK_LABELS: Record<TrackState, string> = {
  sent: "Skickad",
  dry_run: "Testläge",
  pending: "Väntar på leveransbesked",
  failed: "Misslyckades",
  due: "Aktuell nu",
  passed: "Hoppas över",
  upcoming: "Kommande",
  inactive: "Inaktiv",
};

/** Row of marks, one per follow-up step, with the step's day underneath. */
export function FollowUpTrack({ track, compact = false }: { track: TrackStep[]; compact?: boolean }) {
  if (track.length === 0) return <span className="faint">—</span>;
  const summary = track
    .map((s) => `${s.day} d: ${TRACK_LABELS[s.state]}${s.at ? ` ${formatDate(s.at)}` : ""}`)
    .join(", ");
  return (
    <span className="track" role="img" aria-label={`Uppföljningar — ${summary}`} title={compact ? undefined : summary}>
      {track.map((s) => (
        <span key={s.id} className={`track-step ${s.state}`}>
          <span className="track-dot" />
          {!compact && <span className="track-day">{s.day}</span>}
        </span>
      ))}
    </span>
  );
}

/** Key for the marks, shown once under the table. */
export function FollowUpTrackLegend() {
  const shown: TrackState[] = ["sent", "dry_run", "due", "upcoming", "passed", "failed"];
  return (
    <span className="track-legend" aria-hidden="true">
      {shown.map((state) => (
        <span key={state} className={`track-step ${state}`}>
          <span className="track-dot" />
          {TRACK_LABELS[state]}
        </span>
      ))}
    </span>
  );
}
