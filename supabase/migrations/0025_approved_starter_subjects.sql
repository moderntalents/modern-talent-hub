-- 0025 — Approved starter subjects (needs 0024).
--
-- Adds ONLY the 38 subjects approved for now, by school level and (Senior School) pathway. It never deletes,
-- renames or changes an existing subject, lesson or material: a subject that already exists in the same level
-- with the same name is left exactly as it is (on conflict do nothing). Safe to run more than once.
--
-- The 8 existing Primary (CBC) subjects are not touched. Subjects approved for "later" are not added here;
-- admins add them on Admin -> Subjects whenever they are needed.
--
-- Mathematics in Senior School: both Core Mathematics (STEM pathway) and Essential Mathematics (Social Sciences
-- and Arts & Sports Science pathways) are in the catalogue. Nothing here assigns subjects to students.

insert into subjects (name, level, pathway, description, color, order_index) values
  -- Pre-primary (PP1–PP2)
  ('Language Activities',            'pre_primary', null, null, 'cyan',   1),
  ('Mathematical Activities',        'pre_primary', null, null, 'orange', 2),
  ('Creative Activities',            'pre_primary', null, null, 'red',    3),
  ('Environmental Activities',       'pre_primary', null, null, 'blue',   4),
  ('Religious Education Activities', 'pre_primary', null, null, 'cyan',   5),

  -- Primary (CBC), Grades 1–6: two additions after the existing 8 (order 1–8)
  ('Environmental Activities',       'primary', null, 'Grades 1–3.', 'blue', 9),
  ('Islamic Religious Education',    'primary', null, null,          'cyan', 10),

  -- Junior School, Grades 7–9
  ('English',                        'junior', null, null, 'orange', 1),
  ('Kiswahili',                      'junior', null, null, 'red',    2),
  ('Mathematics',                    'junior', null, null, 'cyan',   3),
  ('Integrated Science',             'junior', null, null, 'blue',   4),
  ('Social Studies',                 'junior', null, null, 'cyan',   5),
  ('Pre-Technical Studies',          'junior', null, null, 'orange', 6),
  ('Agriculture and Nutrition',      'junior', null, null, 'red',    7),
  ('Creative Arts and Sports',       'junior', null, null, 'blue',   8),
  ('Christian Religious Education',  'junior', null, null, 'orange', 9),
  ('Islamic Religious Education',    'junior', null, null, 'cyan',   10),

  -- Senior School, Grades 10–12 — Core
  ('English',                        'senior', 'core', null, 'orange', 1),
  ('Kiswahili',                      'senior', 'core', null, 'red',    2),
  ('Core Mathematics',               'senior', 'core', 'For learners in the STEM pathway.', 'cyan', 3),
  ('Essential Mathematics',          'senior', 'core', 'For learners in the Social Sciences and Arts & Sports Science pathways.', 'cyan', 4),
  ('Community Service Learning',     'senior', 'core', null, 'blue',   5),

  -- Senior School — STEM
  ('Biology',                        'senior', 'stem', null, 'cyan',   11),
  ('Chemistry',                      'senior', 'stem', null, 'orange', 12),
  ('Physics',                        'senior', 'stem', null, 'red',    13),
  ('Agriculture',                    'senior', 'stem', null, 'blue',   14),
  ('Computer Studies',               'senior', 'stem', null, 'cyan',   15),

  -- Senior School — Social Sciences
  ('Literature in English',          'senior', 'social_sciences', null, 'orange', 21),
  ('Fasihi ya Kiswahili',            'senior', 'social_sciences', null, 'red',    22),
  ('History and Citizenship',        'senior', 'social_sciences', null, 'blue',   23),
  ('Geography',                      'senior', 'social_sciences', null, 'cyan',   24),
  ('Business Studies',               'senior', 'social_sciences', null, 'orange', 25),
  ('Christian Religious Education',  'senior', 'social_sciences', null, 'red',    26),
  ('Islamic Religious Education',    'senior', 'social_sciences', null, 'blue',   27),

  -- Senior School — Arts & Sports Science
  ('Sports and Recreation',          'senior', 'arts_sports', null, 'cyan',   31),
  ('Music and Dance',                'senior', 'arts_sports', null, 'orange', 32),
  ('Theatre and Film',               'senior', 'arts_sports', null, 'red',    33),
  ('Fine Arts',                      'senior', 'arts_sports', null, 'blue',   34)
on conflict (level, name) do nothing;
