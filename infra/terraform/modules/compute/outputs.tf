output "app_droplet_ids" {
  description = "Application droplet ids."
  value       = digitalocean_droplet.app[*].id
}

output "app_private_ips" {
  description = "Private IPs — how the droplets reach each other and the databases."
  value       = digitalocean_droplet.app[*].ipv4_address_private
}

output "compute_private_ips" {
  description = "OSRM host(s). Becomes OSRM_BASE_URL."
  value       = digitalocean_droplet.compute[*].ipv4_address_private
}
