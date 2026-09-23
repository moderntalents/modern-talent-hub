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
  // Bank destination is still freely typed (that path is unchanged and manual). M-Pesa
  // withdrawals are always paid to the coach's own registered number — the server
  // ignores anything sent here for that method, so this field isn't even shown for it.
  const [bankDestination, setBankDestination] = useState("");
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
    if (method === "mpesa" && !defaultPhone) {
      setError("No M-Pesa number is registered on your profile yet — add one before withdrawing.");
      return;
    }
    if (method === "bank" && !bankDestination.trim()) {
      setError("Enter your bank account details.");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/withdrawals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: numAmount,
          method,
          ...(method === "bank" ? { destination: bankDestination } : {}),
        }),
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
      {method === "mpesa" ? (
        <Field label="M-Pesa number" hint="Paid out to your registered number — update it in your profile to change it.">
          <Input value={defaultPhone || "No number registered"} disabled readOnly />
        </Field>
      ) : (
        <Field label="Bank account details">
          <Input value={bankDestination} onChange={(e) => setBankDestination(e.target.value)} placeholder="Bank name & account number" />
        </Field>
      )}
      {error && <ErrorBanner message={error} />}
      {success && (
        <p className="text-sm font-medium text-[var(--success-text)]">
          {method === "mpesa"
            ? "Withdrawal submitted — you'll be paid out via M-Pesa shortly."
            : "Withdrawal request submitted — an admin will review and process it."}
        </p>
      )}
      <Button type="submit" loading={loading} disabled={walletBalance <= 0 || (method === "mpesa" && !defaultPhone)}>
        Request withdrawal
      </Button>
    </form>
  );
}
