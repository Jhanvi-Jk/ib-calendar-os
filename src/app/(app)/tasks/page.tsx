import { TaskManager } from "./TaskManager";
import { getOpenTasks, getSubjects, getUserContext } from "@/lib/data/queries";
import { getRunningTimer } from "@/lib/data/analytics";
import { isAiConfigured } from "@/lib/ai/client";
import { toEpochMinute } from "@/lib/time";

export default async function TasksPage() {
  const [ctx, tasks, subjects, timer] = await Promise.all([
    getUserContext(),
    getOpenTasks(),
    getSubjects(),
    getRunningTimer(),
  ]);
  if (!ctx) return null;

  return (
    <TaskManager
      tasks={tasks}
      subjects={subjects}
      timezone={ctx.timezone}
      runningTaskId={timer?.taskId ?? null}
      nowMin={toEpochMinute(new Date())}
      aiEnabled={isAiConfigured()}
    />
  );
}
