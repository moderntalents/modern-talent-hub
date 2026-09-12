"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/Button";
import { Card, Field, Input } from "@/components/ui/Card";
import { ErrorBanner } from "@/components/ui/EmptyState";

type Role = "student" | "teacher";

export default function SignupPage() {
  const router = useRouter();
  const [role, setRole] = useState<Role>("student");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [grade, setGrade] = useState("");
  const [schoolName, setSchoolName] = useState("");
  const [specialty, setSpecialty] = useState("");
  const [bio, setBio] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  function validate(): string | null {
    if (!fullName.trim()) return "Enter your full name.";
    if (!/^\S+@\S+\.\S+$/.test(email)) return "Enter a valid email address.";
    if (!phone.trim()) return "Enter your phone number.";
    if (password.length < 8) return "Password must be at least 8 characters.";
    if (password !== confirm) return "Passwords do not match.";
    if (role === "student" && !grade.trim()) return "Enter your grade/class.";
    if (role === "teacher" && !specialty.trim()) return "Enter what you teach.";
    return null;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    setLoading(true);
    setError(null);
    const supabase = createClient();

    const { error: signUpError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          role,
          full_name: fullName,
          phone,
          grade,
          school_name: schoolName,
          specialty,
          bio,
        },
      },
    });

    setLoading(false);

    if (signUpError) {
      setError(signUpError.message);
      return;
    }

    setSubmitted(true);
    setTimeout(() => router.push(`/${role}`), 1200);
  }

  if (submitted) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="font-head text-lg font-bold">Account created</p>
        <p className="text-sm text-ink-soft">
          Check your email to confirm your address if required, then taking you to your dashboard…
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-5 p-6">
      <div className="text-center">
        <h1 className="font-head text-2xl font-extrabold">Create your account</h1>
        <p className="mt-1 text-sm text-ink-soft">Join Modern Talent Hub as a student or teacher.</p>
      </div>

      <Card>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-2">
            {(["student", "teacher"] as Role[]).map((r) => (
              <button
                type="button"
                key={r}
                onClick={() => setRole(r)}
                className={`min-h-11 rounded-xl border text-sm font-semibold capitalize ${
                  role === r
                    ? "border-brand-cyan-deep bg-brand-cyan text-ink"
                    : "border-line bg-surface text-ink-soft"
                }`}
              >
                {r}
              </button>
            ))}
          </div>

          <Field label="Full name">
            <Input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Amina Wanjiru" />
          </Field>
          <Field label="Email">
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
          </Field>
          <Field label="Phone number">
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="07XX XXX XXX" />
          </Field>

          {role === "student" ? (
            <>
              <Field label="Grade / Class">
                <Input value={grade} onChange={(e) => setGrade(e.target.value)} placeholder="Grade 6" />
              </Field>
              <Field label="School (optional)">
                <Input value={schoolName} onChange={(e) => setSchoolName(e.target.value)} placeholder="St. Luke's Primary" />
              </Field>
            </>
          ) : (
            <>
              <Field label="What do you teach?">
                <Input value={specialty} onChange={(e) => setSpecialty(e.target.value)} placeholder="Karate, Piano, Coding…" />
              </Field>
              <Field label="Short bio (optional)">
                <Input value={bio} onChange={(e) => setBio(e.target.value)} placeholder="A sentence about your experience" />
              </Field>
            </>
          )}

          <Field label="Password">
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" />
          </Field>
          <Field label="Confirm password">
            <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </Field>

          {error && <ErrorBanner message={error} />}

          <Button type="submit" loading={loading} className="w-full">
            Create account
          </Button>
        </form>
      </Card>

      <p className="text-center text-sm text-ink-soft">
        Already have an account?{" "}
        <Link href="/login" className="font-semibold text-brand-cyan-deep">
          Log in
        </Link>
      </p>
    </main>
  );
}
