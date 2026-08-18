"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button, Card, Hint, Input, Label } from "@/components/ui";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [message, setMessage] = useState("");

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    setStatus("sending");

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    });

    if (error) {
      setStatus("error");
      setMessage(error.message);
    } else {
      setStatus("sent");
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <h1 className="text-2xl font-semibold tracking-tight">IB Calendar OS</h1>
      <p className="mt-1 text-muted">
        A planner that protects your sleep and does the scheduling for you.
      </p>

      <Card className="mt-8">
        {status === "sent" ? (
          <div>
            <p className="font-medium">Check your email</p>
            <Hint className="mt-1">
              We sent a sign-in link to <strong>{email}</strong>. It expires in an
              hour.
            </Hint>
          </div>
        ) : (
          /* Magic link only — the app never asks for or stores a password. */
          <form onSubmit={signIn}>
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              required
              autoComplete="email"
              placeholder="you@school.edu"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <Button
              type="submit"
              variant="primary"
              className="mt-4 w-full"
              disabled={status === "sending"}
            >
              {status === "sending" ? "Sending…" : "Email me a sign-in link"}
            </Button>
            {status === "error" && (
              <p className="mt-3 text-sm text-danger">{message}</p>
            )}
          </form>
        )}
      </Card>
    </main>
  );
}
