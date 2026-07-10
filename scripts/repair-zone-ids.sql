-- One-time repair (2026-07-10): journal commit paths stamped zone_id with a
-- hardcoded 'unknown' codebase id instead of the real one. Rewrites the prefix
-- from the row's own codebase_id; privacy_zone is verified non-null on every
-- affected row and zone_id is always exactly 'unknown:' || privacy_zone.
UPDATE files SET zone_id = codebase_id || ':' || privacy_zone WHERE zone_id LIKE 'unknown:%';
UPDATE file_versions SET zone_id = codebase_id || ':' || privacy_zone WHERE zone_id LIKE 'unknown:%';
