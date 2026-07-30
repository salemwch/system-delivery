-- ─────────────────────────────────────────────────────────────────────────────
-- 0028 — `nominatim` as a geocode source
--
-- `addresses_source_chk` allowed none | mapbox | google | manual |
-- driver_corrected. Binding a self-hosted Nominatim (OpenStreetMap) geocoder
-- therefore had nowhere truthful to record where a coordinate came from, and
-- provenance is not cosmetic here: `geocode_confidence` drives the
-- auto-dispatch block (docs/06 §4.4), and knowing WHICH provider produced a bad
-- coordinate is how a systematic geocoding failure gets diagnosed rather than
-- blamed on the drivers.
--
-- Self-hosted rather than a commercial API by default: the extract is the one
-- already prepared for OSRM, there is no per-request cost, and a customer's home
-- address never leaves the deployment — which is the posture INPDP expects for
-- personal data. A commercial provider chains in behind it for the addresses
-- Nominatim cannot place.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE addresses DROP CONSTRAINT IF EXISTS addresses_source_chk;
ALTER TABLE addresses ADD CONSTRAINT addresses_source_chk
  CHECK (geocode_source IN (
    'none', 'nominatim', 'mapbox', 'google', 'manual', 'driver_corrected'
  ));
