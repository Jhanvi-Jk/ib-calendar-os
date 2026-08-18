"use client";

import { useState } from "react";
import { completeOnboarding } from "./actions";
import { Button, Card, Hint, Input, Label, Select } from "@/components/ui";
import type { Chronotype } from "@/lib/domain/energy";

const IB_GROUPS = [
  "Studies in Language and Literature",
  "Language Acquisition",
  "Individuals and Societies",
  "Sciences",
  "Mathematics",
  "The Arts",
];

type SubjectDraft = { name: string; level: "HL" | "SL" | "CORE"; ibGroup: number | null };

const DEFAULT_SUBJECTS: SubjectDraft[] = [
  { name: "", level: "HL", ibGroup: 1 },
  { name: "", level: "HL", ibGroup: 3 },
  { name: "", level: "HL", ibGroup: 4 },
  { name: "", level: "SL", ibGroup: 2 },
  { name: "", level: "SL", ibGroup: 5 },
  { name: "", level: "SL", ibGroup: 6 },
  // The core generates as much work as any single subject and is the thing
  // students most often forget to plan for.
  { name: "Extended Essay", level: "CORE", ibGroup: null },
  { name: "TOK", level: "CORE", ibGroup: null },
  { name: "CAS", level: "CORE", ibGroup: null },
];

export default function OnboardingPage() {
  const [step, setStep] = useState(0);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const [displayName, setDisplayName] = useState("");
  const [timezone, setTimezone] = useState(
    Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  );
  const [chronotype, setChronotype] = useState<Chronotype>("neutral");
  const [sleepStart, setSleepStart] = useState("23:00");
  const [sleepEnd, setSleepEnd] = useState("07:00");
  const [dayStart, setDayStart] = useState("07:30");
  const [dayEnd, setDayEnd] = useState("22:30");
  const [maxDailyFocusMin, setMaxDailyFocusMin] = useState(300);
  const [subjects, setSubjects] = useState<SubjectDraft[]>(DEFAULT_SUBJECTS);

  function updateSubject(i: number, patch: Partial<SubjectDraft>) {
    setSubjects((prev) => prev.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  }

  async function submit() {
    setSaving(true);
    setError("");
    const named = subjects.filter((s) => s.name.trim().length > 0);
    if (named.length === 0) {
      setError("Add at least one subject.");
      setSaving(false);
      return;
    }
    const result = await completeOnboarding({
      displayName,
      timezone,
      chronotype,
      sleepStart,
      sleepEnd,
      dayStart,
      dayEnd,
      maxDailyFocusMin,
      subjects: named,
    });
    // A successful action redirects, so reaching here means it failed.
    if (result && !result.ok) {
      setError(result.error);
      setSaving(false);
    }
  }

  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <p className="text-sm text-subtle">Step {step + 1} of 3</p>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">
        {step === 0 && "Where and when do you work?"}
        {step === 1 && "When is your brain actually good?"}
        {step === 2 && "What are you taking?"}
      </h1>

      {step === 0 && (
        <Card className="mt-6 space-y-4">
          <div>
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Optional"
            />
          </div>
          <div>
            <Label htmlFor="tz">Timezone</Label>
            <Input id="tz" value={timezone} onChange={(e) => setTimezone(e.target.value)} />
            <Hint className="mt-1">Detected automatically. Change it if you&apos;re travelling.</Hint>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="ds">Day starts</Label>
              <Input id="ds" type="time" value={dayStart} onChange={(e) => setDayStart(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="de">Day ends</Label>
              <Input id="de" type="time" value={dayEnd} onChange={(e) => setDayEnd(e.target.value)} />
            </div>
          </div>
        </Card>
      )}

      {step === 1 && (
        <Card className="mt-6 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="ss">Sleep starts</Label>
              <Input id="ss" type="time" value={sleepStart} onChange={(e) => setSleepStart(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="se">Wake up</Label>
              <Input id="se" type="time" value={sleepEnd} onChange={(e) => setSleepEnd(e.target.value)} />
            </div>
          </div>
          <Hint>
            Sleep is treated as immutable. Nothing gets scheduled here — not the
            night before an exam, not during IA week.
          </Hint>

          <div>
            <Label htmlFor="chrono">When do you think best?</Label>
            <Select
              id="chrono"
              value={chronotype}
              onChange={(e) => setChronotype(e.target.value as Chronotype)}
            >
              <option value="lark">Mornings — I fade after dinner</option>
              <option value="neutral">Mid-morning and late afternoon</option>
              <option value="owl">Evenings — I get going after 8pm</option>
            </Select>
            <Hint className="mt-1">
              A starting guess. The app measures what you actually get done and
              corrects itself.
            </Hint>
          </div>

          <div>
            <Label htmlFor="focus">Realistic focused hours per day</Label>
            <Select
              id="focus"
              value={maxDailyFocusMin}
              onChange={(e) => setMaxDailyFocusMin(Number(e.target.value))}
            >
              <option value={120}>2 hours</option>
              <option value={180}>3 hours</option>
              <option value={240}>4 hours</option>
              <option value={300}>5 hours</option>
              <option value={360}>6 hours</option>
            </Select>
            <Hint className="mt-1">
              Be honest rather than aspirational — an over-stuffed plan is what
              makes planners get abandoned.
            </Hint>
          </div>
        </Card>
      )}

      {step === 2 && (
        <Card className="mt-6">
          <Hint className="mb-4">
            Leave blank any you aren&apos;t taking. The core is pre-filled because
            it generates real work.
          </Hint>
          <div className="space-y-2">
            {subjects.map((s, i) => (
              <div key={i} className="grid grid-cols-[1fr_7rem] gap-2">
                <Input
                  value={s.name}
                  placeholder={
                    s.level === "CORE" ? s.name : `Group ${s.ibGroup} — ${IB_GROUPS[(s.ibGroup ?? 1) - 1]}`
                  }
                  onChange={(e) => updateSubject(i, { name: e.target.value })}
                />
                <Select
                  value={s.level}
                  onChange={(e) =>
                    updateSubject(i, { level: e.target.value as SubjectDraft["level"] })
                  }
                  disabled={s.level === "CORE"}
                >
                  <option value="HL">HL</option>
                  <option value="SL">SL</option>
                  <option value="CORE">Core</option>
                </Select>
              </div>
            ))}
          </div>
        </Card>
      )}

      {error && <p className="mt-4 text-sm text-danger">{error}</p>}

      <div className="mt-6 flex justify-between">
        <Button onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}>
          Back
        </Button>
        {step < 2 ? (
          <Button variant="primary" onClick={() => setStep((s) => s + 1)}>
            Continue
          </Button>
        ) : (
          <Button variant="primary" onClick={submit} disabled={saving}>
            {saving ? "Setting up…" : "Finish setup"}
          </Button>
        )}
      </div>
    </main>
  );
}
