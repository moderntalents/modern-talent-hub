import { ButtonHTMLAttributes, forwardRef } from "react";
import Link from "next/link";

type Variant = "primary" | "outline" | "danger" | "ghost";

const variantClasses: Record<Variant, string> = {
  primary: "bg-brand-cyan text-ink hover:bg-brand-cyan-deep hover:text-white",
  outline: "border border-line bg-surface text-ink hover:border-brand-cyan-deep",
  danger: "bg-brand-red-deep text-white hover:opacity-90",
  ghost: "bg-transparent text-ink hover:bg-surface-2",
};

const base =
  "inline-flex items-center justify-center gap-2 rounded-full px-5 min-h-11 text-sm font-semibold transition-colors disabled:opacity-50 disabled:pointer-events-none";

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; loading?: boolean }
>(({ variant = "primary", loading, className = "", children, disabled, ...props }, ref) => (
  <button
    ref={ref}
    disabled={disabled || loading}
    className={`${base} ${variantClasses[variant]} ${className}`}
    {...props}
  >
    {loading && (
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
    )}
    {children}
  </button>
));
Button.displayName = "Button";

export function LinkButton({
  href,
  variant = "primary",
  className = "",
  children,
}: {
  href: string;
  variant?: Variant;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Link href={href} className={`${base} ${variantClasses[variant]} ${className}`}>
      {children}
    </Link>
  );
}
