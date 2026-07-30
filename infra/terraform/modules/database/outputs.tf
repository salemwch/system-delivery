/**
 * Connection strings for the three identities.
 *
 * ⚠️ ALL MARKED SENSITIVE. Terraform then refuses to print them in plan or apply
 * output, which is what stops a database password ending up in a CI log that is
 * retained for ninety days and readable by everyone with repository access.
 *
 * `private_host` in every URI: the public host exists but must never be used —
 * see the note in main.tf.
 */

locals {
  pg_host = digitalocean_database_cluster.postgres.private_host
  pg_port = digitalocean_database_cluster.postgres.port
  pg_db   = digitalocean_database_db.app.name

  # `sslmode=require` is not optional. The VPC is private, but the connection
  # still crosses a shared network fabric, and the managed cluster presents a
  # certificate for exactly this reason.
  pg_suffix = "?sslmode=require"
}

output "database_url" {
  description = "DATABASE_URL — the application role. NO BYPASSRLS."
  sensitive   = true
  value = format(
    "postgresql://%s:%s@%s:%d/%s%s",
    digitalocean_database_user.app.name,
    digitalocean_database_user.app.password,
    local.pg_host,
    local.pg_port,
    local.pg_db,
    local.pg_suffix,
  )
}

output "migration_database_url" {
  description = "MIGRATION_DATABASE_URL — owns the schema. Never serves a request."
  sensitive   = true
  value = format(
    "postgresql://%s:%s@%s:%d/%s%s",
    digitalocean_database_user.migrator.name,
    digitalocean_database_user.migrator.password,
    local.pg_host,
    local.pg_port,
    local.pg_db,
    local.pg_suffix,
  )
}

output "relay_database_url" {
  description = "RELAY_DATABASE_URL — cross-tenant on `outbox` only."
  sensitive   = true
  value = format(
    "postgresql://%s:%s@%s:%d/%s%s",
    digitalocean_database_user.relay.name,
    digitalocean_database_user.relay.password,
    local.pg_host,
    local.pg_port,
    local.pg_db,
    local.pg_suffix,
  )
}

output "telemetry_database_url" {
  description = <<-EOT
    TELEMETRY_DATABASE_URL — the same dp_app identity on a SEPARATE pool.

    ADR-005 requirement 4: telemetry must not contend with transactional traffic
    for connections. This is pool isolation, not a new privilege boundary, which
    is why it deliberately reuses the app role.
  EOT
  sensitive = true
  value = format(
    "postgresql://%s:%s@%s:%d/%s%s",
    digitalocean_database_user.app.name,
    digitalocean_database_user.app.password,
    local.pg_host,
    local.pg_port,
    local.pg_db,
    local.pg_suffix,
  )
}

output "valkey_url" {
  description = "VALKEY_URL. TLS (`rediss`) — presence and stream state cross the same fabric."
  sensitive   = true
  value = format(
    "rediss://default:%s@%s:%d",
    digitalocean_database_cluster.valkey.password,
    digitalocean_database_cluster.valkey.private_host,
    digitalocean_database_cluster.valkey.port,
  )
}

output "postgres_cluster_id" {
  description = "For attaching further firewall rules or replicas."
  value       = digitalocean_database_cluster.postgres.id
}
