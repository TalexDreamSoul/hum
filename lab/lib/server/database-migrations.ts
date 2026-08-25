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
  {
    version: 4,
    name: "knowledge-media-pipeline-governance",
    sql: `
CREATE TABLE knowledge_domains (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES knowledge_domains(id) ON DELETE RESTRICT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','retired')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX knowledge_domains_parent_idx ON knowledge_domains(parent_id, status, name);

CREATE TABLE knowledge_sources (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL CHECK (source_type IN ('book','article','standard','course','manual','original')),
  title TEXT NOT NULL,
  publisher TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','review','published','retired')),
  current_revision INTEGER NOT NULL DEFAULT 1 CHECK (current_revision > 0),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX knowledge_sources_filter_idx ON knowledge_sources(source_type, status, title);

CREATE TABLE knowledge_source_revisions (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES knowledge_sources(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  version_label TEXT NOT NULL,
  license TEXT NOT NULL,
  excerpt TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  content_hash TEXT NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at BIGINT NOT NULL,
  UNIQUE(source_id, revision),
  UNIQUE(content_hash)
);

CREATE TABLE knowledge_chapters (
  id TEXT PRIMARY KEY,
  source_revision_id TEXT NOT NULL REFERENCES knowledge_source_revisions(id) ON DELETE RESTRICT,
  parent_id TEXT REFERENCES knowledge_chapters(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  locator TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL CHECK (position >= 0),
  excerpt TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at BIGINT NOT NULL,
  UNIQUE(source_revision_id, parent_id, position)
);
CREATE INDEX knowledge_chapters_source_idx ON knowledge_chapters(source_revision_id, position);

CREATE TABLE curricula (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  age_band TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('draft','published','retired')),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE knowledge_items (
  id TEXT PRIMARY KEY,
  domain_id TEXT NOT NULL REFERENCES knowledge_domains(id) ON DELETE RESTRICT,
  slug TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','review','published','retired')),
  current_revision INTEGER NOT NULL DEFAULT 1 CHECK (current_revision > 0),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE(domain_id, slug)
);
CREATE INDEX knowledge_items_filter_idx ON knowledge_items(domain_id, status, updated_at DESC);

CREATE TABLE knowledge_item_revisions (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES knowledge_items(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  lead TEXT NOT NULL,
  answer TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  age_band TEXT NOT NULL,
  content_risk TEXT NOT NULL DEFAULT 'low' CHECK (content_risk IN ('low','medium','high')),
  source_revision_id TEXT REFERENCES knowledge_source_revisions(id) ON DELETE RESTRICT,
  source_locator TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at BIGINT NOT NULL,
  UNIQUE(item_id, revision),
  UNIQUE(content_hash)
);
CREATE INDEX knowledge_revision_search_idx ON knowledge_item_revisions(title, age_band, created_at DESC);

CREATE TABLE knowledge_edges (
  id TEXT PRIMARY KEY,
  from_revision_id TEXT NOT NULL REFERENCES knowledge_item_revisions(id) ON DELETE RESTRICT,
  to_revision_id TEXT NOT NULL REFERENCES knowledge_item_revisions(id) ON DELETE RESTRICT,
  relation TEXT NOT NULL CHECK (relation IN ('sequence','cause','contrast','classification','condition','result','prerequisite')),
  connector TEXT NOT NULL DEFAULT '',
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at BIGINT NOT NULL,
  CHECK (from_revision_id <> to_revision_id),
  UNIQUE(from_revision_id, to_revision_id, relation)
);
CREATE INDEX knowledge_edges_from_idx ON knowledge_edges(from_revision_id, relation);
CREATE INDEX knowledge_edges_to_idx ON knowledge_edges(to_revision_id, relation);

CREATE TABLE curriculum_items (
  curriculum_id TEXT NOT NULL REFERENCES curricula(id) ON DELETE CASCADE,
  item_revision_id TEXT NOT NULL REFERENCES knowledge_item_revisions(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY(curriculum_id, item_revision_id),
  UNIQUE(curriculum_id, position)
);

CREATE TABLE knowledge_reviews (
  id TEXT PRIMARY KEY,
  item_revision_id TEXT NOT NULL REFERENCES knowledge_item_revisions(id) ON DELETE RESTRICT,
  review_kind TEXT NOT NULL CHECK (review_kind IN ('mock_ai','content','final')),
  verdict TEXT NOT NULL CHECK (verdict IN ('pass','revise','reject')),
  score INTEGER CHECK (score BETWEEN 0 AND 100),
  notes TEXT NOT NULL DEFAULT '',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  reviewer_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX knowledge_reviews_revision_idx ON knowledge_reviews(item_revision_id, created_at DESC);

CREATE TABLE knowledge_song_specs (
  item_revision_id TEXT NOT NULL REFERENCES knowledge_item_revisions(id) ON DELETE RESTRICT,
  spec_id TEXT NOT NULL REFERENCES song_specs(id) ON DELETE RESTRICT,
  created_at BIGINT NOT NULL,
  PRIMARY KEY(item_revision_id, spec_id)
);

CREATE TABLE media_assets (
  id TEXT PRIMARY KEY,
  storage_provider TEXT NOT NULL CHECK (storage_provider IN ('qiniu','local','mock')),
  object_key TEXT NOT NULL,
  original_name TEXT NOT NULL,
  media_kind TEXT NOT NULL CHECK (media_kind IN ('audio','video','screen_recording','document','image')),
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
  content_hash TEXT NOT NULL DEFAULT '',
  qiniu_hash TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'uploaded' CHECK (status IN ('authorized','uploaded','analyzing','ready','rejected','retired')),
  duration_ms BIGINT,
  sample_rate INTEGER,
  channels INTEGER,
  width INTEGER,
  height INTEGER,
  frame_rate DOUBLE PRECISION,
  transcript TEXT NOT NULL DEFAULT '',
  transcript_model TEXT NOT NULL DEFAULT '',
  thumbnail_object_key TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  source_song_id TEXT REFERENCES songs(id) ON DELETE SET NULL,
  source_candidate_id TEXT REFERENCES candidates(id) ON DELETE SET NULL,
  uploaded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE(storage_provider, object_key)
);
CREATE UNIQUE INDEX media_assets_hash_unique ON media_assets(content_hash) WHERE content_hash <> '';
CREATE INDEX media_assets_filter_idx ON media_assets(media_kind, status, created_at DESC);

CREATE TABLE media_links (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('knowledge','publication','song_spec','candidate','release')),
  subject_id TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'primary',
  position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at BIGINT NOT NULL,
  UNIQUE(asset_id, subject_type, subject_id, purpose)
);
CREATE INDEX media_links_subject_idx ON media_links(subject_type, subject_id, position);

CREATE TABLE publications (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('book','album','collection')),
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','review','published','retired')),
  current_revision INTEGER NOT NULL DEFAULT 1 CHECK (current_revision > 0),
  audience TEXT NOT NULL DEFAULT '',
  scene TEXT NOT NULL DEFAULT 'general',
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX publications_filter_idx ON publications(kind, status, updated_at DESC);

CREATE TABLE publication_revisions (
  id TEXT PRIMARY KEY,
  publication_id TEXT NOT NULL REFERENCES publications(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  content_hash TEXT NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at BIGINT NOT NULL,
  UNIQUE(publication_id, revision),
  UNIQUE(content_hash)
);

CREATE TABLE publication_items (
  id TEXT PRIMARY KEY,
  publication_revision_id TEXT NOT NULL REFERENCES publication_revisions(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL CHECK (item_type IN ('knowledge','song_spec','media','publication')),
  item_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  label TEXT NOT NULL DEFAULT '',
  snapshot_hash TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  UNIQUE(publication_revision_id, position),
  UNIQUE(publication_revision_id, item_type, item_id)
);

CREATE TABLE content_tags (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('audience','scene','theme','domain','format')),
  created_at BIGINT NOT NULL
);

CREATE TABLE content_tag_bindings (
  tag_id TEXT NOT NULL REFERENCES content_tags(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('knowledge','publication','media','song_spec')),
  subject_id TEXT NOT NULL,
  PRIMARY KEY(tag_id, subject_type, subject_id)
);
CREATE INDEX content_tag_bindings_subject_idx ON content_tag_bindings(subject_type, subject_id);

CREATE TABLE rights_grants (
  id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('source','publication','media','song_spec')),
  subject_id TEXT NOT NULL,
  holder TEXT NOT NULL,
  license TEXT NOT NULL,
  territory TEXT NOT NULL DEFAULT 'global',
  starts_at BIGINT,
  expires_at BIGINT,
  evidence_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'valid' CHECK (status IN ('draft','valid','expired','revoked')),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX rights_grants_subject_idx ON rights_grants(subject_type, subject_id, status);

CREATE TABLE release_packages (
  id TEXT PRIMARY KEY,
  publication_revision_id TEXT NOT NULL REFERENCES publication_revisions(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version > 0),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','review','released','recalled')),
  manifest_json TEXT NOT NULL DEFAULT '{}',
  content_hash TEXT NOT NULL UNIQUE,
  gate_snapshot_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  approved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at BIGINT NOT NULL,
  released_at BIGINT,
  UNIQUE(publication_revision_id, version)
);
CREATE INDEX release_packages_status_idx ON release_packages(status, created_at DESC);

CREATE TABLE import_batches (
  id TEXT PRIMARY KEY,
  import_kind TEXT NOT NULL CHECK (import_kind IN ('knowledge','publication','media')),
  status TEXT NOT NULL CHECK (status IN ('validating','ready','imported','failed')),
  source_name TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  summary_json TEXT NOT NULL DEFAULT '{}',
  error TEXT NOT NULL DEFAULT '',
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at BIGINT NOT NULL,
  finished_at BIGINT
);
CREATE UNIQUE INDEX import_batches_hash_unique ON import_batches(import_kind, source_hash);

CREATE TABLE import_items (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  row_no INTEGER NOT NULL CHECK (row_no > 0),
  status TEXT NOT NULL CHECK (status IN ('valid','invalid','imported','skipped')),
  payload_json TEXT NOT NULL,
  error TEXT NOT NULL DEFAULT '',
  UNIQUE(batch_id, row_no)
);

CREATE TABLE pipeline_templates (
  id TEXT PRIMARY KEY,
  template_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','retired')),
  current_revision INTEGER NOT NULL DEFAULT 1 CHECK (current_revision > 0),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE pipeline_template_revisions (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL REFERENCES pipeline_templates(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  stages_json TEXT NOT NULL,
  content_hash TEXT NOT NULL UNIQUE,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at BIGINT NOT NULL,
  UNIQUE(template_id, revision)
);

CREATE TABLE pipeline_plans (
  id TEXT PRIMARY KEY,
  template_revision_id TEXT NOT NULL REFERENCES pipeline_template_revisions(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  subject_type TEXT NOT NULL DEFAULT 'topic',
  subject_id TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','queued','running','paused','retry_wait','awaiting_review','succeeded','failed','cancelling','cancelled')),
  input_json TEXT NOT NULL DEFAULT '{}',
  output_json TEXT NOT NULL DEFAULT '{}',
  mock_enabled INTEGER NOT NULL DEFAULT 1 CHECK (mock_enabled = 1),
  model TEXT NOT NULL DEFAULT 'music-3.0-free' CHECK (model = 'music-3.0-free'),
  requests_per_minute INTEGER NOT NULL DEFAULT 3 CHECK (requests_per_minute = 3),
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt > 0),
  parent_plan_id TEXT REFERENCES pipeline_plans(id) ON DELETE SET NULL,
  root_plan_id TEXT REFERENCES pipeline_plans(id) ON DELETE SET NULL,
  scheduled_at BIGINT,
  next_attempt_at BIGINT,
  lease_owner TEXT,
  lease_expires_at BIGINT,
  pause_reason TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  finished_at BIGINT
);
CREATE INDEX pipeline_plans_claim_idx ON pipeline_plans(status, scheduled_at, next_attempt_at, created_at);
CREATE INDEX pipeline_plans_root_idx ON pipeline_plans(root_plan_id, created_at);

CREATE TABLE pipeline_stage_runs (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES pipeline_plans(id) ON DELETE CASCADE,
  stage_key TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','paused','succeeded','failed','skipped','cancelled')),
  checkpoint_json TEXT NOT NULL DEFAULT '{}',
  artifact_hash TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  started_at BIGINT,
  finished_at BIGINT,
  UNIQUE(plan_id, stage_key)
);
CREATE INDEX pipeline_stage_runs_plan_idx ON pipeline_stage_runs(plan_id, position);

CREATE TABLE pipeline_schedules (
  id TEXT PRIMARY KEY,
  template_revision_id TEXT NOT NULL REFERENCES pipeline_template_revisions(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  interval_minutes INTEGER NOT NULL CHECK (interval_minutes BETWEEN 1 AND 10080),
  input_json TEXT NOT NULL DEFAULT '{}',
  next_run_at BIGINT NOT NULL,
  last_run_at BIGINT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX pipeline_schedules_due_idx ON pipeline_schedules(enabled, next_run_at);

CREATE TABLE pipeline_events (
  id BIGSERIAL PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES pipeline_plans(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at BIGINT NOT NULL
);
CREATE INDEX pipeline_events_plan_idx ON pipeline_events(plan_id, created_at);

CREATE TABLE provider_rate_limits (
  provider_lane TEXT PRIMARY KEY,
  window_started_at BIGINT NOT NULL,
  used_tokens INTEGER NOT NULL CHECK (used_tokens BETWEEN 0 AND 3),
  updated_at BIGINT NOT NULL
);

CREATE TABLE role_policies (
  role TEXT PRIMARY KEY CHECK (role IN ('admin','approver','uploader')),
  tier TEXT NOT NULL CHECK (tier IN ('A','B','C')),
  label TEXT NOT NULL,
  permissions_json TEXT NOT NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE review_rubrics (
  id TEXT PRIMARY KEY,
  rubric_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('audio','video','knowledge','publication')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','retired')),
  current_revision INTEGER NOT NULL DEFAULT 1 CHECK (current_revision > 0),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE rubric_revisions (
  id TEXT PRIMARY KEY,
  rubric_id TEXT NOT NULL REFERENCES review_rubrics(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  dimensions_json TEXT NOT NULL,
  threshold INTEGER NOT NULL CHECK (threshold BETWEEN 0 AND 100),
  content_hash TEXT NOT NULL UNIQUE,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at BIGINT NOT NULL,
  UNIQUE(rubric_id, revision)
);

ALTER TABLE candidate_reviews ADD COLUMN round_no INTEGER NOT NULL DEFAULT 1 CHECK (round_no > 0);
ALTER TABLE candidate_reviews ADD COLUMN rubric_revision_id TEXT REFERENCES rubric_revisions(id) ON DELETE RESTRICT;
ALTER TABLE candidate_reviews ADD COLUMN assignment_id TEXT;
ALTER TABLE candidate_reviews ADD COLUMN decision_reason TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX candidate_reviews_human_round_unique
  ON candidate_reviews(candidate_id, round_no, review_kind, reviewer_id) WHERE reviewer_id IS NOT NULL;
CREATE UNIQUE INDEX candidate_reviews_auto_round_unique
  ON candidate_reviews(candidate_id, round_no, review_kind) WHERE reviewer_id IS NULL;

CREATE TABLE review_rounds (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE RESTRICT,
  round_no INTEGER NOT NULL CHECK (round_no > 0),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','changes_requested','passed','closed')),
  opened_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  closed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at BIGINT NOT NULL,
  closed_at BIGINT,
  UNIQUE(candidate_id, round_no)
);

CREATE TABLE review_assignments (
  id TEXT PRIMARY KEY,
  review_round_id TEXT NOT NULL REFERENCES review_rounds(id) ON DELETE CASCADE,
  review_kind TEXT NOT NULL CHECK (review_kind IN ('content','music')),
  reviewer_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned','submitted','cancelled')),
  assigned_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at BIGINT NOT NULL,
  submitted_at BIGINT,
  UNIQUE(review_round_id, review_kind),
  UNIQUE(review_round_id, reviewer_id)
);

CREATE TABLE media_reviews (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES media_assets(id) ON DELETE RESTRICT,
  rubric_revision_id TEXT REFERENCES rubric_revisions(id) ON DELETE RESTRICT,
  round_no INTEGER NOT NULL DEFAULT 1 CHECK (round_no > 0),
  review_kind TEXT NOT NULL CHECK (review_kind IN ('technical','content','music')),
  verdict TEXT NOT NULL CHECK (verdict IN ('pass','revise','reject')),
  score INTEGER CHECK (score BETWEEN 0 AND 100),
  dimensions_json TEXT NOT NULL DEFAULT '{}',
  notes TEXT NOT NULL DEFAULT '',
  reviewer_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX media_reviews_asset_idx ON media_reviews(asset_id, round_no, created_at DESC);

CREATE TABLE benchmark_sets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','retired')),
  current_revision INTEGER NOT NULL DEFAULT 1 CHECK (current_revision > 0),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE benchmark_set_revisions (
  id TEXT PRIMARY KEY,
  benchmark_set_id TEXT NOT NULL REFERENCES benchmark_sets(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  rubric_revision_id TEXT REFERENCES rubric_revisions(id) ON DELETE RESTRICT,
  content_hash TEXT NOT NULL UNIQUE,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at BIGINT NOT NULL,
  UNIQUE(benchmark_set_id, revision)
);

CREATE TABLE benchmark_items (
  benchmark_revision_id TEXT NOT NULL REFERENCES benchmark_set_revisions(id) ON DELETE CASCADE,
  report_id TEXT NOT NULL REFERENCES evaluation_reports(id) ON DELETE RESTRICT,
  snapshot_hash TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY(benchmark_revision_id, report_id),
  UNIQUE(benchmark_revision_id, position)
);

CREATE TABLE benchmark_runs (
  id TEXT PRIMARY KEY,
  benchmark_revision_id TEXT NOT NULL REFERENCES benchmark_set_revisions(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('running','passed','failed')),
  model TEXT NOT NULL DEFAULT 'music-3.0-free',
  result_json TEXT NOT NULL DEFAULT '{}',
  started_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at BIGINT NOT NULL,
  finished_at BIGINT
);

CREATE TABLE release_gate_checks (
  id TEXT PRIMARY KEY,
  publication_revision_id TEXT REFERENCES publication_revisions(id) ON DELETE CASCADE,
  candidate_id TEXT REFERENCES candidates(id) ON DELETE CASCADE,
  gate_key TEXT NOT NULL CHECK (gate_key IN ('auto_qc','content_review','music_review','rights','media_ready','final_approval')),
  verdict TEXT NOT NULL CHECK (verdict IN ('pass','block','pending')),
  evidence_json TEXT NOT NULL DEFAULT '{}',
  checked_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX release_gate_subject_idx ON release_gate_checks(publication_revision_id, candidate_id, gate_key, created_at DESC);
CREATE INDEX audit_log_filter_idx ON audit_log(action, target_type, target_id, created_at DESC);

INSERT INTO role_policies (role, tier, label, permissions_json, updated_at) VALUES
  ('admin','A','A 级管理员','["configure","publish","final_review","manage"]',0),
  ('approver','B','B 级复审员','["content_review","music_review","compare","read"]',0),
  ('uploader','C','C 级创作者','["draft","upload","submit","read_own"]',0);

INSERT INTO knowledge_domains (id, slug, name, description, status, revision, created_at, updated_at) VALUES
  ('seed-domain-english','english','英语启蒙','词汇、表达与自然拼读','published',1,0,0),
  ('seed-domain-nursery','nursery-rhymes','儿歌表达','节奏、押韵、情绪与生活习惯','published',1,0,0),
  ('seed-domain-math','mathematics','数学启蒙','数感、运算、比较与形状','published',1,0,0),
  ('seed-domain-science','science','科学常识','自然观察与因果解释','published',1,0,0),
  ('seed-domain-life','life-skills','生活安全','健康、规则与安全习惯','published',1,0,0);

INSERT INTO knowledge_sources (id, source_type, title, publisher, status, current_revision, created_at, updated_at) VALUES
  ('seed-source-starter','original','hum 内置启蒙知识集','hum','published',1,0,0);
INSERT INTO knowledge_source_revisions (id, source_id, revision, version_label, license, excerpt, metadata_json, content_hash, created_at) VALUES
  ('seed-source-starter-r1','seed-source-starter',1,'2026.08','hum-original','用于本地 Mock 流水线的英语、儿歌、数学和生活常识示例。','{}',md5('seed-source-starter-r1') || md5('seed-source-starter-r1'),0);
INSERT INTO knowledge_chapters (id, source_revision_id, title, locator, position, excerpt, content_hash, created_at) VALUES
  ('seed-chapter-english','seed-source-starter-r1','英语启蒙','chapter:english',0,'问候、颜色和动物词汇。',md5('seed-chapter-english') || md5('seed-chapter-english'),0),
  ('seed-chapter-nursery','seed-source-starter-r1','儿歌与生活','chapter:nursery',1,'节奏表达、洗手和情绪命名。',md5('seed-chapter-nursery') || md5('seed-chapter-nursery'),0),
  ('seed-chapter-math','seed-source-starter-r1','数学启蒙','chapter:math',2,'数数、加法、比较和形状。',md5('seed-chapter-math') || md5('seed-chapter-math'),0);
INSERT INTO curricula (id, code, name, age_band, description, status, created_at, updated_at) VALUES
  ('seed-curriculum-3-4','hum-3-4','3–4 岁启蒙路径','3-4','短句、单一答案和高频复现。','published',0,0),
  ('seed-curriculum-5-6','hum-5-6','5–6 岁基础路径','5-6','因果链、两步推理和接唱提取。','published',0,0);

INSERT INTO knowledge_items (id, domain_id, slug, status, current_revision, created_at, updated_at) VALUES
  ('seed-ki-hello','seed-domain-english','hello-greeting','published',1,0,0),
  ('seed-ki-colors','seed-domain-english','red-blue-colors','published',1,0,0),
  ('seed-ki-animals','seed-domain-english','cat-dog-animals','published',1,0,0),
  ('seed-ki-rhythm','seed-domain-nursery','steady-rhythm','published',1,0,0),
  ('seed-ki-handwash','seed-domain-life','handwash-steps','published',1,0,0),
  ('seed-ki-emotion','seed-domain-nursery','name-emotions','published',1,0,0),
  ('seed-ki-count-five','seed-domain-math','count-one-to-five','published',1,0,0),
  ('seed-ki-addition','seed-domain-math','two-plus-three','published',1,0,0),
  ('seed-ki-compare','seed-domain-math','compare-numbers','published',1,0,0),
  ('seed-ki-triangle','seed-domain-math','triangle-three-sides','published',1,0,0),
  ('seed-ki-rain','seed-domain-science','rain-water-cycle','published',1,0,0),
  ('seed-ki-road','seed-domain-life','red-light-stop','published',1,0,0);

INSERT INTO knowledge_item_revisions (id, item_id, revision, title, objective, lead, answer, summary, age_band, source_revision_id, source_locator, content_hash, created_at) VALUES
  ('seed-kir-hello','seed-ki-hello',1,'Hello 是问候','会在见面时使用 Hello','见面问候说','Hello','把英语问候放入见面场景。','3-4','seed-source-starter-r1','chapter:english',md5('seed-kir-hello') || md5('seed-kir-hello'),0),
  ('seed-kir-colors','seed-ki-colors',1,'Red 与 Blue','认识红色和蓝色的英文','红色英文是','red','用实物颜色建立词义。','3-4','seed-source-starter-r1','chapter:english',md5('seed-kir-colors') || md5('seed-kir-colors'),0),
  ('seed-kir-animals','seed-ki-animals',1,'Cat 与 Dog','认识猫和狗的英文','小猫英文是','cat','用常见动物建立词义。','3-4','seed-source-starter-r1','chapter:english',md5('seed-kir-animals') || md5('seed-kir-animals'),0),
  ('seed-kir-rhythm','seed-ki-rhythm',1,'稳定节拍','能跟随四拍稳定拍手','四拍一轮要数到','四','用固定拍点帮助复述。','3-4','seed-source-starter-r1','chapter:nursery',md5('seed-kir-rhythm') || md5('seed-kir-rhythm'),0),
  ('seed-kir-handwash','seed-ki-handwash',1,'洗手要搓洗','知道用流水和肥皂洗手','洗手要先用','流水','建立基本卫生顺序。','3-4','seed-source-starter-r1','chapter:nursery',md5('seed-kir-handwash') || md5('seed-kir-handwash'),0),
  ('seed-kir-emotion','seed-ki-emotion',1,'说出情绪','能用词语表达当下感受','开心难过都是','情绪','先命名再表达需要。','3-4','seed-source-starter-r1','chapter:nursery',md5('seed-kir-emotion') || md5('seed-kir-emotion'),0),
  ('seed-kir-count-five','seed-ki-count-five',1,'从一数到五','能按顺序数出一到五','一二三四接着是','五','建立稳定数序。','3-4','seed-source-starter-r1','chapter:math',md5('seed-kir-count-five') || md5('seed-kir-count-five'),0),
  ('seed-kir-addition','seed-ki-addition',1,'二加三等于五','理解合并数量的加法','二加三等于','五','把两组数量合并。','5-6','seed-source-starter-r1','chapter:math',md5('seed-kir-addition') || md5('seed-kir-addition'),0),
  ('seed-kir-compare','seed-ki-compare',1,'比较大小','能比较五和三的大小','五比三更','大','用一一对应比较数量。','5-6','seed-source-starter-r1','chapter:math',md5('seed-kir-compare') || md5('seed-kir-compare'),0),
  ('seed-kir-triangle','seed-ki-triangle',1,'三角形有三条边','认识三角形基本特征','三角形有几条边','三条','用边的数量识别形状。','3-4','seed-source-starter-r1','chapter:math',md5('seed-kir-triangle') || md5('seed-kir-triangle'),0),
  ('seed-kir-rain','seed-ki-rain',1,'水汽变成雨','理解冷却凝结的简单因果','水汽遇冷会变成','小水滴','用观察解释降雨。','5-6','seed-source-starter-r1','chapter:science',md5('seed-kir-rain') || md5('seed-kir-rain'),0),
  ('seed-kir-road','seed-ki-road',1,'红灯要停','记住过马路基本规则','看到红灯先','停','建立交通安全动作链。','3-4','seed-source-starter-r1','chapter:life',md5('seed-kir-road') || md5('seed-kir-road'),0);

INSERT INTO knowledge_edges (id, from_revision_id, to_revision_id, relation, connector, created_at) VALUES
  ('seed-edge-count-add','seed-kir-count-five','seed-kir-addition','prerequisite','先会数数，再学习合并数量',0),
  ('seed-edge-add-compare','seed-kir-addition','seed-kir-compare','sequence','算出数量后比较大小',0),
  ('seed-edge-handwash-emotion','seed-kir-handwash','seed-kir-emotion','sequence','照顾身体，也学会照顾感受',0);
INSERT INTO curriculum_items (curriculum_id, item_revision_id, position) VALUES
  ('seed-curriculum-3-4','seed-kir-hello',0),('seed-curriculum-3-4','seed-kir-colors',1),('seed-curriculum-3-4','seed-kir-count-five',2),('seed-curriculum-3-4','seed-kir-triangle',3),('seed-curriculum-3-4','seed-kir-road',4),
  ('seed-curriculum-5-6','seed-kir-addition',0),('seed-curriculum-5-6','seed-kir-compare',1),('seed-curriculum-5-6','seed-kir-rain',2),('seed-curriculum-5-6','seed-kir-emotion',3);

INSERT INTO publications (id, kind, slug, title, description, status, current_revision, audience, scene, created_at, updated_at) VALUES
  ('seed-publication-book','book','starter-knowledge-book','hum 启蒙知识书','英语、数学与生活常识的内置示例。','published',1,'3-6','general',0,0),
  ('seed-publication-album','album','singing-math-album','会唱的数学','从数数到加法与比较的歌曲专辑。','review',1,'3-6','play',0,0);
INSERT INTO publication_revisions (id, publication_id, revision, title, description, metadata_json, content_hash, created_at) VALUES
  ('seed-publication-book-r1','seed-publication-book',1,'hum 启蒙知识书','用于 Mock 流水线和内容编排演示。','{"language":"zh-CN"}',md5('seed-publication-book-r1') || md5('seed-publication-book-r1'),0),
  ('seed-publication-album-r1','seed-publication-album',1,'会唱的数学','数感、加法和比较的三段学习路径。','{"language":"zh-CN"}',md5('seed-publication-album-r1') || md5('seed-publication-album-r1'),0);
INSERT INTO publication_items (id, publication_revision_id, item_type, item_id, position, label, snapshot_hash, created_at) VALUES
  ('seed-pi-book-1','seed-publication-book-r1','knowledge','seed-ki-hello',0,'英语问候',md5('seed-kir-hello') || md5('seed-kir-hello'),0),
  ('seed-pi-book-2','seed-publication-book-r1','knowledge','seed-ki-count-five',1,'数数',md5('seed-kir-count-five') || md5('seed-kir-count-five'),0),
  ('seed-pi-album-1','seed-publication-album-r1','knowledge','seed-ki-count-five',0,'一到五',md5('seed-kir-count-five') || md5('seed-kir-count-five'),0),
  ('seed-pi-album-2','seed-publication-album-r1','knowledge','seed-ki-addition',1,'二加三',md5('seed-kir-addition') || md5('seed-kir-addition'),0),
  ('seed-pi-album-3','seed-publication-album-r1','knowledge','seed-ki-compare',2,'比大小',md5('seed-kir-compare') || md5('seed-kir-compare'),0);

INSERT INTO pipeline_templates (id, template_key, name, description, status, current_revision, created_at, updated_at) VALUES
  ('seed-pipeline-template','knowledge-to-song','知识到歌曲自动流水线','Mock 知识扩写、免费歌曲候选、媒体评分和人工复审门禁。','active',1,0,0);
INSERT INTO pipeline_template_revisions (id, template_id, revision, stages_json, content_hash, created_at) VALUES
  ('seed-pipeline-template-r1','seed-pipeline-template',1,'[{"key":"knowledge_expand","label":"知识扩写"},{"key":"song_generate","label":"免费候选"},{"key":"media_analyze","label":"媒体评分"},{"key":"human_review","label":"人工复审"},{"key":"notify","label":"进度通知"}]',md5('seed-pipeline-template-r1') || md5('seed-pipeline-template-r1'),0);

INSERT INTO review_rubrics (id, rubric_key, name, subject_type, status, current_revision, created_at, updated_at) VALUES
  ('seed-rubric-audio','hum-audio-9d','音频九维量表','audio','active',1,0,0),
  ('seed-rubric-video','hum-video-5d','视频内容量表','video','active',1,0,0);
INSERT INTO rubric_revisions (id, rubric_id, revision, dimensions_json, threshold, content_hash, created_at) VALUES
  ('seed-rubric-audio-r1','seed-rubric-audio',1,'[{"key":"loudness","label":"响度","weight":14},{"key":"dynamics","label":"动态","weight":7},{"key":"tempo","label":"节奏","weight":13},{"key":"pitch","label":"音域","weight":14},{"key":"clarity","label":"清晰度","weight":13},{"key":"repetition","label":"重复","weight":13},{"key":"gaps","label":"留白","weight":11},{"key":"spectrum","label":"频谱","weight":7},{"key":"duration","label":"时长","weight":8}]',70,md5('seed-rubric-audio-r1') || md5('seed-rubric-audio-r1'),0),
  ('seed-rubric-video-r1','seed-rubric-video',1,'[{"key":"knowledge","label":"知识正确","weight":30},{"key":"visual","label":"画面清晰","weight":20},{"key":"audio","label":"声音质量","weight":20},{"key":"pacing","label":"节奏适龄","weight":15},{"key":"safety","label":"内容安全","weight":15}]',75,md5('seed-rubric-video-r1') || md5('seed-rubric-video-r1'),0);
`,
  },
  {
    version: 5,
    name: "seed-publication-release-reset",
    sql: `
UPDATE publications
SET status = 'draft'
WHERE id IN ('seed-publication-book', 'seed-publication-album');

UPDATE release_packages
SET status = 'recalled', approved_by = NULL, released_at = NULL, gate_snapshot_json = '{}'
WHERE publication_revision_id IN ('seed-publication-book-r1', 'seed-publication-album-r1')
  AND status <> 'recalled';

DELETE FROM release_gate_checks
WHERE publication_revision_id IN ('seed-publication-book-r1', 'seed-publication-album-r1');
`,
  },
  {
    version: 6,
    name: "media-failure-and-owner-hash-index",
    sql: `
ALTER TABLE media_assets DROP CONSTRAINT IF EXISTS media_assets_status_check;
ALTER TABLE media_assets ADD CONSTRAINT media_assets_status_check CHECK (status IN ('authorized','uploaded','analyzing','ready','failed','rejected','retired'));
DROP INDEX IF EXISTS media_assets_hash_unique;
CREATE INDEX IF NOT EXISTS media_assets_owner_content_hash_idx ON media_assets(uploaded_by, content_hash) WHERE content_hash <> '' AND uploaded_by IS NOT NULL;
`,
  },
];