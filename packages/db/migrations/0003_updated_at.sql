-- 0003_updated_at.sql — keep updated_at honest without application discipline
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER appointment_touch        BEFORE UPDATE ON appointment
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER pre_visit_summary_touch  BEFORE UPDATE ON pre_visit_summary
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER post_visit_summary_touch BEFORE UPDATE ON post_visit_summary
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
