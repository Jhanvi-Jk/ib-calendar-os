import { SettingsClient } from "./SettingsClient";
import { TimetableEditor } from "@/components/settings/TimetableEditor";
import { ReminderSettings } from "@/components/settings/ReminderSettings";
import { getSubjects, getTimetableEntries, getUserContext } from "@/lib/data/queries";
import { getAcademicDates } from "@/lib/data/planning";
import { getStudyQuotas } from "@/lib/data/quotas";

export default async function SettingsPage() {
  const [board, subjects, entries, ctx, quotas] = await Promise.all([
    getAcademicDates(),
    getSubjects(),
    getTimetableEntries(),
    getUserContext(),
    getStudyQuotas(),
  ]);

  // Anchor first, then upcoming, then finished — the order a student scans in.
  const dates = [
    ...(board.primary ? [board.primary] : []),
    ...board.upcoming,
    ...board.past,
  ];

  return (
    <div className="space-y-5">
      {/*
        Timetable leads. It is the thing that has to be right before anything
        else works: without lessons the solver believes every weekday is empty.
      */}
      <TimetableEditor
        entries={entries}
        subjects={subjects}
        anchorMonday={ctx?.timetableAnchorMonday ?? null}
      />

      <ReminderSettings />

      <SettingsClient dates={dates} subjects={subjects} quotas={quotas} />
    </div>
  );
}
