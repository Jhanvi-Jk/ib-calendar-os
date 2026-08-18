import { TaskManager } from "./TaskManager";
import { getOpenTasks, getSubjects, getUserContext } from "@/lib/data/queries";

export default async function TasksPage() {
  const [ctx, tasks, subjects] = await Promise.all([
    getUserContext(),
    getOpenTasks(),
    getSubjects(),
  ]);
  if (!ctx) return null;

  return <TaskManager tasks={tasks} subjects={subjects} timezone={ctx.timezone} />;
}
