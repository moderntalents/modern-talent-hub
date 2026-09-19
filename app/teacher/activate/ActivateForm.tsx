"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Card";
import { ErrorBanner } from "@/components/ui/EmptyState";

type PaymentPhase = "idle" | "awaiting_pin" | "confirmed" | "failed";

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 2 * 60 * 1000; // Daraja STK prompts expire after ~60-90s.

export function ActivateForm({ feeLabel }: { feeLabel: string }) {
  const router = useRouter();
  const [phone, setPhone] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<PaymentPhase>("idle");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current);
  }, []);

  // Watches for the REAL outcome: the STK response only means "prompt sent".
  // Only the Safaricom callback can mark the payment completed.
  function pollForOutcome(paymentId: string) {
    const startedAt = Date.now();
    pollRef.current = setInterval(async () => {
      if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
        if (pollRef.current) clearInterval(pollRef.current);
        setPhase("failed");
        setError(
          "We didn't receive confirmation in time. If M-Pesa deducted your money, contact support with your phone number and the time of payment.",
        );
        return;
      }

      try {
        const res = await fetch(`/api/mpesa/activation/${paymentId}`);
        if (!res.ok) return;
        const data = await res.json();

        if (data.status === "completed") {
          if (pollRef.current) clearInterval(pollRef.current);
          setPhase("confirmed");
          setMessage("Payment confirmed — your account is activated!");
          router.refresh();
          router.push("/teacher");
        } else if (data.status === "failed" || data.status === "expired") {
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
      // No amount is sent: the server charges the current fee from platform_settings.
      const res = await fetch("/api/mpesa/activation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phoneNumber: phone }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Payment could not be started.");
      setMessage(data.message);
      setPhase("awaiting_pin");
      pollForOutcome(data.paymentId);
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
          disabled={phase === "awaiting_pin" || phase === "confirmed"}
        />
      </Field>
      <Button
        type="submit"
        loading={loading || phase === "awaiting_pin"}
        disabled={phase === "awaiting_pin" || phase === "confirmed"}
      >
        {phase === "awaiting_pin" ? "Waiting for confirmation…" : `Pay ${feeLabel} with M-Pesa`}
      </Button>
      {message && phase !== "failed" && <p className="text-sm font-medium text-[var(--success-text)]">{message}</p>}
      {error && <ErrorBanner message={error} />}
    </form>
  );
}
