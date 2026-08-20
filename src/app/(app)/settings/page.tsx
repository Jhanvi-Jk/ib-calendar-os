import { SettingsClient } from "./SettingsClient";
import { getSubjects } from "@/lib/data/queries";
import { getAcademicDates } from "@/lib/data/planning";

export default async function SettingsPage() {
  const [board, subjects] = await Promise.all([getAcademicDates(), getSubjects()]);

  // Anchor first, then upcoming, then finished — the order a student scans in.
  const dates = [
    ...(board.primary ? [board.primary] : []),
    ...board.upcoming,
    ...board.past,
  ];

  return <SettingsClient dates={dates} subjects={subjects} />;
}
