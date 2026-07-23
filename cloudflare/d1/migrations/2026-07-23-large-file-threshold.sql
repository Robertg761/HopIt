-- GR-G2: per-codebase override for the large-file warning threshold.
-- NULL (the value existing rows get) means "use the agent default" (100 MB).
-- Large files always sync -- this column only controls when the `file.large`
-- dashboard note fires; there is no cap, no gate.
alter table codebase_settings add column large_file_threshold_bytes integer;
