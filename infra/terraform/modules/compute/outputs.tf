output "app_droplet_ids" {
  description = "Application droplet ids."
  value       = digitalocean_droplet.app[*].id
}

output "app_private_ips" {
  description = "Private IPs — how the droplets reach each other and the databases."
  value       = digitalocean_droplet.app[*].ipv4_address_private
}

output "compute_private_ips" {
  description = "Geospatial host(s) — OSRM (:5000) and Nominatim (:8080). Becomes OSRM_URL and NOMINATIM_URL."
  value       = digitalocean_droplet.compute[*].ipv4_address_private
}
