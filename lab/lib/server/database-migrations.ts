import "server-only";

export interface DatabaseMigration {
  version: number;
  name: string;
  sql: string;
}

export const DATABASE_MIGRATIONS: DatabaseMigration[] = [
  {
    version: 1,
    name: "initial-domain-schema",
    sql: `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  display_name TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','approver','uploader')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX users_username_lower_unique ON users (lower(username));

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  user_agent TEXT NOT NULL DEFAULT ''
);
CREATE INDEX sessions_user_id_idx ON sessions(user_id);
CREATE INDEX sessions_expires_at_idx ON sessions(expires_at);

CREATE TABLE auth_attempts (
  attempt_key TEXT PRIMARY KEY,
  failure_count INTEGER NOT NULL,
  window_started BIGINT NOT NULL,
  blocked_until BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE auth_identities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  avatar_url TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE(provider, subject),
  UNIQUE(user_id, provider)
);

CREATE TABLE oauth_states (
  state_hash TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('login','link')),
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  return_to TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX oauth_states_expires_at_idx ON oauth_states(expires_at);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  encrypted INTEGER NOT NULL DEFAULT 0 CHECK (encrypted IN (0,1)),
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE songs (
  id TEXT PRIMARY KEY,
  object_key TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  qiniu_hash TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded','queued','analyzing','analyzed','approved','rejected')),
  uploaded_by TEXT NOT NULL REFERENCES users(id),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX songs_created_at_idx ON songs(created_at DESC);

CREATE TABLE upload_grants (
  object_key TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX upload_grants_expires_at_idx ON upload_grants(expires_at);

CREATE TABLE source_materials (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  title TEXT NOT NULL,
  source_version TEXT NOT NULL,
  license TEXT NOT NULL,
  source_hash TEXT NOT NULL UNIQUE,
  content_json TEXT NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE song_specs (
  id TEXT PRIMARY KEY,
  spec_key TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  parent_id TEXT REFERENCES song_specs(id) ON DELETE RESTRICT,
  source_material_id TEXT NOT NULL REFERENCES source_materials(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('draft','spec_review','approved','retired')),
  content_json TEXT NOT NULL,
  content_hash TEXT NOT NULL UNIQUE,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  approved_by TEXT REFERENCES users(id) ON DELETE RESTRICT,
  approved_at BIGINT,
  created_at BIGINT NOT NULL,
  UNIQUE(spec_key, revision),
  UNIQUE(id, spec_key),
  CHECK (status != 'approved' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);

CREATE OR REPLACE FUNCTION enforce_song_spec_parent() RETURNS trigger AS $$
BEGIN
  IF NEW.parent_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM song_specs parent
    WHERE parent.id = NEW.parent_id
      AND parent.spec_key = NEW.spec_key
      AND parent.revision < NEW.revision
  ) THEN
    RAISE EXCEPTION 'SongSpec parent must use the same key and an earlier revision';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER song_specs_parent_must_match BEFORE INSERT ON song_specs
FOR EACH ROW EXECUTE FUNCTION enforce_song_spec_parent();

CREATE OR REPLACE FUNCTION enforce_song_spec_update() RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('approved','retired') AND ROW(
    NEW.spec_key, NEW.revision, NEW.parent_id, NEW.source_material_id,
    NEW.content_json, NEW.content_hash, NEW.created_by, NEW.approved_by,
    NEW.approved_at, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.spec_key, OLD.revision, OLD.parent_id, OLD.source_material_id,
    OLD.content_json, OLD.content_hash, OLD.created_by, OLD.approved_by,
    OLD.approved_at, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'approved SongSpec content is immutable';
  END IF;
  IF (OLD.status = 'approved' AND NEW.status NOT IN ('approved','retired'))
    OR (OLD.status = 'retired' AND NEW.status != 'retired') THEN
    RAISE EXCEPTION 'SongSpec status transition is not allowed';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER song_specs_update_guard BEFORE UPDATE ON song_specs
FOR EACH ROW EXECUTE FUNCTION enforce_song_spec_update();

CREATE OR REPLACE FUNCTION enforce_song_spec_delete() RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('approved','retired') THEN
    RAISE EXCEPTION 'approved SongSpec cannot be deleted';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER song_specs_delete_guard BEFORE DELETE ON song_specs
FOR EACH ROW EXECUTE FUNCTION enforce_song_spec_delete();

CREATE TABLE experiment_batches (
  id TEXT PRIMARY KEY,
  spec_id TEXT NOT NULL REFERENCES song_specs(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('draft','generating','auto_qc','human_review','completed','failed','cancelled')),
  variables_json TEXT NOT NULL DEFAULT '{}',
  budget_limit_micros BIGINT CHECK (budget_limit_micros IS NULL OR budget_limit_micros >= 0),
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE(id, spec_id)
);

CREATE OR REPLACE FUNCTION require_approved_spec() RETURNS trigger AS $$
BEGIN
  IF (SELECT status FROM song_specs WHERE id = NEW.spec_id) IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION 'experiment batch requires an approved SongSpec';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER experiment_batches_require_approved_spec BEFORE INSERT ON experiment_batches
FOR EACH ROW EXECUTE FUNCTION require_approved_spec();

CREATE TABLE candidates (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  spec_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  model_version TEXT NOT NULL,
  seed BIGINT,
  status TEXT NOT NULL CHECK (status IN ('pending','generating','generated','failed','rejected','needs_inpaint','approved')),
  input_hash TEXT NOT NULL,
  output_hash TEXT,
  artifact_path TEXT,
  latency_ms BIGINT CHECK (latency_ms IS NULL OR latency_ms >= 0),
  cost_micros BIGINT CHECK (cost_micros IS NULL OR cost_micros >= 0),
  error TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE(id, spec_id),
  FOREIGN KEY(batch_id, spec_id) REFERENCES experiment_batches(id, spec_id) ON DELETE RESTRICT
);
CREATE INDEX candidates_batch_id_idx ON candidates(batch_id, created_at);

CREATE TABLE candidate_reviews (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE RESTRICT,
  review_kind TEXT NOT NULL CHECK (review_kind IN ('auto','content','music')),
  verdict TEXT NOT NULL CHECK (verdict IN ('pass','fail','needs_inpaint')),
  scores_json TEXT NOT NULL DEFAULT '{}',
  notes TEXT NOT NULL DEFAULT '',
  reviewer_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  created_at BIGINT NOT NULL,
  CHECK (review_kind = 'auto' OR reviewer_id IS NOT NULL)
);
CREATE INDEX candidate_reviews_candidate_id_idx ON candidate_reviews(candidate_id, created_at);

CREATE TABLE approved_masters (
  id TEXT PRIMARY KEY,
  spec_id TEXT NOT NULL UNIQUE,
  candidate_id TEXT NOT NULL UNIQUE,
  mixed_artifact_path TEXT NOT NULL,
  vocal_stem_path TEXT,
  accompaniment_stem_path TEXT,
  master_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('approved','retired')),
  approved_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  approved_at BIGINT NOT NULL,
  UNIQUE(id, spec_id),
  FOREIGN KEY(candidate_id, spec_id) REFERENCES candidates(id, spec_id) ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION require_generated_candidate() RETURNS trigger AS $$
BEGIN
  IF (SELECT status FROM candidates WHERE id = NEW.candidate_id) IS DISTINCT FROM 'generated' THEN
    RAISE EXCEPTION 'approved master requires a generated candidate';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER approved_masters_require_generated_candidate BEFORE INSERT ON approved_masters
FOR EACH ROW EXECUTE FUNCTION require_generated_candidate();

CREATE TABLE derived_tracks (
  id TEXT PRIMARY KEY,
  master_id TEXT NOT NULL,
  spec_id TEXT NOT NULL,
  level INTEGER NOT NULL CHECK (level BETWEEN 0 AND 3),
  artifact_path TEXT NOT NULL,
  audio_hash TEXT NOT NULL UNIQUE,
  processor_version TEXT NOT NULL,
  windows_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('pending','ready','failed','retired')),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE(master_id, level),
  FOREIGN KEY(master_id, spec_id) REFERENCES approved_masters(id, spec_id) ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION require_approved_master() RETURNS trigger AS $$
BEGIN
  IF (SELECT status FROM approved_masters WHERE id = NEW.master_id) IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION 'derived track requires an approved master';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER derived_tracks_require_approved_master BEFORE INSERT ON derived_tracks
FOR EACH ROW EXECUTE FUNCTION require_approved_master();

CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at BIGINT NOT NULL
);
CREATE INDEX audit_log_created_at_idx ON audit_log(created_at DESC);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed')),
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  parent_job_id TEXT,
  root_job_id TEXT,
  input_json TEXT NOT NULL DEFAULT '{}',
  steps_json TEXT NOT NULL DEFAULT '[]',
  artifacts_json TEXT NOT NULL DEFAULT '[]',
  output_json TEXT NOT NULL DEFAULT 'null',
  error TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  finished_at BIGINT
);
CREATE INDEX jobs_created_at_idx ON jobs(created_at DESC);
CREATE INDEX jobs_root_idx ON jobs(root_job_id, created_at);
`,
  },
  {
    version: 2,
    name: "evaluation-skills-notifications",
    sql: `
CREATE TABLE prompt_snapshots (
  id TEXT PRIMARY KEY,
  spec_id TEXT REFERENCES song_specs(id) ON DELETE RESTRICT,
  tuning_id TEXT NOT NULL DEFAULT 'general',
  system_prompt TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL,
  lyrics TEXT NOT NULL DEFAULT '',
  request_json TEXT NOT NULL DEFAULT '{}',
  builder_version TEXT NOT NULL,
  skill_bundle_hash TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL UNIQUE,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX prompt_snapshots_spec_idx ON prompt_snapshots(spec_id, created_at DESC);

ALTER TABLE experiment_batches ADD COLUMN prompt_snapshot_id TEXT REFERENCES prompt_snapshots(id) ON DELETE RESTRICT;
ALTER TABLE candidates ADD COLUMN prompt_snapshot_id TEXT REFERENCES prompt_snapshots(id) ON DELETE RESTRICT;
CREATE INDEX candidates_prompt_snapshot_idx ON candidates(prompt_snapshot_id, model);

CREATE TABLE evaluation_reports (
  id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('candidate','song')),
  subject_id TEXT NOT NULL,
  candidate_id TEXT REFERENCES candidates(id) ON DELETE RESTRICT,
  song_id TEXT REFERENCES songs(id) ON DELETE RESTRICT,
  report_kind TEXT NOT NULL,
  evaluator TEXT NOT NULL,
  evaluator_version TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('pass','fail','warning','info')),
  total_score DOUBLE PRECISION,
  grade TEXT NOT NULL DEFAULT '',
  domain TEXT NOT NULL DEFAULT '',
  age_band TEXT NOT NULL DEFAULT '',
  scene TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  spec_id TEXT REFERENCES song_specs(id) ON DELETE RESTRICT,
  spec_revision INTEGER,
  spec_content_hash TEXT NOT NULL DEFAULT '',
  prompt_snapshot_id TEXT REFERENCES prompt_snapshots(id) ON DELETE RESTRICT,
  skill_bundle_hash TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  raw_json TEXT NOT NULL DEFAULT '{}',
  created_at BIGINT NOT NULL,
  CHECK ((subject_type = 'candidate' AND candidate_id IS NOT NULL AND song_id IS NULL)
      OR (subject_type = 'song' AND song_id IS NOT NULL AND candidate_id IS NULL))
);
CREATE INDEX evaluation_reports_filter_idx ON evaluation_reports(report_kind, verdict, total_score DESC, created_at DESC);
CREATE INDEX evaluation_reports_domain_idx ON evaluation_reports(domain, age_band, scene, created_at DESC);
CREATE INDEX evaluation_reports_model_idx ON evaluation_reports(provider, model, created_at DESC);
CREATE INDEX evaluation_reports_spec_idx ON evaluation_reports(spec_id, spec_revision, created_at DESC);
CREATE INDEX evaluation_reports_subject_idx ON evaluation_reports(subject_type, subject_id, created_at DESC);

CREATE TABLE evaluation_dimensions (
  report_id TEXT NOT NULL REFERENCES evaluation_reports(id) ON DELETE CASCADE,
  dimension_key TEXT NOT NULL,
  label TEXT NOT NULL,
  score DOUBLE PRECISION NOT NULL,
  threshold DOUBLE PRECISION,
  verdict TEXT NOT NULL CHECK (verdict IN ('pass','fail','warning','info')),
  evidence_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY(report_id, dimension_key)
);
CREATE INDEX evaluation_dimensions_filter_idx ON evaluation_dimensions(dimension_key, score, verdict);

CREATE TABLE test_sets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE TABLE test_set_items (
  test_set_id TEXT NOT NULL REFERENCES test_sets(id) ON DELETE CASCADE,
  report_id TEXT NOT NULL REFERENCES evaluation_reports(id) ON DELETE CASCADE,
  added_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  added_at BIGINT NOT NULL,
  PRIMARY KEY(test_set_id, report_id)
);

CREATE TABLE skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE TABLE skill_revisions (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  body_markdown TEXT NOT NULL,
  references_json TEXT NOT NULL DEFAULT '[]',
  content_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at BIGINT NOT NULL,
  UNIQUE(skill_id, revision)
);
CREATE TABLE skill_bindings (
  id TEXT PRIMARY KEY,
  skill_revision_id TEXT NOT NULL REFERENCES skill_revisions(id) ON DELETE RESTRICT,
  purpose TEXT NOT NULL CHECK (purpose IN ('generation','evaluation','both')),
  domain TEXT NOT NULL DEFAULT '',
  age_band TEXT NOT NULL DEFAULT '',
  scene TEXT NOT NULL DEFAULT '',
  priority INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at BIGINT NOT NULL
);
CREATE INDEX skill_bindings_lookup_idx ON skill_bindings(active, purpose, domain, age_band, scene, priority DESC);
CREATE TABLE run_skill_snapshots (
  id TEXT PRIMARY KEY,
  job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  prompt_snapshot_id TEXT REFERENCES prompt_snapshots(id) ON DELETE CASCADE,
  skill_revision_id TEXT NOT NULL REFERENCES skill_revisions(id) ON DELETE RESTRICT,
  content_hash TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE(prompt_snapshot_id, skill_revision_id)
);

CREATE TABLE ai_context_links (
  token_hash TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('candidate','song','report','test_set')),
  subject_id TEXT NOT NULL,
  format TEXT NOT NULL DEFAULT 'markdown' CHECK (format IN ('markdown','json')),
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  revoked_at BIGINT
);
CREATE INDEX ai_context_links_expiry_idx ON ai_context_links(expires_at);

CREATE TABLE notification_channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  channel_type TEXT NOT NULL CHECK (channel_type IN ('feishu_app','feishu_webhook')),
  target TEXT NOT NULL,
  secret_encrypted TEXT NOT NULL DEFAULT '',
  config_json TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE TABLE notification_rules (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES notification_channels(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  filter_json TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at BIGINT NOT NULL,
  UNIQUE(channel_id, event_type)
);
CREATE TABLE notification_outbox (
  id TEXT PRIMARY KEY,
  event_key TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','delivered','failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at BIGINT NOT NULL,
  error TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  delivered_at BIGINT
);
CREATE INDEX notification_outbox_pending_idx ON notification_outbox(status, next_attempt_at);
CREATE TABLE notification_deliveries (
  id TEXT PRIMARY KEY,
  outbox_id TEXT NOT NULL REFERENCES notification_outbox(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES notification_channels(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('delivered','failed','skipped')),
  http_status INTEGER,
  response_summary TEXT NOT NULL DEFAULT '',
  attempted_at BIGINT NOT NULL,
  UNIQUE(outbox_id, channel_id)
);

CREATE TABLE legacy_imports (
  source_hash TEXT PRIMARY KEY,
  source_path TEXT NOT NULL,
  counts_json TEXT NOT NULL,
  imported_at BIGINT NOT NULL
);
`,
  },
  {
    version: 3,
    name: "report-analysis-indexes",
    sql: `
ALTER TABLE evaluation_dimensions ALTER COLUMN score DROP NOT NULL;
ALTER TABLE songs ADD COLUMN analysis_scene TEXT NOT NULL DEFAULT 'general'
  CHECK (analysis_scene IN ('general','morning','bath','commute','meal','play','focus','travel','bedtime'));
CREATE UNIQUE INDEX evaluation_reports_candidate_evaluator_unique
  ON evaluation_reports(candidate_id, report_kind, evaluator, evaluator_version)
  WHERE candidate_id IS NOT NULL;
CREATE UNIQUE INDEX evaluation_reports_song_evaluator_unique
  ON evaluation_reports(song_id, report_kind, evaluator, evaluator_version)
  WHERE song_id IS NOT NULL;
`,
  },
];
