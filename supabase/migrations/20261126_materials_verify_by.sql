-- Materials register: a verify-by date on each line, the date it is to be in
-- hand and checked ("Received, checked"). The warehouse owner gets a reminder
-- in the app as it nears (app/api/cron/maintenance, lib/materialReminders).
-- Without this column the app works to the need-by date less 14 days and
-- says so when a typed verify-by date can't be kept.

ALTER TABLE project_materials ADD COLUMN IF NOT EXISTS verify_by DATE;
COMMENT ON COLUMN project_materials.verify_by IS 'By when the line is to be in hand and checked; the warehouse owner is reminded as it nears.';

NOTIFY pgrst, 'reload schema';
