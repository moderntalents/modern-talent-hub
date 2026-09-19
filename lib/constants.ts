// Content model constants — kept in one place and mirrored by the database
// (see supabase/migrations/0001_init.sql and supabase/seed.sql).

export const REVENUE_SPLIT = {
  teacherPct: 70,
  platformPct: 30,
} as const;

// Key of the admin-editable coach activation price in the platform_settings
// table (supabase/migrations/0002_coach_activation_fee.sql). The price itself
// lives in the database — change it at /admin/settings, never in code. The
// limits mirror the table's CHECK constraint: Daraja needs a whole-shilling
// Amount and M-Pesa caps a single transaction at KSh 250,000.
export const COACH_ACTIVATION_FEE_KEY = "coach_activation_fee_kes";
// Global switch (boolean) in platform_settings. Off/missing = everything is free.
export const PAYMENTS_ENABLED_KEY = "payments_enabled";
export const ACTIVATION_FEE_LIMITS = { min: 1, max: 250_000 } as const;

export const CBC_SUBJECTS = [
  "Mathematics",
  "English",
  "Kiswahili",
  "Science & Technology",
  "Social Studies",
  "Christian Religious Education",
  "Agriculture",
  "Creative Arts",
] as const;

export type ActivityCategoryId = "sports" | "martial" | "performing" | "creative";

export interface ActivityCategory {
  id: ActivityCategoryId;
  name: string;
  color: "cyan" | "red" | "orange" | "blue";
  activities: { id: string; name: string; subTypes?: string[] }[];
}

// The full co-curricular marketplace offered through Modern Talent Hub.
export const ACTIVITY_CATEGORIES: ActivityCategory[] = [
  {
    id: "sports",
    name: "Sports",
    color: "cyan",
    activities: [
      { id: "skating", name: "Skating" },
      { id: "football", name: "Football" },
      { id: "archery", name: "Archery" },
      { id: "rugby", name: "Rugby" },
      { id: "tennis", name: "Tennis" },
      { id: "athletics", name: "Athletics" },
      { id: "swimming", name: "Swimming" },
    ],
  },
  {
    id: "martial",
    name: "Martial Arts",
    color: "red",
    activities: [
      { id: "karate", name: "Karate" },
      { id: "taekwondo", name: "Taekwondo" },
      { id: "kickboxing", name: "Kickboxing" },
    ],
  },
  {
    id: "performing",
    name: "Performing Arts & Music",
    color: "orange",
    activities: [
      { id: "ballet", name: "Ballet" },
      { id: "moderndance", name: "Modern Dance" },
      { id: "gymnastics", name: "Gymnastics" },
      { id: "music", name: "Music", subTypes: ["Piano", "Guitar", "Drums", "Violin"] },
    ],
  },
  {
    id: "creative",
    name: "Creative, Tech & Mind Games",
    color: "blue",
    activities: [
      { id: "coding", name: "Coding" },
      { id: "robotics", name: "Robotics" },
      { id: "artcraft", name: "Art & Craft" },
      { id: "chess", name: "Chess" },
    ],
  },
];

export const BILLING_LABELS: Record<string, string> = {
  month: "/month",
  week: "/week",
  lesson: "/lesson",
  day: "/day",
  "one-time": " one-time",
  free: "",
};

export function formatKes(amount: number): string {
  return "KSh " + Math.round(amount).toLocaleString("en-KE");
}
