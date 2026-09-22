import type { PGlite } from "@electric-sql/pglite";

// A small, fixed cast of people so every test reads the same way. Ids are readable on purpose.
export const ID = {
  // teachers
  T1: "aaaaaaaa-0000-4000-8000-000000000001", // approved, has a PUBLISHED lesson (L1) and a draft (L2)
  T2: "aaaaaaaa-0000-4000-8000-000000000002", // approved, has activity A1 (published), no published lesson
  T3: "aaaaaaaa-0000-4000-8000-000000000003", // NOT approved, has a published lesson (L3)
  T4: "aaaaaaaa-0000-4000-8000-000000000004", // approved, only a DRAFT lesson and activity A2 with no subscribers
  // students
  S1: "bbbbbbbb-0000-4000-8000-000000000001", // adult, no consent needed; active subscriber of A1
  S2: "bbbbbbbb-0000-4000-8000-000000000002", // under 18, guardian approved the account AND messaging (v2 wording)
  S3: "bbbbbbbb-0000-4000-8000-000000000003", // under 18, guardian approval PENDING
  S4: "bbbbbbbb-0000-4000-8000-000000000004", // no age record at all
  S5: "bbbbbbbb-0000-4000-8000-000000000005", // adult; subscription to A1 exists but is pending_payment
  S6: "bbbbbbbb-0000-4000-8000-000000000006", // under 18, guardian DECLINED
  S7: "bbbbbbbb-0000-4000-8000-000000000007", // adult, unrelated to everyone (an outsider)
  S8: "bbbbbbbb-0000-4000-8000-000000000008", // under 18, guardian approved the account but NOT messaging
  // admin
  ADMIN: "cccccccc-0000-4000-8000-000000000001",
  // content
  SUBJECT: "dddddddd-0000-4000-8000-000000000001",
  L1: "eeeeeeee-0000-4000-8000-000000000001", // T1, published
  L2: "eeeeeeee-0000-4000-8000-000000000002", // T1, draft
  L3: "eeeeeeee-0000-4000-8000-000000000003", // T3 (unapproved), published
  L4: "eeeeeeee-0000-4000-8000-000000000004", // T4, draft
  A1: "ffffffff-0000-4000-8000-000000000001", // T2, published
  A2: "ffffffff-0000-4000-8000-000000000002", // T4, published, nobody subscribed
  A3: "ffffffff-0000-4000-8000-000000000003", // T2, DRAFT
} as const;

const user = (id: string, role: string, name: string) =>
  `insert into auth.users (id, email, raw_user_meta_data)
   values ('${id}', '${id}@test.invalid', '{"role":"${role}","full_name":"${name}"}');`;

export async function seedWorld(db: PGlite): Promise<void> {
  await db.exec(`
    ${user(ID.T1, "teacher", "Teacher One")}
    ${user(ID.T2, "teacher", "Teacher Two")}
    ${user(ID.T3, "teacher", "Teacher Three (unapproved)")}
    ${user(ID.T4, "teacher", "Teacher Four")}
    ${user(ID.S1, "student", "Student One")}
    ${user(ID.S2, "student", "Student Two")}
    ${user(ID.S3, "student", "Student Three")}
    ${user(ID.S4, "student", "Student Four")}
    ${user(ID.S5, "student", "Student Five")}
    ${user(ID.S6, "student", "Student Six")}
    ${user(ID.S7, "student", "Student Seven")}
    ${user(ID.S8, "student", "Student Eight")}
    ${user(ID.ADMIN, "student", "Admin Person")}
    update profiles set role = 'admin' where id = '${ID.ADMIN}';

    update teacher_profiles set approved = true where profile_id in ('${ID.T1}', '${ID.T2}', '${ID.T4}');

    insert into age_records (profile_id, date_of_birth, guardian_email, consent_status) values
      ('${ID.T1}', '1985-01-01', null, 'not_required'),
      ('${ID.T2}', '1985-01-01', null, 'not_required'),
      ('${ID.T3}', '1985-01-01', null, 'not_required'),
      ('${ID.T4}', '1985-01-01', null, 'not_required'),
      ('${ID.S1}', '1990-01-01', null, 'not_required'),
      ('${ID.S2}', '2012-01-01', 'g2@test.invalid', 'granted'),
      ('${ID.S3}', '2012-01-01', 'g3@test.invalid', 'pending'),
      ('${ID.S5}', '1990-01-01', null, 'not_required'),
      ('${ID.S6}', '2012-01-01', 'g6@test.invalid', 'declined'),
      ('${ID.S7}', '1990-01-01', null, 'not_required'),
      ('${ID.S8}', '2012-01-01', 'g8@test.invalid', 'granted');

    -- 0014: S2's guardian also allowed private messaging, on wording that covers it.
    update age_records
    set guardian_messaging_allowed = true, guardian_messaging_status = 'granted',
        guardian_messaging_version = 'guardian-v2', guardian_messaging_decided_at = now()
    where profile_id = '${ID.S2}';

    insert into subjects (id, name) values ('${ID.SUBJECT}', 'Mathematics');
    insert into lessons (id, subject_id, teacher_id, title, status) values
      ('${ID.L1}', '${ID.SUBJECT}', '${ID.T1}', 'Fractions', 'published'),
      ('${ID.L2}', '${ID.SUBJECT}', '${ID.T1}', 'Decimals (draft)', 'draft'),
      ('${ID.L3}', '${ID.SUBJECT}', '${ID.T3}', 'Algebra', 'published'),
      ('${ID.L4}', '${ID.SUBJECT}', '${ID.T4}', 'Geometry (draft)', 'draft');

    insert into activities (id, teacher_id, category, activity_type, title, status) values
      ('${ID.A1}', '${ID.T2}', 'sports', 'football', 'Football club', 'published'),
      ('${ID.A2}', '${ID.T4}', 'creative', 'chess', 'Chess club', 'published'),
      ('${ID.A3}', '${ID.T2}', 'sports', 'skating', 'Skating (draft)', 'draft');

    insert into subscriptions (student_id, activity_id, teacher_id, status) values
      ('${ID.S1}', '${ID.A1}', '${ID.T2}', 'active'),
      ('${ID.S5}', '${ID.A1}', '${ID.T2}', 'pending_payment');
  `);
}
