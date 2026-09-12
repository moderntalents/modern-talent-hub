-- Seed data preserving the real content model from the original MTH prototype.
-- Run after 0001_init.sql. Safe to re-run (idempotent on name).

insert into subjects (name, color, order_index) values
  ('Mathematics', 'cyan', 1),
  ('English', 'orange', 2),
  ('Kiswahili', 'red', 3),
  ('Science & Technology', 'blue', 4),
  ('Social Studies', 'cyan', 5),
  ('Christian Religious Education', 'orange', 6),
  ('Agriculture', 'red', 7),
  ('Creative Arts', 'blue', 8)
on conflict (name) do nothing;

-- Co-curricular categories/activities are represented directly as `activities.category`
-- and `activities.activity_type` values (enforced by the activity_category enum and
-- validated in the app's activity form). The full set offered through Modern Talent Hub:
--
--   sports     -> skating, football, archery, rugby, tennis, athletics, swimming
--   martial    -> karate, taekwondo, kickboxing
--   performing -> ballet, moderndance, gymnastics, music (sub_type: Piano/Guitar/Drums/Violin)
--   creative   -> coding, robotics, artcraft, chess
--
-- These aren't a separate lookup table because each activity is a real, teacher-owned
-- listing (title, price, billing cycle) rather than a static catalog entry — teachers
-- create them from the dashboard, choosing category + activity type from this fixed set
-- (see lib/constants.ts ACTIVITY_CATEGORIES, kept in sync with this comment).
