/**
 * What the deployment pipeline consumes.
 *
 * Every connection string is sensitive, so `terraform output` hides it unless
 * asked for by name — which is what stops a password reaching a CI log that is
 * retained for ninety days and readable by everyone with repository access.
 */

output "load_balancer_ip" {
  description = "Point the DNS A record here."
  value       = module.network.load_balancer_ip
}

output "app_private_ips" {
  value = module.compute.app_private_ips
}

output "osrm_private_ips" {
  description = "Becomes OSRM_BASE_URL once the Maghreb extract is loaded."
  value       = module.compute.compute_private_ips
}

output "database_url" {
  sensitive = true
  value     = module.database.database_url
}

output "migration_database_url" {
  sensitive = true
  value     = module.database.migration_database_url
}

output "relay_database_url" {
  sensitive = true
  value     = module.database.relay_database_url
}

output "telemetry_database_url" {
  sensitive = true
  value     = module.database.telemetry_database_url
}

output "valkey_url" {
  sensitive = true
  value     = module.database.valkey_url
}

output "pod_bucket_name" {
  value = module.storage.bucket_name
}

output "pod_bucket_endpoint" {
  value = module.storage.bucket_endpoint
}
