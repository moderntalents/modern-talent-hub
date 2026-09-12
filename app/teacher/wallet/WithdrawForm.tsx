"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select } from "@/components/ui/Card";
import { ErrorBanner } from "@/components/ui/EmptyState";

export function WithdrawForm({ walletBalance, defaultPhone }: { walletBalance: number; defaultPhone: string }) {
  const router = useRouter();
  const [method, setMethod] = useState<"mpesa" | "bank">("mpesa");
  const [amount, setAmount] = useState("");
  const [destination, setDestination] = useState(defaultPhone);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(false);

    const numAmount = Number(amount);
    if (!numAmount || numAmount <= 0) {
      setError("Enter a valid amount.");
      return;
    }
    if (numAmount > walletBalance) {
      setError(`You can withdraw up to ${walletBalance.toLocaleString()} KSh.`);
      return;
    }
    if (!destination.trim()) {
      setError(method === "mpesa" ? "Enter your M-Pesa number." : "Enter your bank account details.");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/withdrawals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: numAmount, destination, method }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not submit withdrawal request.");
      setSuccess(true);
      setAmount("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not submit withdrawal request.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <Field label="Method">
        <Select value={method} onChange={(e) => setMethod(e.target.value as "mpesa" | "bank")}>
          <option value="mpesa">M-Pesa</option>
          <option value="bank">Bank transfer</option>
        </Select>
      </Field>
      <Field label="Amount (KSh)" hint={`Available: ${walletBalance.toLocaleString()} KSh`}>
        <Input type="number" min={1} max={walletBalance} value={amount} onChange={(e) => setAmount(e.target.value)} />
      </Field>
      <Field label={method === "mpesa" ? "M-Pesa number" : "Bank account details"}>
        <Input value={destination} onChange={(e) => setDestination(e.target.value)} placeholder={method === "mpesa" ? "07XX XXX XXX" : "Bank name & account number"} />
      </Field>
      {error && <ErrorBanner message={error} />}
      {success && (
        <p className="text-sm font-medium text-[var(--success-text)]">
          Withdrawal request submitted — an admin will review and process it.
        </p>
      )}
      <Button type="submit" loading={loading} disabled={walletBalance <= 0}>
        Request withdrawal
      </Button>
    </form>
  );
}
