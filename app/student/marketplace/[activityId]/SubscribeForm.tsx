"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Card";
import { ErrorBanner } from "@/components/ui/EmptyState";
import { enrolFree } from "./actions";

type PaymentPhase = "idle" | "awaiting_pin" | "confirmed" | "failed";

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 2 * 60 * 1000; // Daraja STK prompts expire after ~60-90s.

export function SubscribeForm({
  activityId,
  price,
  alreadySubscribed,
}: {
  activityId: string;
  price: number;
  alreadySubscribed: boolean;
}) {
  const router = useRouter();
  const [phone, setPhone] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<PaymentPhase>("idle");
  const [pending, startTransition] = useTransition();
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current);
  }, []);

  if (alreadySubscribed) {
    return <p className="text-sm font-semibold text-[var(--success-text)]">✓ You&apos;re enrolled in this activity.</p>;
  }

  if (price === 0) {
    return (
      <div className="flex flex-col gap-2">
        <Button
          onClick={() =>
            startTransition(async () => {
              setError(null);
              try {
                await enrolFree(activityId);
                router.refresh();
              } catch (err) {
                setError(err instanceof Error ? err.message : "Could not enrol.");
              }
            })
          }
          loading={pending}
        >
          Enrol for free
        </Button>
        {error && <ErrorBanner message={error} />}
      </div>
    );
  }

  // Polls the server for the REAL, verified outcome of the payment — the STK
  // push response only means "the prompt was sent to the phone", never that
  // money moved. Only /api/mpesa/callback (driven by Safaricom itself) can
  // ever flip a transaction to "completed"; this just watches for that.
  function pollForOutcome(transactionId: string) {
    const startedAt = Date.now();
    pollRef.current = setInterval(async () => {
      if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
        if (pollRef.current) clearInterval(pollRef.current);
        setPhase("failed");
        setError("We didn't receive confirmation in time. If M-Pesa deducted your money, contact support with your phone number and the time of payment.");
        return;
      }

      try {
        const res = await fetch(`/api/mpesa/status/${transactionId}`);
        if (!res.ok) return;
        const data = await res.json();

        if (data.status === "completed") {
          if (pollRef.current) clearInterval(pollRef.current);
          setPhase("confirmed");
          setMessage("Payment confirmed — you're enrolled!");
          router.refresh();
        } else if (data.status === "failed") {
          if (pollRef.current) clearInterval(pollRef.current);
          setPhase("failed");
          setError("Payment was not completed (cancelled or insufficient funds). You can try again.");
        }
      } catch {
        // Transient network error — the interval will just try again.
      }
    }, POLL_INTERVAL_MS);
  }

  async function pay(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setMessage(null);
    setPhase("idle");
    try {
      const res = await fetch("/api/mpesa/stkpush", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ activityId, phoneNumber: phone }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Payment could not be started.");
      setMessage(data.message);
      setPhase("awaiting_pin");
      pollForOutcome(data.transactionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Payment could not be started.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={pay} className="flex flex-col gap-3">
      <Field label="M-Pesa phone number" hint="You'll get an STK push prompt to enter your PIN.">
        <Input
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="07XX XXX XXX"
          disabled={phase === "awaiting_pin"}
        />
      </Field>
      <Button type="submit" loading={loading || phase === "awaiting_pin"} disabled={phase === "awaiting_pin"}>
        {phase === "awaiting_pin" ? "Waiting for confirmation…" : "Pay with M-Pesa"}
      </Button>
      {message && phase !== "failed" && (
        <p className="text-sm font-medium text-[var(--success-text)]">{message}</p>
      )}
      {error && <ErrorBanner message={error} />}
    </form>
  );
}
